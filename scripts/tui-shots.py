"""Drive both tier TUIs headless through tmux; save ANSI captures and PNGs.

    uv run python scripts/tui-shots.py                 # home + settings, both tiers
    uv run python scripts/tui-shots.py --session       # + a real turn (model call) for the header
    uv run python scripts/tui-shots.py --out /tmp/x tier2

Needs demo 2 up (make demo2-up), tmux, and Google Chrome for the PNG render
(the ANSI capture is turned into HTML and screenshotted — braille and colours
exactly as a terminal shows them). Writes docs/shots/tui/<tier>-<step>.{ans,png}.
"""

from __future__ import annotations

import argparse
import html
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SESSION = "sojourner-shots"
WORKDIR = {"tier1": "/workspace/project", "tier2": "/workspace"}


def tmux(*a: str) -> str:
    return subprocess.run(["tmux", *a], capture_output=True, text=True).stdout


def cap(esc: bool = False) -> str:
    return tmux("capture-pane", "-p", "-t", SESSION, *(["-e"] if esc else []))


def keys(*ks: str, pause: float = 0.35) -> None:
    for k in ks:
        if k.startswith("lit:"):
            tmux("send-keys", "-t", SESSION, "-l", k[4:])
        else:
            tmux("send-keys", "-t", SESSION, k)
        time.sleep(pause)


def wait(text: str, timeout: float) -> bool:
    t0 = time.time()
    while time.time() - t0 < timeout:
        if text in cap():
            return True
        time.sleep(0.4)
    return False


def start(tier: str, size: str) -> None:
    w, h = size.split("x")
    tmux("kill-session", "-t", SESSION)
    # a killed tmux client leaves `docker exec`'s opencode running in the container
    subprocess.run(["docker", "exec", f"sojourner-{tier}", "pkill", "-x", "opencode"], capture_output=True)
    time.sleep(0.5)
    tmux("new-session", "-d", "-s", SESSION, "-x", w, "-y", h,
         f"docker exec -it -w {WORKDIR[tier]} sojourner-{tier} opencode")
    if not wait("SETTINGS", 60):
        raise SystemExit(f"{tier}: TUI did not come up\n{cap()}")
    time.sleep(2)


# ---- ANSI -> HTML -> PNG ---------------------------------------------------------

BASE16 = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
          "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"]


