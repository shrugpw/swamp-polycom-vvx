#!/usr/bin/env python3
"""
Polycom VVX render/serve daemon -- the DISPLAY plane of @shrug/polycom-vvx.

Ported from the throwaway spike at design/poc/vvx-microbrowser/server.py per
design/specs/polycom-vvx-extension.spec.md sections 2 and 4. Read those before
touching this file.

THE CORE DISCIPLINE (do not violate):

  This daemon is DUMB about data sources. It reads a pre-computed snapshot JSON
  file and renders/serves it. It NEVER acquires data, and it NEVER shells out
  to `swamp` or any other CLI. Data acquisition is the swamp plane's job (the
  @shrug/polycom-vvx extension's `composeIdleSnapshot` method, scheduled by a
  swamp workflow) -- that plane writes the snapshot file this daemon reads.

  The spike's server.py violated this on purpose (a knowing repo-rule-1
  shortcut, documented as such in the spike) by importing sources.py and
  running an in-process refresher thread that shelled out to `swamp
  ... queryMetrics`. That import, that thread, and the SWAMP_BIN path are
  REMOVED here. They do not belong in the product.

Two channels:

  PULL  phone -> us   The microbrowser fetches XHTML from us. Point the
                      phone's mb.idleDisplay.home at http://<us>/idle and
                      mb.main.home at http://<us>/s/dashboard.
  PUSH  phone -> us   The phone POSTs telephony-event XML to /event. This
                      daemon only logs/records the event -- it is a seam for
                      a future relay (screen-pop, pager), not a data source of
                      its own, and it never calls swamp.

Run directly for local testing:
    VVX_SNAPSHOT_PATH=/tmp/idle_snapshot.json python3 server.py

Normal deployment is the systemd --user unit in deploy/vvx-daemon.service,
configured via an env file (see README.md).

Everything is stdlib + Pillow (via screens.py) -- no other deps.
"""

import hmac
import html
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------------------
# Configuration -- all from the environment. No CLI flags for anything that
# changes runtime behavior; the systemd unit's env file is the single source
# of truth (repo rule: config in tracked config, not ephemeral flags).
# ---------------------------------------------------------------------------

