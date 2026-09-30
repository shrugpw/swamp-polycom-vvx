# @shrug/polycom-vvx

Polycom VVX phone control + real-data idle-display swamp model. One model type,
`@shrug/polycom-vvx/phone` (one instance per phone), that productizes the
`design/poc/vvx-microbrowser/` POC into typed, safe, testable methods. Two
planes (design spec `design/specs/polycom-vvx-extension.spec.md`):

- **Control** — typed methods 1:1 with the verified REST/push surface
  (`design/poc/vvx-microbrowser/CONTROL-SURFACE.md`, VVX 411 / UCS 6.4.7.4560).
- **Data** — `composeIdleSnapshot`, a typed-primitive interpreter that turns a
  declarative provider list + recorded Grafana data into the `{tiles, rows}`
  snapshot the render/serve daemon consumes.

All phone I/O flows through a SINGLE injectable fetch seam (`phoneRequest` for
Basic-authed REST, `sendPush` for the Digest push channel), so every method is
unit-testable with canned envelopes and no network.

## Config (globalArguments)

| arg | default | notes |
|-----|---------|-------|
| `phoneHost` | — | phone IP/host (REST + push target), e.g. `phone.example.test` |
| `adminUser` | `Polycom` | HTTP Basic user for the REST API |
| `adminPassword` | — | **sensitive**; Web Config admin password. CEL vault ref -> `vault.get("vvx","<phone>/admin")` |
| `pushUser` | — | push (digest) user for `/push` |
| `pushPassword` | — | **sensitive**; push digest password. `vault.get("vvx","<phone>/push")` |
| `phoneCaCert` | — | the phone's self-signed cert (PEM) to **pin** TLS trust to (no global bypass). Inline or `vault.get("vvx","<phone>/cacert")`. Capture: `openssl s_client -connect <phone>:443 </dev/null 2>/dev/null \| openssl x509` |
| `serveBaseUrl` | — | the render/serve daemon URL the phone points `mb.*`/event at |
| `grafanaModel` | `shrug-grafana` | Grafana source model whose recorded queryResults `composeIdleSnapshot` reads |
| `grafanaRepoDir` | — | cross-repo path where the grafana model lives (for the compose workflow) |
| `displayConfig` | `{refreshSeconds:30,providers:[]}` | the declarative idle-display provider list (spec section 5) |
| `line` | `1` | SIP line/registration index for dial + call-forward |

Secrets are vault refs, never literals (config in tracked YAML, secrets in
vault). A phone inventory instance (spec section 6):

```yaml
type: "@shrug/polycom-vvx/phone"
name: desk-vvx-411
globalArguments:
  phoneHost: phone.example.test
  adminUser: Polycom
  adminPassword: ${{ vault.get("vvx","desk/admin") }}
  pushUser: pushuser
  pushPassword: ${{ vault.get("vvx","desk/push") }}
  phoneCaCert: ${{ vault.get("vvx","desk/cacert") }}
  serveBaseUrl: http://daemon.example:7070
  grafanaModel: shrug-grafana
  line: "1"
  displayConfig:
    refreshSeconds: 30
    providers:
      - id: up-ready
        source: { type: grafana-promql, dataName: q-up-ready }   # count(up==1)
      - id: up-total
        source: { type: grafana-promql, dataName: q-up-total }   # count(up)
      - id: fleet-health
        source: { type: static }
        tile:
          label: Fleet
          value: { fraction: { num: { provider: up-ready }, den: { provider: up-total } } }
          sev:
            thresholds:
              - { crit: { eq: 0 } }
              - { warn: { ltRef: { provider: up-total } } }
              - { ok: {} }
```

## Methods

### Control plane (phone-facing, serialized)

| method | REST/push | gate |
|--------|-----------|------|
| `discover` | `GET mgmt/device/info` | read |
| `callStatus` | `GET webCallControl/callStatus` | read (`4007` = no active call) |
| `configGet` | `POST mgmt/config/get` | read (unknown names -> `invalidParams`) |
| `getForward` | config `divert.*` read | read (flags server-controlled line) |
| `captureScreen` | `auth.htm` cookie -> `GET /captureScreen/mainScreen` | read (writes the BMP `screenCapture` file) |
| `dial` | `POST callctrl/dial` | **gated** — `dryRun` default; `confirm:true` to place |
| `endCall` | `POST callctrl/endCall` | **gated** (`4007` = already ended) |
| `configSet` | `POST mgmt/config/set` (FLAT body) | **gated**; verifies via read-back |
| `reconcileForward` | config `divert.*` write | **gated**; refuses a server-controlled line |
| `simulateKeyEvent` | `POST mgmt/simulateKeyEvent` | **gated**; serialized + paced ~0.9s |
| `reboot` | `POST mgmt/safeRestart` | **gated (heavy)** |
| `pushAlert` | `/push` (digest) URI/inline push | write |
| `setDisplay` | `/push` (digest) URI swap to `/s/<screen>` | write |

