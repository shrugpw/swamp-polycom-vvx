/**
 * Unit tests for the `@shrug/polycom-vvx/phone` model.
 *
 * Two layers (spec §9):
 *  - The PURE typed-primitive interpreter (spec §5): tiles/rows/degrade output
 *    for the fraction tile, the seriesCount tile + rows, down-hosts rows, the
 *    log-errors scalar tile (§5.5), the 3-tile cap, row dedup, the degrade-on-
 *    bad-source path, refs, the custom escape hatch, and buildSeriesByProvider's
 *    JSON.parse of the opaque Grafana `results` string (§5.0).
 *  - The control methods driven through an injected fetch seam ({@link FetchLike}):
 *    request URL/method/auth/body shape + parsed result, the dry-run-vs-confirm
 *    branch for gated writes, the 4007 no-active-call case, InvalidParams, and the
 *    /push DIGEST challenge/response flow.
 *
 * DEPERSONALIZED (spec §9 hard gate): every fixture is synthetic — phone.example.test,
 * host-a.example, adminpin/pushpin, pushuser. No real IPs/pins/creds/hostnames.
 *
 * Run: `~/.swamp/deno/deno test -A extensions/models/polycom-vvx_test.ts`
 * @module
 */
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { createHash } from "node:crypto";
import {
  buildDigestAuth,
  buildForwardWrites,
  buildPushEnvelope,
  buildSeriesByProvider,
  type CustomReducer,
  DisplayConfigSchema,
  evalThresholds,
  type FetchLike,
  type FetchResponse,
  forwardParams,
  type Fragment,
  interpolate,
  interpret,
  model,
  parseDigestChallenge,
  parseEnvelope,
  phoneFetch,
  type Provider,
  ProviderSchema,
  reduceFirstSeries,
  resolveRef,
  sendPush,
  type Series,
} from "./polycom-vvx.ts";

// ===========================================================================
// Test helpers
// ===========================================================================

/** Build a synthetic series: metric labels + a single sample value. */
function ser(metric: Record<string, string>, value: number | string): Series {
  return { metric, values: [[0, String(value)]] };
}

/** Parse a provider fixture through the schema (applies defaults). */
function prov(obj: unknown): Provider {
  return ProviderSchema.parse(obj);
}

interface RespOpts {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

function makeResp(o: RespOpts = {}): FetchResponse {
  const headers = o.headers ?? {};
  return {
    ok: o.ok ?? true,
    status: o.status ?? 200,
    statusText: o.statusText ?? "OK",
    headers: {
      get: (n: string) => headers[n] ?? headers[n.toLowerCase()] ?? null,
    },
    json: () => Promise.resolve(o.json ?? {}),
    text: () => Promise.resolve(o.text ?? ""),
    arrayBuffer: () =>
      Promise.resolve(
        (o.bytes ?? new Uint8Array()).buffer as ArrayBuffer,
      ),
  };
}

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** A fetch stub returning canned responses in order, recording every call. */
function seqFetcher(
  responses: RespOpts[],
): { f: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const f: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    const o = responses[Math.min(i, responses.length - 1)];
    i++;
    return Promise.resolve(makeResp(o));
  };
  return { f, calls };
}