LISTEN_HOST = os.environ.get("VVX_LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("VVX_LISTEN_PORT", "7070"))

# Where the swamp plane's composeIdleSnapshot writes its output. This daemon
# only ever READS this file -- it never writes it, never queries anything to
# produce it. Default matches the systemd --user runtime dir convention.
_DEFAULT_RUNTIME_DIR = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
SNAPSHOT_PATH = os.environ.get(
    "VVX_SNAPSHOT_PATH", os.path.join(_DEFAULT_RUNTIME_DIR, "vvx", "idle_snapshot.json")
)

# Advertised only on the human-facing status page (/) -- purely informational,
# not used to reach out anywhere. Set to whatever serveBaseUrl is configured
# as on the phone's inventory YAML so the status page is self-documenting.
BASE_URL = os.environ.get("VVX_BASE_URL", f"http://<this-host>:{LISTEN_PORT}")

# Snapshot older than this (seconds) => render with the (stale) header marker.
# Per spec section 4: tune by making the compose cycle faster, do not widen
# this to paper over a slow refresh.
IDLE_STALE_AFTER = int(os.environ.get("VVX_STALE_AFTER_SECONDS", "90"))

# --- endpoint auth (finding F3) --------------------------------------------
# The write-ish POST endpoints are otherwise an unauthenticated spoofing/flood
# surface on a LAN-reachable port. Two separate secrets because the two callers
# differ in what they can send:
#   * /api/push  -- called BY the swamp control plane (it CAN send a header), so
#     it is FAIL-CLOSED: unset token => the endpoint is disabled (403).
#   * /event     -- POSTed BY the phone, which cannot attach an auth header, so
#     the secret rides the configured event URL as ?token=<...>. If unset, the
#     endpoint stays open (phone compatibility) but logs a one-time warning.
PUSH_TOKEN = os.environ.get("VVX_PUSH_TOKEN", "")
EVENT_TOKEN = os.environ.get("VVX_EVENT_TOKEN", "")
_EVENT_OPEN_WARNED = False

# Bound on in-memory event/hit logs so the daemon never grows unbounded.
_LOG_CAP = 40

# ---------------------------------------------------------------------------
# Shared mutable state. All ephemeral (in-memory only, reset on restart):
#   - events: rolling log of telephony events POSTed to /event
#   - alert / caller: content handed to us by the control-plane extension via
#     POST /api/push, for the /s/alert and /s/caller display-swap surfaces
#     (CONTROL-SURFACE.md's setDisplay primitive points the phone at these
#     URLs; the daemon renders whatever content it was last given -- it does
#     not go fetch that content itself).
# ---------------------------------------------------------------------------

import threading

STATE_LOCK = threading.Lock()
STATE = {
    "events": [],
    "alert": {"level": "info", "title": "No active alerts", "body": "", "host": "", "ts": None},
    "caller": None,
}


def record_event(entry):
    with STATE_LOCK:
        STATE["events"].insert(0, entry)
        del STATE["events"][_LOG_CAP:]


# ---------------------------------------------------------------------------
# Snapshot reading. This is the ONLY place the daemon touches the filesystem
# for data. It never writes here, never computes anything -- just parses the
# JSON the swamp plane already produced. Shape (frozen by spec section 5.3):
#   { tiles:[{value,label,sev}], rows:[{sev,key,msg}], degraded:[...],
#     notes, epoch }
# ---------------------------------------------------------------------------


def read_snapshot(path):
    """Return (snapshot_dict, age_seconds) or (None, None) if missing/bad."""
    try:
        with open(path) as f:
            snap = json.load(f)
    except (OSError, ValueError):
        return None, None
    try:
        epoch = int(snap.get("epoch", 0))
    except (TypeError, ValueError):
        epoch = 0
    age = int(time.time()) - epoch
    return snap, age


# ---------------------------------------------------------------------------
# XHTML rendering -- strict XHTML 1.0 Transitional, the dialect the
# microbrowser parses. Every tag closes; self-closing tags use '/>'.
# ---------------------------------------------------------------------------

DOCTYPE = (
    '<?xml version="1.0" encoding="iso-8859-1"?>\n'
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" '
    '"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n'
)


def page(title, body):
    return (
        DOCTYPE
        + '<html xmlns="http://www.w3.org/1999/xhtml">'
        + f"<head><title>{html.escape(title)}</title></head>"
        + f"<body>{body}</body></html>"
    )


def esc(s):
    return html.escape(str(s), quote=True)


# ---------------------------------------------------------------------------
# Telephony event parsing (verified schema, carried over from the spike).
# The daemon parses these purely to log/record them -- it does NOT screen-pop,
# does NOT page, does NOT call swamp. That logic belongs to the control-plane
# extension (spec section 7, v1 defers pager to v2). This handler is the
# clean seam a future relay hooks into.
# ---------------------------------------------------------------------------


def parse_event(raw, query):
    """Parse a VVX Telephony Event Notification.
    Returns (kind, callstate, number, name).

      <IncomingCallEvent>...<CallingPartyName>..</><CallingPartyNumber>sip:NUM@host</>
      <CallStateChangeEvent CallState="Offering|Connected|Disconnected|Free">
    """
    blob = raw or ""

    def tag(n):
        m = re.search(rf"<{n}>([^<]*)</{n}>", blob, re.I)
        return m.group(1).strip() if m else ""

    m = re.search(r"<(\w+Event)\b", blob)
    kind = m.group(1) if m else "event"
    m = re.search(r'CallState="([^"]+)"', blob)
    callstate = m.group(1) if m else ""
    name = tag("CallingPartyName")
    rawnum = tag("CallingPartyNumber")
    # the number is the user part of a SIP URI: sip:15550100100@host:port
    m = re.search(r"sip:([^@;>]+)", rawnum, re.I)
    number = m.group(1) if m else rawnum
    return kind, callstate, number, name


def fmt_number(number):
    d = "".join(c for c in (number or "") if c.isdigit())
    if len(d) == 11 and d[0] == "1":
        d = d[1:]
    if len(d) == 10:
        return f"+1 {d[0:3]} {d[3:6]} {d[6:]}"
    return number or ""


def events_page():
    with STATE_LOCK:
        evs = list(STATE["events"])
    trs = "".join(
        f"<tr><td>{esc(e['t'])}</td><td>{esc(e['kind'])}</td><td>{esc(e['party'])}</td></tr>"
        for e in evs
    )
    body = (
        "<h1>Telephony events (log only -- no relay wired in v1)</h1>"
        '<table border="1"><tbody>'
        "<tr><th>time</th><th>event</th><th>party</th></tr>"
        f"{trs}</tbody></table>"
        '<p><a href="/events">refresh</a> | <a href="/">home</a></p>'
    )
    return page("Events", body)


# ---------------------------------------------------------------------------
# Rendering -- delegates entirely to screens.py (kept verbatim, hardware-
# verified render/design system). This daemon never composes tile/row data
# itself; it only reads the snapshot (for dashboard/idle) or the last pushed
# content (for alert/caller) and hands it to screens.py.
# ---------------------------------------------------------------------------

try:
    import screens as SCREENS

    _HAVE_SCREENS = True
except Exception as e:  # pragma: no cover - Pillow/font issue on this host
    _HAVE_SCREENS = False
    sys.stderr.write(f"[server] screens.py unavailable: {e!r}\n")


def render_screen_png(name):
    if not _HAVE_SCREENS:
        return None
    clock = time.strftime("%H:%M")

    if name == "caller":
        with STATE_LOCK:
            c = dict(STATE["caller"]) if STATE["caller"] else {}
        return SCREENS.render_caller(
            name=c.get("name", "No active call"),
            org=c.get("org", ""),
            number=c.get("number", ""),
            note=c.get("note", ""),
            matched=bool(c.get("matched")),
            clock=clock,
        )

    if name == "alert":
        with STATE_LOCK:
            a = dict(STATE["alert"])
        lvl = a.get("level", "info")
        lvl = lvl if lvl in ("ok", "warn", "crit", "info") else "info"
        return SCREENS.render_alert(
            level=lvl, title=a.get("title", ""), body=a.get("body", ""),
            host=a.get("host", ""), clock=clock,
        )

    if name in ("dashboard", "idle"):
        # The ONLY data this daemon ever renders for the fleet view: whatever
        # is currently in the snapshot file. No fallback to a live query, no
        # swamp call -- if the snapshot is missing, screens.py's own built-in
        # demo defaults are used so the panel is never blank on first boot.
        tiles = rows = None
        stale = False
        snap, age = read_snapshot(SNAPSHOT_PATH)
        if snap:
            # Honor the snapshot EXACTLY -- an empty rows list is real
            # ("nothing down") and must NOT fall back to demo data. Demo data
            # appears only when there is no snapshot file at all yet.
            tiles = snap.get("tiles") or None
            rows = snap.get("rows", [])
            degraded = snap.get("degraded")
            stale = bool(degraded) or (age is not None and age > IDLE_STALE_AFTER)
        return SCREENS.render_dashboard(
            clock=clock, updated=time.strftime("%H:%M:%S"),
            full=(name == "idle"), tiles=tiles, rows=rows, stale=stale,
        )

    return None


def screen_page(name, height=180):
    # Bare page = the composed image. height=180 fits inside the main
    # browser's title + soft-key chrome; height=240 fills the whole panel for
    # the chromeless idle/screensaver surface. The page <title> becomes the
    # phone's status bar (ignored by the screensaver, which has no title
    # bar). bgcolor + zeroed body margins (the only styling the microbrowser
    # honors) kill the white margin the browser otherwise paints.
    with STATE_LOCK:
        snap_for_title = {"alert": dict(STATE["alert"])}
    title = SCREENS.title_for(name, snap_for_title) if _HAVE_SCREENS else name
    img = (
        f'<img src="/screen/{esc(name)}.png" width="320" height="{height}" '
        f'alt="{esc(name)}"/>'
    )
    return (
        DOCTYPE
        + '<html xmlns="http://www.w3.org/1999/xhtml">'
        + f"<head><title>{html.escape(title)}</title></head>"
        + '<body bgcolor="#0B0E13" text="#E6EDF3" topmargin="0" leftmargin="0" '
          f'marginwidth="0" marginheight="0">{img}</body></html>'
    )


def status_page():
    snap, age = read_snapshot(SNAPSHOT_PATH)
    if snap is None:
        snap_line = f"no snapshot at {esc(SNAPSHOT_PATH)} (not written yet, or path misconfigured)"
    else:
        degraded = snap.get("degraded")
        stale = bool(degraded) or (age is not None and age > IDLE_STALE_AFTER)
        snap_line = (
            f"snapshot age {age}s, degraded={bool(degraded)}, "
            f"stale={stale} ({esc(SNAPSHOT_PATH)})"
        )
    body = (
        "<h1>polycom-vvx daemon</h1>"
        "<p>Display plane only. Reads a pre-computed snapshot; never queries "
        "data; never shells out to swamp.</p>"
        f"<p>base url: {esc(BASE_URL)}</p>"
        f"<p>{snap_line}</p>"
        "<ul>"
        '<li><a href="/idle">/idle</a> -- chromeless idle surface (320x240)</li>'
        '<li><a href="/s/dashboard">/s/dashboard</a> -- main surface (320x180)</li>'
        '<li><a href="/s/alert">/s/alert</a>, <a href="/s/caller">/s/caller</a></li>'
        '<li><a href="/events">/events</a> -- recorded telephony events (log only)</li>'
        '<li><a href="/healthz">/healthz</a></li>'
        "</ul>"
    )
    return page("polycom-vvx daemon", body)


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "VVXDaemon/1"

    def _send_xhtml(self, doc, code=200):
        payload = doc.encode("iso-8859-1", "replace")
        self.send_response(code)
        # The microbrowser accepts application/xhtml+xml; charset must match.
        self.send_header("Content-Type", "application/xhtml+xml; charset=iso-8859-1")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(payload)

    def _send_json(self, obj, code=200):
        payload = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _handle_event(self, raw, query):
        """Log + record a telephony event notification. Does NOT screen-pop,
        does NOT page, does NOT call swamp -- this is a seam for a future
        relay, not a data source or control-plane action."""
        kind, callstate, number, name = parse_event(raw, query)
        label = callstate or kind
        party = (f"{name} <{number}>" if name else number) or "(none)"
        record_event({"t": time.strftime("%H:%M:%S"), "kind": label, "party": party})
        sys.stderr.write(f"[EVENT] {label} party={party}\n")
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)

        if u.path == "/event":
            self._handle_event("", u.query)
            return

        if u.path == "/healthz":
            self._send_json({"ok": True, "snapshotPath": SNAPSHOT_PATH})
            return

        if u.path.startswith("/screen/") and u.path.endswith(".png"):
            name = u.path[len("/screen/"):-len(".png")]
            data = render_screen_png(name)
            if data is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/idle":
            # chromeless full-panel idle/screensaver surface (mb.idleDisplay.home)
            self._send_xhtml(screen_page("idle", height=240))
            return

        if u.path.startswith("/s/"):
            name = u.path[len("/s/"):]
            if name in ("alert", "caller", "dashboard"):
                self._send_xhtml(screen_page(name))
                return
            self.send_error(404)
            return

        if u.path == "/events":
            self._send_xhtml(events_page())
            return

        if u.path == "/":
            self._send_xhtml(status_page())
            return

        self._send_xhtml(page("404", "<h1>404</h1><p>No such page.</p>"), code=404)

    # Hard cap on any request body -- the phone's event XML and the control
    # plane's push JSON are both tiny; anything larger is abuse. Guards against
    # an oversized/garbage Content-Length forcing a huge per-thread allocation
    # (ThreadingHTTPServer = one thread per request).
    MAX_BODY_BYTES = 64 * 1024

    def _read_body(self):
        """Read the request body with a safe Content-Length parse and a size
        cap. On a bad or oversized length, send an error response and return
        None (the caller must return immediately)."""
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except (TypeError, ValueError):
            self._send_json({"ok": False, "error": "bad Content-Length"}, code=400)
            return None
        if length < 0:
            self._send_json({"ok": False, "error": "bad Content-Length"}, code=400)
            return None
        if length > self.MAX_BODY_BYTES:
            self._send_json({"ok": False, "error": "payload too large"}, code=413)
            return None
        return self.rfile.read(length).decode("utf-8", "replace") if length else ""

    def _authorize_push(self):
        """/api/push is FAIL-CLOSED (finding F3): disabled unless VVX_PUSH_TOKEN
        is set, then it requires the token via `Authorization: Bearer <t>` or an
        `X-VVX-Token` header. The swamp control plane is the only caller and can
        send a header, so there is no reason to leave this open."""
        if not PUSH_TOKEN:
            self._send_json(
                {"ok": False, "error": "/api/push disabled: set VVX_PUSH_TOKEN"},
                code=403,
            )
            return False
        provided = self.headers.get("X-VVX-Token", "")
        auth = self.headers.get("Authorization", "")
        if not provided and auth.startswith("Bearer "):
            provided = auth[len("Bearer "):]
        if not hmac.compare_digest(provided, PUSH_TOKEN):
            self._send_json({"ok": False, "error": "forbidden"}, code=403)
            return False
        return True

    def _authorize_event(self, query):
        """/event is POSTed by the phone, which cannot attach an auth header, so
        the secret rides the configured event URL as `?token=<...>` (finding F3).
        If VVX_EVENT_TOKEN is unset the endpoint stays open for phone
        compatibility, but warns once so the exposure is never silent."""
        global _EVENT_OPEN_WARNED
        if not EVENT_TOKEN:
            if not _EVENT_OPEN_WARNED:
                sys.stderr.write(
                    "[server] WARNING: /event is unauthenticated. Set "
                    "VVX_EVENT_TOKEN and append ?token=<it> to the phone's "
                    "configured event URL to require it.\n"
                )
                _EVENT_OPEN_WARNED = True
            return True
        provided = parse_qs(query or "").get("token", [""])[0]
        if not hmac.compare_digest(provided, EVENT_TOKEN):
            self._send_json({"ok": False, "error": "forbidden"}, code=403)
            return False
        return True

    def do_POST(self):
        u = urlparse(self.path)

        if u.path == "/event":
            if not self._authorize_event(u.query):
                return
            raw = self._read_body()
            if raw is None:
                return
            self._handle_event(raw, u.query)
            return

        if u.path == "/api/push":
            # The control-plane extension's pushAlert/setDisplay methods hand
            # us already-composed content here; we just remember it and
            # render it when the phone next pulls /s/alert or /s/caller. We
            # never fetch this content ourselves -- it is handed to us.
            if not self._authorize_push():
                return
            raw = self._read_body()
            if raw is None:
                return
            try:
                body = json.loads(raw) if raw else {}
            except ValueError:
                self._send_json({"ok": False, "error": "invalid JSON"}, code=400)
                return
            screen = body.get("screen")
            if screen == "alert":
                with STATE_LOCK:
                    STATE["alert"] = {
                        "level": body.get("level", "info"),
                        "title": body.get("title", ""),
                        "body": body.get("body", ""),
                        "host": body.get("host", ""),
                        "ts": time.strftime("%H:%M:%S"),
                    }
                self._send_json({"ok": True})
                return
            if screen == "caller":
                with STATE_LOCK:
                    STATE["caller"] = {
                        "name": body.get("name", ""),
                        "org": body.get("org", ""),
                        "number": fmt_number(body.get("number", "")),
                        "note": body.get("note", ""),
                        "matched": bool(body.get("matched")),
                    }
                self._send_json({"ok": True})
                return
            self._send_json({"ok": False, "error": "screen must be 'alert' or 'caller'"}, code=400)
            return

        # Lenient: the phone may POST telephony event notifications to
        # whatever path is configured (often the app-server root, "/").
        # Treat any other POST as an event so we never miss one.
        if not self._authorize_event(u.query):
            return
        raw = self._read_body()
        if raw is None:
            return
        self._handle_event(raw, u.query)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


# ---------------------------------------------------------------------------
# Entry point. No CLI subcommands for control-plane actions (dial, push,
# config, forward) -- those live in the @shrug/polycom-vvx extension now.
# This daemon does exactly one thing: serve.
# ---------------------------------------------------------------------------


def main():
    if not _HAVE_SCREENS:
        sys.stderr.write(
            "[server] WARNING: screens.py failed to import (Pillow/fonts "
            "missing?) -- /screen/*.png and /s/*, /idle will 404 or 500.\n"
        )
    httpd = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f"polycom-vvx daemon serving on http://{LISTEN_HOST}:{LISTEN_PORT}")
    print(f"reading idle snapshot from {SNAPSHOT_PATH}")
    print("display plane only: never queries data, never calls swamp")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
