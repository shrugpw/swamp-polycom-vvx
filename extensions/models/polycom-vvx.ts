/**
 * @shrug/polycom-vvx — Polycom VVX phone control + real-data idle-display model.
 *
 * Productizes the `design/poc/vvx-microbrowser/` POC into one typed swamp model
 * type (`@shrug/polycom-vvx/phone`, one instance per phone). Two planes live
 * here (design spec §2):
 *
 *  1. CONTROL plane — typed methods 1:1 with the verified REST/push surface
 *     (`design/poc/vvx-microbrowser/CONTROL-SURFACE.md`): discover, pushAlert,
 *     setDisplay, dial, endCall, callStatus, configGet, configSet, getForward,
 *     reconcileForward, simulateKeyEvent, captureScreen, reboot. Transport is
 *     `https://<phoneHost>/api/v1/...`, HTTP Basic auth (except /push which is
 *     HTTP DIGEST), self-signed cert. A SINGLE injectable fetch seam
 *     ({@link phoneRequest} / {@link sendPush}) carries all phone I/O so tests
 *     drive canned envelopes with no network.
 *
 *  2. DATA plane — {@link composeIdleSnapshot}, the typed-primitive interpreter
 *     (spec §5). It reads `displayConfig.providers` and each provider's recorded
 *     Grafana `queryResult` (whose `results` field is a JSON-ENCODED STRING —
 *     spec §5.0), `JSON.parse`s it into a series array, and maps it to the
 *     normalized `{tiles, rows, degraded, notes, epoch}` snapshot the render
 *     daemon serves. The interpreter core is a PURE function ({@link interpret})
 *     over already-fetched series, so the whole vocabulary is unit-testable with
 *     fixtures and no I/O.
 *
 * ## Safety (spec §8) — baked into every phone-facing method
 *
 * - SERIALIZE + pace. The phone httpd wedges under bursty/parallel calls, so
 *   nothing here fans out parallel requests at one phone; UI-drive
 *   (`simulateKeyEvent`) paces ~0.9s between taps.
 * - DRY-RUN by default. Every GATED write (dial, endCall, configSet,
 *   reconcileForward, simulateKeyEvent, reboot) requires an explicit
 *   `confirm: true`; otherwise it returns the would-do preview and sends NOTHING
 *   (the house never-dryRun-false-without-approval gate).
 * - VERIFY before destructive. reconcileForward reads the current divert config
 *   back before proposing a write and refuses on a server-controlled line.
 *
 * Secrets (`adminPassword`, `pushPassword`) are vault refs resolved into
 * globalArguments — never literals in code.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { createHash } from "node:crypto";

// ===========================================================================
// SECTION A — the typed-primitive interpreter (spec §5). Pure, no I/O.
// ===========================================================================

/** Severity vocabulary (spec §5); screens.py maps each to a palette color. */
export const SEVERITIES = ["ok", "warn", "crit", "info"] as const;
export type Sev = (typeof SEVERITIES)[number];
const SevEnum = z.enum(SEVERITIES);

/**
 * One parsed Prometheus/Loki series: metric labels + `[ts, "value"]` samples.
 * This is the shape trapped inside a Grafana `queryResult.results` JSON string
 * (spec §5.0); {@link buildSeriesByProvider} parses it out.
 */
export interface Series {
  metric: Record<string, string>;
  values: Array<[number | string, string]>;
}

/** One of the (max 3) top stat tiles: a big value + label, colored by sev. */
export interface Tile {
  value: string;
  label: string;
  sev: Sev;
}

/** One detail row in the fleet list: a sev dot + a stable key + a message. */
export interface Row {
  sev: Sev;
  key: string;
  msg: string;
}

/** The normalized snapshot the render daemon consumes (spec §5.3 output). */
export interface Snapshot {
  tiles: Tile[];
  rows: Row[];
  degraded: string[];
  notes: string[];
  epoch: number;
}

// --- provider vocabulary schemas (spec §5.1) -------------------------------
// Every field is a small typed object with exactly one shape — never a
// free-form expression string. The interpreter is a switch over these kinds.

/** A numeric reference: another provider's number, or a constant (spec §5.1). */
const RefSchema = z.union([
  z.object({
    provider: z.string(),
    as: z.enum(["scalar", "seriesCount"]).default("scalar"),
  }),
  z.object({ const: z.number() }),
]);
export type Ref = z.infer<typeof RefSchema>;

/**
 * A single predicate over a numeric value (spec §5.1). Exactly one key is set:
 * a literal comparison (`eq|ne|lt|lte|gt|gte`) or a ref comparison
 * (`ltRef|gtRef`). An empty object `{}` is the always-true default.
 */
const PredicateSchema = z.object({
  eq: z.number().optional(),
  ne: z.number().optional(),
  lt: z.number().optional(),
  lte: z.number().optional(),
  gt: z.number().optional(),
  gte: z.number().optional(),
  ltRef: RefSchema.optional(),
  gtRef: RefSchema.optional(),
});
export type Predicate = z.infer<typeof PredicateSchema>;

/**
 * One ordered threshold entry: exactly one severity key mapping to a predicate,
 * e.g. `{ crit: { eq: 0 } }` or the terminal default `{ ok: {} }`.
 */
const ThresholdEntrySchema = z.object({
  ok: PredicateSchema.optional(),
  warn: PredicateSchema.optional(),
  crit: PredicateSchema.optional(),
  info: PredicateSchema.optional(),
}).refine(
  // EXACTLY one severity key per entry: else the fixed check order could let a
  // permissive `ok` mask a `crit` in the same entry (silent under-alerting).
  (e) => Object.values(e).filter((v) => v !== undefined).length === 1,
  { message: "a threshold entry must set exactly one severity key" },
);
export type ThresholdEntry = z.infer<typeof ThresholdEntrySchema>;

/** A tile value spec — exactly ONE of the four kinds is set (spec §5.1). */
const TileValueSchema = z.object({
  seriesCount: z.object({}).optional(),
  scalar: z.object({
    reduce: z.enum(["last", "max", "min", "sum", "avg"]).default("last"),
  }).optional(),
  fraction: z.object({ num: RefSchema, den: RefSchema }).optional(),
  literal: z.string().optional(),
});

/** A tile severity spec — literal OR ordered thresholds (spec §5.1). */
const TileSevSchema = z.object({
  literal: SevEnum.optional(),
  thresholds: z.array(ThresholdEntrySchema).optional(),
});

const TileSpecSchema = z.object({
  label: z.string(),
  value: TileValueSchema,
  sev: TileSevSchema,
});

/** A row filter (spec §5.1) — default is `{always:{}}`. */
const WhereSchema = z.object({
  labelEq: z.record(z.string(), z.string()).optional(),
  valueEq: z.number().optional(),
  always: z.object({}).optional(),
});

const RowsSpecSchema = z.object({
  forEach: z.literal("series"),
  where: WhereSchema.optional(),
  key: z.object({
    label: z.string().optional(),
    template: z.string().optional(),
  }).refine(
    // Exactly one of label|template: neither ⇒ every row keys to "" and the
    // dedup step collapses real rows into one (silent data loss).
    (k) => (k.label !== undefined) !== (k.template !== undefined),
    { message: "rows.key needs exactly one of label|template" },
  ),
  msg: z.object({ template: z.string() }),
  sev: z.object({
    literal: SevEnum.optional(),
    byValue: z.array(ThresholdEntrySchema).optional(),
  }),
});

/** A provider source (spec §5.1). `static` carries inline series; `custom`
 * names a registered TS reducer (spec §5.4). */
const SourceSchema = z.object({
  type: z.enum([
    "grafana-promql",
    "grafana-logql",
    "swamp-data",
    "static",
    "custom",
  ]),
  dataName: z.string().optional(),
  model: z.string().optional(),
  // Inline series for a `static` (or test) source.
  series: z.array(z.object({
    metric: z.record(z.string(), z.string()).default({}),
    values: z.array(z.array(z.union([z.number(), z.string()]))).default([]),
  })).optional(),
  // Registered reducer name for `custom` (spec §5.4).
  name: z.string().optional(),
});

/** One declarative provider (spec §5.1): identity + source + optional
 * tile/rows mappings. */
export const ProviderSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  tile: TileSpecSchema.optional(),
  rows: RowsSpecSchema.optional(),
});
export type Provider = z.infer<typeof ProviderSchema>;

/** The declarative idle-display config (spec §5.2 / §6). */
export const DisplayConfigSchema = z.object({
  refreshSeconds: z.number().default(30),
  // Provider ids must be UNIQUE: the interpreter keys series by id, so a
  // duplicate id would make one provider silently read another's data. Reject
  // it fail-loud at config parse (the D6 YAML editor's safety net).
  providers: z.array(ProviderSchema).default([]).refine(
    (ps) => new Set(ps.map((p) => p.id)).size === ps.length,
    { message: "provider ids must be unique" },
  ),
});
export type DisplayConfig = z.infer<typeof DisplayConfigSchema>;