interface WriteCall {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

/** Stub ExecuteContext: recording writeResource + file writer + noop logger. */
function stubContext(globalArgs: Record<string, unknown>) {
  const writes: WriteCall[] = [];
  const fileWrites: Array<{ spec: string; name: string; bytes: Uint8Array }> =
    [];
  const noop = (_m: string, _p?: Record<string, unknown>) => {};
  const context = {
    globalArgs,
    logger: { debug: noop, info: noop, warning: noop, error: noop },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    createFileWriter: (spec: string, name: string) => ({
      writeAll: (bytes: Uint8Array) => {
        fileWrites.push({ spec, name, bytes });
        return Promise.resolve({ name });
      },
    }),
    // deno-lint-ignore no-explicit-any
  } as any;
  return { context, writes, fileWrites };
}

/** Full synthetic globalArgs (all secrets synthetic — spec §9). */
function mkGlobalArgs(overrides: Record<string, unknown> = {}) {
  return {
    phoneHost: "phone.example.test",
    adminUser: "Polycom",
    adminPassword: "adminpin",
    pushUser: "pushuser",
    pushPassword: "pushpin",
    serveBaseUrl: "http://daemon.example:7070",
    grafanaModel: "shrug-grafana",
    grafanaRepoDir: "",
    line: "1",
    displayConfig: { refreshSeconds: 30, providers: [] },
    ...overrides,
  };
}

// ===========================================================================
// SECTION A — the interpreter (spec §5)
// ===========================================================================

Deno.test("reduceFirstSeries: last/max/min/sum/avg over the first series' samples", () => {
  const s: Series[] = [{ metric: {}, values: [[0, "2"], [1, "8"], [2, "5"]] }];
  assertEquals(reduceFirstSeries(s, "last"), 5);
  assertEquals(reduceFirstSeries(s, "max"), 8);
  assertEquals(reduceFirstSeries(s, "min"), 2);
  assertEquals(reduceFirstSeries(s, "sum"), 15);
  assertEquals(reduceFirstSeries(s, "avg"), 5);
  assertThrows(() => reduceFirstSeries([], "last")); // no series ⇒ degrade
});

Deno.test("resolveRef: const, provider-as-scalar, provider-as-seriesCount", () => {
  const sbp: Record<string, Series[] | undefined> = {
    a: [ser({}, 7)],
    b: [ser({ x: "1" }, 1), ser({ x: "2" }, 1)],
  };
  assertEquals(resolveRef({ const: 42 }, sbp), 42);
  assertEquals(resolveRef({ provider: "a", as: "scalar" }, sbp), 7);
  assertEquals(resolveRef({ provider: "b", as: "seriesCount" }, sbp), 2);
  assertThrows(() => resolveRef({ provider: "missing", as: "scalar" }, sbp));
});

Deno.test("interpolate: fills {label}s + reserved {value}", () => {
  const s = ser({ alertname: "HighCPU", instance: "host-a.example" }, 1);
  assertEquals(
    interpolate("{alertname} / {instance}", s),
    "HighCPU / host-a.example",
  );
  assertEquals(interpolate("{instance} down", s), "host-a.example down");
  assertEquals(interpolate("v={value}", s), "v=1");
  assertEquals(interpolate("{missing}!", s), "!"); // unknown label ⇒ empty
});

// --- the fraction tile (fleet-health) — spec §5.2 --------------------------

const FRACTION_PROVIDERS: Provider[] = [
  prov({
    id: "up-ready",
    source: { type: "grafana-promql", dataName: "q-up-ready" },
  }),
  prov({
    id: "up-total",
    source: { type: "grafana-promql", dataName: "q-up-total" },
  }),
  prov({
    id: "fleet-health",
    source: { type: "static" },
    tile: {
      label: "Fleet",
      value: {
        fraction: {
          num: { provider: "up-ready" },
          den: { provider: "up-total" },
        },
      },
      sev: {
        thresholds: [
          { crit: { eq: 0 } },
          { warn: { ltRef: { provider: "up-total" } } },
          { ok: {} },
        ],
      },
    },
  }),
];

Deno.test("fraction tile: crit when num==0 (spec §5.2)", () => {
  const snap = interpret(FRACTION_PROVIDERS, {
    "up-ready": [ser({}, 0)],
    "up-total": [ser({}, 3)],
    "fleet-health": [],
  }, { epoch: 1 });
  assertEquals(snap.tiles.length, 1);
  assertEquals(snap.tiles[0], { value: "0/3", label: "Fleet", sev: "crit" });
  assertEquals(snap.degraded, []);
});

Deno.test("fraction tile: warn when num<den (ready<total)", () => {
  const snap = interpret(FRACTION_PROVIDERS, {
    "up-ready": [ser({}, 2)],
    "up-total": [ser({}, 3)],
    "fleet-health": [],
  }, { epoch: 1 });
  assertEquals(snap.tiles[0], { value: "2/3", label: "Fleet", sev: "warn" });
});

Deno.test("fraction tile: ok when num>=den", () => {
  const snap = interpret(FRACTION_PROVIDERS, {
    "up-ready": [ser({}, 3)],
    "up-total": [ser({}, 3)],
    "fleet-health": [],
  }, { epoch: 1 });
  assertEquals(snap.tiles[0], { value: "3/3", label: "Fleet", sev: "ok" });
});

// --- the seriesCount tile + rows (firing-alerts) — spec §5.2 ---------------

const ALERTS_PROVIDER: Provider = prov({
  id: "firing-alerts",
  source: { type: "grafana-promql", dataName: "q-alerts" },
  tile: {
    label: "Alerts",
    value: { seriesCount: {} },
    sev: { thresholds: [{ crit: { gt: 0 } }, { ok: {} }] },
  },
  rows: {
    forEach: "series",
    key: { label: "alertname" },
    msg: { template: "{alertname} / {instance}" },
    sev: { literal: "crit" },
  },
});

Deno.test("seriesCount tile + rows: count + one crit row per firing alert (spec §5.2)", () => {
  const snap = interpret([ALERTS_PROVIDER], {
    "firing-alerts": [
      ser({ alertname: "HighCPU", instance: "host-a.example" }, 1),
      ser({ alertname: "DiskFull", instance: "host-b.example" }, 1),
    ],
  }, { epoch: 1 });
  assertEquals(snap.tiles[0], { value: "2", label: "Alerts", sev: "crit" });
  assertEquals(snap.rows, [
    { sev: "crit", key: "HighCPU", msg: "HighCPU / host-a.example" },
    { sev: "crit", key: "DiskFull", msg: "DiskFull / host-b.example" },
  ]);
});

Deno.test("seriesCount tile: zero firing ⇒ ok tile + resting row", () => {
  const snap = interpret([ALERTS_PROVIDER], { "firing-alerts": [] }, {
    epoch: 1,
  });
  assertEquals(snap.tiles[0], { value: "0", label: "Alerts", sev: "ok" });
  // No crit/warn rows ⇒ the resting "all systems nominal" row (spec §5.3).
  assertEquals(snap.rows, [{ sev: "ok", key: "all systems", msg: "nominal" }]);
});

// --- down-hosts rows — spec §5.2 -------------------------------------------

Deno.test("down-hosts rows: one crit row per down target", () => {
  const p = prov({
    id: "down-hosts",
    source: { type: "grafana-promql", dataName: "q-down" },
    rows: {
      forEach: "series",
      key: { label: "instance" },
      msg: { template: "{instance} down" },
      sev: { literal: "crit" },
    },
  });
  const snap = interpret([p], {
    "down-hosts": [
      ser({ instance: "host-c.example" }, 0),
      ser({ instance: "host-d.example" }, 0),
    ],
  }, { epoch: 1 });
  assertEquals(snap.rows, [
    { sev: "crit", key: "host-c.example", msg: "host-c.example down" },
    { sev: "crit", key: "host-d.example", msg: "host-d.example down" },
  ]);
});

// --- the log-errors scalar tile — spec §5.5 --------------------------------

const LOG_ERRORS_PROVIDER: Provider = prov({
  id: "log-errors",
  source: { type: "grafana-logql", dataName: "q-log-errors" },
  tile: {
    label: "Errors",
    value: { scalar: { reduce: "last" } },
    sev: {
      thresholds: [{ crit: { gt: 50 } }, { warn: { gt: 0 } }, { ok: {} }],
    },
  },
});

Deno.test("log-errors scalar tile: quiet(ok)/spike(warn)/flood(crit) (spec §5.5)", () => {
  const ok = interpret([LOG_ERRORS_PROVIDER], { "log-errors": [ser({}, 0)] }, {
    epoch: 1,
  });
  assertEquals(ok.tiles[0], { value: "0", label: "Errors", sev: "ok" });
  const warn = interpret(
    [LOG_ERRORS_PROVIDER],
    { "log-errors": [ser({}, 12)] },
    { epoch: 1 },
  );
  assertEquals(warn.tiles[0], { value: "12", label: "Errors", sev: "warn" });
  const crit = interpret(
    [LOG_ERRORS_PROVIDER],
    { "log-errors": [ser({}, 99)] },
    { epoch: 1 },
  );
  assertEquals(crit.tiles[0], { value: "99", label: "Errors", sev: "crit" });
});

// --- merge/cap/dedup/degrade — spec §5.3 -----------------------------------

Deno.test("tiles are capped at 3 (spec §5.3)", () => {
  const mk = (id: string) =>
    prov({
      id,
      source: { type: "static" },
      tile: { label: id, value: { literal: "x" }, sev: { literal: "info" } },
    });
  const snap = interpret([mk("a"), mk("b"), mk("c"), mk("d")], {
    a: [],
    b: [],
    c: [],
    d: [],
  }, { epoch: 1 });
  assertEquals(snap.tiles.length, 3);
  assertEquals(snap.tiles.map((t) => t.label), ["a", "b", "c"]);
});

Deno.test("rows are deduped by key, first occurrence wins (spec §5.3)", () => {
  const mkRows = (id: string, msg: string) =>
    prov({
      id,
      source: { type: "grafana-promql", dataName: id },
      rows: {
        forEach: "series",
        key: { label: "instance" },
        msg: { template: msg },
        sev: { literal: "crit" },
      },
    });
  const snap = interpret([
    mkRows("p1", "first {instance}"),
    mkRows("p2", "second {instance}"),
  ], {
    p1: [ser({ instance: "host-a.example" }, 0)],
    p2: [ser({ instance: "host-a.example" }, 0)], // same key
  }, { epoch: 1 });
  assertEquals(snap.rows.length, 1);
  assertEquals(snap.rows[0].msg, "first host-a.example"); // first wins
});

Deno.test("degrade-on-bad-source: a missing/unparseable provider is skipped + recorded, others survive (spec §5.3)", () => {
  const snap = interpret([...FRACTION_PROVIDERS, ALERTS_PROVIDER], {
    "up-ready": [ser({}, 3)],
    "up-total": [ser({}, 3)],
    "fleet-health": [],
    "firing-alerts": undefined, // source missing/unparseable
  }, { epoch: 1 });
  // fleet-health still renders; firing-alerts degraded.
  assertEquals(snap.tiles.length, 1);
  assertEquals(snap.tiles[0].label, "Fleet");
  assertEquals(snap.degraded, ["firing-alerts"]);
  assertEquals(snap.notes.length, 1);
  assertEquals(snap.notes[0].startsWith("firing-alerts:"), true);
});

Deno.test("a fraction ref into a missing sibling degrades the display tile, never aborts", () => {
  const snap = interpret(FRACTION_PROVIDERS, {
    "up-ready": undefined, // the numerator source is gone
    "up-total": [ser({}, 3)],
    "fleet-health": [],
  }, { epoch: 1 });
  assertEquals(snap.tiles.length, 0);
  assertEquals(snap.degraded, ["fleet-health"]);
});

// --- where filter + row byValue sev ----------------------------------------

Deno.test("where: labelEq + valueEq filter series before emitting rows", () => {
  const p = prov({
    id: "sel",
    source: { type: "grafana-promql", dataName: "q" },
    rows: {
      forEach: "series",
      where: { labelEq: { job: "web" } },
      key: { label: "instance" },
      msg: { template: "{instance}" },
      sev: { literal: "warn" },
    },
  });
  const snap = interpret([p], {
    sel: [
      ser({ instance: "w1.example", job: "web" }, 1),
      ser({ instance: "db1.example", job: "db" }, 1),
    ],
  }, { epoch: 1 });
  assertEquals(snap.rows, [{
    sev: "warn",
    key: "w1.example",
    msg: "w1.example",
  }]);
});

Deno.test("row sev byValue: thresholds over each series' own value", () => {
  const p = prov({
    id: "q",
    source: { type: "grafana-promql", dataName: "q" },
    rows: {
      forEach: "series",
      key: { label: "instance" },
      msg: { template: "{instance}={value}" },
      sev: {
        byValue: [{ crit: { gt: 90 } }, { warn: { gt: 50 } }, { ok: {} }],
      },
    },
  });
  const snap = interpret([p], {
    q: [
      ser({ instance: "a.example" }, 95),
      ser({ instance: "b.example" }, 60),
      ser({ instance: "c.example" }, 10),
    ],
  }, { epoch: 1 });
  assertEquals(snap.rows.map((r) => r.sev), ["crit", "warn", "ok"]);
});

// --- custom escape hatch — spec §5.4 ---------------------------------------

Deno.test("custom reducer: dispatched when registered; degrades when not (spec §5.4)", () => {
  const p = prov({ id: "cx", source: { type: "custom", name: "myReducer" } });
  // Unregistered ⇒ degrade (the seam exists even with zero reducers).
  const bad = interpret([p], { cx: [] }, { epoch: 1, customReducers: {} });
  assertEquals(bad.degraded, ["cx"]);

  // Registered ⇒ its fragment is merged.
  const reducer: CustomReducer = (): Fragment => ({
    tiles: [{ value: "7", label: "Custom", sev: "info" }],
    rows: [{ sev: "info", key: "cx", msg: "hello" }],
  });
  const good = interpret([p], { cx: [] }, {
    epoch: 1,
    customReducers: { myReducer: reducer },
  });
  assertEquals(good.tiles[0], { value: "7", label: "Custom", sev: "info" });
  assertEquals(good.degraded, []);
});

// --- buildSeriesByProvider: the JSON.parse of the opaque results string ----

Deno.test("buildSeriesByProvider: JSON.parses the opaque Grafana results string (spec §5.0)", () => {
  const providers = [
    prov({
      id: "up-ready",
      source: { type: "grafana-promql", dataName: "q-up-ready" },
    }),
    prov({
      id: "static-x",
      source: {
        type: "static",
        series: [{ metric: { a: "b" }, values: [[0, "1"]] }],
      },
    }),
  ];
  const results = JSON.stringify([
    { metric: { __name__: "up" }, values: [[1000, "3"]] },
  ]);
  const sbp = buildSeriesByProvider(providers, {
    "q-up-ready": { results, resultType: "vector", seriesCount: 1 },
  });
  assertEquals(sbp["up-ready"]?.length, 1);
  assertEquals(sbp["up-ready"]?.[0].values[0][1], "3");
  // static inline series carried through.
  assertEquals(sbp["static-x"]?.[0].metric, { a: "b" });
});

Deno.test("buildSeriesByProvider: missing dataName or unparseable results ⇒ undefined (degrade path)", () => {
  const providers = [
    prov({
      id: "missing",
      source: { type: "grafana-promql", dataName: "nope" },
    }),
    prov({ id: "bad", source: { type: "grafana-promql", dataName: "q-bad" } }),
  ];
  const sbp = buildSeriesByProvider(providers, {
    "q-bad": { results: "{not valid json" },
  });
  assertEquals(sbp["missing"], undefined);
  assertEquals(sbp["bad"], undefined);
});

// --- composeIdleSnapshot method (end-to-end through the interpreter) --------

Deno.test("composeIdleSnapshot: parses queryResults + writes a schema-valid idleSnapshot", async () => {
  const providers = [
    ProviderSchema.parse({
      id: "up-ready",
      source: { type: "grafana-promql", dataName: "q-up-ready" },
    }),
    ProviderSchema.parse({
      id: "up-total",
      source: { type: "grafana-promql", dataName: "q-up-total" },
    }),
    FRACTION_PROVIDERS[2],
    ALERTS_PROVIDER,
  ];
  const g = mkGlobalArgs({ displayConfig: { refreshSeconds: 30, providers } });
  const { context, writes } = stubContext(g);
  await model.methods.composeIdleSnapshot.execute({
    queryResults: {
      "q-up-ready": {
        results: JSON.stringify([{ metric: {}, values: [[0, "2"]] }]),
      },
      "q-up-total": {
        results: JSON.stringify([{ metric: {}, values: [[0, "3"]] }]),
      },
      "q-alerts": {
        results: JSON.stringify([
          {
            metric: { alertname: "HighCPU", instance: "host-a.example" },
            values: [[0, "1"]],
          },
        ]),
      },
    },
    epoch: 123,
    // deno-lint-ignore no-explicit-any
  } as any, context);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "idleSnapshot");
  const data = writes[0].data;
  assertEquals(data.epoch, 123);
  const tiles = data.tiles as Array<Record<string, unknown>>;
  assertEquals(tiles[0], { value: "2/3", label: "Fleet", sev: "warn" });
  assertEquals(tiles[1], { value: "1", label: "Alerts", sev: "crit" });
  // The written data validates against the resource schema.
  model.resources.idleSnapshot.schema.parse(data);
});

