#!/usr/bin/env python3
"""Local work board. Serves the UI, stores board.json, per-card canvases, media,
and exposes live 'waiting on you' sessions."""
import json, os, glob, time, fcntl, re, base64, shutil, hashlib
from urllib.parse import unquote
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "board.json")
CANVASES = os.path.join(HERE, "canvases")
MEDIA = os.path.join(HERE, "media")
KEPT = os.path.join(HERE, "kept.json")   # Studio boards kept for good (ad creatives, libraries): listed first, reused by new cards
DROPS = os.path.expanduser(os.environ.get("BOARD_DROPS", "~/.claude/drops"))   # files dropped into an agent chat
ASSETS = os.path.join(HERE, "canvas-assets")
WAIT_DIR = os.path.expanduser("~/.claude/waiting")
PORT = int(os.environ.get("BOARD_PORT", 4477))
# Studio: each card can have its own Studio board (planning + designs in one place)
STUDIO_URL = os.environ.get("STUDIO_URL", "http://127.0.0.1:4517")
STUDIO_CLI = os.environ.get("STUDIO_CLI") or os.path.join(HERE, "studio")   # install.sh links it to the repo's studio/bin/studio
STUDIO_HOME = os.environ.get("STUDIO_HOME", os.path.expanduser("~/Studio"))
CORS_OK = {STUDIO_URL, STUDIO_URL.replace("127.0.0.1", "localhost")}
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SAFE_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,200}$")
TYPES = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2",
         ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
         ".svg": "image/svg+xml", ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".webm": "video/webm"}

HIST = os.path.join(HERE, "history")
def snapshot(src=DATA, hist=HIST):
    """Keep a copy at most once a minute, last 3000 copies."""
    os.makedirs(hist, exist_ok=True)
    files = sorted(os.listdir(hist))
    if files and time.time() - os.path.getmtime(os.path.join(hist, files[-1])) < 60:
        return
    shutil.copy2(src, os.path.join(hist, time.strftime("%Y%m%d-%H%M%S-") + str(time.time_ns() % 10**6) + ".json"))
    for f in sorted(os.listdir(hist))[:-3000]: os.remove(os.path.join(hist, f))

def mtime_version(path):
    try: return str(os.stat(path).st_mtime_ns)
    except OSError: return "0"

def version(): return mtime_version(DATA)

def kept_boards():
    try: return [b for b in json.load(open(KEPT)) if isinstance(b, str)]
    except Exception: return []

def linked_cards(board):
    """Every card working on a Studio board that is not finished, newest first, with its Claude session."""
    try: cards = json.load(open(DATA))["cards"]
    except Exception: cards = []
    out = []
    for c in cards:
        if not board or c.get("studio") != board or c.get("status") == "Done": continue
        out.append({"id": c["id"], "title": c["title"], "brand": c.get("brand", ""), "status": c.get("status"),
                    "state": card_state(c), "created": c.get("created", 0)})
    return sorted(out, key=lambda c: -(c["created"] or 0))


def alive(pid):
    try:
        os.kill(int(pid), 0); return True
    except (ValueError, TypeError): return True   # no pid recorded: keep it
    except ProcessLookupError: return False
    except PermissionError: return True

def sessions():
    out = []
    for f in glob.glob(os.path.join(WAIT_DIR, "*.json")):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if d.get("pid") and not alive(d["pid"]):
            try: os.remove(f)
            except OSError: pass
            continue
        out.append(d)
    return sorted(out, key=lambda d: d.get("ts", 0))

PROJECTS = os.path.join(HERE, "projects.json")   # {brand: folder} the last folder each brand's agents were started in
def project_folders(brand):
    """Folders a new session can start in, the best one for this brand first: the one used last for it, else a folder
    named after it (~/Documents/<Brand> Agents, ~/<Brand>…), else the home folder."""
    try: saved = json.load(open(PROJECTS))
    except Exception: saved = {}
    home = os.path.expanduser("~"); docs = os.path.join(home, "Documents")
    cands = list(saved.values())
    for base in (docs, home):
        try: cands += [os.path.join(base, f) for f in sorted(os.listdir(base)) if not f.startswith(".") and re.search(r"agents?$", f, re.I) and os.path.isdir(os.path.join(base, f))]
        except OSError: pass
    cands.append(home)
    folders = list(dict.fromkeys(f for f in cands if os.path.isdir(f)))
    b = (brand or "").strip().lower()
    pick = saved.get(brand or "") if saved.get(brand or "") in folders else None
    if not pick and b: pick = next((f for f in folders if os.path.basename(f).lower().startswith(b)), None)
    pick = pick or (folders[0] if folders and folders[0] != home else home)
    tilde = lambda f: "~" + f[len(home):] if f.startswith(home) else f
    return [{"path": f, "label": tilde(f)} for f in folders], pick
def remember_folder(brand, folder):
    if not brand: return
    try: saved = json.load(open(PROJECTS))
    except Exception: saved = {}
    saved[brand] = folder
    tmp = PROJECTS + ".tmp"; json.dump(saved, open(tmp, "w"), indent=1); os.replace(tmp, PROJECTS)
def start_prompt(c):
    """The first message for a new session: the task, its notes and open steps."""
    out = [c.get("title") or ""]
    notes = (c.get("notes") or "").strip()
    if notes: out += ["", notes]
    steps = [s.get("text", "").strip() for s in c.get("steps") or [] if not s.get("done") and s.get("text", "").strip()]
    if steps: out += ["", "Steps:"] + [f"- {t}" for t in steps]
    return "\n".join(out).strip()

def card_info(cid):
    try:
        for c in json.load(open(DATA))["cards"]:
            if c["id"] == cid: return c
    except Exception: pass
    return {}

# ---------- linked Claude sessions ----------
SESS_DIR = os.path.join(WAIT_DIR, ".sessions")
ORCA = os.environ.get("ORCA") or shutil.which("orca") or "/usr/local/bin/orca"

def session_rec(pid):
    try: return json.load(open(os.path.join(SESS_DIR, f"{pid}.json")))
    except Exception: return {}

def tail_lines(path, nbytes=3_000_000):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2); size = f.tell(); f.seek(max(0, size - nbytes))
            data = f.read().decode("utf-8", "replace")
        lines = data.split("\n")
        return lines[1:] if size > nbytes else lines
    except Exception:
        return []

def reverse_lines(path, chunk=4_000_000, max_bytes=200_000_000):
    """Yield complete lines from the end of a file backwards (handles huge image lines)."""
    try: f = open(path, "rb")
    except Exception: return
    with f:
        f.seek(0, 2); pos = f.tell(); buf = b""; read = 0
        while pos > 0 and read < max_bytes:
            step = min(chunk, pos); pos -= step; read += step
            f.seek(pos); buf = f.read(step) + buf
            parts = buf.split(b"\n")
            buf = parts[0]                      # may be incomplete: keep for next round
            for ln in reversed(parts[1:]):
                if ln.strip(): yield ln
        if pos == 0 and buf.strip(): yield buf

def transcript_info(path, limit=14):
    """Clean conversation (your messages + Claude's replies) and the session title, newest last."""
    rev, title, custom = [], "", ""
    for raw in reverse_lines(path):
        # cheap pre-filter: skip giant image/tool blobs without parsing them
        head = raw[:400]
        if b'"type":"custom-title"' in head or b'"type":"ai-title"' in head:
            try: d = json.loads(raw)
            except Exception: continue
            if d.get("type") == "custom-title" and not custom: custom = d.get("customTitle") or ""
            if d.get("type") == "ai-title" and not title: title = d.get("aiTitle") or ""
            continue
        if len(rev) >= limit:
            if custom or title: break
            continue
        # the top-level "type" can sit at the start or (after a long message body) near the end of the line
        if len(raw) > 3_000_000: continue                      # image/tool-output blobs, never chat text
        ends = raw[:2000] + raw[-4000:]
        if b'"type":"user"' not in ends and b'"type":"assistant"' not in ends: continue
        try: d = json.loads(raw)
        except Exception: continue
        t = d.get("type")
        if t not in ("user", "assistant") or d.get("isMeta") or d.get("isSidechain") or d.get("isCompactSummary"): continue
        c = (d.get("message") or {}).get("content")
        if isinstance(c, str): text = c
        elif isinstance(c, list): text = "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
        else: text = ""
        text = text.strip()
        if not text or text.startswith("<") or text.startswith("Caveat:") or text.startswith("[Request interrupted") or text.startswith("This session is being continued from a previous conversation"): continue
        role = "you" if t == "user" else "claude"
        if rev and rev[-1]["role"] == role == "claude": rev[-1]["text"] = text + "\n\n" + rev[-1]["text"]
        else: rev.append({"role": role, "text": text[:30000]})
    return list(reversed(rev)), custom or title