// --- pure helpers ----------------------------------------------------------

/** Format a number the way the tiles read: integer bare, else 2 decimals. */
export function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * Reduce the FIRST series' time samples to one number (spec §5.1 `scalar`).
 * `count(up==1)` returns a single series whose latest sample IS the count, so
 * `last` is the common reduce. Throws when there is no numeric sample — that
 * degrades the provider rather than silently inventing a 0 (§5.3).
 */
export function reduceFirstSeries(
  series: Series[],
  reduce: "last" | "max" | "min" | "sum" | "avg",
): number {
  if (series.length === 0) throw new Error("no series to reduce");
  const samples = series[0].values
    .map((v) => Number(v[1]))
    .filter((n) => Number.isFinite(n));
  if (samples.length === 0) throw new Error("series has no numeric samples");
  switch (reduce) {
    case "last":
      return samples[samples.length - 1];
    case "max":
      return Math.max(...samples);
    case "min":
      return Math.min(...samples);
    case "sum":
      return samples.reduce((a, b) => a + b, 0);
    case "avg":
      return samples.reduce((a, b) => a + b, 0) / samples.length;
  }
}

/**
 * Resolve a numeric `<ref>` (spec §5.1): a constant, or another provider's
 * number (`as: scalar` reduces last, `as: seriesCount` counts). Throws when the
 * referenced provider's series is missing — the tile's provider then degrades.
 */
export function resolveRef(
  ref: Ref,
  seriesByProvider: Record<string, Series[] | undefined>,
): number {
  if ("const" in ref) return ref.const;
  const s = seriesByProvider[ref.provider];
  if (s === undefined) {
    // Missing/absent provider, or a `custom` provider (which emits tiles/rows,
    // not a referable number -- buildSeriesByProvider leaves those undefined).
    // Fail loud rather than silently resolve to 0/empty (findings F5).
    throw new Error(
      `ref provider '${ref.provider}' is not referable ` +
        `(unknown, or a custom provider -- refs need a data-only source)`,
    );
  }
  if (ref.as === "seriesCount") return s.length;
  // `as: scalar` (default) over a multi-series result is ambiguous and
  // non-deterministic (series order isn't stable) -- make the author choose
  // (finding F8). Single-series scalars (count(...) etc.) are the common case.
  if (s.length > 1) {
    throw new Error(
      `ref provider '${ref.provider}' has ${s.length} series; ` +
        `'as: scalar' is ambiguous -- use 'as: seriesCount' or a single-series query`,
    );
  }
  return reduceFirstSeries(s, "last");
}

/** Evaluate a single predicate against numeric `v` (spec §5.1). Empty ⇒ true. */
export function matchPredicate(
  v: number,
  pred: Predicate,
  seriesByProvider: Record<string, Series[] | undefined>,
): boolean {
  if (pred.eq !== undefined) return v === pred.eq;
  if (pred.ne !== undefined) return v !== pred.ne;
  if (pred.lt !== undefined) return v < pred.lt;
  if (pred.lte !== undefined) return v <= pred.lte;
  if (pred.gt !== undefined) return v > pred.gt;
  if (pred.gte !== undefined) return v >= pred.gte;
  if (pred.ltRef !== undefined) {
    return v < resolveRef(pred.ltRef, seriesByProvider);
  }
  if (pred.gtRef !== undefined) {
    return v > resolveRef(pred.gtRef, seriesByProvider);
  }
  return true; // {} default (the terminal {ok:{}})
}

/** First-match-wins over ordered thresholds (spec §5.1). */
export function evalThresholds(
  v: number,
  thresholds: ThresholdEntry[],
  seriesByProvider: Record<string, Series[] | undefined>,
): Sev {
  for (const entry of thresholds) {
    for (const sev of SEVERITIES) {
      const pred = entry[sev];
      if (pred !== undefined && matchPredicate(v, pred, seriesByProvider)) {
        return sev;
      }
    }
  }
  // No entry matched: the config is broken (missing terminal {ok:{}}). Throw so
  // the provider DEGRADES visibly, rather than rendering a false "ok" on what is
  // an alerting surface (better a stale/degraded tile than a lying green one).
  throw new Error("no threshold matched (missing terminal default?)");
}

/** Interpolate `{label}` (from metric labels) + reserved `{value}` (spec §5.1). */
export function interpolate(template: string, series: Series): string {
  let value = "";
  try {
    value = fmtNum(reduceFirstSeries([series], "last"));
  } catch {
    value = "";
  }
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (name === "value") return value;
    return series.metric[name] ?? "";
  });
}

/** The numeric value a tile's thresholds/refs compare against (spec §5.2:
 * a fraction compares by its numerator; a literal has none). */
function tileNumericValue(
  tile: z.infer<typeof TileSpecSchema>,
  seriesByProvider: Record<string, Series[] | undefined>,
  own: Series[] | undefined,
): number | undefined {
  const value = tile.value;
  if (value.seriesCount) {
    if (own === undefined) throw new Error("source has no series");
    return own.length;
  }
  if (value.scalar) {
    if (own === undefined) throw new Error("source has no series");
    return reduceFirstSeries(own, value.scalar.reduce);
  }
  if (value.fraction) return resolveRef(value.fraction.num, seriesByProvider);
  return undefined; // literal
}

/** Render a tile's display string (spec §5.1). */
function renderTileValue(
  tile: z.infer<typeof TileSpecSchema>,
  seriesByProvider: Record<string, Series[] | undefined>,
  own: Series[] | undefined,
): string {
  const value = tile.value;
  if (value.seriesCount) {
    if (own === undefined) throw new Error("source has no series");
    return String(own.length);
  }
  if (value.scalar) {
    if (own === undefined) throw new Error("source has no series");
    return fmtNum(reduceFirstSeries(own, value.scalar.reduce));
  }
  if (value.fraction) {
    const num = resolveRef(value.fraction.num, seriesByProvider);
    const den = resolveRef(value.fraction.den, seriesByProvider);
    return `${Math.round(num)}/${Math.round(den)}`;
  }
  if (value.literal !== undefined) return value.literal;
  throw new Error("tile.value has no kind set");
}

/** Compute a tile's severity (spec §5.1). */
function tileSev(
  tile: z.infer<typeof TileSpecSchema>,
  numeric: number | undefined,
  seriesByProvider: Record<string, Series[] | undefined>,
): Sev {
  if (tile.sev.literal !== undefined) return tile.sev.literal;
  if (tile.sev.thresholds !== undefined) {
    if (numeric === undefined) {
      throw new Error("thresholds require a numeric tile value");
    }
    return evalThresholds(numeric, tile.sev.thresholds, seriesByProvider);
  }
  throw new Error("tile.sev has no kind set");
}

/** Does a series pass a row `where` filter (spec §5.1)? Default: yes. */
function matchWhere(
  series: Series,
  where: z.infer<typeof WhereSchema> | undefined,
): boolean {
  if (!where || where.always) return true;
  if (where.labelEq) {
    return Object.entries(where.labelEq).every(
      ([k, v]) => series.metric[k] === v,
    );
  }
  if (where.valueEq !== undefined) {
    try {
      return reduceFirstSeries([series], "last") === where.valueEq;
    } catch {
      return false;
    }
  }
  return true;
}

/** A provider's contribution to the screen (spec §5.4 custom-reducer shape). */
export interface Fragment {
  tiles: Tile[];
  rows: Row[];
}

/** A registered custom reducer (spec §5.4 escape hatch). */
export type CustomReducer = (
  provider: Provider,
  seriesByProvider: Record<string, Series[] | undefined>,
) => Fragment;

/**
 * The custom-reducer registry (spec §5.4). The dispatch SEAM exists even with
 * zero reducers registered: a `source.type: custom` provider whose `name` is
 * not registered degrades cleanly. Register real reducers with
 * {@link registerCustomReducer} — a deliberate, reviewed code edit, never the
 * default path.
 */
const CUSTOM_REDUCERS: Record<string, CustomReducer> = {};

/** Register a custom reducer under `name` (spec §5.4). */
export function registerCustomReducer(name: string, fn: CustomReducer): void {
  CUSTOM_REDUCERS[name] = fn;
}

