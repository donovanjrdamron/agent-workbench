#!/usr/bin/env python3
"""Move a card's old Excalidraw canvas onto its Studio board (once; the old canvas file is left as it is).

  canvas_to_studio.py <card id> [...]     convert these cards
  canvas_to_studio.py --all               every card whose canvas has something on it

Frames become sections, boxes keep their text, arrows keep their order, notes grouped with a picture or video
stay attached to it, pictures and videos are copied into the board folder's studio-assets/.
Re-running replaces what an earlier run made (same ids), it never duplicates.
"""
import json, os, shutil, sys

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import server as S  # noqa: E402  (same folder: card data, Studio helpers)

K = 1.6           # Studio boxes are drawn bigger than Excalidraw's (30px text vs ~20px)
SHAPES = {"rectangle", "ellipse", "diamond"}


def convert(cid):
    path = S.canvas_path(cid)
    els = [e for e in json.load(open(path)).get("elements", []) if not e.get("isDeleted")]
    if not els: return f"{cid}: empty canvas, nothing to move"
    name = S.ensure_studio(cid)
    root = next(b["root"] for b in S.studio("GET", "/api/boards")[1]["boards"] if b["name"] == name)
    assets = os.path.join(root, "studio-assets"); os.makedirs(assets, exist_ok=True)
    by = {e["id"]: e for e in els}
    bound = {e["containerId"]: (e.get("text") or e.get("originalText") or "") for e in els if e["type"] == "text" and e.get("containerId") in by}
    size = {e["containerId"]: e.get("fontSize") or 20 for e in els if e["type"] == "text" and e.get("containerId") in by}
    x0 = min(e["x"] for e in els if e["type"] != "arrow"); y0 = min(e["y"] for e in els if e["type"] != "arrow")
    pos = lambda e: {"x": round((e["x"] - x0) * K), "y": round((e["y"] - y0) * K), "w": max(20, round(e.get("width", 0) * K)), "h": max(20, round(e.get("height", 0) * K))}
    iid = lambda eid: "x_" + eid

    # notes grouped with a picture or video
    media_ids = {e["id"] for e in els if e["type"] in ("image", "embeddable")}
    attach = {}
    for m in media_ids:
        g = set(by[m].get("groupIds") or [])
        if not g: continue
        for o in els:
            if o["id"] != m and set(o.get("groupIds") or []) & g and (o["type"] in SHAPES or (o["type"] == "text" and not o.get("containerId"))):
                attach[o["id"]] = m

    items, skipped = [], {}
    for e in els:
        t = e["type"]
        it = {"id": iid(e["id"]), **pos(e)}
        if t in ("frame", "magicframe"):
            it.update(kind="section", text=e.get("name") or "Section")
        elif t in SHAPES:
            it.update(kind="box", text=bound.get(e["id"], ""), fs=round(size.get(e["id"], 20) * K * 0.88))
        elif t == "text" and e.get("containerId") in by:
            continue                                   # lives inside its box or arrow
        elif t == "text":
            it.update(kind="box" if e["id"] in attach else "text", text=e.get("text") or e.get("originalText") or "", fs=round((e.get("fontSize") or 20) * K * 0.88))
            if it["kind"] == "text": it["h"] = max(it["h"], 60)
        elif t == "image":
            fd = S.files_dir(cid); src = None
            if os.path.isdir(fd):
                f = next((f for f in os.listdir(fd) if f.startswith(e.get("fileId") or "\0")), None)
                if f: shutil.copy2(os.path.join(fd, f), os.path.join(assets, f)); src = f"studio-assets/{f}"
            if not src: skipped["image without its file"] = skipped.get("image without its file", 0) + 1; continue
            it.update(kind="image", src=src)
        elif t == "embeddable":
            link = e.get("link") or ""
            if link.startswith("https://media.local/"):
                f = link.split("/", 3)[-1]
                if not os.path.exists(os.path.join(S.MEDIA, f)): skipped["missing video"] = skipped.get("missing video", 0) + 1; continue
                shutil.copy2(os.path.join(S.MEDIA, f), os.path.join(assets, f))
                it.update(kind="video", src=f"studio-assets/{f}", text=f)
            else:
                it.update(kind="link", url=link, text=link, w=max(it["w"], 520), h=max(min(it["h"], 160), 120))
        elif t == "arrow":
            a = (e.get("startBinding") or {}).get("elementId"); b = (e.get("endBinding") or {}).get("elementId")
            if a not in by or b not in by: skipped["loose arrow"] = skipped.get("loose arrow", 0) + 1; continue
            it.update(kind="arrow", x=0, y=0, w=0, h=0, **{"from": iid(a), "to": iid(b)}, text=bound.get(e["id"], ""))
        else:
            skipped[t] = skipped.get(t, 0) + 1; continue
        if e["id"] in attach:   # a note sits under its picture, as wide as it, and wraps
            m = pos(by[attach[e["id"]]])
            it.update(attach=iid(attach[e["id"]]), color="note", x=m["x"], w=max(m["w"], 360))
        items.append(it)
    # the ad files on a board sit at x >= 0: keep the old plan to their left
    width = max((i["x"] + i["w"] for i in items if i["kind"] != "arrow"), default=0)
    for i in items:
        if i["kind"] != "arrow": i["x"] -= width + 400
    code, r = S.studio("POST", "/api/items", {"board": name, "put": items, "by": "agent"})
    if code != 200: raise RuntimeError(r.get("error") or code)
    extra = f" (left out: {', '.join(f'{n} {k}' for k, n in skipped.items())})" if skipped else ""
    return f"{cid}: {len(items)} things moved to Studio board \"{name}\"{extra}"


if __name__ == "__main__":
    args = sys.argv[1:]
    if args == ["--all"]:
        args = []
        for f in sorted(os.listdir(S.CANVASES)):
            if f.endswith(".json"):
                try:
                    if any(not e.get("isDeleted") for e in json.load(open(os.path.join(S.CANVASES, f))).get("elements", [])): args.append(f[:-5])
                except Exception: pass
    if not args: print(__doc__.strip()); sys.exit(1)
    for cid in args:
        try: print(convert(cid))
        except Exception as e: print(f"{cid}: FAILED {e}")
