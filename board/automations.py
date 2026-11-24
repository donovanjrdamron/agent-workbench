"""Automations: follow-ups and recurring jobs the agents set up for the user ("hit me back in 30 minutes", "every
morning at 9 check yesterday's spend"). They live apart from the cards, so a card can go to Done while its follow-up
still runs. When one is due, the board resumes that agent's conversation in the background (a fork of it, so a session
that is still open is never disturbed), keeps the answer as the run's result and tells the user."""
import datetime as dt, json, os, re, shutil, subprocess, threading, time, uuid, fcntl

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(HERE, "automations.json")
LOCK = threading.Lock()
RUNNING = set()

# ---------- when ----------
UNITS = {"s": 1, "sec": 1, "secs": 1, "second": 1, "seconds": 1, "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60,
         "h": 3600, "hr": 3600, "hrs": 3600, "hour": 3600, "hours": 3600, "d": 86400, "day": 86400, "days": 86400}
DAYS = {"mon": 0, "monday": 0, "tue": 1, "tues": 1, "tuesday": 1, "wed": 2, "wednesday": 2, "thu": 3, "thur": 3, "thurs": 3, "thursday": 3,
        "fri": 4, "friday": 4, "sat": 5, "saturday": 5, "sun": 6, "sunday": 6}

def _clock(t):
    """'9', '9am', '5:30pm', '17:30' -> (h, m), or None."""
    m = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", t.strip())
    if not m: return None
    h, mi, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3)
    if ap == "pm" and h < 12: h += 12
    if ap == "am" and h == 12: h = 0
    return (h, mi) if h < 24 and mi < 60 else None

def _dur(t):
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([a-z]+)", t.strip())
    if m and m.group(2) in UNITS: return int(float(m.group(1)) * UNITS[m.group(2)])
    return None

def parse_when(text, now=None):
    """Turns what an agent writes into a schedule. Returns ({kind,...}, first run epoch) or raises ValueError.
    once: '30m', 'in 2 hours', '5:30pm', 'tomorrow 9am', 'friday 10am'
    repeat: 'every 30m', 'every day 9am', 'daily 9:00', 'every weekday 9am', 'every monday 10am'"""
    now = now or time.time()
    t = " ".join(text.lower().replace(",", " ").split())
    t = re.sub(r"^(in|after)\s+", "", t)
    every = t.startswith(("every ", "each ")) or t.startswith("daily") or t.startswith("hourly") or t.startswith("weekdays")
    if every:
        t = re.sub(r"^(every|each)\s+", "", t)
        if t.startswith("hourly") or t in ("hour",): return _next({"kind": "interval", "secs": 3600}, now)
        d = _dur(t) or (_dur("1 " + t) if t in UNITS else None)
        if d and d >= 60: return _next({"kind": "interval", "secs": d}, now)
        m = re.fullmatch(r"(day|daily|weekday|weekdays|morning|[a-z]+day|[a-z]{3})(?:\s+(?:at\s+)?(.+))?", t)
        if m:
            word, at = m.group(1), m.group(2) or ("9am" if m.group(1) == "morning" else "9am")
            hm = _clock(at)
            if not hm: raise ValueError(f"Can't read the time in '{text}'")
            if word in ("day", "daily", "morning"): days = list(range(7))
            elif word in ("weekday", "weekdays"): days = [0, 1, 2, 3, 4]
            elif word in DAYS: days = [DAYS[word]]
            else: raise ValueError(f"Can't read '{text}'")
            return _next({"kind": "daily", "hm": list(hm), "days": days}, now)
        raise ValueError(f"Can't read '{text}'. Try 'every 30m', 'every day 9am' or 'every weekday 9am'.")
    d = _dur(t)
    if d: return {"kind": "once"}, now + d
    m = re.fullmatch(r"(today|tonight|tomorrow|[a-z]+)?\s*(?:at\s+)?(.+)", t)
    if m:
        hm = _clock(m.group(2))
        day = m.group(1)
        if hm:
            base = dt.datetime.fromtimestamp(now)
            at = base.replace(hour=hm[0], minute=hm[1], second=0, microsecond=0)
            if day == "tomorrow": at += dt.timedelta(days=1)
            elif day in DAYS: at += dt.timedelta(days=(DAYS[day] - at.weekday()) % 7 or (7 if at.timestamp() <= now else 0))
            elif day not in (None, "today", "tonight"): raise ValueError(f"Can't read '{text}'")
            if at.timestamp() <= now: at += dt.timedelta(days=1)
            return {"kind": "once"}, at.timestamp()
    raise ValueError(f"Can't read '{text}'. Try '30m', '2h', '5:30pm', 'tomorrow 9am' or 'every day 9am'.")

def _next(sched, after):
    if sched["kind"] == "interval": return sched, after + sched["secs"]
    if sched["kind"] == "daily":
        base = dt.datetime.fromtimestamp(after)
        for i in range(0, 8):
            c = (base + dt.timedelta(days=i)).replace(hour=sched["hm"][0], minute=sched["hm"][1], second=0, microsecond=0)
            if c.timestamp() > after and c.weekday() in sched["days"]: return sched, c.timestamp()
    return sched, None

