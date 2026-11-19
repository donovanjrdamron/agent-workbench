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
ASSETS = os.path.join(HERE, "canvas-assets")
WAIT_DIR = os.path.expanduser("~/.claude/waiting")
PORT = int(os.environ.get("BOARD_PORT", 4477))
# Studio: each card can have its own Studio board (planning + designs in one place)
STUDIO_URL = os.environ.get("STUDIO_URL", "http://127.0.0.1:4517")
STUDIO_CLI = os.environ.get("STUDIO_CLI") or shutil.which("studio") or os.path.expanduser("~/agent-workbench/studio/bin/studio")
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

def card_info(cid):
    try:
        for c in json.load(open(DATA))["cards"]:
            if c["id"] == cid: return c
    except Exception: pass
    return {}

# ---------- linked Claude sessions ----------
SESS_DIR = os.path.join(WAIT_DIR, ".sessions")
ORCA = "/usr/local/bin/orca"

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

def agent_state(card):
    a = card.get("agent") or {}
    pid = a.get("pid")
    if not pid: return None
    rec = session_rec(pid)
    if not alive(pid) or not _is_claude(pid):        # closed, or the pid now belongs to something else
        return {"state": "ended", "rec": rec, "agent": a}
    return {"state": rec.get("state", "working"), "rec": rec, "agent": a}

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
        if p == "/api/agents":   # status dot for every linked card
            out = {}
            try: cards = json.load(open(DATA))["cards"]
            except Exception: cards = []
            for c in cards:
                if c.get("status") == "Done": continue
                st = agent_state(c)
                if st and st["state"] != "ended":
                    out[c["id"]] = {"state": st["state"]}
            return self.send(200, json.dumps(out))
        m = re.match(r"^/api/agent/([^/]+)$", p)
        if m:
            cid = unquote(m.group(1))
            c = card_info(cid); st = agent_state(c) if c else None
            if not st: return self.send(200, json.dumps({"linked": False}))
            msgs, title = transcript_info(st["rec"].get("transcript", "")) if st["rec"].get("transcript") else ([], "")
            return self.send(200, json.dumps({"linked": True, "state": st["state"], "title": title, "messages": msgs,
                                              "canSend": st["state"] != "ended" and bool(st["agent"].get("terminal"))}))
        if p == "/api/studio-card":   # which card a Studio board belongs to
            from urllib.parse import parse_qs
            name = (parse_qs(self.path.split("?", 1)[1]).get("board") or [""])[0] if "?" in self.path else ""
            try: cards = json.load(open(DATA))["cards"]
            except Exception: cards = []
            c = next((c for c in cards if name and c.get("studio") == name), None)
            return self.send(200, json.dumps({"card": {"id": c["id"], "title": c["title"], "brand": c.get("brand", ""), "status": c.get("status")} if c else None}))
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
            if c.get("studio") and (self.headers.get("Host") or "").startswith(("127.0.0.1", "localhost")):
                from urllib.parse import quote
                return self.send(302, b"", "text/plain", extra={"Location": f"{STUDIO_URL}/?board={quote(c['studio'])}"})
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
        m = re.match(r"^/api/agent/([^/]+)/(send|open)$", self.path)
        if m:
            cid, action = unquote(m.group(1)), m.group(2)
            c = card_info(cid); st = agent_state(c) if c else None
            if not st or st["state"] == "ended":
                return self.send(409, json.dumps({"error": "That Claude session isn't running anymore."}))
            term = st["agent"].get("terminal") or st["rec"].get("terminal")
            if not term: return self.send(409, json.dumps({"error": "This session wasn't started inside Orca."}))
            if action == "open":
                r = orca("terminal", "switch", "--terminal", term)
                import subprocess; subprocess.run(["/usr/bin/open", "-a", "Orca"])
                return self.send(200 if r.get("ok") else 502, json.dumps({"ok": bool(r.get("ok")), "error": r.get("error")}))
            try: text = json.loads(self.body()).get("text", "")
            except Exception: text = ""
            text = " ".join(str(text).split())[:4000]       # one line: a newline would send early
            if not text: return self.send(400, json.dumps({"error": "empty"}))
            r = orca("terminal", "send", "--terminal", term, "--text", text, "--enter")
            return self.send(200 if r.get("ok") else 502, json.dumps({"ok": bool(r.get("ok")), "error": r.get("error")}))
        m = re.match(r"^/api/studio/([^/]+)$", self.path)
        if m:   # open this card's Studio board, making it on first use
            cid = unquote(m.group(1))
            if not SAFE_ID.match(cid): return self.send(400, "{}")
            try: name = ensure_studio(cid)
            except Exception as e: return self.send(502, json.dumps({"error": str(e)[:300]}))
            from urllib.parse import quote
            return self.send(200, json.dumps({"board": name, "url": f"{STUDIO_URL}/?board={quote(name)}"}))
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
            if os.path.exists(DATA):
                shutil.copy2(DATA, DATA + ".bak"); snapshot()
            tmp = DATA + ".tmp"
            with open(tmp, "wb") as f: f.write(body)
            os.replace(tmp, DATA)
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
    subprocess.run([STUDIO_CLI, "boards"], capture_output=True, timeout=60, env={**os.environ, "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"})

def ensure_studio(cid):
    c = card_info(cid)
    if not c: raise KeyError(f"no card {cid}")
    studio_up()
    names = {b["name"]: b for b in studio("GET", "/api/boards")[1].get("boards", [])}
    if c.get("studio") in names: return c["studio"]
    base = re.sub(r"[^\w .()&,-]+", " ", c["title"]).strip()[:70].strip() or "Board"
    brand = re.sub(r"[^\w .-]+", " ", c.get("brand") or "General").strip() or "General"
    name, n = base, 2
    while name in names: name, n = f"{base} ({n})", n + 1
    folder = os.path.join(STUDIO_HOME, brand, name)
    os.makedirs(folder, exist_ok=True)
    code, r = studio("POST", "/api/boards", {"name": name, "root": folder})
    if code != 200: raise RuntimeError(r.get("error") or f"Studio said {code}")
    update_card(cid, lambda card: card.__setitem__("studio", name))
    return name

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
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
