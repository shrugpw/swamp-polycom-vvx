#!/usr/bin/env python3
"""
Server-side screen renderer for the VVX 411.

IMPORTANT geometry: the microbrowser draws its OWN title bar (top, the page
<title>) and soft-key bar (bottom). On a 320x240 panel that leaves a usable
content area of ~320x180. So we compose to 320x180 -- no clipping -- and let the
phone's title bar carry the status line (set dynamically by the server).

Design system: dark NOC ground, moss-teal brand, semantic severity colors,
IBM Plex Mono for data + Inter for the human layer.
"""

from io import BytesIO
from PIL import Image, ImageDraw, ImageFont

W, H = 320, 180   # content-area safe size (inside the microbrowser chrome)
H_FULL = 240      # full panel -- the idle/screensaver surface has NO chrome

# --- palette -------------------------------------------------------------
INK0 = (11, 14, 19)
INK1 = (20, 26, 35)
PANEL = (27, 36, 48)
LINE = (38, 49, 63)
TEXT = (230, 237, 243)
DIM = (139, 151, 166)
BRAND = (53, 199, 154)
SEV = {
    "ok":   (63, 183, 126),
    "warn": (231, 163, 62),
    "crit": (229, 72, 77),
    "info": (53, 199, 154),
}

_F = {
    "inter": {
        "b": "/home/neil/.local/share/fonts/Inter-Bold.ttf",
        "m": "/home/neil/.local/share/fonts/Inter-Medium.ttf",
        "r": "/home/neil/.local/share/fonts/Inter-Regular.ttf",
    },
    "mono": {
        "b": "/home/neil/.local/share/fonts/ibm-plex-mono/IBMPlexMono-Bold.ttf",
        "m": "/home/neil/.local/share/fonts/ibm-plex-mono/IBMPlexMono-Medium.ttf",
        "r": "/home/neil/.local/share/fonts/ibm-plex-mono/IBMPlexMono-Regular.ttf",
    },
}
_CACHE = {}


def font(family, weight, size):
    key = (family, weight, size)
    if key not in _CACHE:
        try:
            _CACHE[key] = ImageFont.truetype(_F[family][weight], size)
        except Exception:
            _CACHE[key] = ImageFont.load_default()
    return _CACHE[key]


def _vgrad(top, bot, h=H):
    base = Image.new("RGB", (W, h), top)
    d = ImageDraw.Draw(base)
    for y in range(h):
        t = y / (h - 1)
        d.line([(0, y), (W, y)],
               fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return base


def _tw(d, font_, s):
    b = d.textbbox((0, 0), s, font=font_)
    return b[2] - b[0]


def spaced(d, xy, s, font_, fill, tracking=2):
    x, y = xy
    for ch in s:
        d.text((x, y), ch, font=font_, fill=fill)
        x += _tw(d, font_, ch) + tracking
    return x


def spaced_w(d, s, font_, tracking=2):
    return sum(_tw(d, font_, ch) + tracking for ch in s)


def wrap(d, s, font_, max_w):
    words, lines, cur = s.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if _tw(d, font_, trial) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def fit_font(d, s, family, weight, start, min_size, max_w):
    size = start
    while size > min_size and _tw(d, font(family, weight, size), s) > max_w:
        size -= 1
    return font(family, weight, size)


def _base(level, h=H):
    """Ground + left severity stripe. No top bar -- the phone's title bar is our
    status line. Content starts at y~10, x~16."""
    img = _vgrad(INK0, INK1, h=h)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 5, h], fill=SEV.get(level, BRAND))
    return img, d


def _clock(d, clock):
    f = font("mono", "m", 12)
    d.text((W - 12 - _tw(d, f, clock), 10), clock, font=f, fill=DIM)


def _out(img, scale):
    if scale != 1:
        img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _pill(d, xy, text, fg, bg, pad=6):
    f = font("mono", "b", 11)
    x, y = xy
    w, h = spaced_w(d, text, f, 2) + pad * 2, 18
    d.rounded_rectangle([x, y, x + w, y + h], radius=9, fill=bg)
    spaced(d, (x + pad, y + 3), text, f, fg, tracking=2)
    return x + w


# --- screens (composed to 320x180) --------------------------------------