def _short(v, n=70):
    v = " ".join(str(v or "").split())
    return v if len(v) <= n else v[:n - 1] + "…"
def step_label(name, inp):
    """One tool call as a few plain words: what the agent is doing."""
    inp = inp if isinstance(inp, dict) else {}
    base = lambda p: os.path.basename(str(p or "").rstrip("/")) or str(p or "")
    if name == "Bash": return _short(inp.get("description")) if inp.get("description") else "Running " + _short(inp.get("command"), 60)
    if name == "Read": return "Reading " + base(inp.get("file_path"))
    if name in ("Edit", "MultiEdit"): return "Editing " + base(inp.get("file_path"))
    if name == "Write": return "Writing " + base(inp.get("file_path"))
    if name == "NotebookEdit": return "Editing " + base(inp.get("notebook_path"))
    if name in ("Grep", "Glob"): return "Searching for " + _short(inp.get("pattern"), 50)
    if name == "WebSearch": return "Searching the web: " + _short(inp.get("query"), 60)
    if name == "WebFetch":
        from urllib.parse import urlparse
        return "Reading " + (urlparse(str(inp.get("url") or "")).netloc or "a web page")
    if name in ("Agent", "Task"): return "Agent: " + _short(inp.get("description") or inp.get("prompt"), 60)
    if name == "TodoWrite": return "Updating its plan"
    if name == "Skill": return "Using the " + str(inp.get("skill") or "") + " skill"
    if name.startswith("mcp__"):
        parts = name.split("__")
        return "Using " + parts[1].replace("claude_ai_", "").replace("_", " ") + (": " + parts[2].replace("_", " ").replace("-", " ") if len(parts) > 2 else "")
    return name

_acts = {}
def turn_activity(path):
    """What the session has done since your last message: its steps (newest last) and when the turn began."""
    try: st = os.stat(path); key = (st.st_size, st.st_mtime_ns)
    except OSError: return None
    hit = _acts.get(path)
    if hit and hit[0] == key: return hit[1]
    steps, since = [], None
    for raw in reverse_lines(path):
        if len(raw) > 3_000_000: continue
        ends = raw[:2000] + raw[-4000:]
        if b'"type":"user"' not in ends and b'"type":"assistant"' not in ends: continue
        try: d = json.loads(raw)
        except Exception: continue
        if d.get("isSidechain"): continue
        c = (d.get("message") or {}).get("content")
        if d.get("type") == "user":
            text = c if isinstance(c, str) else " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text") if isinstance(c, list) else ""
            text = text.strip()
            if text and not d.get("isMeta") and not text.startswith(("<", "Caveat:", "[Request interrupted", "This session is being continued")):   # your message: the turn starts here
                since = d.get("timestamp"); break
            continue
        for b in reversed(c if isinstance(c, list) else []):
            if not isinstance(b, dict): continue
            if b.get("type") == "tool_use": steps.append({"label": step_label(b.get("name") or "", b.get("input")), "ts": d.get("timestamp")})
            elif b.get("type") == "thinking" and not steps: steps.append({"label": "Thinking", "ts": d.get("timestamp")})
        if len(steps) >= 40: break
    out = {"since": since, "steps": list(reversed(steps))[-40:]}
    _acts[path] = (key, out)
    return out

def card_agents(card):
    """Every session that has worked on this card (card start/new links one each time), oldest first."""
    out, seen = [], set()
    for a in (card.get("agents") or []) + ([card["agent"]] if card.get("agent") else []):
        if a.get("pid") and a["pid"] not in seen: seen.add(a["pid"]); out.append(a)
    return out

def live_by_sid(sid):
    """A running Claude process on this session (it was resumed after it ended, so its pid is new)."""
    if not sid: return None
    for f in glob.glob(os.path.join(SESS_DIR, "*.json")):
        try: r = json.load(open(f))
        except Exception: continue
        if r.get("sid") == sid and alive(r.get("pid")) and _is_claude(r.get("pid")): return r
    return None

def session_state(a):
    """Live state of one linked session. A pid reused by another session counts as ended; a resumed one is found by its id."""
    pid = a.get("pid"); rec = session_rec(pid)
    if a.get("sid") and rec.get("sid") and rec["sid"] != a["sid"]: rec = {}
    sid = a.get("sid") or rec.get("sid") or ""
    if not rec or not alive(pid) or not _is_claude(pid):
        again = live_by_sid(sid)
        if again: rec = again
        else:
            return {"state": "ended", "rec": rec, "agent": a, "sid": sid, "transcript": rec.get("transcript") or a.get("transcript") or ""}
    return {"state": rec.get("state", "working"), "rec": rec, "agent": a, "sid": sid, "transcript": rec.get("transcript") or a.get("transcript") or ""}

def transcript_cwd(path):
    """The folder a session ran in (its transcript says so near the top)."""
    try:
        with open(path, "rb") as f:
            for _ in range(40):
                ln = f.readline()
                if not ln: break
                m = re.search(rb'"cwd":"((?:[^"\\]|\\.)*)"', ln)
                if m: return json.loads(b'"' + m.group(1) + b'"')
    except Exception: pass
    return ""

_titles = {}
def session_title(path):
    """The session's title (its /rename, else Claude's own), cached until the transcript grows."""
    try: st = os.stat(path); key = (st.st_size, st.st_mtime_ns)
    except OSError: return ""
    hit = _titles.get(path)
    if hit and hit[0] == key: return hit[1]
    title = transcript_info(path, limit=0)[1]
    _titles[path] = (key, title)
    return title

_firsts = {}
def first_prompt(path):
    """The first thing the user typed in a session (300 characters), cached per file."""
    hit = _firsts.get(path)
    if hit is not None: return hit
    text = ""
    try:
        with open(path, "rb") as f:
            for _ in range(400):
                ln = f.readline()
                if not ln: break
                if b'"type":"user"' not in ln: continue
                try: m = json.loads(ln).get("message") or {}
                except Exception: continue
                c = m.get("content")
                t = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text") if isinstance(c, list) else ""
                t = re.sub(r"<[^>]+>[^<]*</[^>]+>", " ", t).strip()   # skip command/system wrappers
                if t and not t.startswith(("Caveat:", "[Request interrupted")): text = re.sub(r"\s+", " ", t)[:300]; break
    except OSError: pass
    _firsts[path] = text
    return text

RANK = {"working": 0, "waiting": 0, "ended": 1}
def card_sessions(c):
    """Sessions on a card for the picker: live ones first, then newest."""
    rows = []
    for a in card_agents(c):
        st = session_state(a)
        rows.append({"pid": str(a["pid"]), "state": st["state"], "title": session_title(st["transcript"]) if st["transcript"] else "",
                     "linked": a.get("linked", 0), "resumable": bool(st["sid"] and st["transcript"]), "st": st})
    rows.sort(key=lambda r: (RANK.get(r["state"], 1), -(r["linked"] or 0)))
    return rows

def remember_transcripts(c):
    """Copy each live session's transcript path onto the card, so its chat stays readable after it ends."""
    todo = {}
    for a in card_agents(c):
        if a.get("transcript"): continue
        rec = session_rec(a["pid"])
        if rec.get("transcript") and (not a.get("sid") or a["sid"] == rec.get("sid")): todo[str(a["pid"])] = rec
    if not todo: return
    def fn(card):
        for a in (card.get("agents") or []) + ([card["agent"]] if card.get("agent") else []):
            r = todo.get(str(a.get("pid")))
            if r: a["transcript"] = r["transcript"]; a.setdefault("sid", r.get("sid", ""))
    try: update_card(c["id"], fn)
    except Exception: pass

def card_state(c):
    """One dot for a card: working beats waiting beats nothing."""
    states = [session_state(a)["state"] for a in card_agents(c)]
    return "working" if "working" in states else "waiting" if "waiting" in states else ("ended" if states else None)