def _x256(n: int) -> str:
    if n < 16:
        return BASE16[n]
    if n < 232:
        n -= 16
        f = lambda v: 0 if v == 0 else 55 + v * 40
        return "#%02x%02x%02x" % (f(n // 36), f(n // 6 % 6), f(n % 6))
    v = 8 + (n - 232) * 10
    return "#%02x%02x%02x" % (v, v, v)


def ansi_html(text: str, bg: str = "#000000", fg: str = "#d4d4d4") -> str:
    out, st, buf = [], {"fg": None, "bg": None, "b": False}, []

    def flush() -> None:
        if not buf:
            return
        css = ";".join(x for x in (f"color:{st['fg']}" if st["fg"] else "",
                                   f"background:{st['bg']}" if st["bg"] else "",
                                   "font-weight:bold" if st["b"] else "") if x)
        # braille glyphs are narrower than a cell in the page font: pin each to
        # one cell, or bordered art (book covers) drifts out of its frame
        s = re.sub("([\u2800-\u28ff])", r"<i class=b>\1</i>", html.escape("".join(buf)))
        buf.clear()
        out.append(f"<span style='{css}'>{s}</span>" if css else s)

    for m in re.finditer(r"\x1b\[([0-9;]*)m|\n|[^\x1b\n]+|\x1b.", text):
        tok = m.group(0)
        if tok.startswith("\x1b["):
            flush()
            codes = [int(c) if c else 0 for c in (m.group(1) or "0").split(";")]
            i = 0
            while i < len(codes):
                c = codes[i]
                if c == 0:
                    st.update(fg=None, bg=None, b=False)
                elif c == 1:
                    st["b"] = True
                elif c == 22:
                    st["b"] = False
                elif c == 39:
                    st["fg"] = None
                elif c == 49:
                    st["bg"] = None
                elif 30 <= c <= 37 or 90 <= c <= 97:
                    st["fg"] = BASE16[c - 30 if c < 90 else c - 82]
                elif 40 <= c <= 47 or 100 <= c <= 107:
                    st["bg"] = BASE16[c - 40 if c < 100 else c - 92]
                elif c in (38, 48) and i + 1 < len(codes):
                    key = "fg" if c == 38 else "bg"
                    if codes[i + 1] == 2 and i + 4 < len(codes):
                        st[key] = "#%02x%02x%02x" % tuple(codes[i + 2:i + 5])
                        i += 4
                    elif codes[i + 1] == 5 and i + 2 < len(codes):
                        st[key] = _x256(codes[i + 2])
                        i += 2
                i += 1
        elif tok == "\n":
            flush()
            out.append("\n")
        elif not tok.startswith("\x1b"):
            buf.append(tok)
    flush()
    return (f"<html><head><meta charset='utf-8'><style>body{{margin:0;background:{bg}}}"
            f"pre{{margin:0;padding:12px;font:14px/1.22 Menlo,'Apple Braille',monospace;"
            f"color:{fg};background:{bg}}}i.b{{font-style:normal;display:inline-block;width:1ch;"
            f"text-align:center;overflow:hidden;vertical-align:top}}"
            f"</style></head><body><pre>{''.join(out)}</pre></body></html>")


def png(ans: str, dst: Path, cols: int) -> None:
    page = Path(tempfile.mkdtemp()) / "shot.html"
    page.write_text(ansi_html(ans))
    lines = ans.rstrip("\n").count("\n") + 1
    dst.unlink(missing_ok=True)
    proc = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                             f"--user-data-dir={tempfile.mkdtemp(prefix='tui-shots-')}",
                             f"--window-size={int(cols * 8.45) + 24},{int(lines * 17.1) + 24}",
                             f"--screenshot={dst.resolve()}", page.as_uri()],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    t0, last = time.time(), -1
    while time.time() - t0 < 40:  # headless=new writes the file but may never exit
        time.sleep(0.5)
        size = dst.stat().st_size if dst.exists() else -1
        if size > 0 and size == last:
            break
        last = size
    proc.kill()


def save(out: Path, name: str, cols: int) -> None:
    time.sleep(1.2)
    ans = cap(esc=True)
    (out / f"{name}.ans").write_text(ans)
    if os.path.exists(CHROME):
        png(ans, out / f"{name}.png", cols)
    print(f"{name:28s} -> {out / name}.ans")


# ---- the walk ----------------------------------------------------------------------

# SETTINGS menu order (infra/tui/ui/settings.tsx); ctrl+x o opens it on Identity
SECTIONS = ["identity", "agents", "inference", "commands", "skills", "books", "documents",
            "prompts", "permissions", "connections", "requests", "audit", "sessions"]


def settings(section: str = "identity", enter: bool = True) -> None:
    """Open SETTINGS fresh and move to a section (menu focus unless `enter`)."""
    keys("C-x", "o", pause=0.8)
    keys(*["Down"] * SECTIONS.index(section), pause=0.25)
    if enter:
        keys("Right", pause=0.6)


def leave() -> None:
    keys("Escape", "Escape", pause=0.6)


def walk(tier: str, out: Path, session: bool) -> None:
    start(tier, "120x40")
    save(out, f"{tier}-home", 120)
    settings(enter=False)
    save(out, f"{tier}-settings", 120)
    save(out, f"{tier}-settings-identity", 120)
    leave()
    settings("skills")
    keys("Down", "Enter", pause=0.6)                                  # a skill in the reader
    save(out, f"{tier}-settings-view", 120)
    keys("Escape", pause=0.5)
    leave()
    settings("books", enter=False)                                    # the shelf
    save(out, f"{tier}-settings-books", 120)
    keys("Right", pause=0.6)                                          # architecture selected
    save(out, f"{tier}-settings-books-cover", 120)
    leave()
    for name in ("inference", "permissions", "connections"):
        settings(name)
        save(out, f"{tier}-settings-{name}", 120)
        leave()
    settings("requests")
    if tier == "tier1":
        keys("Down", pause=0.6)                                       # past "+ Request a deploy"
    save(out, f"{tier}-requests", 120)
    if tier == "tier2":
        save(out, f"{tier}-settings-approvals", 120)
    leave()
    if session:
        keys("lit:Reply with exactly: ready", "Enter")
        wait("esc interrupt", 20)
        t0 = time.time()
        while "esc interrupt" in cap() and time.time() - t0 < 240:
            time.sleep(1)
        save(out, f"{tier}-session", 120)
    start(tier, "80x24")
    save(out, f"{tier}-home-80x24", 80)
    settings("books")                                                 # below 100 cols: list + spine
    save(out, f"{tier}-settings-books-80x24", 80)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("tiers", nargs="*", default=["tier1", "tier2"])
    ap.add_argument("--out", type=Path, default=Path("docs/shots/tui"))
    ap.add_argument("--session", action="store_true", help="also run one model turn (header shot)")
    ap.add_argument("--render", action="store_true", help="only re-render the PNGs from the saved .ans")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    if a.render:
        for ans in sorted(a.out.glob("*.ans")):
            png(ans.read_text(), ans.with_suffix(".png"), 80 if ans.stem.endswith("80x24") else 120)
            print(f"{ans.stem:28s} -> {ans.with_suffix('.png')}")
        return 0
    try:
        for tier in a.tiers:
            walk(tier, a.out, a.session)
    finally:
        tmux("kill-session", "-t", SESSION)
        for tier in a.tiers:
            subprocess.run(["docker", "exec", f"sojourner-{tier}", "pkill", "-x", "opencode"], capture_output=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