def render_alert(level="crit", title="riscv-07 unreachable",
                 body="koji builder buildhw-riscv-07 has missed 3 heartbeats; fleet capacity -1.",
                 host="father-of-make-believe", clock="17:42", scale=1):
    img, d = _base(level)
    sev = SEV.get(level, BRAND)
    label = {"crit": "CRITICAL", "warn": "WARNING", "ok": "RESOLVED",
             "info": "NOTICE"}.get(level, "ALERT")
    _clock(d, clock)

    # severity band
    d.rounded_rectangle([16, 10, W - 14, 44], radius=8, fill=PANEL)
    d.rectangle([16, 10, 22, 44], fill=sev)
    cx, cy = 40, 27
    d.polygon([(cx, cy - 10), (cx + 11, cy + 9), (cx - 11, cy + 9)], fill=sev)
    d.text((cx - 2, cy - 5), "!", font=font("inter", "b", 14), fill=(0, 0, 0))
    spaced(d, (60, 20), label, font("mono", "b", 14), sev, tracking=4)

    tf = fit_font(d, title, "inter", "b", 23, 15, W - 40)
    d.text((18, 56), title, font=tf, fill=TEXT)

    bf = font("inter", "r", 14)
    y = 56 + tf.size + 6
    for ln in wrap(d, body, bf, W - 40)[:3]:
        d.text((18, y), ln, font=bf, fill=DIM)
        y += 19

    d.line([(16, H - 26), (W - 14, H - 26)], fill=LINE)
    mf = font("mono", "m", 12)
    d.text((18, H - 19), host, font=mf, fill=DIM)
    ack = "ACK ->"
    d.text((W - 14 - _tw(d, mf, ack), H - 19), ack, font=mf, fill=BRAND)
    return _out(img, scale)


def render_caller(name="Jane Caller", org="Example Org",
                  number="+1 555 010 0100", note="Example screen-pop card.",
                  matched=True, clock="17:42", scale=1):
    img, d = _base("info")
    _clock(d, clock)
    spaced(d, (18, 10), "INCOMING CALL", font("mono", "b", 12), BRAND, tracking=3)

    d.ellipse([18, 34, 62, 78], fill=PANEL, outline=BRAND, width=2)
    initials = "".join(w[0] for w in name.split()[:2]).upper() or "?"
    inf = font("inter", "b", 19)
    d.text((40 - _tw(d, inf, initials) / 2, 46), initials, font=inf, fill=BRAND)

    nf = fit_font(d, name, "inter", "b", 25, 15, W - 86)
    d.text((74, 34), name, font=nf, fill=TEXT)
    d.text((74, 34 + nf.size + 3), org, font=font("mono", "m", 13), fill=DIM)

    d.text((18, 90), number, font=font("mono", "b", 18), fill=TEXT)
    if matched:
        _pill(d, (18, 116), "CRM MATCH", (7, 12, 10), SEV["ok"])
    else:
        _pill(d, (18, 116), "NO MATCH", TEXT, LINE)

    d.line([(16, 144), (W - 14, 144)], fill=LINE)
    bf = font("inter", "r", 14)
    y = 150
    for ln in wrap(d, note, bf, W - 34)[:2]:
        d.text((18, y), ln, font=bf, fill=DIM)
        y += 17
    return _out(img, scale)


def _sev_color(name):
    """Map a provider severity name to a palette color (see sources.py vocab)."""
    if name == "brand":
        return BRAND
    return SEV.get(name, SEV["info"])