def agent_state(card):
    """The card's most relevant session (kept for older callers)."""
    rows = card_sessions(card)
    return rows[0]["st"] if rows else None

def _is_claude(pid):
    import subprocess
    try: return subprocess.run(["ps", "-o", "comm=", "-p", str(pid)], capture_output=True, text=True).stdout.strip().endswith("claude")
    except Exception: return False

def orca(*args):
    import subprocess
    r = subprocess.run([ORCA, *args, "--json"], capture_output=True, text=True, timeout=15,
                       env={"HOME": os.path.expanduser("~"), "PATH": "/usr/local/bin:/usr/bin:/bin"})
    try: return json.loads(r.stdout)
    except Exception: return {"ok": False, "error": (r.stderr or r.stdout)[:300]}

import threading, sys
sys.path.insert(0, HERE)
import automations
SEND_LOCK = threading.Lock()

def orca_err(r):
    """Orca's error as words (it comes as {"code", "message"})."""
    e = r.get("error")
    if isinstance(e, dict): e = e.get("message") or e.get("code")
    e = str(e or "Orca didn't answer")
    return {"terminal_handle_stale": "Orca lost track of this session's terminal. Click it in Orca once (or send from there), then try again."}.get(e, e)

def live_term(st):
    """The session's terminal as Orca knows it now. Orca sometimes issues new handles (after it reloads), and the one the
    session started with goes stale; its tab and pane stay the same, so look it up by those."""
    rec, a = st.get("rec") or {}, st.get("agent") or {}
    term, pane = rec.get("terminal") or a.get("terminal"), rec.get("pane") or ""
    r = orca("terminal", "list")
    ts = (r.get("result") or {}).get("terminals") or []
    if not r.get("ok") or not ts: return term
    if any(t.get("handle") == term for t in ts): return term
    hit = next((t["handle"] for t in ts if pane and f'{t.get("tabId")}:{t.get("leafId")}' == pane), None)
    if not hit and not pane:   # saved before panes were recorded: the one tab with this session's name, in its folder
        name = session_title(st.get("transcript") or "") if st.get("transcript") else ""
        clean = lambda t: re.sub(r"^[^\w(]+", "", t or "").strip()
        cwd = rec.get("cwd") or a.get("cwd") or ""
        same = [t["handle"] for t in ts if name and clean(t.get("title")) == clean(name) and (not cwd or t.get("worktreePath") == cwd or cwd.startswith((t.get("worktreePath") or "\0") + "/"))]
        if len(same) == 1: hit = same[0]
    if hit and rec.get("pid"):   # remember it, so the next message goes straight there
        f = os.path.join(SESS_DIR, f'{rec["pid"]}.json')
        try:
            d = json.load(open(f)); d["terminal"] = hit
            tmp = f + ".tmp"; json.dump(d, open(tmp, "w"), indent=2); os.replace(tmp, f)
        except Exception: pass
    return hit or term

# ---------- close a finished card's Orca tabs ----------
def _terminal_busy_elsewhere(term, pid, cid):
    """True when this terminal/session also belongs to a card that is not Done."""
    try: cards = json.load(open(DATA))["cards"]
    except Exception: return True
    for c in cards:
        if c["id"] == cid or c.get("status") == "Done": continue
        for a in card_agents(c):
            if (term and a.get("terminal") == term) or str(a.get("pid")) == str(pid): return True
    return False

def _other_live_session(term, a):
    """A different live Claude session now sits in this terminal (the tab was reused): leave it alone."""
    try: names = os.listdir(SESS_DIR)
    except OSError: return False
    for n in names:
        try: r = json.load(open(os.path.join(SESS_DIR, n)))
        except Exception: continue
        if r.get("terminal") != term or not alive(r.get("pid")) or not _is_claude(r.get("pid")): continue
        if str(r.get("pid")) != str(a.get("pid")) or (a.get("sid") and r.get("sid") and r["sid"] != a["sid"]): return True
    return False

def close_done(cid):
    """A card was marked Done: close the Orca tabs of the sessions linked to it. Only those tabs, never
    one that also works on another open card or that now holds a different session. A session still
    working is closed once it goes quiet. Moving the card back out of Done calls it off."""
    log = lambda m: open(os.path.join(HERE, "server.log"), "a").write(f"close-done {cid}: {m}\n")
    try:
        for a in card_agents(card_info(cid)):
            term = a.get("terminal") or session_rec(a.get("pid")).get("terminal")
            if not term: continue
            for _ in range(720):                      # up to an hour for a session to finish its turn
                if card_info(cid).get("status") != "Done": log("card reopened, nothing closed"); return
                if session_state(a)["state"] != "working": break
                time.sleep(5)
            else: log(f"{term} still working after an hour, left open"); continue
            if session_state(a)["state"] == "ended" and _other_live_session(term, a): log(f"{term} now holds another session, left open"); continue
            if _terminal_busy_elsewhere(term, a.get("pid"), cid): log(f"{term} also on another open card, left open"); continue
            r = orca("terminal", "close", "--terminal", term, "--tab")
            log(f"{term} closed" if r.get("ok") else f"{term} not closed: {str(r.get('error'))[:160]}")
    except Exception as e: log(f"error {e}")

def close_done_later(cid):
    import threading
    threading.Thread(target=close_done, args=(cid,), daemon=True).start()

# ---------- canvases ----------
def canvas_path(cid): return os.path.join(CANVASES, f"{cid}.json")
def files_dir(cid): return os.path.join(CANVASES, f"{cid}.files")

def load_canvas(cid):
    p = canvas_path(cid)
    d = json.load(open(p)) if os.path.exists(p) else {"elements": [], "appState": {}}
    files = {}
    fd = files_dir(cid)
    if os.path.isdir(fd):
        for f in os.listdir(fd):
            fid, ext = os.path.splitext(f)
            mime = TYPES.get(ext.lower(), "application/octet-stream")
            raw = open(os.path.join(fd, f), "rb").read()
            files[fid] = {"id": fid, "mimeType": mime, "dataURL": f"data:{mime};base64," + base64.b64encode(raw).decode(),
                          "created": int(os.path.getmtime(os.path.join(fd, f)) * 1000)}
    c = card_info(cid)
    return {**d, "files": files, "title": c.get("title", ""), "brand": c.get("brand", "")}