Deno.test("composeIdleSnapshot: seriesByProvider injection bypasses queryResults", async () => {
  const g = mkGlobalArgs({
    displayConfig: { refreshSeconds: 30, providers: [LOG_ERRORS_PROVIDER] },
  });
  const { context, writes } = stubContext(g);
  await model.methods.composeIdleSnapshot.execute({
    seriesByProvider: { "log-errors": [ser({}, 77)] },
    epoch: 9,
    // deno-lint-ignore no-explicit-any
  } as any, context);
  const tiles = writes[0].data.tiles as Array<Record<string, unknown>>;
  assertEquals(tiles[0], { value: "77", label: "Errors", sev: "crit" });
});

// ===========================================================================
// SECTION B — envelope + auth + push builders (pure)
// ===========================================================================

Deno.test("parseEnvelope: decodes {data,Status} + InvalidParams (spec §3.2)", () => {
  const ok = parseEnvelope({ data: { ModelNumber: "VVX-X" }, Status: "2000" });
  assertEquals(ok.status, "2000");
  assertEquals(ok.data?.ModelNumber, "VVX-X");
  assertEquals(ok.invalidParams, undefined);

  const bad = parseEnvelope({
    data: { InvalidParams: ["nope.param"] },
    Status: "4000",
  });
  assertEquals(bad.status, "4000");
  assertEquals(bad.invalidParams, ["nope.param"]);

  const noCall = parseEnvelope({ Status: "4007" });
  assertEquals(noCall.status, "4007");
  assertEquals(noCall.data, undefined);
});