/** Evaluate ONE provider into a fragment (throws ⇒ the provider degrades). */
function evalProvider(
  p: Provider,
  seriesByProvider: Record<string, Series[] | undefined>,
  customReducers: Record<string, CustomReducer>,
): Fragment {
  if (p.source.type === "custom") {
    const reducer = customReducers[p.source.name ?? ""];
    if (!reducer) {
      throw new Error(`no custom reducer registered as '${p.source.name}'`);
    }
    return reducer(p, seriesByProvider);
  }

  const own = seriesByProvider[p.id];
  const tiles: Tile[] = [];
  const rows: Row[] = [];

  if (p.tile) {
    const numeric = tileNumericValue(p.tile, seriesByProvider, own);
    const value = renderTileValue(p.tile, seriesByProvider, own);
    const sev = tileSev(p.tile, numeric, seriesByProvider);
    tiles.push({ value, label: p.tile.label, sev });
  }

  if (p.rows) {
    if (own === undefined) throw new Error("source has no series");
    for (const s of own) {
      if (!matchWhere(s, p.rows.where)) continue;
      const key = p.rows.key.template
        ? interpolate(p.rows.key.template, s)
        : (s.metric[p.rows.key.label ?? ""] ?? "");
      const msg = interpolate(p.rows.msg.template, s);
      let sev: Sev = "info";
      if (p.rows.sev.literal !== undefined) {
        sev = p.rows.sev.literal;
      } else if (p.rows.sev.byValue !== undefined) {
        const v = reduceFirstSeries([s], "last");
        sev = evalThresholds(v, p.rows.sev.byValue, seriesByProvider);
      }
      rows.push({ sev, key, msg });
    }
  }

  return { tiles, rows };
}

/**
 * THE typed-primitive interpreter (spec §5.3). Pure: given the declarative
 * providers and the ALREADY-FETCHED series keyed by provider id, produce the
 * normalized snapshot. No expression eval, no I/O.
 *
 * Merge + degrade rules (spec §5.3):
 *  1. Tiles concatenated in provider order, then CAPPED AT 3 (phone real estate).
 *  2. Rows concatenated in provider order, deduped by `key` (first wins).
 *  3. A provider that is missing/unparseable OR whose mapping throws is SKIPPED,
 *     its id recorded in `degraded[]` — degrade, never abort (all-or-nothing per
 *     provider: a mid-mapping throw contributes NOTHING, not a partial tile).
 *  4. If zero crit/warn rows remain, append the resting "all systems nominal" row.
 *  5. Stamp `epoch`; `degraded` is the list of degraded provider ids.
 *
 * @param providers The declarative provider list (spec §5.1).
 * @param seriesByProvider Parsed series keyed by provider id; `undefined` for a
 *   provider whose source was missing/unparseable.
 * @param opts.epoch Injectable epoch (seconds) for deterministic tests.
 * @param opts.customReducers Injectable custom-reducer registry (spec §5.4).
 */
export function interpret(
  providers: Provider[],
  seriesByProvider: Record<string, Series[] | undefined>,
  opts: { epoch?: number; customReducers?: Record<string, CustomReducer> } = {},
): Snapshot {
  const customReducers = opts.customReducers ?? CUSTOM_REDUCERS;
  const tiles: Tile[] = [];
  const rows: Row[] = [];
  const degraded: string[] = [];
  const notes: string[] = [];

  // Duplicate provider ids would make siblings read each other's series
  // (buildSeriesByProvider keys by id). Degrade every provider sharing a
  // duplicated id -- loud, never a silently-wrong tile (§5.3).
  const idCounts = new Map<string, number>();
  for (const p of providers) idCounts.set(p.id, (idCounts.get(p.id) ?? 0) + 1);

  for (const p of providers) {
    if ((idCounts.get(p.id) ?? 0) > 1) {
      if (!degraded.includes(p.id)) {
        degraded.push(p.id);
        notes.push(`${p.id}: duplicate provider id -- skipped`);
      }
      continue;
    }
    try {
      const frag = evalProvider(p, seriesByProvider, customReducers);
      tiles.push(...frag.tiles);
      rows.push(...frag.rows);
    } catch (err) {
      degraded.push(p.id);
      const detail = err instanceof Error ? err.message : String(err);
      notes.push(`${p.id}: ${detail}`);
    }
  }

  // Dedup rows by key (first occurrence wins), preserving provider order.
  const seen = new Set<string>();
  const dedupedRows: Row[] = [];
  for (const r of rows) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    dedupedRows.push(r);
  }

  // Resting state: no crit/warn ⇒ show a calm row rather than an empty panel.
  const hasAlert = dedupedRows.some((r) =>
    r.sev === "crit" || r.sev === "warn"
  );
  const finalRows = hasAlert ? dedupedRows : [...dedupedRows, {
    sev: "ok" as Sev,
    key: "all systems",
    msg: "nominal",
  }];

  return {
    tiles: tiles.slice(0, 3),
    rows: finalRows,
    degraded,
    notes,
    epoch: opts.epoch ?? Math.floor(Date.now() / 1000),
  };
}

/**
 * Build the `seriesByProvider` map the interpreter consumes (spec §5.0/§5.3
 * step 1). This is where the unavoidable TS `JSON.parse` of the Grafana
 * `queryResult.results` STRING happens — swamp-native CEL cannot do it (§5.0).
 *
 *  - `static` (and `custom`) providers: inline `source.series`.
 *  - grafana/swamp-data providers: look up `queryResults[source.dataName]`, then
 *    `JSON.parse(results)` into a series array. A missing entry or a parse
 *    failure yields `undefined` for that provider (the interpreter degrades it).
 *
 * @param providers The declarative provider list.
 * @param queryResults Recorded Grafana query results keyed by `dataName`; each
 *   is `{query, resultType, results, seriesCount, timestamp}` with `results` a
 *   JSON-encoded string (spec §5.0). In production these come via
 *   `data.latest(model, dataName)` (rule 3, no re-fetch).
 */
export function buildSeriesByProvider(
  providers: Provider[],
  queryResults: Record<string, { results?: unknown; [k: string]: unknown }>,
): Record<string, Series[] | undefined> {
  const out: Record<string, Series[] | undefined> = {};
  for (const p of providers) {
    if (p.source.type === "static") {
      out[p.id] = (p.source.series ?? []).map(normalizeSeries);
      continue;
    }
    if (p.source.type === "custom") {
      // A custom provider produces tiles/rows via its reducer, not a series.
      // Leave it undefined so a ref to it fails loud in resolveRef (F5) rather
      // than silently reading an (empty) source.series.
      out[p.id] = undefined;
      continue;
    }
    const dataName = p.source.dataName;
    const qr = dataName ? queryResults[dataName] : undefined;
    if (!qr || typeof qr.results !== "string") {
      out[p.id] = undefined;
      continue;
    }
    try {
      const parsed = JSON.parse(qr.results);
      out[p.id] = Array.isArray(parsed)
        ? parsed.map(normalizeSeries)
        : undefined;
    } catch {
      out[p.id] = undefined;
    }
  }
  return out;
}

/** Coerce a loosely-typed parsed series into the {@link Series} shape. */
function normalizeSeries(raw: unknown): Series {
  const o = (raw ?? {}) as Record<string, unknown>;
  const metricRaw = (o.metric ?? {}) as Record<string, unknown>;
  const metric: Record<string, string> = {};
  for (const [k, v] of Object.entries(metricRaw)) metric[k] = String(v);
  const valuesRaw = Array.isArray(o.values) ? o.values : [];
  const values: Array<[number | string, string]> = valuesRaw.map((pair) => {
    const p = pair as unknown[];
    return [p?.[0] as number | string, String(p?.[1] ?? "")];
  });
  return { metric, values };
}

// ===========================================================================
// SECTION B — the control plane (spec §3.2). Single injectable fetch seam.
// ===========================================================================

/** A minimal `fetch`-compatible response (the subset the methods use). */
export interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** A `fetch`-compatible function (injected in tests). */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

/** Config the seam reads (a subset of globalArguments). */
export interface PhoneConfig {
  phoneHost: string;
  adminUser: string;
  adminPassword: string;
  pushUser: string;
  pushPassword: string;
  line: string;
  /** PEM of the phone's self-signed cert to pin TLS trust to (F2). Empty ⇒
   * system trust (self-signed then needs a host-level bypass). */
  phoneCaCert?: string;
}

/** The phone's response envelope, decided in ONE tested place (spec §3.2). */
export interface Envelope {
  status: string;
  data: Record<string, unknown> | undefined;
  invalidParams: string[] | undefined;
  raw: unknown;
}

/**
 * Parse the `{"data":..,"Status":..}` phone envelope (spec §3.2 / CONTROL-
 * SURFACE.md). Status `2000` success, `4000` bad param, `4007` no active call;
 * unknown config names come back under `data.InvalidParams` (a namespace probe).
 * Pure + isolated so a status-code surprise is a one-line fix with one fixture.
 */