def write_digest(cid, scene):
    try:
        import importlib, canvas_digest
        importlib.reload(canvas_digest)
        c = card_info(cid)
        md = canvas_digest.build(scene, c.get("title", ""), c.get("brand", ""), HERE, cid)
        tmp = os.path.join(CANVASES, f"{cid}.md.tmp")
        open(tmp, "w").write(md); os.replace(tmp, os.path.join(CANVASES, f"{cid}.md"))
    except Exception as e:
        open(os.path.join(HERE, "server.log"), "a").write(f"digest error {cid}: {e}\n")

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass

    def query(self, k):
        from urllib.parse import parse_qs
        return (parse_qs(self.path.split("?", 1)[1]).get(k) or [""])[0] if "?" in self.path else ""

    def studio_base(self):
        """Studio as seen from whoever asked: this Mac, or the phone over Tailscale (review mode there)."""
        host = (self.headers.get("Host") or "").split(":")[0]
        # any address but this Mac's own (the Tailscale IP or its macbook-pro...ts.net name): the phone
        return STUDIO_URL if host in ("", "127.0.0.1", "localhost") else f"http://{host}:4517"

    def send(self, code, body, ctype="application/json", ver=None, extra=None):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("X-Version", ver if ver is not None else version())
        try: self.send_header("X-Build", str(os.stat(os.path.join(HERE, "index.html")).st_mtime_ns))
        except OSError: pass
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items(): self.send_header(k, v)
        origin = self.headers.get("Origin")
        if origin in CORS_OK:                     # Studio's Claude panel reads this card's session
            self.send_header("Access-Control-Allow-Origin", origin); self.send_header("Vary", "Origin")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n)

    def static(self, path, cache=True):
        if not os.path.isfile(path): return self.send(404, "{}")
        ext = os.path.splitext(path)[1].lower()
        b = open(path, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(ext, "application/octet-stream"))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if cache else "no-store")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(b)

    def media(self, path):
        """Serve video with Range support (Safari/iPhone need it to play and seek)."""
        if not os.path.isfile(path): return self.send(404, "{}")
        size = os.path.getsize(path)
        ctype = TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream")
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)", rng or "")
        if m:
            if m.group(1): start = int(m.group(1))
            if m.group(2): end = min(int(m.group(2)), size - 1)
            if not m.group(1) and m.group(2): start, end = size - int(m.group(2)), size - 1
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "public, max-age=31536000")
        self.end_headers()
        if self.command == "HEAD": return
        with open(path, "rb") as f:
            f.seek(start); left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk: break
                try: self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError): return
                left -= len(chunk)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p in ("/", "/index.html"):
            return self.send(200, open(os.path.join(HERE, "index.html"), "rb").read(), "text/html; charset=utf-8")
        if p == "/icon.png" and os.path.exists(os.path.join(HERE, "icon.png")):
            return self.send(200, open(os.path.join(HERE, "icon.png"), "rb").read(), "image/png")
        if p == "/editor.js":
            return self.send(200, open(os.path.join(HERE, "editor.js"), "rb").read(), "text/javascript; charset=utf-8")
        if p == "/api/board":
            return self.send(200, open(DATA).read() if os.path.exists(DATA) else '{"cards":[]}')
        if p == "/api/sessions":
            return self.send(200, json.dumps({"now": int(time.time()), "sessions": sessions()}))
        if p == "/api/automations":   # follow-ups and recurring jobs, newest first, with what they last reported
            items = automations.load()
            for a in items: a["every"] = automations.describe(a); a["running"] = a["id"] in automations.RUNNING
            items.sort(key=lambda a: (a.get("status") != "active", a.get("next") or 9e12))
            unread = sum(1 for a in items for r in a.get("runs") or [] if r.get("unread"))
            return self.send(200, json.dumps({"items": items, "unread": unread}))
        if p == "/api/agents":   # status dot for every linked card
            out = {}
            try: cards = json.load(open(DATA))["cards"]
            except Exception: cards = []
            for c in cards:
                if c.get("status") == "Done": continue
                st = card_state(c)
                if st in ("working", "waiting"):
                    out[c["id"]] = {"state": st}
            return self.send(200, json.dumps(out))
        m = re.match(r"^/api/agent/([^/]+)$", p)
        if m:   # one session's conversation (?pid=, else the most relevant) and every session on the card
            cid = unquote(m.group(1)); c = card_info(cid)
            rows = card_sessions(c) if c else []
            if not rows: return self.send(200, json.dumps({"linked": False, "sessions": []}))
            remember_transcripts(c)
            want = self.query("pid")
            row = next((r for r in rows if r["pid"] == want), rows[0])
            st = row["st"]
            msgs, title = transcript_info(st["transcript"]) if st["transcript"] else ([], "")
            act = turn_activity(st["transcript"]) if st["transcript"] and st["state"] == "working" else None
            return self.send(200, json.dumps({"linked": True, "pid": row["pid"], "state": st["state"], "title": title, "messages": msgs, "activity": act,
                                              "canSend": st["state"] != "ended" and bool(st["rec"].get("terminal") or st["agent"].get("terminal")),
                                              "resumable": row["resumable"],
                                              "sessions": [{k: r[k] for k in ("pid", "state", "title", "linked", "resumable")} for r in rows]}))
        m = re.match(r"^/api/agent/([^/]+)/start-info$", p)
        if m:   # what "Start agent" offers: the folders a session can work in (this card's project first) and a first message
            c = card_info(unquote(m.group(1)))
            if not c: return self.send(404, json.dumps({"error": "No such card."}))
            folders, pick = project_folders(c.get("brand"))
            return self.send(200, json.dumps({"folders": folders, "folder": pick, "prompt": start_prompt(c)}))
        m = re.match(r"^/api/agent/([^/]+)/commands$", p)
        if m:   # what "/" can complete to in this session's chat box: built-ins, skills, plugins, the project's own
            c = card_info(unquote(m.group(1))); rows = card_sessions(c) if c else []
            want = self.query("pid"); row = next((r for r in rows if r["pid"] == want), rows[0] if rows else None)
            st = row["st"] if row else None
            cwd = (st["rec"].get("cwd") or st["agent"].get("cwd") or (transcript_cwd(st["transcript"]) if st["transcript"] else "")) if st else ""
            return self.send(200, json.dumps({"commands": slash_commands(cwd)}))
        if p == "/api/studio-sessions":   # every session on every card working on a Studio board, for its chat picker
            name = self.query("board")
            try: cards = json.load(open(DATA))["cards"]
            except Exception: cards = []
            out = []
            for c in cards:
                if not name or c.get("studio") != name: continue
                for r in card_sessions(c):
                    out.append({"cid": c["id"], "card": c["title"], "done": c.get("status") == "Done", **{k: r[k] for k in ("pid", "state", "title", "linked", "resumable")}})
            out.sort(key=lambda r: (RANK.get(r["state"], 1), r["done"], -(r["linked"] or 0)))
            return self.send(200, json.dumps({"sessions": out}))
        if p == "/api/studio-boards":   # the work board's Studio tab: pinned boards first, then newest first
            return self.send(200, json.dumps({"boards": studio_boards(self.studio_base())}))
        if p == "/api/studio-preview":   # what is on one board, for its tile (asked for only when the tile is on screen)
            return self.send(200, json.dumps(board_preview(self.query("board"))))
        if p == "/api/studio-cards":   # every unfinished card on a Studio board (one board, many agents)
            from urllib.parse import parse_qs
            name = (parse_qs(self.path.split("?", 1)[1]).get("board") or [""])[0] if "?" in self.path else ""
            return self.send(200, json.dumps({"cards": linked_cards(name), "kept": name in kept_boards()}))
        if p == "/api/kept":
            return self.send(200, json.dumps({"boards": kept_boards()}))
        if p == "/api/studio-card":   # which card a Studio board belongs to
            from urllib.parse import parse_qs
            name = (parse_qs(self.path.split("?", 1)[1]).get("board") or [""])[0] if "?" in self.path else ""
            try: cards = json.load(open(DATA))["cards"]
            except Exception: cards = []
            c = next((c for c in cards if name and c.get("studio") == name), None)
            return self.send(200, json.dumps({"card": {"id": c["id"], "title": c["title"], "brand": c.get("brand", ""), "status": c.get("status")} if c else None}))
        if p == "/api/search-index":   # what each Done card's sessions were called and first asked, for the Done search
            try: cards = json.load(open(DATA))["cards"]
            except Exception: cards = []
            out = {}
            for c in cards:
                if c.get("status") != "Done": continue
                bits = []
                for a in card_agents(c):
                    tr = a.get("transcript") or session_rec(a.get("pid")).get("transcript") or ""
                    if tr: bits += [session_title(tr), first_prompt(tr)]
                bits = [b for b in dict.fromkeys(bits) if b]
                if bits: out[c["id"]] = bits
            return self.send(200, json.dumps(out))
        if p == "/api/canvases":   # which cards have a canvas with something on it
            ids = []
            if os.path.isdir(CANVASES):
                for f in os.listdir(CANVASES):
                    if not f.endswith(".json"): continue
                    try:
                        if any(not e.get("isDeleted") for e in json.load(open(os.path.join(CANVASES, f))).get("elements", [])):
                            ids.append(f[:-5])
                    except Exception: pass
            return self.send(200, json.dumps(ids))
        m = re.match(r"^/canvas/([^/]+)$", p)
        if m and SAFE_ID.match(unquote(m.group(1))):
            # the plan moved to the card's Studio board (on this Mac; Studio isn't reachable from the phone)
            c = card_info(unquote(m.group(1)))
            if c.get("studio"):   # on the phone (Tailscale): Studio's review-only address on the same machine
                from urllib.parse import quote
                return self.send(302, b"", "text/plain", extra={"Location": f"{self.studio_base()}/?board={quote(c['studio'])}" + (f"&focus={quote(c['studio_folder'])}" if c.get("studio_folder") else "")})
            return self.send(200, open(os.path.join(HERE, "canvas.html"), "rb").read(), "text/html; charset=utf-8")
        m = re.match(r"^/canvas-assets/(.+)$", p)
        if m:
            rel = unquote(m.group(1))
            full = os.path.realpath(os.path.join(ASSETS, rel))
            # entry files keep the same name across updates -> never cache; hashed chunks/fonts can be cached
            if full.startswith(os.path.realpath(ASSETS) + os.sep):
                return self.static(full, cache=os.path.basename(full) not in ("canvas.js", "canvas.css"))
            return self.send(404, "{}")
        m = re.match(r"^/api/canvas/([^/]+)$", p)
        if m:
            cid = unquote(m.group(1))
            if not SAFE_ID.match(cid): return self.send(400, "{}")
            return self.send(200, json.dumps(load_canvas(cid)), ver=mtime_version(canvas_path(cid)))
        m = re.match(r"^/media/([^/]+)$", p)
        if m:
            name = unquote(m.group(1))
            if SAFE_NAME.match(name): return self.media(os.path.join(MEDIA, name))
        self.send(404, "{}")

    def do_OPTIONS(self):
        origin = self.headers.get("Origin")
        self.send_response(204)
        if origin in CORS_OK:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0"); self.end_headers()

    def do_HEAD(self):
        p = self.path.split("?")[0]
        m = re.match(r"^/api/canvas/([^/]+)$", p)
        if m and SAFE_ID.match(unquote(m.group(1))):
            return self.send(200, b"", ver=mtime_version(canvas_path(unquote(m.group(1)))))
        m = re.match(r"^/media/([^/]+)$", p)
        if m and SAFE_NAME.match(unquote(m.group(1))):
            return self.media(os.path.join(MEDIA, unquote(m.group(1))))
        self.send(200, b"")

    def do_POST(self):
        if self.path.split("?")[0] == "/api/automations":   # set one up (agents do this through `card remind`)
            d = json.loads(self.body() or b"{}")
            c = card_info(d.get("card") or "") if d.get("card") else None
            sid, cwd = d.get("sid") or "", d.get("cwd") or ""
            if d.get("pid") and not sid:   # the agent that asked: continue from its own conversation
                rec = session_rec(str(d["pid"])); sid = rec.get("sid") or ""; cwd = cwd or rec.get("cwd") or ""
            if not sid and c:   # else the card's latest session
                ag = (card_agents(c) or [None])[-1]
                if ag:
                    st = session_state(ag); sid = st.get("sid") or ""; cwd = cwd or ag.get("cwd") or st["rec"].get("cwd") or ""
            if not (d.get("prompt") or "").strip(): return self.send(400, json.dumps({"error": "Say what to do."}))
            try: a = automations.create(c["id"] if c else "", (c or {}).get("title") or d.get("title") or "", d.get("when") or "", d["prompt"], sid, cwd, d.get("by") or "agent")
            except ValueError as e: return self.send(400, json.dumps({"error": str(e)}))
            a["every"] = automations.describe(a)
            return self.send(200, json.dumps({"ok": True, "automation": a}))
        m = re.match(r"^/api/automations/([^/]+)/(run|pause|resume|delete|read|edit)$", self.path.split("?")[0])
        if m:
            aid, act = m.group(1), m.group(2)
            d = json.loads(self.body() or b"{}") if act == "edit" else {}
            def change(items):
                a = next((i for i in items if i["id"] == aid), None)
                if not a: return False
                if act == "pause": a["status"] = "paused"
                if act == "resume":
                    a["status"] = "active"
                    if not a.get("next") or a["next"] < time.time(): a["next"] = automations._next(a["sched"], time.time())[1] if a["sched"]["kind"] != "once" else time.time()
                if act == "delete": items.remove(a)
                if act == "read":
                    for r in a.get("runs") or []: r["unread"] = False
                if act == "edit":
                    if d.get("prompt", "").strip(): a["prompt"] = d["prompt"].strip()
                    if d.get("when", "").strip():
                        a["sched"], a["next"] = automations.parse_when(d["when"]); a["when"] = d["when"]; a["status"] = "active"
                return True
            try: found = automations.edit(change)
            except ValueError as e: return self.send(400, json.dumps({"error": str(e)}))
            if not found: return self.send(404, json.dumps({"error": "No such automation."}))
            if act == "run": threading.Thread(target=automations.run, args=(aid,), daemon=True).start()
            return self.send(200, json.dumps({"ok": True}))
        m = re.match(r"^/api/agent/([^/]+)/start$", self.path.split("?")[0])
        if m:   # start a new Claude session on this card: a new Orca tab in the project folder, the task as its first message
            cid = unquote(m.group(1)); c = card_info(cid)
            if not c: return self.send(404, json.dumps({"error": "No such card."}))
            d = json.loads(self.body() or b"{}")
            text, cwd = (d.get("prompt") or "").strip(), os.path.expanduser(d.get("folder") or "")
            if not text: return self.send(400, json.dumps({"error": "Write what the agent should do."}))
            if not os.path.isdir(cwd): return self.send(400, json.dumps({"error": f"No such folder: {cwd}"}))
            first = f"{text}\n\n(This is work board card {cid}. Run `~/.claude/scripts/board/card start {cid}` first.)"
            import shlex
            title = (c.get("title") or "Claude")[:40]
            cmd = f"claude {shlex.quote(first)}"
            r = orca("terminal", "create", "--worktree", f"path:{cwd}", "--title", title, "--command", cmd)
            if not r.get("ok"):   # not one of Orca's folders: open it in the current one and step into the folder
                r = orca("terminal", "create", "--title", title, "--command", f"cd {shlex.quote(cwd)} && {cmd}")
            err = r.get("error"); err = err.get("message") if isinstance(err, dict) else err
            if r.get("ok"):
                remember_folder(c.get("brand"), cwd)
                update_card(cid, lambda card: (card.update({"status": "Orchestrating", "order": -1}), card.pop("today", None)) if card.get("status") in ("Next", "Done") else None)
            return self.send(200 if r.get("ok") else 502, json.dumps({"ok": bool(r.get("ok")), "error": None if r.get("ok") else f"Orca couldn't open it: {err}"}))
        m = re.match(r"^/api/agent/([^/]+)/rename", self.path)
        if m:   # name a session: the same record Claude Code's /rename writes, so /resume lists it by that name too
            cid = unquote(m.group(1)); c = card_info(cid); rows = card_sessions(c) if c else []
            want = self.query("pid"); row = next((r for r in rows if r["pid"] == want), None)
            try: title = " ".join(str(json.loads(self.body()).get("title", "")).split())[:80]
            except Exception: title = ""
            if not row or not title: return self.send(400, json.dumps({"error": "Nothing to rename."}))
            st = row["st"]
            if not (st["transcript"] and os.path.exists(st["transcript"])): return self.send(409, json.dumps({"error": "This session's conversation file is gone."}))
            with open(st["transcript"], "a") as f:
                f.write(json.dumps({"type": "custom-title", "customTitle": title, "sessionId": st["sid"]}, separators=(",", ":")) + "\n")
            return self.send(200, json.dumps({"ok": True, "title": title}))
        m = re.match(r"^/api/agent/([^/]+)/resume", self.path)
        if m:   # turn an ended session back on: a new Orca tab running `claude --resume <id>` in its own folder
            cid = unquote(m.group(1)); c = card_info(cid); rows = card_sessions(c) if c else []
            want = self.query("pid"); row = next((r for r in rows if r["pid"] == want), None)
            if not row: return self.send(404, json.dumps({"error": "No such session on this task."}))
            st = row["st"]
            if st["state"] != "ended": return self.send(200, json.dumps({"ok": True, "already": True}))
            if not (st["sid"] and st["transcript"]): return self.send(409, json.dumps({"error": "This session can't be resumed (its conversation file is gone)."}))
            cwd = st["agent"].get("cwd") or st["rec"].get("cwd") or transcript_cwd(st["transcript"]) or os.path.expanduser("~")
            import shlex
            title = (row["title"] or c.get("title") or "Claude")[:40]
            r = orca("terminal", "create", "--worktree", f"path:{cwd}", "--title", title, "--command", f"claude --resume {shlex.quote(st['sid'])}")
            if not r.get("ok"):   # not one of Orca's folders: open it in the current one and step into the session's folder
                r = orca("terminal", "create", "--title", title, "--command", f"cd {shlex.quote(cwd)} && claude --resume {shlex.quote(st['sid'])}")
            err = r.get("error"); err = err.get("message") if isinstance(err, dict) else err
            return self.send(200 if r.get("ok") else 502, json.dumps({"ok": bool(r.get("ok")), "error": f"Orca couldn't open it: {err}" if not r.get("ok") else None}))
        m = re.match(r"^/api/agent/([^/]+)/(send|open)$", self.path.split("?")[0])   # (?pid= picks the session)
        if m:
            cid, action = unquote(m.group(1)), m.group(2)
            c = card_info(cid); rows = card_sessions(c) if c else []
            want = self.query("pid")
            row = next((r for r in rows if r["pid"] == want), None) if want else (rows[0] if rows else None)
            st = row["st"] if row else None
            if not st or st["state"] == "ended":
                return self.send(409, json.dumps({"error": "That Claude session isn't running anymore."}))
            term = live_term(st)
            if not term: return self.send(409, json.dumps({"error": "This session wasn't started inside Orca."}))
            if action == "open":
                r = orca("terminal", "switch", "--terminal", term)
                import subprocess; subprocess.run(["/usr/bin/open", "-a", "Orca"])
                return self.send(200 if r.get("ok") else 502, json.dumps({"ok": bool(r.get("ok")), "error": None if r.get("ok") else orca_err(r)}))
            try: text = json.loads(self.body()).get("text", "")
            except Exception: text = ""
            text = " ".join(str(text).split())[:4000]       # one line: a newline would send early
            if text == "\u001b":                                # the Stop button: Esc interrupts what Claude is doing
                r = orca("terminal", "send", "--terminal", term, "--text", "\u001b")
                return self.send(200 if r.get("ok") else 502, json.dumps({"ok": bool(r.get("ok")), "error": None if r.get("ok") else orca_err(r)}))
            if not text: return self.send(400, json.dumps({"error": "empty"}))
            with SEND_LOCK:   # one at a time: two messages typed into a terminal at once collide
                r = orca("terminal", "send", "--terminal", term, "--text", text, "--enter")
                if not r.get("ok"):   # a hiccup, or the handle went stale between messages: look again and retry once
                    time.sleep(0.4); term = live_term(st)
                    r = orca("terminal", "send", "--terminal", term, "--text", text, "--enter")
            if not r.get("ok"): open(os.path.join(HERE, "server.log"), "a").write(f"send {cid} {term}: {r.get('error')}\n")
            return self.send(200 if r.get("ok") else 502, json.dumps({"ok": bool(r.get("ok")), "error": None if r.get("ok") else orca_err(r)}))
        m = re.match(r"^/api/studio/([^/]+)$", self.path.split("?")[0])
        if m:   # open this card's Studio board, making it on first use
            cid = unquote(m.group(1))
            if not SAFE_ID.match(cid): return self.send(400, "{}")
            k = self.query("kind") or None
            try: name, folder = ensure_studio(cid, k if k in ("ads", "email", "web") else None)
            except Exception as e: return self.send(502, json.dumps({"error": str(e)[:300]}))
            from urllib.parse import quote
            root = next((b["root"] for b in studio("GET", "/api/boards")[1].get("boards", []) if b["name"] == name), "")
            return self.send(200, json.dumps({"board": name, "folder": os.path.join(root, folder) if folder else root, "permanent": bool(folder),
                                              "url": f"{self.studio_base()}/?board={quote(name)}" + (f"&focus={quote(folder)}" if folder else "")}))
        if self.path == "/api/studio-delete":   # {"board": name}: take a board off Studio. The files in its folder stay.
            try: name = str(json.loads(self.body()).get("board", ""))[:200]
            except Exception: return self.send(400, "{}")
            if not name: return self.send(400, "{}")
            try:
                studio_up(); code, r = studio("POST", "/api/boards", {"remove": name})
            except Exception as e: code, r = 502, {"error": str(e)[:200]}
            if code != 200: return self.send(502, json.dumps({"error": r.get("error") or "Studio is not answering"}))
            ks = [b for b in kept_boards() if b != name]
            tmp = KEPT + ".tmp"; json.dump(ks, open(tmp, "w"), indent=1); os.replace(tmp, KEPT)
            open(os.path.join(HERE, "server.log"), "a").write(f"studio board removed: {name}\n")
            return self.send(200, '{"ok":true}')
        if self.path == "/api/kept":   # {"board": name, "keep": true|false}
            try: d = json.loads(self.body()); name = str(d.get("board", ""))[:200]
            except Exception: return self.send(400, "{}")
            if not name: return self.send(400, "{}")
            ks = [b for b in kept_boards() if b != name] + ([name] if d.get("keep") else [])
            tmp = KEPT + ".tmp"; json.dump(ks, open(tmp, "w"), indent=1); os.replace(tmp, KEPT)
            try: studio("POST", "/api/boards", {"permanent": name, "on": bool(d.get("keep"))})   # a star means permanent
            except Exception: pass
            return self.send(200, json.dumps({"boards": ks}))
        if self.path.split("?")[0] == "/api/drop":
            # a file dropped or pasted into an agent chat: keep a copy and hand back its full path for the message
            from urllib.parse import parse_qs, urlparse
            orig = os.path.basename(unquote((parse_qs(urlparse(self.path).query).get("name") or ["file"])[0])) or "file"
            stem, ext = os.path.splitext(orig)
            stem = re.sub(r"[^A-Za-z0-9_-]+", "-", stem).strip("-")[:60] or "file"
            ext = re.sub(r"[^A-Za-z0-9.]", "", ext)[:12].lower()
            n = int(self.headers.get("Content-Length", 0))
            if n > 2 << 30: return self.send(413, json.dumps({"error": "That file is over 2 GB."}))
            day = os.path.join(DROPS, time.strftime("%Y-%m-%d"))
            os.makedirs(day, exist_ok=True)
            tmp = os.path.join(day, f".upload-{time.time_ns()}")
            h = hashlib.sha1()
            with open(tmp, "wb") as f:
                left = n
                while left > 0:
                    chunk = self.rfile.read(min(1 << 20, left))
                    if not chunk: break
                    f.write(chunk); h.update(chunk); left -= len(chunk)
            path = os.path.join(day, f"{stem}-{h.hexdigest()[:6]}{ext}")
            os.replace(tmp, path)
            return self.send(200, json.dumps({"path": path}))
        if self.path == "/api/media":
            # stream a video upload to disk
            n = int(self.headers.get("Content-Length", 0))
            orig = unquote(self.headers.get("X-Filename", "video.mp4"))
            ext = os.path.splitext(orig)[1].lower()
            if ext not in (".mp4", ".mov", ".m4v", ".webm"): ext = ".mp4"
            os.makedirs(MEDIA, exist_ok=True)
            stem = re.sub(r"[^A-Za-z0-9_-]+", "-", os.path.splitext(orig)[0]).strip("-")[:60] or "video"
            tmp = os.path.join(MEDIA, f".upload-{time.time_ns()}")
            h = hashlib.sha1()
            with open(tmp, "wb") as f:
                left = n
                while left > 0:
                    chunk = self.rfile.read(min(1 << 20, left))
                    if not chunk: break
                    f.write(chunk); h.update(chunk); left -= len(chunk)
            name = f"{stem}-{h.hexdigest()[:8]}{ext}"
            os.replace(tmp, os.path.join(MEDIA, name))
            return self.send(200, json.dumps({"name": name}))
        self.send(404, "{}")

    def do_PUT(self):
        p = self.path.split("?")[0]
        m = re.match(r"^/api/canvas/([^/]+)/file/([^/]+)$", p)
        if m:
            cid, fid = unquote(m.group(1)), unquote(m.group(2))
            if not (SAFE_ID.match(cid) and SAFE_NAME.match(fid)): return self.send(400, "{}")
            d = json.loads(self.body())
            mime = d.get("mimeType", "image/png")
            ext = {v: k for k, v in TYPES.items()}.get(mime, ".png")
            raw = base64.b64decode(d["dataURL"].split(",", 1)[1])
            os.makedirs(files_dir(cid), exist_ok=True)
            open(os.path.join(files_dir(cid), fid + ext), "wb").write(raw)
            return self.send(200, '{"ok":true}', ver=mtime_version(canvas_path(cid)))
        m = re.match(r"^/api/canvas/([^/]+)$", p)
        if m:
            cid = unquote(m.group(1))
            if not SAFE_ID.match(cid): return self.send(400, "{}")
            body = self.body()
            try:
                d = json.loads(body); assert isinstance(d.get("elements"), list)
            except Exception: return self.send(400, '{"error":"bad canvas"}')
            path = canvas_path(cid)
            os.makedirs(CANVASES, exist_ok=True)
            with open(path + ".lock", "w") as lk:
                fcntl.flock(lk, fcntl.LOCK_EX)
                if self.headers.get("X-Version") != mtime_version(path):
                    return self.send(409, '{"error":"stale"}', ver=mtime_version(path))
                if os.path.exists(path):
                    shutil.copy2(path, path + ".bak")
                    snapshot(path, os.path.join(HIST, "canvas", cid))
                tmp = path + ".tmp"
                open(tmp, "wb").write(json.dumps({"elements": d["elements"], "appState": d.get("appState", {})}).encode())
                os.replace(tmp, path)
            write_digest(cid, d)
            return self.send(200, '{"ok":true}', ver=mtime_version(path))
        if p != "/api/board": return self.send(404, "{}")
        body = self.body()
        try:
            d = json.loads(body)
            assert isinstance(d.get("cards"), list) and isinstance(d.get("brands"), list)
        except Exception: return self.send(400, '{"error":"bad board"}')
        with open(DATA + ".lock", "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            if self.headers.get("X-Version") != version():
                return self.send(409, '{"error":"stale"}')
            try: was = {c["id"]: c.get("status") for c in json.load(open(DATA))["cards"]}
            except Exception: was = None
            if os.path.exists(DATA):
                shutil.copy2(DATA, DATA + ".bak"); snapshot()
            tmp = DATA + ".tmp"
            with open(tmp, "wb") as f: f.write(body)
            os.replace(tmp, DATA)
        if was is not None:      # cards just moved to Done: their Orca tabs close
            for c in d["cards"]:
                if c.get("status") == "Done" and was.get(c.get("id"), "Done") != "Done": close_done_later(c["id"])
        self.send(200, '{"ok":true}')

def update_card(cid, fn):
    """Change one card on disk the way the board page does: locked, backed up, snapshotted.
    Open board tabs see the new version on their next save (they merge per card)."""
    with open(DATA + ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        b = json.load(open(DATA))
        c = next((c for c in b["cards"] if c["id"] == cid), None)
        if not c: raise KeyError(cid)
        fn(c)
        shutil.copy2(DATA, DATA + ".bak"); snapshot()
        tmp = DATA + ".tmp"
        with open(tmp, "w") as f: json.dump(b, f, indent=1)
        os.replace(tmp, DATA)
        return c

def studio(method, path, body=None):
    import urllib.request
    req = urllib.request.Request(STUDIO_URL + path, method=method, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=20) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b"{}")
        except Exception: return e.code, {}

def studio_up():
    import subprocess
    try:
        if studio("GET", "/api/health")[0] == 200: return
    except Exception: pass
    # the Studio CLI starts the server when it isn't running
    subprocess.run([STUDIO_CLI, "boards"], capture_output=True, timeout=60, env={**os.environ, "PATH": os.environ.get("PATH", "") + ":/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"})

PERMANENTS = os.path.join(HERE, "permanents.json")   # {brand: {ads|email|web: board}}: one board per brand and kind of design work
KINDS = [("email", r"\b(e-?mails?|klaviyo|newsletters?|flows?)\b"),
         ("ads", r"\b(static|statics|ads?|creatives?|placements?|retarget\w*|banners?)\b"),
         ("web", r"\b(web|website|site|landing|lander|pdps?|product pages?|home ?page|theme|redesign)\b")]
def kind_of(title):
    for k, rx in KINDS:
        if re.search(rx, title or "", re.I): return k
    return None
def folder_name(title):
    return re.sub(r"\s+", " ", re.sub(r"[^\w .()&,-]+", " ", title or "")).strip()[:70].strip() or "Task"

KIND_LABEL = {"ads": "Static Ads", "email": "Emails", "web": "Web"}
def make_permanent(brand, k, names):
    """Create the brand's permanent board for this kind of design work (<Brand> Static Ads/Emails/Web), star it
    and remember it in permanents.json. Returns its name, or None if Studio refused."""
    name = f"{brand} {KIND_LABEL[k]}"
    if name not in names:
        root = os.path.join(STUDIO_HOME, re.sub(r"[^\w .-]+", " ", brand).strip() or "General", KIND_LABEL[k])
        os.makedirs(root, exist_ok=True)
        code, r = studio("POST", "/api/boards", {"name": name, "root": root})
        if code != 200: return None
    studio("POST", "/api/boards", {"permanent": name, "on": True})
    try: perm = json.load(open(PERMANENTS))
    except Exception: perm = {}
    perm.setdefault(brand, {})[k] = name
    tmp = PERMANENTS + ".tmp"; json.dump(perm, open(tmp, "w"), indent=1); os.replace(tmp, PERMANENTS)
    try: kept = json.load(open(KEPT))
    except Exception: kept = []
    if name not in kept:
        kept.append(name); tmp = KEPT + ".tmp"; json.dump(kept, open(tmp, "w"), indent=1); os.replace(tmp, KEPT)
    reg = studio("GET", "/api/boards")[1].get("boards", [])
    names.clear(); names.update({b["name"]: b for b in reg})
    return name if name in names else None

def ensure_studio(cid, kind=None):
    """The card's Studio board. Design work for a brand (ads, emails, web) goes on that brand's permanent board,
    in its own folder (and section); anything else gets a board of its own. Returns (board, folder or None)."""
    c = card_info(cid)
    if not c: raise KeyError(f"no card {cid}")
    studio_up()
    reg = studio("GET", "/api/boards")[1].get("boards", [])
    names = {b["name"]: b for b in reg}
    try: perm = json.load(open(PERMANENTS))
    except Exception: perm = {}
    target = c.get("studio") if c.get("studio") in names else None
    k = None
    if not target:
        k = kind or kind_of(c.get("title", ""))
        target = (perm.get(c.get("brand") or "") or {}).get(k) if k else None
        if target not in names: target = None
    if not target and k and (c.get("brand") or "").strip():
        target = make_permanent(c["brand"].strip(), k, names)   # first design task of this kind for the brand
    if target and names[target].get("permanent"):
        folder = c.get("studio_folder") or folder_name(c["title"])
        os.makedirs(os.path.join(names[target]["root"], folder), exist_ok=True)
        if c.get("studio") != target or c.get("studio_folder") != folder:
            update_card(cid, lambda card: card.update({"studio": target, "studio_folder": folder}))
        return target, folder
    if c.get("studio") in names: return c["studio"], None
    base = re.sub(r"[^\w .()&,-]+", " ", c["title"]).strip()[:70].strip() or "Board"
    brand = re.sub(r"[^\w .-]+", " ", c.get("brand") or "General").strip() or "General"
    name, n = base, 2
    while name in names: name, n = f"{base} ({n})", n + 1
    folder = os.path.join(STUDIO_HOME, brand, name)
    os.makedirs(folder, exist_ok=True)
    code, r = studio("POST", "/api/boards", {"name": name, "root": folder})
    if code != 200: raise RuntimeError(r.get("error") or f"Studio said {code}")
    update_card(cid, lambda card: card.__setitem__("studio", name))
    return name, None

# ---------- slash commands for the chat composers ----------
BUILTIN_COMMANDS = [
    ("compact", "Summarize the conversation so far to free up context"), ("clear", "Start over with an empty conversation"),
    ("context", "Show how full the context window is"), ("cost", "Show what this session has cost"),
    ("model", "Switch the model"), ("rename", "Name this session"), ("resume", "Resume another session"),
    ("review", "Review a pull request"), ("init", "Write a CLAUDE.md for this project"), ("memory", "Edit memory files"),
    ("status", "Show account and session status"), ("usage", "Show plan usage limits"), ("config", "Open settings"),
    ("permissions", "View or change tool permissions"), ("agents", "Manage subagents"), ("mcp", "Manage MCP servers"),
    ("hooks", "Manage hooks"), ("add-dir", "Add another working folder"), ("export", "Export the conversation"),
    ("todos", "Show the current todo list"), ("plan", "Switch to plan mode"), ("fast", "Toggle fast mode"),
    ("help", "List commands"), ("doctor", "Check the Claude Code install"), ("release-notes", "What's new"),
]
def _front(path):
    """name and description from a skill/command file's frontmatter (first lines)."""
    try: head = open(path, errors="ignore").read(4000)
    except OSError: return {}
    m = re.match(r"^---\s*\n(.*?)\n---", head, re.S)
    out = {}
    if m:
        for k in ("name", "description"):
            mm = re.search(rf"^{k}:[ \t]*(.*)$((?:\n[ \t]+.*)*)", m.group(1), re.M)
            if not mm: continue
            v = mm.group(1).strip()
            if v in ("", ">", ">-", "|", "|-"): v = " ".join(l.strip() for l in mm.group(2).splitlines() if l.strip())   # a folded block
            out[k] = v.strip('"\'')
    if "description" not in out:   # a plain command file: its first line of text
        body = head[m.end():] if m else head
        line = next((l.strip("# ").strip() for l in body.splitlines() if l.strip()), "")
        if line: out["description"] = line
    return out
def _scan_cmds(base, prefix=""):
    out = []
    for f in glob.glob(os.path.join(base, "skills", "*", "SKILL.md")) + glob.glob(os.path.join(base, "skills", "*", "*", "SKILL.md")):
        fm = _front(f); n = fm.get("name") or os.path.basename(os.path.dirname(f))
        out.append((prefix + n, fm.get("description", "")))
    for f in glob.glob(os.path.join(base, "commands", "*.md")):
        fm = _front(f); out.append((prefix + os.path.splitext(os.path.basename(f))[0], fm.get("description", "")))
    return out
_cmd_cache = {}
def slash_commands(cwd):
    hit = _cmd_cache.get(cwd)
    if hit and time.time() - hit[0] < 60: return hit[1]
    home = os.path.expanduser("~/.claude")
    found = [(n, d, "built-in") for n, d in BUILTIN_COMMANDS]
    found += [(n, d, "skill") for n, d in _scan_cmds(home)]
    if cwd: found += [(n, d, "project") for n, d in _scan_cmds(os.path.join(cwd, ".claude"))]
    try: inst = json.load(open(os.path.join(home, "plugins", "installed_plugins.json"))).get("plugins", {})
    except Exception: inst = {}
    for key, entries in inst.items():
        plug = key.split("@")[0]
        for e in entries:
            if e.get("scope") == "local" and not (cwd and (cwd + "/").startswith(e.get("projectPath", "") + "/")): continue
            found += [(n, d, "plugin") for n, d in _scan_cmds(e.get("installPath", ""), plug + ":")]
    for pdir in glob.glob(os.path.join(home, "plugins", "synced", "*", "*")):
        found += [(n, d, "plugin") for n, d in _scan_cmds(pdir, os.path.basename(pdir) + ":")]
    seen, out = set(), []
    for n, d, src in found:
        if n in seen: continue
        seen.add(n); out.append({"name": n, "description": d[:160], "source": src})
    _cmd_cache[cwd] = (time.time(), out)
    return out

STUDIO_DATA = os.path.expanduser(os.environ.get("STUDIO_DATA", "~/Library/Application Support/Studio"))
_empty = {}
def board_empty(name, root):
    """No designs, no planning objects and no HTML in its folder (the same test Studio uses for its own lists)."""
    sp = os.path.join(STUDIO_DATA, "boards", name, "state.json")
    def mt(f):
        try: return os.stat(f).st_mtime_ns
        except OSError: return 0
    key = (mt(sp), mt(root)); hit = _empty.get(name)
    if hit and hit[0] == key: return hit[1]
    try:
        st = json.load(open(sp)) if os.path.exists(sp) else {}
        empty = not (st.get("designs") or {}) and not (st.get("items") or [])
        if empty and os.path.isdir(root):
            base = root.rstrip("/").count(os.sep)
            for dp, dn, fn in os.walk(root):
                dn[:] = [] if dp.count(os.sep) - base >= 4 else [d for d in dn if d[:1] not in "._" and d not in ("node_modules", "shared", "final", "studio-assets", "html-archive")]
                if any(f.lower().endswith(".html") and f[:1] not in "._" for f in fn): empty = False; break
    except Exception: empty = False
    _empty[name] = (key, empty)
    return empty

_previews = {}
def board_preview(name):
    """A board's first few designs and its planning objects, read from Studio's saved state only (no folder scan:
    board folders sit in a cloud-synced folder, where touching every file is slow). Kept until the state file changes."""
    sp = os.path.join(STUDIO_DATA, "boards", name, "state.json")
    try: key = os.stat(sp).st_mtime_ns
    except OSError: key = 0
    hit = _previews.get(name)
    if hit and hit[0] == key: return hit[1]
    try: st = json.load(open(sp)) if key else {}
    except Exception: st = {}
    try: root = next(r["root"] for r in json.load(open(os.path.join(STUDIO_DATA, "boards.json"))) if r.get("name") == name)
    except Exception: root = ""
    ds = st.get("designs") or {}
    ids = [i for i in ds if not i.startswith("loose/")]
    shown = []
    for i in ids:                                   # a design whose file is gone is passed over
        if len(shown) == 3: break
        if os.path.isfile(os.path.join(root, i)): shown.append({"id": i, "w": ds[i].get("w") or 1080, "h": ds[i].get("h") or 1350})
    items = [{"kind": i.get("kind"), "x": i.get("x", 0), "y": i.get("y", 0), "w": i.get("w", 0), "h": i.get("h", 0), "rot": i.get("rot"),
              "text": (i.get("text") or "")[:60], "src": i.get("src")} for i in (st.get("items") or []) if i.get("kind") != "arrow"][:300]
    out = {"name": name, "designCount": len(ids), "designs": shown, "items": items}
    _previews[name] = (key, out)
    return out

def studio_boards(base):
    """Every Studio board with its pin, dates and the cards on it. Read from Studio's own files, so it works while Studio is down."""
    from urllib.parse import quote
    try: reg = json.load(open(os.path.join(STUDIO_DATA, "boards.json")))
    except Exception: reg = []
    try: cards = json.load(open(DATA))["cards"]
    except Exception: cards = []
    kept = kept_boards(); out = []
    for i, r in enumerate(reg):
        name = r.get("name", "")
        d = os.path.join(STUDIO_DATA, "boards", name)
        try: st = os.stat(d); created = getattr(st, "st_birthtime", st.st_mtime)
        except OSError: created = 0
        try: updated = max(os.path.getmtime(os.path.join(d, f)) for f in os.listdir(d))
        except (OSError, ValueError): updated = created
        if name not in kept and board_empty(name, r.get("root", "")): continue      # nothing on it: not listed anywhere (permanent boards always are)
        on = sorted((c for c in cards if c.get("studio") == name), key=lambda c: c.get("status") == "Done")
        out.append({"name": name, "kept": name in kept, "closed": bool(r.get("closed")), "exists": os.path.isdir(r.get("root", "")),
                    "created": created, "updated": updated, "order": i, "url": f"{base}/?board={quote(name)}",
                    "cards": [{"id": c["id"], "title": c["title"], "status": c.get("status"), "brand": c.get("brand", "")} for c in on]})
    pinned = sorted((b for b in out if b["kept"]), key=lambda b: kept.index(b["name"]))
    rest = sorted((b for b in out if not b["kept"]), key=lambda b: (-b["updated"], -b["order"]))
    return pinned + rest

def tailscale_ip():
    import subprocess
    for exe in ("/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"):
        try:
            out = subprocess.run([exe, "ip", "-4"], capture_output=True, text=True, timeout=5).stdout.split()
            if out and out[0].startswith("100."): return out[0]
        except Exception: pass

def serve_tailscale():
    """Only reachable from your own Tailscale devices (100.x address), never the open internet or Wi-Fi."""
    import threading
    def loop():
        while True:
            ip = tailscale_ip()
            if ip:
                try: ThreadingHTTPServer((ip, PORT), H).serve_forever()
                except OSError: pass
            time.sleep(15)
    threading.Thread(target=loop, daemon=True).start()

if __name__ == "__main__":
    import sys; sys.path.insert(0, HERE)
    if not os.environ.get("BOARD_NO_TAILSCALE"): serve_tailscale()
    if not os.environ.get("BOARD_NO_AUTOMATIONS"): automations.start()
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