Deno.test("parseDigestChallenge: parses realm/nonce/qop/opaque", () => {
  const c = parseDigestChallenge(
    'Digest realm="phone", nonce="abc123", qop="auth", opaque="op42", algorithm=MD5',
  );
  assertEquals(c.realm, "phone");
  assertEquals(c.nonce, "abc123");
  assertEquals(c.qop, "auth");
  assertEquals(c.opaque, "op42");
  assertEquals(c.algorithm, "MD5");
});

Deno.test("buildDigestAuth: RFC 2617 MD5 response wiring (qop=auth)", () => {
  const challenge = {
    realm: "phone",
    nonce: "abc123",
    qop: "auth",
    opaque: "op42",
  };
  const h = buildDigestAuth({
    user: "pushuser",
    password: "pushpin",
    method: "POST",
    uri: "/push",
    challenge,
    cnonce: "cafef00d",
    nc: "00000001",
  });
  // Recompute the expected response independently from the standard formula.
  const md5 = (s: string) => createHash("md5").update(s).digest("hex");
  const ha1 = md5("pushuser:phone:pushpin");
  const ha2 = md5("POST:/push");
  const expected = md5(`${ha1}:abc123:00000001:cafef00d:auth:${ha2}`);
  assertEquals(h.includes(`response="${expected}"`), true);
  assertEquals(h.includes('username="pushuser"'), true);
  assertEquals(h.includes("qop=auth"), true);
  assertEquals(h.includes('cnonce="cafef00d"'), true);
  assertEquals(h.includes('opaque="op42"'), true);
});

Deno.test("buildPushEnvelope: URI push vs inline message, with priority + escaping", () => {
  assertEquals(
    buildPushEnvelope({ uri: "/s/dashboard", priority: "critical" }),
    '<PolycomIPPhone><URL priority="critical">/s/dashboard</URL></PolycomIPPhone>',
  );
  assertEquals(
    buildPushEnvelope({
      message: "Build <4821> FAILED & down",
      priority: "normal",
    }),
    '<PolycomIPPhone><Data priority="normal"><h1>Build &lt;4821&gt; FAILED &amp; down</h1></Data></PolycomIPPhone>',
  );
});

Deno.test("forwardParams + buildForwardWrites: flat divert.* writes; '' clears+disables", () => {
  const p = forwardParams("2");
  assertEquals(p.busyContact, "divert.busy.2.contact");
  assertEquals(p.serverCf, "reg.2.serverFeatureControl.cf");
  // A target enables; an empty string clears + disables.
  assertEquals(buildForwardWrites("1", { busy: "200@sip.example.test" }), {
    "divert.busy.1.contact": "200@sip.example.test",
    "divert.busy.1.enabled": "1",
  });
  assertEquals(buildForwardWrites("1", { noanswer: "", naTimeout: 20 }), {
    "divert.noanswer.1.contact": "",
    "divert.noanswer.1.enabled": "0",
    "divert.noanswer.1.timeout": "20",
  });
  assertEquals(buildForwardWrites("1", {}), {}); // nothing to change
});

// ===========================================================================
// SECTION C — control methods through the injected fetch seam (spec §3.2)
// ===========================================================================