def describe(a):
    s = a.get("sched") or {}
    if s.get("kind") == "interval":
        n = s["secs"]; return f"every {n // 3600}h" if n % 3600 == 0 else f"every {n // 60}m"
    if s.get("kind") == "daily":
        hm = dt.time(*s["hm"]).strftime("%-I:%M %p").replace(":00 ", " ")
        d = s["days"]
        return f"every day at {hm}" if len(d) == 7 else f"weekdays at {hm}" if d == [0, 1, 2, 3, 4] else "every " + ", ".join(k.title() for k, v in DAYS.items() if v in d and len(k) > 3) + f" at {hm}"
    return "once"

# ---------- store ----------
def load():
    try: return json.load(open(STORE))
    except Exception: return []
def save(items):
    tmp = STORE + ".tmp"; json.dump(items, open(tmp, "w"), indent=1); os.replace(tmp, STORE)
def edit(fn):
    with LOCK, open(STORE + ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        items = load(); out = fn(items); save(items); return out

def create(card, card_title, when, prompt, sid, cwd, by="agent"):
    sched, nxt = parse_when(when)
    a = {"id": "a" + uuid.uuid4().hex[:10], "card": card, "card_title": card_title, "prompt": prompt.strip(), "when": when,
         "sched": sched, "next": nxt, "sid": sid, "cwd": cwd, "status": "active", "created": time.time(), "by": by, "runs": []}
    edit(lambda items: items.append(a))
    return a

# ---------- running ----------
def _bin(name):
    extra = [os.path.expanduser("~/.npm-global/bin"), "/opt/homebrew/bin", "/usr/local/bin", os.path.expanduser("~/.local/bin"), os.path.expanduser("~/.bun/bin")]
    return shutil.which(name, path=os.pathsep.join([os.environ.get("PATH", "")] + extra))
def _env():
    path = [os.environ.get("PATH", ""), os.path.expanduser("~/.npm-global/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", os.path.expanduser("~/.local/bin")]
    return {**os.environ, "PATH": os.pathsep.join(p for p in path if p)}

def notify(title, text):
    """A Mac notification (and the board's inbox count)."""
    q = lambda s: '"' + str(s).replace("\\", "\\\\").replace('"', '\\"')[:220] + '"'
    try: subprocess.run(["/usr/bin/osascript", "-e", f"display notification {q(text)} with title {q(title)} sound name \"Glass\""], timeout=10, capture_output=True)
    except Exception: pass

INSTR = ("[Automation from the work board, scheduled earlier in this conversation: \"{when}\".]\n{prompt}\n\n"
         "Do it now. The user is not watching this run: finish the work, then reply with a short report for them "
         "(it is what they will read), starting with the answer. If you need them to decide something, say so plainly.")

def run(aid):
    """Run one automation now (in its own thread)."""
    if aid in RUNNING: return
    a = next((x for x in load() if x["id"] == aid), None)
    if not a: return
    RUNNING.add(aid)
    started = time.time()
    try:
        claude = _bin("claude")
        if not claude: raise RuntimeError("Can't find the claude command")
        cwd = a.get("cwd") if a.get("cwd") and os.path.isdir(a.get("cwd")) else os.path.expanduser("~")
        cmd = [claude, "-p", "--output-format", "json"]
        if a.get("sid"): cmd += ["--resume", a["sid"], "--fork-session"]
        cmd.append(INSTR.format(when=a.get("when", ""), prompt=a["prompt"]))
        p = subprocess.run(cmd, cwd=cwd, env=_env(), capture_output=True, text=True, timeout=45 * 60, stdin=subprocess.DEVNULL)
        try: j = json.loads(p.stdout.strip().splitlines()[-1])
        except Exception: j = {}
        ok = p.returncode == 0 and not j.get("is_error")
        result = (j.get("result") or "").strip() or (p.stderr.strip()[-800:] if not ok else "")
        run_rec = {"ts": started, "took": round(time.time() - started), "ok": ok, "text": result or "(no reply)", "sid": j.get("session_id"), "unread": True}
    except Exception as e:
        run_rec = {"ts": started, "took": round(time.time() - started), "ok": False, "text": f"Couldn't run it: {e}", "unread": True}
    def finish(items):
        x = next((i for i in items if i["id"] == aid), None)
        if not x: return None
        x["runs"] = (x.get("runs") or [])[-19:] + [run_rec]
        if run_rec.get("sid"): x["sid"] = run_rec["sid"]          # the next run continues from this one
        if x["sched"]["kind"] == "once": x["status"] = "done"; x["next"] = None
        else: x["next"] = _next(x["sched"], max(time.time(), x.get("next") or 0))[1]
        return x
    x = edit(finish)
    RUNNING.discard(aid)
    if x: notify(("✓ " if run_rec["ok"] else "⚠ ") + (x.get("card_title") or "Automation"), run_rec["text"].replace("\n", " ")[:200])

def loop():
    """Every 20s: start whatever is due."""
    while True:
        try:
            now = time.time()
            for a in load():
                if a.get("status") == "active" and a.get("next") and a["next"] <= now and a["id"] not in RUNNING:
                    if a["sched"]["kind"] != "once":   # claim this slot now, so a long run is not started twice
                        edit(lambda items: [i.update({"next": _next(i["sched"], max(now, i["next"]))[1]}) for i in items if i["id"] == a["id"]])
                    threading.Thread(target=run, args=(a["id"],), daemon=True).start()
        except Exception as e:
            open(os.path.join(HERE, "server.log"), "a").write(f"automations: {e}\n")
        time.sleep(20)

def start():
    threading.Thread(target=loop, daemon=True).start()
