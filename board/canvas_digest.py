"""Turn an Excalidraw canvas into a plain-language outline an AI can read.

Frames are separate sections. Inside each frame: flows (boxes chained by arrows,
in order), standalone text, boxes, videos/links/images, each placed in reading
order and tied to the nearest text so "this video goes with that note" survives.
"""
import math, os

SHAPES = {"rectangle", "ellipse", "diamond"}


def _center(e):
    return (e["x"] + e.get("width", 0) / 2, e["y"] + e.get("height", 0) / 2)


def _clean(t):
    return " ".join((t or "").split())


def build(scene, title="", brand="", board_dir="", card_id=""):
    els = [e for e in scene.get("elements", []) if not e.get("isDeleted")]
    by_id = {e["id"]: e for e in els}

    # text that lives inside a shape or on an arrow
    bound_text = {}
    for e in els:
        if e["type"] == "text" and e.get("containerId") in by_id:
            bound_text[e["containerId"]] = _clean(e.get("text") or e.get("originalText"))

    frames = sorted([e for e in els if e["type"] in ("frame", "magicframe")],
                    key=lambda f: (round(f["y"] / 200), f["x"]))
    frame_name = {f["id"]: (_clean(f.get("name")) or f"Frame {i + 1}") for i, f in enumerate(frames)}

    def label(e):
        t = e["type"]
        if t in SHAPES:
            txt = bound_text.get(e["id"], "")
            return f'[{txt}]' if txt else f"[empty {t}]"
        if t == "text":
            return f'"{_clean(e.get("text") or e.get("originalText"))}"'
        if t == "embeddable":
            return media_label(e)
        if t == "image":
            return image_label(e)
        return t

    def media_label(e):
        link = e.get("link") or ""
        if link.startswith("https://media.local/"):
            name = link.split("/", 3)[-1]
            return f"Video file: {os.path.join(board_dir, 'media', name)}"
        if any(h in link for h in ("youtube.com", "youtu.be", "vimeo.com", "loom.com", "tiktok.com", "instagram.com")):
            return f"Video: {link}"
        return f"Embed: {link}"

    def image_label(e):
        fid = e.get("fileId")
        folder = os.path.join(board_dir, "canvases", f"{card_id}.files")
        if fid and os.path.isdir(folder):
            for f in os.listdir(folder):
                if f.startswith(fid):
                    return f"Image: {os.path.join(folder, f)}"
        return "Image"

    # arrows -> edges between things
    edges, loose_arrows = [], []
    for e in els:
        if e["type"] != "arrow":
            continue
        a = (e.get("startBinding") or {}).get("elementId")
        b = (e.get("endBinding") or {}).get("elementId")
        lab = bound_text.get(e["id"], "")
        if a in by_id and b in by_id:
            edges.append((a, b, lab))
        else:
            loose_arrows.append(e)

    def frame_of(e):
        fid = e.get("frameId")
        if fid in frame_name:
            return fid
        if e["type"] == "text" and e.get("containerId") in by_id:
            return frame_of(by_id[e["containerId"]])
        return None

    def chains(ids):
        """Follow arrows into ordered flows: A -> B -> C."""
        ids = set(ids)
        out_e = {}
        indeg = {i: 0 for i in ids}
        for a, b, lab in edges:
            if a in ids and b in ids:
                out_e.setdefault(a, []).append((b, lab))
                indeg[b] += 1
        used, flows = set(), []
        starts = sorted([i for i in ids if indeg[i] == 0 and i in out_e], key=lambda i: (by_id[i]["y"], by_id[i]["x"]))
        for s in starts + [i for i in out_e if i not in starts]:
            if s in used:
                continue
            seq, cur, seen = [(s, "")], s, {s}
            while cur in out_e:
                nxt = [(b, l) for b, l in out_e[cur] if b not in seen]
                if not nxt:
                    break
                b, l = sorted(nxt, key=lambda x: (by_id[x[0]]["x"], by_id[x[0]]["y"]))[0]
                seq.append((b, l)); seen.add(b); cur = b
                if len(out_e[cur] if cur in out_e else []) > 1:
                    pass
            used |= seen
            flows.append(seq)
        # branches: a box that splits into several next steps -> each extra path listed from its split point
        changed = True
        while changed:
            changed = False
            for a_, outs in out_e.items():
                for b_, l_ in outs:
                    if b_ in used or a_ not in used:
                        continue
                    seq, cur, seen = [(a_, ""), (b_, l_)], b_, {a_, b_}
                    while cur in out_e:
                        nxt = [(b, l) for b, l in out_e[cur] if b not in seen and b not in used]
                        if not nxt: break
                        b, l = sorted(nxt, key=lambda x: (by_id[x[0]]["x"], by_id[x[0]]["y"]))[0]
                        seq.append((b, l)); seen.add(b); cur = b
                    used |= seen
                    flows.append(seq)
                    changed = True
        return flows, used

    def nearest_text(e, pool):
        cx, cy = _center(e)
        best, bd = None, 1e18
        for o in pool:
            if o["id"] == e["id"] or o["type"] not in SHAPES | {"text"}:
                continue
            if o["type"] == "text" and o.get("containerId"):
                continue
            ox, oy = _center(o)
            d = math.hypot(cx - ox, cy - oy)
            if d < bd:
                best, bd = o, d
        return best

    # notes attached to an image/video (grouped with it via "+ Note" or Cmd+G)
    attached = {}            # media id -> [note elements]
    note_ids = set()
    for med in els:
        if med["type"] not in ("image", "embeddable") or not med.get("groupIds"):
            continue
        g = set(med["groupIds"])
        notes = [o for o in els if o["id"] != med["id"] and set(o.get("groupIds") or []) & g
                 and (o["type"] in SHAPES or (o["type"] == "text" and not o.get("containerId")))]
        if notes:
            attached[med["id"]] = sorted(notes, key=lambda o: (o["y"], o["x"]))
            note_ids |= {o["id"] for o in notes}

    def media_line(m):
        notes = attached.get(m["id"])
        if not notes:
            return label(m)
        txt = " / ".join(label(n).strip('"[]') for n in notes)
        return f'{label(m)}\n    Note attached to it: "{txt}"'

    def section(members):
        lines = []
        content = [m for m in members if m["type"] not in ("arrow", "frame", "magicframe")
                   and not (m["type"] == "text" and m.get("containerId")) and m["id"] not in note_ids]
        flows, in_flow = chains([m["id"] for m in content if m["type"] in SHAPES | {"text", "embeddable", "image"}])
        for n, seq in enumerate(flows, 1):
            branch = n > 1 and seq[0][0] in {x for f in flows[:n-1] for x, _ in f}
            lines.append(f"- Flow {n} (in order)" + (" — branches off the step above:" if branch else ":"))
            for i, (eid, lab) in enumerate(seq, 1):
                via = f" (arrow says: {lab})" if lab else ""
                el = by_id[eid]
                shown = media_line(el) if el["type"] in ("image", "embeddable") else label(el)
                lines.append(f"  {i}. {shown}{via}")
        rest = sorted([m for m in content if m["id"] not in in_flow], key=lambda m: (round(m["y"] / 60), m["x"]))
        anchors = [m for m in content if m["type"] in SHAPES | {"text"}]
        for m in rest:
            if m["type"] in ("embeddable", "image"):
                if m["id"] in attached:
                    lines.append(f"- {media_line(m)}")
                else:
                    near = nearest_text(m, [a for a in anchors if a["id"] not in note_ids])
                    lines.append(f"- {label(m)}" + (f"  (no note attached; nearest text: {label(near)})" if near else ""))
            elif m["type"] in SHAPES or m["type"] == "text":
                link = f"  (link: {m['link']})" if m.get("link") else ""
                lines.append(f"- {'Box' if m['type'] in SHAPES else 'Text'}: {label(m)}{link}")
        return lines

    out = [f"# Canvas: {title}" + (f" ({brand})" if brand else ""), "",
           "Each frame is a separate section. Flows are boxes connected by arrows, listed in order.", ""]
    for f in frames:
        members = [e for e in els if frame_of(e) == f["id"]]
        out.append(f"## {frame_name[f['id']]}")
        body = section(members)
        out += body if body else ["- (empty)"]
        out.append("")
    loose = [e for e in els if frame_of(e) is None and e["type"] not in ("frame", "magicframe")]
    if any(e["type"] != "arrow" for e in loose):
        out.append("## Outside any frame")
        out += section(loose)
        out.append("")
    # arrows that connect across frames
    cross = [(a, b, l) for a, b, l in edges if frame_of(by_id[a]) != frame_of(by_id[b])]
    if cross:
        out.append("## Connections between frames")
        for a, b, l in cross:
            fa = frame_name.get(frame_of(by_id[a]), "outside"); fb = frame_name.get(frame_of(by_id[b]), "outside")
            out.append(f"- {label(by_id[a])} ({fa}) -> {label(by_id[b])} ({fb})" + (f" (arrow says: {l})" if l else ""))
        out.append("")
    return "\n".join(out).rstrip() + "\n"