Deno.test("discover: GET device/info with Basic auth, parses deviceInfo", async () => {
  const { f, calls } = seqFetcher([{
    json: {
      data: {
        ModelNumber: "VVX-model",
        FirmwareRelease: "6.4.7.4560",
        IPV4Address: "10.0.0.9",
        MACAddress: "AA:BB:CC:00:11:22",
        UpTimeSinceLastReboot: "1 day",
      },
      Status: "2000",
    },
  }]);
  const { context, writes } = stubContext(mkGlobalArgs());
  // deno-lint-ignore no-explicit-any
  await model.methods.discover.execute({ _fetch: f } as any, context);
  assertEquals(
    calls[0].url,
    "https://phone.example.test/api/v1/mgmt/device/info",
  );
  assertEquals(calls[0].method, "GET");
  assertEquals(
    calls[0].headers?.["Authorization"],
    "Basic " + btoa("Polycom:adminpin"),
  );
  assertEquals(writes[0].spec, "deviceInfo");
  assertEquals(writes[0].data.model, "VVX-model");
  assertEquals(writes[0].data.firmware, "6.4.7.4560");
  assertEquals(writes[0].data.ip, "10.0.0.9");
});

Deno.test("callStatus: 2000 ⇒ active call recorded", async () => {
  const { f } = seqFetcher([{
    json: {
      data: { CallHandle: "0x1", CallState: "Connected" },
      Status: "2000",
    },
  }]);
  const { context, writes } = stubContext(mkGlobalArgs());
  // deno-lint-ignore no-explicit-any
  await model.methods.callStatus.execute({ _fetch: f } as any, context);
  assertEquals(writes[0].data.active, true);
  assertEquals(
    (writes[0].data.call as Record<string, unknown>).CallHandle,
    "0x1",
  );
});

Deno.test("callStatus: 4007 ⇒ no active call, NOT an error (the is-a-call-up check)", async () => {
  const { f } = seqFetcher([{ json: { Status: "4007" } }]);
  const { context, writes } = stubContext(mkGlobalArgs());
  // deno-lint-ignore no-explicit-any
  await model.methods.callStatus.execute({ _fetch: f } as any, context);
  assertEquals(writes[0].data.active, false);
  assertEquals(writes[0].data.status, "4007");
  assertEquals(writes[0].data.call, null);
});

Deno.test("configGet: sends {data:[names]}, surfaces Value/Source + invalidParams (4000)", async () => {
  const { f, calls } = seqFetcher([{
    json: {
      data: {
        "up.foo": { Value: "1", Source: "local" },
        InvalidParams: ["bogus.param"],
      },
      Status: "4000",
    },
  }]);
  const { context, writes } = stubContext(mkGlobalArgs());
  await model.methods.configGet.execute(
    // deno-lint-ignore no-explicit-any
    { names: ["up.foo", "bogus.param"], _fetch: f } as any,
    context,
  );
  assertEquals(calls[0].method, "POST");
  assertEquals(JSON.parse(calls[0].body!), { data: ["up.foo", "bogus.param"] });
  const params = writes[0].data.params as Array<Record<string, unknown>>;
  assertEquals(params[0], { name: "up.foo", value: "1", source: "local" });
  assertEquals(writes[0].data.invalidParams, ["bogus.param"]);
});

Deno.test("configGet: an unexpected Status throws", async () => {
  const { f } = seqFetcher([{ json: { Status: "5000" } }]);
  const { context } = stubContext(mkGlobalArgs());
  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () =>
      model.methods.configGet.execute(
        { names: ["x"], _fetch: f } as any,
        context,
      ),
    Error,
    "Status 5000",
  );
});

Deno.test("dial: dry-run by default previews Dest, sends NOTHING", async () => {
  const { f, calls } = seqFetcher([{ json: { Status: "2000" } }]);
  const { context, writes } = stubContext(mkGlobalArgs());
  await model.methods.dial.execute(
    // deno-lint-ignore no-explicit-any
    { dest: "200@sip.example.test", _fetch: f } as any,
    context,
  );
  assertEquals(calls.length, 0); // no network on dry run
  assertEquals(writes[0].data.dryRun, true);
  assertEquals(
    (writes[0].data.preview as Record<string, unknown>).Dest,
    "200@sip.example.test",
  );
});

Deno.test("dial: confirm:true POSTs callctrl/dial with the SIP body", async () => {
  const { f, calls } = seqFetcher([{
    json: { data: { CallHandle: "0x9" }, Status: "2000" },
  }]);
  const { context, writes } = stubContext(mkGlobalArgs());
  await model.methods.dial.execute(
    // deno-lint-ignore no-explicit-any
    { dest: "200@sip.example.test", confirm: true, _fetch: f } as any,
    context,
  );
  assertEquals(calls[0].url, "https://phone.example.test/api/v1/callctrl/dial");
  assertEquals(JSON.parse(calls[0].body!), {
    data: { Dest: "200@sip.example.test", Line: "1", Type: "SIP" },
  });
  assertEquals(writes[0].data.active, true);
});

Deno.test("endCall: confirm:true tolerates 4007 (already ended)", async () => {
  const { f } = seqFetcher([{ json: { Status: "4007" } }]);
  const { context, writes } = stubContext(mkGlobalArgs());
  await model.methods.endCall.execute(
    // deno-lint-ignore no-explicit-any
    { ref: "0x9", confirm: true, _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].data.status, "4007");
  assertEquals(writes[0].data.active, false);
});

Deno.test("configSet: dry-run previews flat writes; nothing sent", async () => {
  const { f, calls } = seqFetcher([{ json: { Status: "2000" } }]);
  const { context, writes } = stubContext(mkGlobalArgs());
  await model.methods.configSet.execute(
    // deno-lint-ignore no-explicit-any
    { values: { "feature.x.enabled": "1" }, _fetch: f } as any,
    context,
  );
  assertEquals(calls.length, 0);
  assertEquals(writes[0].data.mode, "dryRun");
  assertEquals(
    (writes[0].data.writes as Record<string, unknown>)["feature.x.enabled"],
    "1",
  );
});

