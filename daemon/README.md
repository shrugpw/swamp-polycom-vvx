# polycom-vvx render/serve daemon

The DISPLAY plane of `@shrug/polycom-vvx` (see
`design/specs/polycom-vvx-extension.spec.md`, sections 2 and 4). This is the
long-running HTTP server the Polycom VVX microbrowser polls for its idle
screensaver and main-browser surfaces.

## The contract (read this before changing anything)

This daemon is **dumb about data sources**:

- It reads a pre-computed snapshot JSON file (`VVX_SNAPSHOT_PATH`) and renders
  it to PNG + XHTML.
- It **never** queries Grafana, swamp, or anything else to produce that data.
- It **never** shells out to the `swamp` CLI.

Data acquisition is a separate concern owned by the `@shrug/polycom-vvx`
model extension's `composeIdleSnapshot` method, run on a cadence by a
scheduled swamp workflow (the "swamp plane"). That plane writes the snapshot
file; this daemon only reads it. If you find yourself wanting this daemon to
fetch data, don't -- extend the extension's provider config instead (spec
section 5).

Phone-facing control actions (dial, pushAlert, setDisplay, config
read/write, reboot, etc.) also live in the extension, not here. This daemon
only accepts already-composed content over `POST /api/push` (see below) --
it never initiates a call to the phone's REST/push API itself.

## Snapshot contract

`VVX_SNAPSHOT_PATH` must point at a JSON file shaped exactly like this
(frozen by spec section 5.3; this is what `screens.py`'s `render_dashboard`
consumes):

```json
{
  "tiles": [ { "value": "12/12", "label": "HOSTS UP", "sev": "ok" }, ... ],
  "rows":  [ { "sev": "crit", "key": "example-host", "msg": "unreachable 3m" }, ... ],
  "degraded": false,
  "notes": ["..."],
  "epoch": 1790139168
}
```

- `sev` is one of `ok | warn | crit | info`.
- `tiles` is capped at 3 by the compose step (screens.py only draws 3 slots).
- `epoch` is a Unix timestamp (seconds); the daemon computes snapshot age
  from it.
- An empty `rows` list is meaningful ("nothing down") -- the daemon renders
  it as-is, it does not fall back to demo data unless the snapshot file is
  missing entirely.

The daemon never writes this file. The swamp-plane `composeIdleSnapshot`
method (or, for local testing, a hand-written JSON file) is responsible for
writing it atomically.

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `VVX_LISTEN_HOST` | `0.0.0.0` | HTTP bind address |
| `VVX_LISTEN_PORT` | `7070` | HTTP bind port |
| `VVX_SNAPSHOT_PATH` | `${XDG_RUNTIME_DIR:-/run/user/<uid>}/vvx/idle_snapshot.json` | where to read the idle snapshot from. **Wire the swamp-plane compose workflow to write here.** |
| `VVX_BASE_URL` | `http://<this-host>:<port>` | informational only, shown on the `/` status page; not used to reach out anywhere |
| `VVX_STALE_AFTER_SECONDS` | `90` | snapshot age (or `degraded=true`) past which the header shows `(stale)`. Per spec section 4: fix a slow compose cycle, don't widen this. |

No CLI flags control runtime behavior -- config is env-var/env-file driven so
the systemd unit's env file is the single source of truth (repo rule: config
in tracked config, not ephemeral flags).

## Endpoints served

| Path | Method | What |
| --- | --- | --- |
| `/idle` | GET | chromeless full-panel idle/screensaver surface (320x240). Point `mb.idleDisplay.home` here. |
| `/s/dashboard` | GET | main-browser fleet view (320x180, sits under the phone's title+softkey chrome). Point `mb.main.home` here. |
| `/s/alert`, `/s/caller` | GET | main-browser alert / caller-card surfaces, rendered from whatever was last handed to `/api/push` (see below). Used as `setDisplay` targets by the control-plane extension. |
| `/screen/<name>.png` | GET | the composed PNG for `idle` \| `dashboard` \| `alert` \| `caller`, rendered via `screens.py` (kept verbatim from the hardware-verified spike). |
| `/event` | GET, POST | telephony event webhook (`mb.telephonyEvent.url` on the phone). Parses `IncomingCallEvent` / `CallStateChangeEvent`, strips the SIP URI to the caller's number, and **only logs/records it** (visible at `/events`). This is a clean seam for a future relay (CRM screen-pop, pager) -- it does not call swamp, does not dial, does not push anything on its own. |
| `/api/push` | POST | JSON body `{"screen":"alert",...}` or `{"screen":"caller",...}` -- lets the control-plane extension hand this daemon already-composed alert/caller-card content to render the next time the phone pulls `/s/alert` or `/s/caller` (the `setDisplay` display-swap primitive, spec section 3.2/4.4). This is a content **sink**, not a query -- the daemon never fetches this itself. |
| `/events` | GET | debug view of the last 40 recorded telephony events. |
| `/healthz` | GET | `{"ok": true, "snapshotPath": ...}` |
| `/` | GET | human-facing status page: snapshot age/staleness, base URL, route list. |

## Running locally

```sh
mkdir -p /tmp/vvx && cat > /tmp/vvx/idle_snapshot.json <<'EOF'
{"tiles":[{"value":"1/1","label":"HOSTS UP","sev":"ok"}],
 "rows":[{"sev":"ok","key":"example","msg":"all good"}],
 "degraded":false,"notes":[],"epoch":1790139168}
EOF
VVX_SNAPSHOT_PATH=/tmp/vvx/idle_snapshot.json VVX_LISTEN_PORT=17070 python3 server.py
```

Then `curl http://127.0.0.1:17070/idle` or `curl -o out.png
http://127.0.0.1:17070/screen/idle.png`.

Requires Pillow (`pip install pillow`) and the Inter / IBM Plex Mono font
files at the paths hardcoded in `screens.py` (`_F` dict) -- those paths are
carried over verbatim from the hardware-verified spike; if they're missing on
a given host, `screens.py` falls back to Pillow's default bitmap font rather
than failing (see `font()`).

## systemd --user install

```sh
mkdir -p ~/.config/systemd/user
ln -s /path/to/swamp/polycom-vvx/daemon/deploy/vvx-daemon.service \
      ~/.config/systemd/user/vvx-daemon.service
# create deploy/vvx-daemon.env (gitignored, 0600) with any of the
# VVX_* vars above that you want to override -- host/port/snapshot path.
loginctl enable-linger "$USER"   # survive logout
systemctl --user daemon-reload
systemctl --user enable --now vvx-daemon
systemctl --user status vvx-daemon
```

No secrets belong in `deploy/vvx-daemon.env` -- this daemon doesn't hold any
(no phone creds, no push creds; those live in the extension's vault-backed
`globalArguments`). It's just host/port/path overrides.

## What this daemon deliberately does NOT do

- Does not acquire data (no Grafana query, no swamp model read, no `swamp`
  subprocess).
- Does not talk to the phone's REST or push API (dial, pushAlert, setDisplay,
  configGet/Set, reboot, capture) -- those are `@shrug/polycom-vvx` extension
  methods.
- Does not screen-pop or page on a telephony event -- v1 defers that relay
  (spec section 7, decision D5); `/event` only logs.
- Does not run a background refresher thread. The spike's in-process
  Grafana-polling thread (`sources.py` + `SWAMP_BIN`) is gone; refresh
  cadence is owned by a scheduled swamp workflow outside this daemon.