def render_dashboard(hosts_up=41, hosts_total=43, alerts=1, builds=6,
                     clock="17:42", updated="17:41:58", scale=1, full=False,
                     tiles=None, rows=None, stale=False):
    # full=True renders the whole 320x240 panel for the chromeless idle/
    # screensaver surface; full=False keeps the 320x180 box that fits under the
    # main browser's title + soft-key chrome (used for pushed screens).
    #
    # tiles/rows: when supplied by the data-source layer (sources.py), they
    # override the demo defaults. tiles = [{value,label,sev}], capped at 3;
    # rows = [{sev,key,msg}]. Omitted -> the hardcoded demo view below.
    # stale=True dims the header to flag that the cached snapshot is old.
    h = H_FULL if full else H
    # any crit tile/row (or the legacy `alerts` count) reddens the ground
    has_crit = bool(alerts)
    if tiles is not None:
        has_crit = any(t.get("sev") == "crit" for t in tiles)
    if rows is not None:
        has_crit = has_crit or any(r.get("sev") == "crit" for r in rows)
    level = "crit" if has_crit else "ok"
    img, d = _base(level, h)
    _clock(d, clock)
    header = "FLEET STATUS" + ("  (stale)" if stale else "")
    spaced(d, (18, 10), header, font("mono", "b", 12),
           SEV["warn"] if stale else DIM, tracking=3)

    if tiles is not None:
        tile_defs = [(t["value"], t["label"], _sev_color(t.get("sev", "info")))
                     for t in tiles[:3]]
    else:
        tile_defs = [
            (f"{hosts_up}/{hosts_total}", "HOSTS UP",
             SEV["ok"] if hosts_up == hosts_total else SEV["warn"]),
            (str(alerts), "ALERTS", SEV["crit"] if alerts else SEV["ok"]),
            (str(builds), "BUILDS", BRAND),
        ]
    tw, gap, x0, y0 = 92, 8, 18, 30
    for i, (num, lab, col) in enumerate(tile_defs):
        x = x0 + i * (tw + gap)
        d.rounded_rectangle([x, y0, x + tw, y0 + 60], radius=8, fill=PANEL)
        d.rectangle([x, y0, x + tw, y0 + 3], fill=col)
        nf = fit_font(d, num, "mono", "b", 28, 15, tw - 12)
        d.text((x + (tw - _tw(d, nf, num)) / 2, y0 + 10), num, font=nf, fill=col)
        lf = font("mono", "m", 10)
        spaced(d, (x + (tw - spaced_w(d, lab, lf, 2)) / 2, y0 + 44),
               lab, lf, DIM, tracking=2)

    panel_bottom = h - 8
    d.rounded_rectangle([18, 100, W - 14, panel_bottom], radius=8, fill=(0, 0, 0))
    if rows is not None:
        row_defs = [(_sev_color(r.get("sev", "info")), r["key"], r["msg"])
                    for r in rows]
    else:
        row_defs = [
            (SEV["crit"], "riscv-07", "unreachable 3m"),
            (SEV["ok"], "backup1", "borg ok 04:00"),
            (SEV["ok"], "worker2", "coolify healthy"),
        ]
        if full:
            # the tall panel has room for the rest of the resting fleet view
            row_defs += [
                (SEV["ok"], "father", "xcp-ng 8.3 up"),
                (SEV["warn"], "vyos-home", "cpu 78%"),
                (SEV["ok"], "backup2", "borg ok 04:12"),
                (SEV["ok"], "thinkcenter", "alloy scraping"),
            ]
    # when full, reserve a bottom strip inside the panel for the updated stamp
    row_limit_y = (h - 26) if full else panel_bottom
    y = 108
    rf = font("mono", "m", 12)
    for col, host, msg in row_defs:
        if y + 14 > row_limit_y:
            break
        d.ellipse([26, y + 3, 32, y + 9], fill=col)
        d.text((40, y), host, font=font("mono", "b", 12), fill=TEXT)
        d.text((W - 22 - _tw(d, rf, msg), y), msg, font=rf, fill=DIM)
        y += 19
    if full:
        sf = font("mono", "m", 10)
        stamp = f"updated {updated}"
        d.text((W - 14 - _tw(d, sf, stamp), h - 18), stamp, font=sf, fill=DIM)
    return _out(img, scale)


RENDERERS = {
    "alert": render_alert,
    "caller": render_caller,
    "dashboard": render_dashboard,
}


def title_for(name, state):
    """Status line for the microbrowser's title bar (the blue top strip)."""
    if name == "dashboard":
        return "SWAMP  41/43 up  1 alert"
    if name == "alert":
        a = state.get("alert", {}) if state else {}
        lvl = (a.get("level") or "info").upper()
        return f"SWAMP {lvl}"
    if name == "caller":
        return "SWAMP  Incoming call"
    return "SWAMP"


if __name__ == "__main__":
    import sys
    outdir = sys.argv[1] if len(sys.argv) > 1 else "."
    for name, fn in RENDERERS.items():
        with open(f"{outdir}/screen-{name}.png", "wb") as f:
            f.write(fn(scale=1))
        with open(f"{outdir}/screen-{name}@3x.png", "wb") as f:
            f.write(fn(scale=3))
    print(f"wrote {len(RENDERERS)} screens (1x + 3x, {W}x{H}) to {outdir}")