Deno.test("configSet: confirm:true writes FLAT body then verifies via read-back", async () => {
  const { f, calls } = seqFetcher([
    { json: { Status: "2000" } }, // the set
    {
      json: {
        data: { "feature.x.enabled": { Value: "1", Source: "local" } },
        Status: "2000",
      },
    }, // read-back
  ]);
  const { context, writes } = stubContext(mkGlobalArgs());
  await model.methods.configSet.execute(
    // deno-lint-ignore no-explicit-any
    { values: { "feature.x.enabled": "1" }, confirm: true, _fetch: f } as any,
    context,
  );
  assertEquals(
    calls[0].url,
    "https://phone.example.test/api/v1/mgmt/config/set",
  );
  assertEquals(JSON.parse(calls[0].body!), {
    data: { "feature.x.enabled": "1" },
  }); // FLAT
  assertEquals(
    calls[1].url,
    "https://phone.example.test/api/v1/mgmt/config/get",
  ); // verify
  assertEquals(writes[0].data.mode, "applied");
  const params = writes[0].data.params as Array<Record<string, unknown>>;
  assertEquals(params[0].value, "1");
});

Deno.test("getForward: reads divert.* + flags a server-controlled line", async () => {
  const { f } = seqFetcher([{
    json: {
      data: {
        "divert.busy.1.contact": { Value: "", Source: "default" },
        "reg.1.serverFeatureControl.cf": { Value: "1", Source: "local" },
      },
      Status: "2000",
    },
  }]);
  const { context, writes } = stubContext(mkGlobalArgs());
  // deno-lint-ignore no-explicit-any
  await model.methods.getForward.execute({ _fetch: f } as any, context);
  assertEquals(writes[0].data.serverControlled, true);
  assertEquals(writes[0].data.mode, "audit");
});

Deno.test("reconcileForward: REFUSES a write on a server-controlled line", async () => {
  const { f, calls } = seqFetcher([{
    json: {
      data: {
        "reg.1.serverFeatureControl.cf": { Value: "1", Source: "local" },
      },
      Status: "2000",
    },
  }]);
  const { context, writes } = stubContext(mkGlobalArgs());
  await model.methods.reconcileForward.execute(
    // deno-lint-ignore no-explicit-any
    { busy: "200@sip.example.test", confirm: true, _fetch: f } as any,
    context,
  );
  assertEquals(calls.length, 1); // only the read; no write attempted
  assertEquals(writes[0].data.mode, "refused");
  assertEquals(writes[0].data.serverControlled, true);
});

Deno.test("reconcileForward: dry-run previews writes on a local-controlled line", async () => {
  const { f, calls } = seqFetcher([{
    json: {
      data: {
        "reg.1.serverFeatureControl.cf": { Value: "0", Source: "default" },
      },
      Status: "2000",
    },
  }]);
  const { context, writes } = stubContext(mkGlobalArgs());
  await model.methods.reconcileForward.execute(
    // deno-lint-ignore no-explicit-any
    { busy: "200@sip.example.test", _fetch: f } as any,
    context,
  );
  assertEquals(calls.length, 1); // read only, no set
  assertEquals(writes[0].data.mode, "dryRun");
  assertEquals(
    (writes[0].data.writes as Record<string, unknown>)["divert.busy.1.contact"],
    "200@sip.example.test",
  );
});

Deno.test("reconcileForward: confirm applies the flat writes", async () => {
  const { f, calls } = seqFetcher([
    {
      json: {
        data: {
          "reg.1.serverFeatureControl.cf": { Value: "0", Source: "default" },
        },
        Status: "2000",
      },
    },
    { json: { Status: "2000" } },
  ]);
  const { context, writes } = stubContext(mkGlobalArgs());
  await model.methods.reconcileForward.execute(
    // deno-lint-ignore no-explicit-any
    { busy: "200@sip.example.test", confirm: true, _fetch: f } as any,
    context,
  );
  assertEquals(
    calls[1].url,
    "https://phone.example.test/api/v1/mgmt/config/set",
  );
  assertEquals(writes[0].data.mode, "applied");
});

Deno.test("simulateKeyEvent: rejects an invalid KeyName before any send", async () => {
  const { f, calls } = seqFetcher([{ json: { Status: "2000" } }]);
  const { context } = stubContext(mkGlobalArgs());
  await assertRejects(
    () =>
      model.methods.simulateKeyEvent.execute(
        // deno-lint-ignore no-explicit-any
        { keys: ["Home", "Menu"], confirm: true, _fetch: f } as any,
        context,
      ),
    Error,
    "invalid KeyName",
  );
  assertEquals(calls.length, 0);
});

Deno.test("simulateKeyEvent: dry-run previews the sequence, sends nothing", async () => {
  const { f, calls } = seqFetcher([{ json: { Status: "2000" } }]);
  const { context, writes } = stubContext(mkGlobalArgs());
  await model.methods.simulateKeyEvent.execute(
    // deno-lint-ignore no-explicit-any
    { keys: ["Home", "Softkey4"], _fetch: f } as any,
    context,
  );
  assertEquals(calls.length, 0);
  assertEquals(writes[0].data.dryRun, true);
  assertEquals(writes[0].data.keys, ["Home", "Softkey4"]);
});

Deno.test("simulateKeyEvent: confirm sends each Tap SERIALIZED + paced (spec §8)", async () => {
  const { f, calls } = seqFetcher([{ json: { Status: "2000" } }, {
    json: { Status: "2000" },
  }]);
  const paces: number[] = [];
  const { context, writes } = stubContext(mkGlobalArgs());
  await model.methods.simulateKeyEvent.execute({
    keys: ["Home", "Softkey4"],
    confirm: true,
    _fetch: f,
    _sleep: (ms: number) => {
      paces.push(ms);
      return Promise.resolve();
    },
    // deno-lint-ignore no-explicit-any
  } as any, context);
  assertEquals(calls.length, 2);
  assertEquals(JSON.parse(calls[0].body!), {
    data: { Type: "Tap", KeyName: "Home" },
  });
  assertEquals(JSON.parse(calls[1].body!), {
    data: { Type: "Tap", KeyName: "Softkey4" },
  });
  assertEquals(paces, [900]); // one pace between the two taps
  assertEquals(writes[0].data.dryRun, false);
});

Deno.test("reboot: dry-run vs confirm (heavy gate)", async () => {
  const dry = seqFetcher([{ json: { Status: "2000" } }]);
  const c1 = stubContext(mkGlobalArgs());
  // deno-lint-ignore no-explicit-any
  await model.methods.reboot.execute({ _fetch: dry.f } as any, c1.context);
  assertEquals(dry.calls.length, 0);
  assertEquals(c1.writes[0].data.dryRun, true);

  const live = seqFetcher([{ json: { Status: "2000" } }]);
  const c2 = stubContext(mkGlobalArgs());
  // deno-lint-ignore no-explicit-any
  await model.methods.reboot.execute(
    { confirm: true, _fetch: live.f } as any,
    c2.context,
  );
  assertEquals(
    live.calls[0].url,
    "https://phone.example.test/api/v1/mgmt/safeRestart",
  );
  assertEquals(c2.writes[0].data.dryRun, false);
});