export function parseEnvelope(raw: unknown): Envelope {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const status = obj.Status !== undefined ? String(obj.Status) : "";
  const data = (obj.data && typeof obj.data === "object")
    ? obj.data as Record<string, unknown>
    : undefined;
  let invalidParams: string[] | undefined;
  const ip = data?.InvalidParams;
  if (Array.isArray(ip)) invalidParams = ip.map((x) => String(x));
  else if (ip && typeof ip === "object") invalidParams = Object.keys(ip);
  return { status, data, invalidParams, raw };
}

/** Base64 a `user:password` for HTTP Basic. */
function basicAuth(user: string, password: string): string {
  return "Basic " + btoa(`${user}:${password}`);
}

/**
 * Cert-pinned fetch for the phone (finding F2). The phone serves a self-signed
 * cert; rather than the process-wide `--unsafely-ignore-certificate-errors`
 * bypass (which weakens TLS for EVERY outbound call in the worker), we pin trust
 * to the phone's own cert via `Deno.createHttpClient({caCerts})` -- scoped to
 * exactly this connection. If `phoneCaCert` is unset we fall back to system
 * trust (documented: a self-signed phone then still needs the host bypass;
 * pinning is strongly preferred). Clients are cached by cert for the process.
 * Tests inject their own `doFetch`, so this is never exercised under test.
 */
const _phoneClients = new Map<string, Deno.HttpClient>();
export function phoneFetch(cfg: PhoneConfig): FetchLike {
  const cert = cfg.phoneCaCert?.trim();
  if (!cert) return fetch as unknown as FetchLike;
  let client = _phoneClients.get(cert);
  if (!client) {
    client = Deno.createHttpClient({ caCerts: [cert] });
    _phoneClients.set(cert, client);
  }
  const pinned = client;
  return ((
    input: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) =>
    fetch(input, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      client: pinned,
    })) as unknown as FetchLike;
}

/**
 * The SOLE REST network seam (spec §3.2): one Basic-authed JSON request to
 * `https://<phoneHost>/api/v1/<path>`, envelope parsed by {@link parseEnvelope}.
 * All Basic-auth control methods call this; tests inject `doFetch`.
 *
 * Production TLS is handled by the default `doFetch` = {@link phoneFetch}, which
 * pins to the phone's self-signed cert (F2) -- no global TLS bypass required.
 */
export async function phoneRequest(
  cfg: PhoneConfig,
  opts: { method: string; path: string; body?: unknown },
  doFetch: FetchLike = phoneFetch(cfg),
): Promise<Envelope> {
  const url = `https://${cfg.phoneHost}/api/v1/${
    opts.path.replace(/^\/+/, "")
  }`;
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Authorization": basicAuth(cfg.adminUser, cfg.adminPassword),
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const resp = await doFetch(url, { method: opts.method, headers, body });
  let json: unknown = {};
  let parsed = false;
  try {
    json = await resp.json();
    parsed = true;
  } catch {
    json = {};
  }
  // A wedged phone httpd returns a non-JSON error body (HTML 500 etc., spec §8).
  // Surface the real HTTP status instead of masking it as an empty envelope --
  // the `{}` normalization above otherwise hid the status exactly when a stuck
  // phone most needs diagnosing.
  const looksEnvelope = parsed && json !== null && typeof json === "object" &&
    ("Status" in (json as Record<string, unknown>) ||
      "data" in (json as Record<string, unknown>));
  if (!resp.ok && !looksEnvelope) {
    throw new Error(
      `phone ${opts.method} ${opts.path} failed (HTTP ${resp.status} ${resp.statusText})`,
    );
  }
  return parseEnvelope(json);
}

// --- HTTP Digest for the push channel (CONTROL-SURFACE.md §push) ------------

function md5hex(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

/** Parse an RFC 2617 `WWW-Authenticate: Digest ...` challenge. */
export function parseDigestChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = header.replace(/^\s*Digest\s+/i, "");
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[m[1]] = m[2] !== undefined ? m[2] : (m[3] ?? "").trim();
  }
  return out;
}

/**
 * Build an RFC 2617 `Authorization: Digest` header value (MD5). The phone's
 * `/push` endpoint requires DIGEST — a preemptive Basic header makes its httpd
 * 500 (CONTROL-SURFACE.md), so the flow is: unauth POST → 401 challenge →
 * this. `cnonce` is injectable for deterministic tests.
 */
export function buildDigestAuth(args: {
  user: string;
  password: string;
  method: string;
  uri: string;
  challenge: Record<string, string>;
  cnonce: string;
  nc?: string;
}): string {
  const { user, password, method, uri, challenge, cnonce } = args;
  const realm = challenge.realm ?? "";
  const nonce = challenge.nonce ?? "";
  // Normalize qop: the server may offer "auth", "auth-int", or a comma list.
  // We only implement the qop=auth HA2 (md5(method:uri)); auth-int needs a body
  // hash we don't compute. Pick "auth" if offered; reject an auth-int-only
  // challenge loudly rather than send a silently-wrong response (finding F11).
  let qop = challenge.qop;
  if (qop) {
    const offered = qop.split(",").map((q) => q.trim()).filter(Boolean);
    if (offered.includes("auth")) {
      qop = "auth";
    } else {
      throw new Error(
        `unsupported digest qop '${challenge.qop}' (only 'auth' is supported)`,
      );
    }
  }
  const opaque = challenge.opaque;
  const nc = args.nc ?? "00000001";
  const ha1 = md5hex(`${user}:${realm}:${password}`);
  const ha2 = md5hex(`${method}:${uri}`);
  const response = qop
    ? md5hex(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5hex(`${ha1}:${nonce}:${ha2}`);
  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", ` +
    `uri="${uri}", response="${response}", algorithm=MD5`;
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) h += `, opaque="${opaque}"`;
  return h;
}

/** Escape XML text for the push envelope. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Build a Polycom push (spipx) envelope (CONTROL-SURFACE.md / server.py). */
export function buildPushEnvelope(
  opts: { uri?: string; message?: string; priority: "critical" | "normal" },
): string {
  const inner = opts.uri !== undefined
    ? `<URL priority="${opts.priority}">${escapeXml(opts.uri)}</URL>`
    : `<Data priority="${opts.priority}"><h1>${
      escapeXml(opts.message ?? "")
    }</h1></Data>`;
  return `<PolycomIPPhone>${inner}</PolycomIPPhone>`;
}

/** The result of a push (spec §3.4 pushRun audit input). */
export interface PushResult {
  status: number;
  ok: boolean;
  authenticated: boolean;
  body: string;
}

/**
 * The SOLE push network seam (spec §3.2 pushAlert/setDisplay). POSTs the spipx
 * envelope to `https://<phoneHost>/push` with the DIGEST challenge/response
 * flow. `cnonce` is injectable for deterministic tests.
 */
export async function sendPush(
  cfg: PhoneConfig,
  opts: { uri?: string; message?: string; priority: "critical" | "normal" },
  doFetch: FetchLike = phoneFetch(cfg),
  cnonce: string = crypto.randomUUID().replace(/-/g, ""),
): Promise<PushResult> {
  const url = `https://${cfg.phoneHost}/push`;
  const body = buildPushEnvelope(opts);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-com-polycom-spipx",
  };
  // First try WITHOUT auth (preemptive Basic 500s the phone; digest answers 401).
  let resp = await doFetch(url, { method: "POST", headers, body });
  let authenticated = false;
  if (resp.status === 401) {
    const challengeHeader = resp.headers.get("WWW-Authenticate") ??
      resp.headers.get("www-authenticate") ?? "";
    const challenge = parseDigestChallenge(challengeHeader);
    const auth = buildDigestAuth({
      user: cfg.pushUser,
      password: cfg.pushPassword,
      method: "POST",
      uri: "/push",
      challenge,
      cnonce,
    });
    resp = await doFetch(url, {
      method: "POST",
      headers: { ...headers, "Authorization": auth },
      body,
    });
    authenticated = true;
  }
  let text = "";
  try {
    text = await resp.text();
  } catch {
    text = "";
  }
  return { status: resp.status, ok: resp.ok, authenticated, body: text };
}

// --- call-forward (divert) param builders (ported from server.py) ----------

/** The local call-forward (divert) params for a registration index. */
export function forwardParams(line: string): Record<string, string> {
  return {
    busyContact: `divert.busy.${line}.contact`,
    busyEnabled: `divert.busy.${line}.enabled`,
    naContact: `divert.noanswer.${line}.contact`,
    naEnabled: `divert.noanswer.${line}.enabled`,
    naTimeout: `divert.noanswer.${line}.timeout`,
    serverCf: `reg.${line}.serverFeatureControl.cf`,
  };
}