Every gated write is **dry-run by default**: without `confirm:true` it records a
would-do preview and sends NOTHING (the house never-dryRun-false gate).

### Data plane

- `composeIdleSnapshot` — reads `displayConfig.providers`, `JSON.parse`s each
  provider's recorded Grafana `queryResult.results` string (swamp-native CEL
  cannot parse it — spec section 5.0), runs the typed-primitive interpreter, and
  writes `{tiles, rows, degraded, notes, epoch}` (the `idleSnapshot` resource).
  The workflow feeds the recorded results via `data.latest` (rule 3, no
  re-fetch); pass them as the `queryResults` arg keyed by `dataName`.

## The typed-primitive interpreter (spec section 5)

The idle screen is defined entirely in tracked config — adding or changing a
tile/row is a YAML edit, never a TypeScript edit. `composeIdleSnapshot` is a
generic switch over a small closed vocabulary (no bundled expression engine):

- **tile.value**: `seriesCount` | `scalar {reduce}` | `fraction {num,den}` (renders
  "N/M") | `literal`.
- **tile.sev**: `literal` | `thresholds` (ordered, first match wins; predicates
  `eq|ne|lt|lte|gt|gte` and `ltRef|gtRef`).
- **rows**: `forEach: series` with `where` (labelEq/valueEq/always), `key`
  (label|template), `msg` (template interpolating `{label}`s + `{value}`), and
  `sev` (literal|byValue).
- **`<ref>`**: `{provider,as}` (another provider's number) | `{const}`.
- **escape hatch**: `source.type: custom` names a registered TS reducer
  (`registerCustomReducer`) for the rare mapping the vocabulary can't express.

Merge/degrade: tiles capped at 3; rows deduped by key; a provider that is
missing/unparseable or whose mapping throws is skipped and its id recorded in
`degraded[]` (degrade, never abort); a resting "all systems nominal" row when no
crit/warn.

## Safety

- **Serialize + pace.** The phone httpd wedges under bursty/parallel calls;
  nothing fans out parallel requests at one phone, and `simulateKeyEvent` paces
  ~0.9s between taps.
- **Dry-run by default** for every gated write; verify-before-destructive
  read-back on `configSet` and `reconcileForward`.
- **Self-signed TLS is cert-pinned, not bypassed.** Set `phoneCaCert` to the
  phone's PEM and every REST/push call verifies against *exactly* that cert via a
  scoped `Deno.createHttpClient({caCerts})` — no process-wide
  `--unsafely-ignore-certificate-errors` (which would weaken TLS for every other
  outbound call in the worker). If `phoneCaCert` is unset, calls fall back to
  system trust (a self-signed phone then still needs the host bypass — pinning is
  strongly preferred). Tests inject their own fetch and never hit the network.

## Companion daemon (the display plane — ships with this package)

The extension is the control + data plane; it cannot *serve* the microbrowser
(swamp has no long-running-server primitive). The `daemon/` directory ships in the
package and is the display plane: a small stdlib+Pillow HTTP server the phone
polls for the idle XHTML/PNG, rendering the `{tiles,rows}` snapshot
`composeIdleSnapshot` writes. It **never** acquires data and **never** shells out
to swamp. Run it as a `systemd --user` unit (`daemon/deploy/vvx-daemon.service`);
see `daemon/README.md`.

Endpoint auth (the daemon is LAN-reachable):

| env | endpoint | behavior |
|-----|----------|----------|
| `VVX_PUSH_TOKEN` | `POST /api/push` | **fail-closed**: endpoint is disabled (403) unless set; then requires `Authorization: Bearer <token>` or `X-VVX-Token` |
| `VVX_EVENT_TOKEN` | `POST /event` | the phone can't send headers, so the secret rides the configured event URL as `?token=<...>`; if unset the endpoint stays open (phone compat) but warns once |
| `VVX_SNAPSHOT_PATH` | — | the snapshot file the daemon reads (default `${XDG_RUNTIME_DIR}/vvx/idle_snapshot.json`) |

`GET /idle`, `/s/*`, `/screen/*.png` are unauthenticated read-only renders (the
phone pulls them with no credentials).

## Running a method

Every gated write previews by default; add `--arg confirm=true` to act:

```bash
# read-only device probe
swamp model @shrug/polycom-vvx/phone method run discover desk-vvx-411
# dry-run a call-forward reconcile (no write)
swamp model @shrug/polycom-vvx/phone method run reconcileForward desk-vvx-411 \
  --arg busy=200@sip.example.test
# compose the idle snapshot the daemon serves
swamp model @shrug/polycom-vvx/phone method run composeIdleSnapshot desk-vvx-411
```

## Testing

```bash
~/.swamp/deno/deno check extensions/models/polycom-vvx.ts
~/.swamp/deno/deno test -A extensions/models/
```

All fixtures are synthetic (spec section 9 depersonalization gate): no real
phone IPs, admin pins, push creds, or hostnames.