Deno.test("pushAlert: DIGEST flow — unauth POST (spipx) → 401 → retry with Digest header", async () => {
  const { f, calls } = seqFetcher([
    {
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: {
        "WWW-Authenticate":
          'Digest realm="phone", nonce="n1", qop="auth", opaque="o1"',
      },
    },
    { ok: true, status: 200, text: "OK" },
  ]);
  const { context, writes } = stubContext(mkGlobalArgs());
  await model.methods.pushAlert.execute(
    // deno-lint-ignore no-explicit-any
    { uri: "/alert", critical: true, _cnonce: "cafef00d", _fetch: f } as any,
    context,
  );
  // First attempt: no Authorization, spipx content-type, the envelope body.
  assertEquals(calls[0].url, "https://phone.example.test/push");
  assertEquals(calls[0].headers?.["Authorization"], undefined);
  assertEquals(
    calls[0].headers?.["Content-Type"],
    "application/x-com-polycom-spipx",
  );
  assertEquals(
    calls[0].body,
    '<PolycomIPPhone><URL priority="critical">/alert</URL></PolycomIPPhone>',
  );
  // Retry carries the digest response.
  assertEquals(
    calls[1].headers?.["Authorization"]?.startsWith("Digest "),
    true,
  );
  assertEquals(writes[0].spec, "pushRun");
  assertEquals(writes[0].data.kind, "alert");
  assertEquals(writes[0].data.authenticated, true);
  assertEquals(writes[0].data.status, 200);
});

Deno.test("setDisplay: pushes a URI swap to /s/<screen>", async () => {
  const { f, calls } = seqFetcher([{ ok: true, status: 200, text: "OK" }]);
  const { context, writes } = stubContext(mkGlobalArgs());
  await model.methods.setDisplay.execute(
    // deno-lint-ignore no-explicit-any
    { screen: "dashboard", _fetch: f } as any,
    context,
  );
  assertEquals(
    calls[0].body,
    '<PolycomIPPhone><URL priority="critical">/s/dashboard</URL></PolycomIPPhone>',
  );
  assertEquals(writes[0].data.kind, "display");
  assertEquals(writes[0].data.uri, "/s/dashboard");
});

Deno.test("captureScreen: auth.htm cookie → GET framebuffer → writes the BMP file", async () => {
  const bmp = new Uint8Array([0x42, 0x4d, 1, 2, 3, 4]); // "BM" + bytes
  const { f, calls } = seqFetcher([
    {
      ok: true,
      status: 200,
      headers: { "Set-Cookie": "session=abc; Path=/; HttpOnly" },
    },
    { ok: true, status: 200, bytes: bmp },
  ]);
  const { context, fileWrites } = stubContext(mkGlobalArgs());
  await model.methods.captureScreen.execute(
    // deno-lint-ignore no-explicit-any
    { _fetch: f, _nonce: "42" } as any,
    context,
  );
  assertEquals(calls[0].url, "https://phone.example.test/form-submit/auth.htm");
  assertEquals(
    calls[1].url,
    "https://phone.example.test/captureScreen/mainScreen?42",
  );
  assertEquals(calls[1].headers?.["Cookie"], "session=abc");
  assertEquals(fileWrites.length, 1);
  assertEquals(fileWrites[0].spec, "screenCapture");
  assertEquals(Array.from(fileWrites[0].bytes), [0x42, 0x4d, 1, 2, 3, 4]);
});

Deno.test("sendPush: no 401 (phone configured Basic/none) ⇒ single POST, unauthenticated flag", async () => {
  const { f, calls } = seqFetcher([{ ok: true, status: 200, text: "done" }]);
  const res = await sendPush(
    {
      phoneHost: "phone.example.test",
      adminUser: "Polycom",
      adminPassword: "adminpin",
      pushUser: "pushuser",
      pushPassword: "pushpin",
      line: "1",
    },
    { uri: "/alert", priority: "normal" },
    f,
    "cafef00d",
  );
  assertEquals(calls.length, 1);
  assertEquals(res.authenticated, false);
  assertEquals(res.ok, true);
});

// ===========================================================================
// Review-hardening: fail-loud guards for the D6 YAML editor (findings 1/4/6)
// ===========================================================================

Deno.test("interpret: duplicate provider ids degrade (never read a sibling's data)", () => {
  // Two providers share id "x": without the guard, one would silently render a
  // tile computed off the other's series. The guard degrades both, loud.
  const dup: Provider[] = [
    {
      id: "x",
      source: { type: "static" },
      tile: {
        label: "A",
        value: { seriesCount: {} },
        sev: { literal: "ok" },
      },
    },
    { id: "x", source: { type: "static" } },
  ];
  const snap = interpret(dup, { x: [ser({}, 1)] });
  assertEquals(snap.tiles, []); // no wrong-but-well-formed tile leaked
  assertEquals(snap.degraded, ["x"]);
});

Deno.test("DisplayConfigSchema: rejects duplicate provider ids (finding 1)", () => {
  assertThrows(() =>
    DisplayConfigSchema.parse({
      providers: [
        { id: "a", source: { type: "static" } },
        { id: "a", source: { type: "static" } },
      ],
    })
  );
});

Deno.test("ThresholdEntrySchema: rejects an entry with >1 severity key (finding 4)", () => {
  // {ok:{}, warn:{gt:1}} would let a permissive ok mask the warn. Schema kills it.
  assertThrows(() =>
    ProviderSchema.parse({
      id: "t",
      source: { type: "static" },
      tile: {
        label: "T",
        value: { seriesCount: {} },
        sev: { thresholds: [{ ok: {}, warn: { gt: 1 } }] },
      },
    })
  );
});

Deno.test("evalThresholds: throws when nothing matches (missing terminal default)", () => {
  // No terminal {ok:{}} and the single rule doesn't match => degrade, not "ok".
  assertThrows(() => evalThresholds(5, [{ crit: { gt: 100 } }], {}));
});