/**
 * Translate forward INTENT into the flat param set (ported from server.py). A
 * contact of "" clears + disables that divert type; a non-empty contact enables
 * it. Returns only the params the caller actually intends to change.
 */
export function buildForwardWrites(
  line: string,
  intent: { busy?: string; noanswer?: string; naTimeout?: string | number },
): Record<string, string> {
  const p = forwardParams(line);
  const writes: Record<string, string> = {};
  if (intent.busy !== undefined) {
    writes[p.busyContact] = intent.busy;
    writes[p.busyEnabled] = intent.busy ? "1" : "0";
  }
  if (intent.noanswer !== undefined) {
    writes[p.naContact] = intent.noanswer;
    writes[p.naEnabled] = intent.noanswer ? "1" : "0";
  }
  if (intent.naTimeout !== undefined) {
    writes[p.naTimeout] = String(intent.naTimeout);
  }
  return writes;
}

/** Pace helper (spec §8): serialize UI drive ~0.9s. Injectable for tests. */
export type SleepLike = (ms: number) => Promise<void>;
const realSleep: SleepLike = (ms) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// SECTION C — globalArguments + resource schemas (spec §3.1 / §3.4)
// ===========================================================================

const GlobalArgsSchema = z.object({
  phoneHost: z.string().min(1).describe(
    "Phone IP/host — the REST + push target (e.g. phone.example.test).",
  ),
  adminUser: z.string().default("Polycom").describe(
    "HTTP Basic user for the REST API (Poly default 'Polycom').",
  ),
  adminPassword: z.string().default("").meta({ sensitive: true }).describe(
    "Web Config ADMIN password (also the REST password). CEL vault ref → " +
      'vault.get("vvx","<phone>/admin"). Never a literal.',
  ),
  pushUser: z.string().default("").describe(
    "Push (digest) user for the /push channel.",
  ),
  pushPassword: z.string().default("").meta({ sensitive: true }).describe(
    'Push (digest) password. CEL vault ref → vault.get("vvx","<phone>/push").',
  ),
  phoneCaCert: z.string().default("").describe(
    "The phone's self-signed TLS cert (PEM) to PIN trust to -- REST/push then " +
      "verify against exactly this cert, so NO global TLS bypass is needed. " +
      "Capture once: `openssl s_client -connect <phone>:443 </dev/null 2>/dev/null " +
      "| openssl x509`. Inline PEM or a vault ref. If empty, connections fall " +
      "back to system trust (a self-signed phone then needs " +
      "--unsafely-ignore-certificate-errors on the host -- pinning is preferred).",
  ),
  serveBaseUrl: z.string().default("").describe(
    "The render/serve daemon URL the phone points its mb.*/event at " +
      "(e.g. http://host.example:7070). Used to build setDisplay/pushAlert URIs.",
  ),
  grafanaModel: z.string().default("shrug-grafana").describe(
    "Grafana source model instance (@keeb/grafana/instance) whose recorded " +
      "queryResults composeIdleSnapshot reads.",
  ),
  grafanaRepoDir: z.string().default("").describe(
    "Cross-repo path where the grafana model lives (for the compose workflow).",
  ),
  displayConfig: DisplayConfigSchema.default({
    refreshSeconds: 30,
    providers: [],
  })
    .describe(
      "The declarative idle-display provider list + refresh cadence (spec §5). " +
        "Changing a tile/row is a YAML edit here, never a code edit.",
    ),
  line: z.string().default("1").describe(
    "SIP line/registration index for dial + call-forward (default '1').",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Narrow globalArgs to the seam's {@link PhoneConfig}. */
function phoneCfg(g: GlobalArgs): PhoneConfig {
  return {
    phoneHost: g.phoneHost,
    adminUser: g.adminUser,
    adminPassword: g.adminPassword,
    pushUser: g.pushUser,
    pushPassword: g.pushPassword,
    line: g.line,
    phoneCaCert: g.phoneCaCert,
  };
}

// --- resource (dataOutputSpec) schemas (spec §3.4) -------------------------

const DeviceInfoSchema = z.object({
  phoneHost: z.string(),
  model: z.string().nullable(),
  firmware: z.string().nullable(),
  ip: z.string().nullable(),
  mac: z.string().nullable(),
  uptime: z.string().nullable(),
  deviceType: z.string().nullable(),
  vendor: z.string().nullable(),
  status: z.string(),
  retrievedAt: z.string(),
});

const CallStatusSchema = z.object({
  phoneHost: z.string(),
  mode: z.enum(["status", "dial", "endCall"]),
  dryRun: z.boolean().default(false),
  active: z.boolean(),
  status: z.string(),
  call: z.record(z.string(), z.unknown()).nullable(),
  preview: z.record(z.string(), z.unknown()).nullable().default(null),
  retrievedAt: z.string(),
});

const ConfigReadbackSchema = z.object({
  phoneHost: z.string(),
  mode: z.enum(["read", "dryRun", "applied"]),
  params: z.array(z.object({
    name: z.string(),
    value: z.string().nullable(),
    source: z.string().nullable(),
  })).default([]),
  invalidParams: z.array(z.string()).default([]),
  writes: z.record(z.string(), z.string()).default({}),
  status: z.string().nullable().default(null),
  retrievedAt: z.string(),
});

const ForwardAuditSchema = z.object({
  phoneHost: z.string(),
  line: z.string(),
  mode: z.enum(["audit", "dryRun", "applied", "refused"]),
  serverControlled: z.boolean(),
  current: z.array(z.object({
    name: z.string(),
    value: z.string().nullable(),
    source: z.string().nullable(),
  })).default([]),
  writes: z.record(z.string(), z.string()).default({}),
  note: z.string().default(""),
  status: z.string().nullable().default(null),
  retrievedAt: z.string(),
});

const IdleSnapshotSchema = z.object({
  tiles: z.array(z.object({
    value: z.string(),
    label: z.string(),
    sev: SevEnum,
  })),
  rows: z.array(z.object({
    sev: SevEnum,
    key: z.string(),
    msg: z.string(),
  })),
  degraded: z.array(z.string()),
  notes: z.array(z.string()),
  epoch: z.number(),
});

const PushRunSchema = z.object({
  phoneHost: z.string(),
  kind: z.enum(["alert", "display", "keyEvent", "reboot"]),
  dryRun: z.boolean().default(false),
  uri: z.string().nullable().default(null),
  message: z.string().nullable().default(null),
  priority: z.string().default("normal"),
  keys: z.array(z.string()).default([]),
  status: z.number().nullable().default(null),
  authenticated: z.boolean().default(false),
  detail: z.string().default(""),
  retrievedAt: z.string(),
});

// --- execute context (mercury idiom, only the fields used) -----------------

interface MethodLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warning(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
}

interface ExecuteContext {
  globalArgs: GlobalArgs;
  logger: MethodLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  createFileWriter?: (
    specName: string,
    name: string,
  ) => { writeAll: (b: Uint8Array) => Promise<{ name: string }> };
}

interface ExecuteResult {
  dataHandles: Array<{ name: string }>;
}

/** The valid simulateKeyEvent KeyNames (CONTROL-SURFACE.md, confirmed 2000). */
export const VALID_KEYS: ReadonlySet<string> = new Set([
  "Home",
  "Select",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Dialpad0",
  "Dialpad1",
  "Dialpad2",
  "Dialpad3",
  "Dialpad4",
  "Dialpad5",
  "Dialpad6",
  "Dialpad7",
  "Dialpad8",
  "Dialpad9",
  "Softkey1",
  "Softkey2",
  "Softkey3",
  "Softkey4",
  "MicMute",
  "VolUp",
  "VolDown",
]);

const now = () => new Date().toISOString();

// ===========================================================================
// SECTION D — the model definition
// ===========================================================================

export const model = {
  type: "@shrug/polycom-vvx/phone",
  version: "2026.09.23.1",
  description:
    "Polycom VVX phone control + real-data idle display. Typed methods 1:1 " +
    "with the verified REST/push surface (serialized, dry-run-by-default writes) " +
    "plus composeIdleSnapshot — a typed-primitive interpreter that turns " +
    "declarative providers + recorded Grafana data into a {tiles,rows} snapshot " +
    "the render daemon serves.",
  globalArguments: GlobalArgsSchema,
  resources: {
    deviceInfo: {
      description:
        "Device info from discover (mgmt/device/info) — reboot/health probe.",
      schema: DeviceInfoSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    callStatus: {
      description:
        "Active-call status (webCallControl/callStatus) + dial/endCall records.",
      schema: CallStatusSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    configReadback: {
      description:
        "Config get/set read-back (mgmt/config/*) incl. dry-run previews.",
      schema: ConfigReadbackSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    forwardAudit: {
      description:
        "Call-forward (divert.*) audit + dry-run/applied reconcile record.",
      schema: ForwardAuditSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    idleSnapshot: {
      description:
        "The composed idle-display snapshot {tiles,rows,degraded,epoch} (spec §5).",
      schema: IdleSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    pushRun: {
      description:
        "Audit of pushes / display swaps / key events / reboots (idempotency + debug).",
      schema: PushRunSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  files: {
    screenCapture: {
      description:
        "The phone's 320x240 framebuffer BMP from captureScreen (state oracle).",
      contentType: "image/bmp",
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    // ---- control: reads --------------------------------------------------
    discover: {
      description:
        "GET mgmt/device/info — model/fw/ip/mac/uptime (reboot detector + health probe).",
      arguments: z.object({}),
      execute: async (
        args: { _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = phoneCfg(context.globalArgs);
        context.logger.info("discover {host}", { host: cfg.phoneHost });
        const env = await phoneRequest(
          cfg,
          { method: "GET", path: "mgmt/device/info" },
          args._fetch,
        );
        if (env.status !== "2000") {
          throw new Error(`discover: unexpected Status ${env.status}`);
        }
        const d = env.data ?? {};
        const s = (k: string) => d[k] === undefined ? null : String(d[k]);
        const handle = await context.writeResource("deviceInfo", "deviceInfo", {
          phoneHost: cfg.phoneHost,
          model: s("ModelNumber"),
          firmware: s("FirmwareRelease"),
          ip: s("IPV4Address"),
          mac: s("MACAddress"),
          uptime: s("UpTimeSinceLastReboot"),
          deviceType: s("DeviceType"),
          vendor: s("VendorName") ?? s("Vendor"),
          status: env.status,
          retrievedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },
    callStatus: {
      description:
        "GET webCallControl/callStatus — the 'is a call up?' check (4007 == no active call).",
      arguments: z.object({}),
      execute: async (
        args: { _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = phoneCfg(context.globalArgs);
        const env = await phoneRequest(
          cfg,
          { method: "GET", path: "webCallControl/callStatus" },
          args._fetch,
        );
        // 4007 is a normal state (no active call), NOT an error.
        const active = env.status === "2000";
        if (!active && env.status !== "4007") {
          throw new Error(`callStatus: unexpected Status ${env.status}`);
        }
        const handle = await context.writeResource("callStatus", "callStatus", {
          phoneHost: cfg.phoneHost,
          mode: "status",
          dryRun: false,
          active,
          status: env.status,
          call: active ? (env.data ?? null) : null,
          preview: null,
          retrievedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },
    configGet: {
      description:
        "POST mgmt/config/get {data:[names]} — per-param {Value,Source}; unknown " +
        "names surface under invalidParams (a cheap namespace probe).",
      arguments: z.object({
        names: z.array(z.string()).min(1).describe(
          "Config parameter names to read.",
        ),
      }),
      execute: async (
        args: { names: string[]; _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = phoneCfg(context.globalArgs);
        const env = await phoneRequest(
          cfg,
          {
            method: "POST",
            path: "mgmt/config/get",
            body: { data: args.names },
          },
          args._fetch,
        );
        if (env.status !== "2000" && env.status !== "4000") {
          throw new Error(`configGet: unexpected Status ${env.status}`);
        }
        const params = readbackParams(env, args.names);
        const handle = await context.writeResource(
          "configReadback",
          "configReadback",
          {
            phoneHost: cfg.phoneHost,
            mode: "read",
            params,
            invalidParams: env.invalidParams ?? [],
            writes: {},
            status: env.status,
            retrievedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    getForward: {
      description:
        "Read the local call-forward (divert.*) config for the line — the audit leg.",
      arguments: z.object({
        line: z.string().optional().describe(
          "Registration index (defaults to globalArgs.line).",
        ),
      }),
      execute: async (
        args: { line?: string; _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = phoneCfg(context.globalArgs);
        const line = args.line ?? cfg.line;
        const names = Object.values(forwardParams(line));
        const env = await phoneRequest(
          cfg,
          { method: "POST", path: "mgmt/config/get", body: { data: names } },
          args._fetch,
        );
        if (env.status !== "2000" && env.status !== "4000") {
          throw new Error(`getForward: unexpected Status ${env.status}`);
        }
        const params = readbackParams(env, names);
        const serverControlled = params.some(
          (p) => p.name === forwardParams(line).serverCf && p.value === "1",
        );
        const handle = await context.writeResource(
          "forwardAudit",
          `forwardAudit:${line}`,
          {
            phoneHost: cfg.phoneHost,
            line,
            mode: "audit",
            serverControlled,
            current: params,
            writes: {},
            note: serverControlled
              ? "server-controlled line: local divert.* writes are ignored by the phone"
              : "",
            status: env.status,
            retrievedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    captureScreen: {
      description:
        "auth.htm -> session cookie -> GET /captureScreen/mainScreen — the real " +
        "320x240 framebuffer BMP (the on-device state oracle).",
      arguments: z.object({}),
      execute: async (
        args: { _fetch?: FetchLike; _nonce?: string },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = phoneCfg(context.globalArgs);
        const doFetch = args._fetch ?? phoneFetch(cfg);
        const base = `https://${cfg.phoneHost}`;
        // 1) authenticate to get the session cookie.
        const authResp = await doFetch(`${base}/form-submit/auth.htm`, {
          method: "POST",
          headers: {
            "Authorization": basicAuth(cfg.adminUser, cfg.adminPassword),
          },
        });
        const setCookie = authResp.headers.get("Set-Cookie") ??
          authResp.headers.get("set-cookie") ?? "";
        const cookie = setCookie.split(";")[0];
        // 2) fetch the framebuffer with the cookie.
        const nonce = args._nonce ?? String(Date.now());
        const capResp = await doFetch(
          `${base}/captureScreen/mainScreen?${nonce}`,
          { method: "GET", headers: cookie ? { "Cookie": cookie } : {} },
        );
        if (!capResp.ok) {
          throw new Error(
            `captureScreen failed (HTTP ${capResp.status} ${capResp.statusText}) — ` +
              "is the capture feature enabled in web config?",
          );
        }
        const bytes = new Uint8Array(await capResp.arrayBuffer());
        context.logger.info("captureScreen {n} bytes", { n: bytes.length });
        if (!context.createFileWriter) {
          throw new Error(
            "captureScreen: no file writer available in this context",
          );
        }
        const writer = context.createFileWriter("screenCapture", "mainScreen");
        const handle = await writer.writeAll(bytes);
        return { dataHandles: [handle] };
      },
    },

    // ---- control: gated writes (dry-run by default) ----------------------
    dial: {
      description:
        "POST callctrl/dial — place a live call. Dest MUST be a full SIP addr " +
        "(bare digits return 2000 but do not route). GATED: dryRun by default; " +
        "confirm:true to place the call.",
      arguments: z.object({
        dest: z.string().min(1).describe(
          "Full SIP address, e.g. NUM@sip.example.test.",
        ),
        line: z.string().optional().describe(
          "Line index (defaults to globalArgs.line).",
        ),
        confirm: z.boolean().default(false).describe(
          "true to actually place the call.",
        ),
      }),
      execute: async (
        args: {
          dest: string;
          line?: string;
          confirm?: boolean;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = phoneCfg(context.globalArgs);
        const line = args.line ?? cfg.line;
        const confirm = args.confirm ?? false;
        const body = { data: { Dest: args.dest, Line: line, Type: "SIP" } };
        if (!confirm) {
          context.logger.info("DRY RUN dial {dest} — NOT placed", {
            dest: args.dest,
          });
          const handle = await context.writeResource(
            "callStatus",
            "callStatus",
            {
              phoneHost: cfg.phoneHost,
              mode: "dial",
              dryRun: true,
              active: false,
              status: "dryRun",
              call: null,
              preview: body.data,
              retrievedAt: now(),
            },
          );
          return { dataHandles: [handle] };
        }
        context.logger.warning("LIVE dial {dest} line {line}", {
          dest: args.dest,
          line,
        });
        const env = await phoneRequest(
          cfg,
          { method: "POST", path: "callctrl/dial", body },
          args._fetch,
        );
        if (env.status !== "2000") {
          throw new Error(`dial: Status ${env.status}`);
        }
        const handle = await context.writeResource("callStatus", "callStatus", {
          phoneHost: cfg.phoneHost,
          mode: "dial",
          dryRun: false,
          active: true,
          status: env.status,
          call: env.data ?? null,
          preview: body.data,
          retrievedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },
    endCall: {
      description:
        "POST callctrl/endCall {Ref:<CallHandle>} — end the active call (Ref from " +
        "callStatus). 4007 == already ended (tolerated). GATED: dryRun by default.",
      arguments: z.object({
        ref: z.string().min(1).describe("CallHandle from callStatus."),
        confirm: z.boolean().default(false).describe(
          "true to actually end the call.",
        ),
      }),
      execute: async (
        args: { ref: string; confirm?: boolean; _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = phoneCfg(context.globalArgs);
        const confirm = args.confirm ?? false;
        const body = { data: { Ref: args.ref } };
        if (!confirm) {
          const handle = await context.writeResource(
            "callStatus",
            "callStatus",
            {
              phoneHost: cfg.phoneHost,
              mode: "endCall",
              dryRun: true,
              active: false,
              status: "dryRun",
              call: null,
              preview: body.data,
              retrievedAt: now(),
            },
          );
          return { dataHandles: [handle] };
        }
        const env = await phoneRequest(
          cfg,
          { method: "POST", path: "callctrl/endCall", body },
          args._fetch,
        );
        // 4007 = the call already ended: a benign no-op, not a failure.
        if (env.status !== "2000" && env.status !== "4007") {
          throw new Error(`endCall: Status ${env.status}`);
        }
        const handle = await context.writeResource("callStatus", "callStatus", {
          phoneHost: cfg.phoneHost,
          mode: "endCall",
          dryRun: false,
          active: false,
          status: env.status,
          call: null,
          preview: body.data,
          retrievedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },
    configSet: {
      description:
        "POST mgmt/config/set {data:{param:value}} — FLAT body required (nested " +
        "writes empty silently). feature.* needs a restart to take effect. GATED: " +
        "dryRun by default; confirm:true to write, then verifies via read-back.",
      arguments: z.object({
        values: z.record(z.string(), z.string()).describe(
          "Flat param->value map.",
        ),
        confirm: z.boolean().default(false).describe("true to actually write."),
      }),
      execute: async (
        args: {
          values: Record<string, string>;
          confirm?: boolean;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = phoneCfg(context.globalArgs);
        const confirm = args.confirm ?? false;
        const names = Object.keys(args.values);
        if (names.length === 0) {
          throw new Error("configSet: no values to write");
        }
        if (!confirm) {
          context.logger.info("DRY RUN configSet — NOT written", {
            params: names,
          });
          const handle = await context.writeResource(
            "configReadback",
            "configReadback",
            {
              phoneHost: cfg.phoneHost,
              mode: "dryRun",
              params: [],
              invalidParams: [],
              writes: args.values,
              status: null,
              retrievedAt: now(),
            },
          );
          return { dataHandles: [handle] };
        }
        context.logger.warning("LIVE configSet {params}", { params: names });
        const env = await phoneRequest(
          cfg,
          {
            method: "POST",
            path: "mgmt/config/set",
            body: { data: args.values },
          },
          args._fetch,
        );
        if (env.status !== "2000") {
          throw new Error(`configSet: Status ${env.status}`);
        }
        // Verify-before-done (spec §8): read the values back.
        const back = await phoneRequest(
          cfg,
          { method: "POST", path: "mgmt/config/get", body: { data: names } },
          args._fetch,
        );
        const handle = await context.writeResource(
          "configReadback",
          "configReadback",
          {
            phoneHost: cfg.phoneHost,
            mode: "applied",
            params: readbackParams(back, names),
            invalidParams: back.invalidParams ?? [],
            writes: args.values,
            status: env.status,
            retrievedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    reconcileForward: {
      description:
        "Reconcile local call-forward (divert.*) to intent. Reads current config " +
        "first (audit), REFUSES on a server-controlled line, then dry-run previews " +
        "the flat writes; confirm:true applies them (the POC forward shape).",
      arguments: z.object({
        line: z.string().optional().describe(
          "Registration index (defaults to globalArgs.line).",
        ),
        busy: z.string().optional().describe(
          "Forward-on-busy target; '' clears+disables.",
        ),
        noanswer: z.string().optional().describe(
          "Forward-on-no-answer target; '' clears.",
        ),
        naTimeout: z.union([z.string(), z.number()]).optional().describe(
          "Ring seconds before the no-answer forward fires.",
        ),
        confirm: z.boolean().default(false).describe(
          "true to apply the writes.",
        ),
      }),
      execute: async (
        args: {
          line?: string;
          busy?: string;
          noanswer?: string;
          naTimeout?: string | number;
          confirm?: boolean;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = phoneCfg(context.globalArgs);
        const line = args.line ?? cfg.line;
        const confirm = args.confirm ?? false;
        const p = forwardParams(line);
        // 1) ALWAYS read current state first (audit / drift).
        const cur = await phoneRequest(
          cfg,
          {
            method: "POST",
            path: "mgmt/config/get",
            body: { data: Object.values(p) },
          },
          args._fetch,
        );
        if (cur.status !== "2000" && cur.status !== "4000") {
          throw new Error(`reconcileForward: read Status ${cur.status}`);
        }
        const current = readbackParams(cur, Object.values(p));
        const serverControlled = current.some(
          (x) => x.name === p.serverCf && x.value === "1",
        );
        const writes = buildForwardWrites(line, {
          busy: args.busy,
          noanswer: args.noanswer,
          naTimeout: args.naTimeout,
        });
        // 2) Guard: server-controlled forwarding makes local divert.* a no-op.
        if (serverControlled && Object.keys(writes).length > 0) {
          context.logger.warning(
            "reconcileForward REFUSED: line {line} is server-controlled",
            { line },
          );
          const handle = await context.writeResource(
            "forwardAudit",
            `forwardAudit:${line}`,
            {
              phoneHost: cfg.phoneHost,
              line,
              mode: "refused",
              serverControlled: true,
              current,
              writes,
              note: "reg." + line +
                ".serverFeatureControl.cf=1: local divert.* writes IGNORED — aborting",
              status: cur.status,
              retrievedAt: now(),
            },
          );
          return { dataHandles: [handle] };
        }
        // 3) Nothing to write ⇒ read-only audit.
        if (Object.keys(writes).length === 0 || !confirm) {
          const mode = Object.keys(writes).length === 0 ? "audit" : "dryRun";
          context.logger.info("reconcileForward {mode}", { mode });
          const handle = await context.writeResource(
            "forwardAudit",
            `forwardAudit:${line}`,
            {
              phoneHost: cfg.phoneHost,
              line,
              mode,
              serverControlled,
              current,
              writes,
              note: mode === "dryRun"
                ? "DRY RUN — re-run with confirm to apply"
                : "",
              status: cur.status,
              retrievedAt: now(),
            },
          );
          return { dataHandles: [handle] };
        }
        // 4) Apply. Log only the param NAMES, not the contact values (forward
        // destinations are phone numbers) -- matches configSet's names-only log.
        context.logger.warning("LIVE reconcileForward {line} {params}", {
          line,
          params: Object.keys(writes),
        });
        const env = await phoneRequest(
          cfg,
          { method: "POST", path: "mgmt/config/set", body: { data: writes } },
          args._fetch,
        );
        if (env.status !== "2000") {
          throw new Error(`reconcileForward: set Status ${env.status}`);
        }
        const handle = await context.writeResource(
          "forwardAudit",
          `forwardAudit:${line}`,
          {
            phoneHost: cfg.phoneHost,
            line,
            mode: "applied",
            serverControlled,
            current,
            writes,
            note: "",
            status: env.status,
            retrievedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    simulateKeyEvent: {
      description:
        "POST mgmt/simulateKeyEvent {Type:Tap,KeyName} — drive the on-device UI. " +
        "SERIALIZED + paced ~0.9s (blind batches DRIFT). GATED: dryRun by default; " +
        "confirm:true to send the sequence.",
      arguments: z.object({
        keys: z.array(z.string()).min(1).describe(
          "Ordered KeyNames to tap (see VALID_KEYS).",
        ),
        paceMs: z.number().default(900).describe(
          "Delay between taps (spec §8, ~0.9s).",
        ),
        confirm: z.boolean().default(false).describe(
          "true to actually send taps.",
        ),
      }),
      execute: async (
        args: {
          keys: string[];
          paceMs?: number;
          confirm?: boolean;
          _fetch?: FetchLike;
          _sleep?: SleepLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = phoneCfg(context.globalArgs);
        const confirm = args.confirm ?? false;
        const paceMs = args.paceMs ?? 900;
        const sleep = args._sleep ?? realSleep;
        // Validate keys up front (4000 == invalid; probe the keymap offline).
        const invalid = args.keys.filter((k) => !VALID_KEYS.has(k));
        if (invalid.length > 0) {
          throw new Error(
            `simulateKeyEvent: invalid KeyName(s): ${invalid.join(", ")}`,
          );
        }
        if (!confirm) {
          const handle = await context.writeResource(
            "pushRun",
            "pushRun:keyEvent",
            {
              phoneHost: cfg.phoneHost,
              kind: "keyEvent",
              dryRun: true,
              uri: null,
              message: null,
              priority: "normal",
              keys: args.keys,
              status: null,
              authenticated: false,
              detail: "DRY RUN — sequence not sent",
              retrievedAt: now(),
            },
          );
          return { dataHandles: [handle] };
        }
        // SERIALIZE + pace: one tap at a time, ~0.9s apart, never parallel.
        let last = "";
        for (let i = 0; i < args.keys.length; i++) {
          if (i > 0) await sleep(paceMs);
          const key = args.keys[i];
          const env = await phoneRequest(
            cfg,
            {
              method: "POST",
              path: "mgmt/simulateKeyEvent",
              body: { data: { Type: "Tap", KeyName: key } },
            },
            args._fetch,
          );
          last = env.status;
          if (env.status !== "2000") {
            throw new Error(`simulateKeyEvent: '${key}' Status ${env.status}`);
          }
        }
        const handle = await context.writeResource(
          "pushRun",
          "pushRun:keyEvent",
          {
            phoneHost: cfg.phoneHost,
            kind: "keyEvent",
            dryRun: false,
            uri: null,
            message: null,
            priority: "normal",
            keys: args.keys,
            status: null,
            authenticated: false,
            detail: `sent ${args.keys.length} taps, last Status ${last}`,
            retrievedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    reboot: {
      description:
        "POST mgmt/safeRestart {} — restart the phone app/UCS (~90-120s down). " +
        "GATED (heavy): dryRun by default; confirm:true to reboot.",
      arguments: z.object({
        confirm: z.boolean().default(false).describe(
          "true to actually reboot.",
        ),
      }),
      execute: async (
        args: { confirm?: boolean; _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = phoneCfg(context.globalArgs);
        const confirm = args.confirm ?? false;
        if (!confirm) {
          const handle = await context.writeResource(
            "pushRun",
            "pushRun:reboot",
            {
              phoneHost: cfg.phoneHost,
              kind: "reboot",
              dryRun: true,
              uri: null,
              message: null,
              priority: "normal",
              keys: [],
              status: null,
              authenticated: false,
              detail: "DRY RUN — reboot not sent",
              retrievedAt: now(),
            },
          );
          return { dataHandles: [handle] };
        }
        context.logger.warning("LIVE reboot {host}", { host: cfg.phoneHost });
        const env = await phoneRequest(
          cfg,
          { method: "POST", path: "mgmt/safeRestart", body: {} },
          args._fetch,
        );
        if (env.status !== "2000") {
          throw new Error(`reboot: Status ${env.status}`);
        }
        const handle = await context.writeResource(
          "pushRun",
          "pushRun:reboot",
          {
            phoneHost: cfg.phoneHost,
            kind: "reboot",
            dryRun: false,
            uri: null,
            message: null,
            priority: "normal",
            keys: [],
            status: null,
            authenticated: false,
            detail: `safeRestart Status ${env.status}`,
            retrievedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // ---- control: push channel (digest) ----------------------------------
    pushAlert: {
      description:
        "Push an alert to the phone via the /push (DIGEST) channel — a URI push " +
        "(phone GETs a daemon path) or a small inline message. Records a pushRun " +
        "audit (level-triggered: re-push the desired state).",
      arguments: z.object({
        uri: z.string().optional().describe(
          "URI push target (a path on the daemon).",
        ),
        message: z.string().optional().describe(
          "Inline content push text (<=1KB).",
        ),
        critical: z.boolean().default(false).describe(
          "true == interrupt-now priority.",
        ),
      }),
      execute: async (
        args: {
          uri?: string;
          message?: string;
          critical?: boolean;
          _fetch?: FetchLike;
          _cnonce?: string;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = phoneCfg(context.globalArgs);
        if (args.uri === undefined && args.message === undefined) {
          throw new Error("pushAlert: provide a uri or a message");
        }
        const priority = args.critical ? "critical" : "normal";
        const res = await sendPush(
          cfg,
          { uri: args.uri, message: args.message, priority },
          args._fetch,
          args._cnonce,
        );
        if (!res.ok) {
          throw new Error(`pushAlert failed (HTTP ${res.status})`);
        }
        const handle = await context.writeResource("pushRun", "pushRun:alert", {
          phoneHost: cfg.phoneHost,
          kind: "alert",
          dryRun: false,
          uri: args.uri ?? null,
          message: args.message ?? null,
          priority,
          keys: [],
          status: res.status,
          authenticated: res.authenticated,
          detail: res.body.slice(0, 200),
          retrievedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },
    setDisplay: {
      description:
        "Swap the phone's displayed screen: push a URI pointing mb at " +
        "serveBaseUrl + /s/<screen> (the display-swap primitive). Level-triggered.",
      arguments: z.object({
        screen: z.string().min(1).describe(
          "Screen name served by the daemon at /s/<screen>.",
        ),
        critical: z.boolean().default(true).describe(
          "true == interrupt-now priority.",
        ),
      }),
      execute: async (
        args: {
          screen: string;
          critical?: boolean;
          _fetch?: FetchLike;
          _cnonce?: string;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = phoneCfg(context.globalArgs);
        const uri = `/s/${args.screen}`;
        const priority = (args.critical ?? true) ? "critical" : "normal";
        const res = await sendPush(
          cfg,
          { uri, priority },
          args._fetch,
          args._cnonce,
        );
        if (!res.ok) throw new Error(`setDisplay failed (HTTP ${res.status})`);
        const handle = await context.writeResource(
          "pushRun",
          "pushRun:display",
          {
            phoneHost: cfg.phoneHost,
            kind: "display",
            dryRun: false,
            uri,
            message: null,
            priority,
            keys: [],
            status: res.status,
            authenticated: res.authenticated,
            detail: res.body.slice(0, 200),
            retrievedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // ---- data plane: the interpreter (spec §5) ---------------------------
    composeIdleSnapshot: {
      description:
        "Compose the idle-display snapshot (spec §5): run the declarative " +
        "displayConfig.providers over recorded Grafana queryResults (JSON-parsing " +
        "the opaque results string) via the typed-primitive interpreter, and " +
        "write {tiles,rows,degraded,notes,epoch}. Pure logic; the workflow feeds " +
        "queryResults via data.latest (rule 3, no re-fetch).",
      arguments: z.object({
        queryResults: z.record(
          z.string(),
          z.object({ results: z.string() }).loose(),
        ).default({}).describe(
          "Recorded Grafana query results keyed by dataName; each has a " +
            "JSON-encoded `results` string (spec §5.0).",
        ),
        seriesByProvider: z.record(
          z.string(),
          z.array(z.object({
            metric: z.record(z.string(), z.string()).default({}),
            values: z.array(z.array(z.union([z.number(), z.string()]))).default(
              [],
            ),
          })),
        ).optional().describe(
          "Direct pre-parsed series keyed by provider id (test/override seam); " +
            "when set it bypasses queryResults parsing.",
        ),
        epoch: z.number().optional().describe(
          "Injectable epoch (seconds) for determinism.",
        ),
      }),
      execute: async (
        args: {
          queryResults?: Record<string, { results: string }>;
          seriesByProvider?: Record<string, Series[]>;
          epoch?: number;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const providers = context.globalArgs.displayConfig.providers;
        const sbp: Record<string, Series[] | undefined> =
          args.seriesByProvider ??
            buildSeriesByProvider(providers, args.queryResults ?? {});
        const snap = interpret(providers, sbp, { epoch: args.epoch });
        context.logger.info(
          "composeIdleSnapshot: {tiles} tiles, {rows} rows{deg}",
          {
            tiles: snap.tiles.length,
            rows: snap.rows.length,
            deg: snap.degraded.length
              ? ` DEGRADED(${snap.degraded.join(",")})`
              : "",
          },
        );
        const handle = await context.writeResource(
          "idleSnapshot",
          "idleSnapshot",
          snap as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Turn a config-get envelope into `[{name,value,source}]` rows (spec §3.4). */
function readbackParams(
  env: Envelope,
  names: string[],
): Array<{ name: string; value: string | null; source: string | null }> {
  const data = env.data ?? {};
  return names.map((name) => {
    const entry = data[name];
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      return {
        name,
        value: e.Value === undefined ? null : String(e.Value),
        source: e.Source === undefined ? null : String(e.Source),
      };
    }
    return { name, value: null, source: null };
  });
}