Deno.test("evalThresholds: author-order first-match still wins with valid config", () => {
  const t = [{ crit: { eq: 0 } }, { warn: { lt: 10 } }, { ok: {} }];
  assertEquals(evalThresholds(0, t, {}), "crit");
  assertEquals(evalThresholds(5, t, {}), "warn");
  assertEquals(evalThresholds(50, t, {}), "ok");
});

Deno.test("RowsSpecSchema.key: rejects neither/both label|template (finding 6)", () => {
  const base = {
    id: "r",
    source: { type: "static" },
    rows: {
      forEach: "series",
      msg: { template: "{instance}" },
      sev: { literal: "crit" },
    },
  };
  // neither set
  assertThrows(() =>
    ProviderSchema.parse({ ...base, rows: { ...base.rows, key: {} } })
  );
  // both set
  assertThrows(() =>
    ProviderSchema.parse({
      ...base,
      rows: { ...base.rows, key: { label: "instance", template: "{instance}" } },
    })
  );
  // exactly one set => ok
  ProviderSchema.parse({
    ...base,
    rows: { ...base.rows, key: { label: "instance" } },
  });
});

// ===========================================================================
// Fix-all: remaining review findings F2/F5/F8/F11
// ===========================================================================

/** A synthetic self-signed cert (generated for tests only -- not a real phone). */
const TEST_PEM = `-----BEGIN CERTIFICATE-----
MIIDGzCCAgOgAwIBAgIUcl5bMN1D7auVdhOFDkbBAL9X/uAwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwScGhvbmUuZXhhbXBsZS50ZXN0MB4XDTI2MDkzMDE1NTc1
M1oXDTI2MTAwMTE1NTc1M1owHTEbMBkGA1UEAwwScGhvbmUuZXhhbXBsZS50ZXN0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3t0Lk7HlV/oWZ9b2aTLV
cS0E6iHGpB+bAd89Lw972KPdXOuwb27H0HS7WE5qYEA2D1ttQBUAAZDXtzdsue/T
n6NEvtuX/pOpiElx3EIVhb53Iqw9gt/2hb9jnmT3sEqHbcIaanfwZErLaUB7GeIV
j0xRPDPYrU6cAkggKvk+zPbOzy5B/xYMHJrH3dNySpieQUKMXxic5ey0YxNvrjyJ
E2ikL5eTlr/R1EW5S0XmHynzy+JjACXOciDGT6yN4f8T7FFAnepV6q9bb7DLyLir
HPyH6aupT9pM4NupLXr7KAKYPMPozRuidXvBc+5FhuJj5LnaKeznxW0pvVdDKuwf
MwIDAQABo1MwUTAdBgNVHQ4EFgQUy0BZk4KKvni9gkKrGN2q+PeFu9MwHwYDVR0j
BBgwFoAUy0BZk4KKvni9gkKrGN2q+PeFu9MwDwYDVR0TAQH/BAUwAwEB/zANBgkq
hkiG9w0BAQsFAAOCAQEAD4WG4Fzc9snKbe55v/lJMCOe9RT8q5nh9YukqHrcYVUo
P18eAE9gCkRbX+/bqctvxzbJB6ak4Jgt3/QLMX/jsqjur4+EMlD98Q1A2Xtkrid2
M9MeJJF1KT/a13Djzuz3tW17Tl6MTmTkHc5mas+ug4CcMpcLvBp0KNxSxz/bg6YR
2SPbkFHYOSsa87xZkHZsgpsQpzrgl3IVu781SotZusRpAbae5yCawUm8/w7e6y9Q
tKtexyVhk8m+pXqFwXwouvGMReYFndTctdeKWMo+0eFTiO8VXtRvJAQl6UDO9Sow
vOiFubt7Q/TaZg+OwBaWqMF+SbQTa4dAjgx69MGycg==
-----END CERTIFICATE-----
`;

function cfg(overrides: Record<string, unknown> = {}) {
  return {
    phoneHost: "phone.example.test",
    adminUser: "Polycom",
    adminPassword: "adminpin",
    pushUser: "pushuser",
    pushPassword: "pushpin",
    line: "1",
    ...overrides,
  } as unknown as Parameters<typeof phoneFetch>[0];
}

Deno.test("F2 phoneFetch: no phoneCaCert => falls back to global fetch", () => {
  assertEquals(phoneFetch(cfg()) as unknown, fetch as unknown);
  assertEquals(phoneFetch(cfg({ phoneCaCert: "   " })) as unknown, fetch as unknown);
});

Deno.test("F2 phoneFetch: a pinned cert => a distinct (scoped) fetch, no global bypass", () => {
  const f = phoneFetch(cfg({ phoneCaCert: TEST_PEM }));
  assertEquals(typeof f, "function");
  // Not the global fetch => it built a cert-pinned Deno.HttpClient client.
  assertEquals(f as unknown === (fetch as unknown), false);
});

Deno.test("F5 resolveRef: a ref to a non-referable (custom/absent) provider throws", () => {
  // buildSeriesByProvider leaves custom providers undefined:
  const sbp = buildSeriesByProvider(
    [ProviderSchema.parse({ id: "c", source: { type: "custom", name: "x" } })],
    {},
  );
  assertEquals(sbp["c"], undefined);
  assertThrows(() => resolveRef({ provider: "c", as: "scalar" }, sbp));
  assertThrows(() => resolveRef({ provider: "absent", as: "seriesCount" }, {}));
});

Deno.test("F8 resolveRef: as:scalar over a multi-series provider is rejected as ambiguous", () => {
  const sbp = { m: [ser({ i: "a" }, 1), ser({ i: "b" }, 1)] };
  assertThrows(() => resolveRef({ provider: "m", as: "scalar" }, sbp));
  // seriesCount over the same multi-series is fine (that is the count).
  assertEquals(resolveRef({ provider: "m", as: "seriesCount" }, sbp), 2);
});

Deno.test("F11 buildDigestAuth: auth-int-only challenge is rejected, not silently mis-hashed", () => {
  const base = {
    user: "u", password: "p", method: "POST", uri: "/push", cnonce: "abc",
  };
  assertThrows(() =>
    buildDigestAuth({ ...base, challenge: { realm: "r", nonce: "n", qop: "auth-int" } })
  );
  // A comma list offering auth is accepted and normalized to qop=auth.
  const h = buildDigestAuth({
    ...base,
    challenge: { realm: "r", nonce: "n", qop: "auth,auth-int" },
  });
  assertEquals(h.includes("qop=auth"), true);
  assertEquals(h.includes("auth-int"), false);
});
