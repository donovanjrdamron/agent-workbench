import React, { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  sceneCoordsToViewportCoords,
  Excalidraw, MainMenu, WelcomeScreen, FONT_FAMILY, CaptureUpdateAction,
  hashElementsVersion, viewportCoordsToSceneCoords, convertToExcalidrawElements,
} from "@excalidraw/excalidraw";
import { renderMd } from "./md.js";
import "./node_modules/@excalidraw/excalidraw/dist/prod/index.css";

const CARD = decodeURIComponent(location.pathname.split("/").pop());
const MEDIA = "https://media.local/";              // device-independent link for uploaded video files
const API = `/api/canvas/${encodeURIComponent(CARD)}`;
const VIDEO_HOSTS = /(youtube\.com|youtu\.be|vimeo\.com|loom\.com|figma\.com|x\.com|twitter\.com|google\.com|spotify\.com)/;

const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;

// Clean, Figma-like defaults instead of the hand-drawn look
const CLEAN = {
  currentItemRoughness: 0,
  currentItemFontFamily: FONT_FAMILY.Helvetica,
  currentItemStrokeWidth: 1,
  currentItemFontSize: 16,
  currentItemRoundness: "round",
  currentItemArrowType: "sharp",
  currentItemStrokeColor: "#1e1e1e",
  currentItemBackgroundColor: "#ffffff",     // filled boxes: the whole inside is clickable, not just the outline
  currentItemFillStyle: "solid",
};

function App() {
  const [api, setApi] = useState(null);
  const [initial, setInitial] = useState(null);
  const [card, setCard] = useState({ title: "", brand: "" });
  const [saving, setSaving] = useState("");
  const [mediaSel, setMediaSel] = useState(null);
  const [mountKey, setMountKey] = useState(0);
  const [plus, setPlus] = useState(null);
  const [agent, setAgent] = useState(null);         // linked Claude session (null if none)
  const [chatOpen, setChatOpen] = useState(() => { try { return localStorage.getItem("cvChat") === "1"; } catch (e) { return false; } });           // selected box + its on-screen rectangle, for the + buttons   // the image/video currently selected, if exactly one
  const ver = useRef(null);
  const lastHash = useRef(null);
  const uploaded = useRef(new Set());
  const timer = useRef(null);
  const busy = useRef(false);
  const pending = useRef(false);

  // ---------- load ----------
  useEffect(() => {
    (async () => {
      const r = await fetch(API);
      ver.current = r.headers.get("X-Version");
      const d = await r.json();
      setCard({ title: d.title || "", brand: d.brand || "" });
      document.title = d.title ? `${d.title} · Canvas` : "Canvas";
      Object.keys(d.files || {}).forEach(id => uploaded.current.add(id));
      const fixed = (d.elements || []).map(e => (e.type === "rectangle" && !e.isDeleted && e.backgroundColor === "transparent")
        ? { ...e, backgroundColor: "#ffffff", fillStyle: "solid", version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() } : e);
      lastHash.current = hashElementsVersion(d.elements || []);   // differs if anything was fixed -> gets saved
      setInitial({
        elements: fixed,
        files: d.files || {},
        appState: { ...CLEAN, ...(d.appState || {}), theme: dark() ? "dark" : "light" },
        scrollToContent: true,
      });
    })();
  }, []);

  // ---------- save ----------
  const push = useCallback(async (tries = 0) => {
    if (!api) return;
    if (busy.current) { pending.current = true; return; }
    busy.current = true;
    try {
      const elements = api.getSceneElementsIncludingDeleted();
      const files = api.getFiles();
      // upload new images once, as real files on disk
      for (const id of Object.keys(files)) {
        if (uploaded.current.has(id)) continue;
        const f = files[id];
        const r = await fetch(`${API}/file/${encodeURIComponent(id)}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mimeType: f.mimeType, dataURL: f.dataURL }),
        });
        if (r.ok) uploaded.current.add(id);
      }
      const st = api.getAppState();
      const body = JSON.stringify({
        elements,
        appState: { viewBackgroundColor: st.viewBackgroundColor, gridModeEnabled: st.gridModeEnabled },
      });
      const r = await fetch(API, { method: "PUT", headers: { "Content-Type": "application/json", "X-Version": ver.current || "" }, body });
      if (r.status === 409 && tries < 5) {
        await pullAndMerge();
        busy.current = false;
        return push(tries + 1);
      }
      if (!r.ok) throw new Error("save " + r.status);
      ver.current = r.headers.get("X-Version") || ver.current;
      lastHash.current = hashElementsVersion(elements);
      setSaving("");
    } catch (e) {
      busy.current = false;
      if (tries < 12) { setSaving("retrying"); setTimeout(() => push(tries + 1), 5000); return; }
      setSaving("failed");
      alert("Your last canvas change did NOT save. Keep this tab open and tell Claude.");
      return;
    }
    busy.current = false;
    if (pending.current) { pending.current = false; push(); }
  }, [api]);

  const pullAndMerge = useCallback(async () => {
    const r = await fetch(API);
    const v = r.headers.get("X-Version");
    const d = await r.json();
    ver.current = v;
    const merged = mergeElements(api.getSceneElementsIncludingDeleted(), d.elements || []);
    const newFiles = Object.values(d.files || {}).filter(f => !api.getFiles()[f.id]);
    if (newFiles.length) api.addFiles(newFiles);
    newFiles.forEach(f => uploaded.current.add(f.id));
    api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
  }, [api]);

  const onChange = useCallback((elements, appState) => {
    const ids = Object.keys(appState.selectedElementIds || {});
    const one = ids.length === 1 ? elements.find(e => e.id === ids[0]) : null;
    const m = one && (one.type === "image" || one.type === "embeddable") ? one.id : null;
    setMediaSel(prev => prev === m ? prev : m);
    // + buttons around a single selected box (hidden while drawing, dragging, resizing or typing)
    const busy = appState.editingTextElement || appState.newElement || appState.selectedElementsAreBeingDragged || appState.resizingElement || appState.multiElement;
    let next = null;
    if (one && one.type === "rectangle" && !busy) {
      const a = sceneCoordsToViewportCoords({ sceneX: one.x, sceneY: one.y }, appState);
      const b = sceneCoordsToViewportCoords({ sceneX: one.x + one.width, sceneY: one.y + one.height }, appState);
      next = { id: one.id, l: a.x - appState.offsetLeft, t: a.y - appState.offsetTop, w: b.x - a.x, h: b.y - a.y };
    }
    setPlus(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
    const h = hashElementsVersion(elements);
    if (h === lastHash.current) return;          // only real content changes, not panning/zooming
    lastHash.current = h;
    clearTimeout(timer.current);
    setSaving("saving");
    timer.current = setTimeout(() => push(), 700);
  }, [push]);

  const loadAgent = useCallback(async () => {
    try {
      const d = await (await fetch(`/api/agent/${encodeURIComponent(CARD)}`)).json();
      setAgent(prev => {
        const next = d.linked ? d : null;
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
    } catch (e) {}
  }, []);
  useEffect(() => {
    loadAgent();
    const iv = setInterval(loadAgent, chatOpen ? 3000 : 6000);
    return () => clearInterval(iv);
  }, [loadAgent, chatOpen]);
  const toggleChat = (v) => { setChatOpen(v); try { localStorage.setItem("cvChat", v ? "1" : "0"); } catch (e) {} };

  // pick up edits made on another device (phone <-> Mac)
  useEffect(() => {
    if (!api) return;
    const iv = setInterval(async () => {
      if (busy.current || timer.current && saving === "saving") return;
      try {
        const r = await fetch(API, { method: "HEAD" });
        const v = r.headers.get("X-Version");
        if (v && v !== ver.current && !busy.current) await pullAndMerge();
      } catch (e) {}
    }, 4000);
    return () => clearInterval(iv);
  }, [api, pullAndMerge, saving]);

  // ---------- videos: drop / pick a video file -> upload -> playable on canvas ----------
  const addVideo = useCallback(async (file, clientX, clientY) => {
    if (!api || !file) return;
    setSaving("uploading");
    const r = await fetch("/api/media", { method: "POST", headers: { "X-Filename": encodeURIComponent(file.name) }, body: file });
    if (!r.ok) { setSaving(""); alert("Video upload failed"); return; }
    const { name } = await r.json();
    const st = api.getAppState();
    const pt = clientX != null
      ? viewportCoordsToSceneCoords({ clientX, clientY }, st)
      : viewportCoordsToSceneCoords({ clientX: innerWidth / 2, clientY: innerHeight / 2 }, st);
    const vertical = await isVertical(file);
    const width = vertical ? 270 : 480, height = vertical ? 480 : 270;
    const frame = api.getSceneElements().find(e => e.type === "frame" &&
      pt.x >= e.x && pt.x <= e.x + e.width && pt.y >= e.y && pt.y <= e.y + e.height);
    const [el] = convertToExcalidrawElements([{
      type: "embeddable", x: pt.x - width / 2, y: pt.y - height / 2, width, height,
      link: MEDIA + name, strokeColor: "transparent", backgroundColor: "transparent", roughness: 0,
    }]);
    if (frame) el.frameId = frame.id;
    const elements = [...api.getSceneElementsIncludingDeleted(), el];
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    await push();
    // Excalidraw only starts showing new embeds after a reload: remount in place, same view
    const view = api.getAppState();
    setInitial({ elements, files: api.getFiles(),
      appState: { ...CLEAN, theme: dark() ? "dark" : "light", scrollX: view.scrollX, scrollY: view.scrollY, zoom: view.zoom,
                  viewBackgroundColor: view.viewBackgroundColor, selectedElementIds: { [el.id]: true } } });
    setMountKey(k => k + 1);
    setSaving("");
  }, [api, push]);

  useEffect(() => {
    if (!api) return;
    const onDbl = (e) => {
      if (!e.target.closest?.(".excalidraw") || e.target.closest?.(".cv-plus, .App-toolbar, .Island")) return;
      const st = api.getAppState();
      if (st.editingTextElement) return;
      const { x, y } = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, st);
      const els = api.getSceneElements();
      const inside = (el) => x >= el.x && x <= el.x + el.width && y >= el.y && y <= el.y + el.height;
      // topmost thing under the pointer (ignore frames and the text living inside boxes)
      let top = null;
      for (const el of els) if (el.type !== "frame" && !(el.type === "text" && el.containerId) && el.type !== "arrow" && inside(el)) top = el;
      if (!top || top.type !== "rectangle") return;        // loose text / image / empty canvas: normal behavior
      if (e.__cvRedirected) return;                           // our own re-sent click: let Excalidraw handle it
      const center = sceneCoordsToViewportCoords({ sceneX: top.x + top.width / 2, sceneY: top.y + top.height / 2 }, st);
      if (Math.abs(center.x - e.clientX) < 2 && Math.abs(center.y - e.clientY) < 2) return;   // already at the center
      e.preventDefault(); e.stopImmediatePropagation();
      // re-send the double-click to the box's center, where Excalidraw always edits the box's own text
      const ev = new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: center.x, clientY: center.y });
      ev.__cvRedirected = true;
      e.target.dispatchEvent(ev);
    };
    window.addEventListener("dblclick", onDbl, true);

    // Type-to-fill: with one empty box selected (e.g. right after drawing it), just start typing.
    let pending = null;     // keys typed while the editor is opening
    const onKey = (e) => {
      const printable = e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (pending) { if (printable) { e.preventDefault(); e.stopImmediatePropagation(); pending.buf += e.key; } return; }
      if (!printable || e.target.closest?.("input, textarea, [contenteditable]")) return;
      const st = api.getAppState();
      if (st.editingTextElement || st.newElement) return;
      const ids = Object.keys(st.selectedElementIds || {});
      if (ids.length !== 1) return;
      const box = api.getSceneElements().find(el => el.id === ids[0]);
      if (!box || box.type !== "rectangle" || (box.boundElements || []).some(b => b.type === "text")) return;
      e.preventDefault(); e.stopImmediatePropagation();
      pending = { buf: e.key };
      const c = sceneCoordsToViewportCoords({ sceneX: box.x + box.width / 2, sceneY: box.y + box.height / 2 }, st);
      const cnv = document.querySelector("canvas.interactive") || document.querySelector(".excalidraw canvas:last-of-type");
      const ev = new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: c.x, clientY: c.y });
      ev.__cvRedirected = true;
      cnv?.dispatchEvent(ev);
      let tries = 0;
      const fill = () => {
        const ta = document.querySelector(".excalidraw-wysiwyg");
        if (ta) {
          ta.value = pending.buf;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.focus(); ta.setSelectionRange?.(ta.value.length, ta.value.length);
          pending = null;
        } else if (tries++ < 30) requestAnimationFrame(fill);
        else pending = null;
      };
      requestAnimationFrame(fill);
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("dblclick", onDbl, true); window.removeEventListener("keydown", onKey, true); };
  }, [api]);

  useEffect(() => {
    const onDrop = (e) => {
      const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith("video/"));
      if (!f) return;
      e.preventDefault(); e.stopPropagation();
      addVideo(f, e.clientX, e.clientY);
    };
    const onOver = (e) => { if ([...(e.dataTransfer?.items || [])].some(i => i.type.startsWith("video/"))) e.preventDefault(); };
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("dragover", onOver, true);
    return () => { window.removeEventListener("drop", onDrop, true); window.removeEventListener("dragover", onOver, true); };
  }, [addVideo]);

  // Attach a text note to the selected image/video: grouped with it, so it moves with it
  // and the AI-readable version says "this note is about that image".
  const attachNote = useCallback(() => {
    if (!api || !mediaSel) return;
    const all = api.getSceneElementsIncludingDeleted();
    const media = all.find(e => e.id === mediaSel);
    if (!media) return;
    const gid = media.groupIds?.[0] || "note-" + Math.random().toString(36).slice(2, 10);
    const [txt] = convertToExcalidrawElements([{
      type: "text", x: media.x, y: media.y + media.height + 10, text: "Note",
      fontSize: 16, fontFamily: FONT_FAMILY.Helvetica, strokeColor: "#1e1e1e",
    }]);
    txt.groupIds = [gid];
    if (media.frameId) txt.frameId = media.frameId;
    const updated = all.map(e => e.id === media.id && !e.groupIds?.includes(gid)
      ? { ...e, groupIds: [gid, ...(e.groupIds || [])], version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) } : e);
    api.updateScene({ elements: [...updated, txt], appState: { selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    // open the new note for typing (same as double-clicking it)
    requestAnimationFrame(() => {
      const st = api.getAppState();
      const { x, y } = sceneCoordsToViewportCoords({ sceneX: txt.x + 8, sceneY: txt.y + 8 }, st);
      const cnv = document.querySelector("canvas.interactive") || document.querySelector(".excalidraw canvas:last-of-type");
      cnv?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: x, clientY: y }));
      setTimeout(() => {
        const ta = document.querySelector(".excalidraw-wysiwyg");
        if (ta) { ta.select?.(); }
      }, 30);
    });
  }, [api, mediaSel]);

  // + button: add a connected box on that side, then start typing in it
  const addNext = useCallback((dir) => {
    if (!api || !plus) return;
    const all = api.getSceneElementsIncludingDeleted();
    const src = all.find(e => e.id === plus.id);
    if (!src) return;
    const GAP = 70, w = src.width, h = src.height;
    const live = all.filter(e => !e.isDeleted && e.type !== "frame" && e.type !== "arrow" && !(e.type === "text" && e.containerId));
    const hits = (x, y) => live.some(e => x < e.x + e.width && x + w > e.x && y < e.y + e.height && y + h > e.y);
    let nx = src.x, ny = src.y;
    if (dir === "right") nx = src.x + w + GAP;
    if (dir === "left") nx = src.x - w - GAP;
    if (dir === "down") ny = src.y + h + GAP;
    if (dir === "up") ny = src.y - h - GAP;
    for (let i = 0; i < 20 && hits(nx, ny); i++) {     // spot taken -> slide along until free
      if (dir === "right" || dir === "left") ny += h + 30; else nx += w + 30;
    }
    const [box] = convertToExcalidrawElements([{ type: "rectangle", x: nx, y: ny, width: w, height: h }]);
    Object.assign(box, { strokeColor: src.strokeColor,
      backgroundColor: src.backgroundColor === "transparent" ? "#ffffff" : src.backgroundColor, fillStyle: "solid",
      strokeWidth: src.strokeWidth, roughness: src.roughness, roundness: src.roundness, opacity: src.opacity });
    // straight connector between the facing edges
    const cx = (e) => e.x + e.width / 2, cy = (e) => e.y + e.height / 2;
    const tgt = { x: nx, y: ny, width: w, height: h };
    let sx, sy, ex, ey; const P = 6;
    if (Math.abs(nx - src.x) >= Math.abs(ny - src.y)) {
      const rightward = nx > src.x;
      sx = rightward ? src.x + w + P : src.x - P; ex = rightward ? nx - P : nx + w + P;
      sy = cy(src); ey = cy(tgt);
    } else {
      const downward = ny > src.y;
      sy = downward ? src.y + h + P : src.y - P; ey = downward ? ny - P : ny + h + P;
      sx = cx(src); ex = cx(tgt);
    }
    const [arrow] = convertToExcalidrawElements([{ type: "arrow", x: sx, y: sy }]);
    Object.assign(arrow, {
      points: [[0, 0], [ex - sx, ey - sy]], width: Math.abs(ex - sx), height: Math.abs(ey - sy),
      strokeColor: src.strokeColor || "#1e1e1e", strokeWidth: 1, roughness: 0, roundness: null, elbowed: false,
      startArrowhead: null, endArrowhead: "arrow",
      startBinding: { elementId: src.id, focus: 0, gap: P }, endBinding: { elementId: box.id, focus: 0, gap: P },
    });
    box.boundElements = [{ id: arrow.id, type: "arrow" }];
    const bump = (e, extra) => ({ ...e, ...extra, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() });
    let updated = all.map(e => e.id === src.id ? bump(e, { boundElements: [...(e.boundElements || []), { id: arrow.id, type: "arrow" }] }) : e);
    if (src.frameId) {
      box.frameId = arrow.frameId = src.frameId;
      // grow the frame so the new box isn't cut off
      updated = updated.map(f => {
        if (f.id !== src.frameId) return f;
        const pad = 40;
        const x1 = Math.min(f.x, nx - pad), y1 = Math.min(f.y, ny - pad);
        const x2 = Math.max(f.x + f.width, nx + w + pad), y2 = Math.max(f.y + f.height, ny + h + pad);
        return (x1 === f.x && y1 === f.y && x2 === f.x + f.width && y2 === f.y + f.height) ? f
          : bump(f, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
      });
    }
    api.updateScene({ elements: [...updated, arrow, box], appState: { selectedElementIds: { [box.id]: true } },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    // open the new box for typing
    requestAnimationFrame(() => {
      const st = api.getAppState();
      const { x, y } = sceneCoordsToViewportCoords({ sceneX: nx + w / 2, sceneY: ny + h / 2 }, st);
      const cnv = document.querySelector("canvas.interactive") || document.querySelector(".excalidraw canvas:last-of-type");
      cnv?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: x, clientY: y }));
    });
  }, [api, plus]);

  const pickVideo = () => {
    const i = document.createElement("input");
    i.type = "file"; i.accept = "video/*";
    i.onchange = () => i.files[0] && addVideo(i.files[0]);
    i.click();
  };

  const renderEmbeddable = useCallback((el) => {
    if (!el.link?.startsWith(MEDIA)) return null;   // YouTube etc. use the normal embed
    const src = "/media/" + el.link.slice(MEDIA.length);
    return <video src={src} controls playsInline preload="metadata"
      style={{ width: "100%", height: "100%", background: "#000", borderRadius: 8, display: "block" }} />;
  }, []);

  const validateEmbeddable = useCallback((link) => link.startsWith(MEDIA) || VIDEO_HOSTS.test(link), []);

  if (!initial) return null;
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Excalidraw
        key={mountKey}
        excalidrawAPI={(a) => { setApi(a); window.cv = a; }}
        initialData={initial}
        onChange={onChange}
        theme={dark() ? "dark" : "light"}
        name={card.title}
        renderEmbeddable={renderEmbeddable}
        validateEmbeddable={validateEmbeddable}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, clearCanvas: false, changeViewBackgroundColor: true, toggleTheme: null }, tools: { image: true } }}
        renderTopRightUI={() => (
          <div className="cv-top">
            {saving && <span className="cv-dot" title={saving} data-s={saving} />}
            {mediaSel && <button className="cv-btn cv-note" onClick={attachNote} title="Attach a note to this image/video">＋ Note</button>}
            <button className="cv-btn" onClick={() => api?.setActiveTool({ type: "frame" })} title="Frame (F)">▢ Frame</button>
            {agent && <button className={"cv-btn" + (chatOpen ? " on" : "")} onClick={() => toggleChat(!chatOpen)} title="Chat with the linked Claude session">
              <span className={"cv-adot " + agent.state} /> Claude</button>}
            <button className="cv-btn" onClick={pickVideo} title="Add a video file">▶︎ Video</button>
          </div>
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => (location.href = "/")}>← Back to board</MainMenu.Item>
          <MainMenu.Item onSelect={pickVideo}>Add video file</MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
      <a className="cv-back" href="/" title="Back to board">←</a>
      <div className="cv-title">{card.title}</div>
      <AgentPanel open={chatOpen} agent={agent} onClose={() => toggleChat(false)} refresh={loadAgent} />
      {plus && [["up", plus.l + plus.w / 2, plus.t - 22], ["down", plus.l + plus.w / 2, plus.t + plus.h + 22],
                ["left", plus.l - 22, plus.t + plus.h / 2], ["right", plus.l + plus.w + 22, plus.t + plus.h / 2]].map(([d, x, y]) => (
        <button key={d} className="cv-plus" style={{ left: x, top: y }} title="Add a connected box"
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); addNext(d); }}>+</button>
      ))}
    </div>
  );
}

// ---------- side panel: the Claude session linked to this card ----------
function AgentPanel({ open, onClose, agent, refresh }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useRef(null);
  const lastCount = useRef(0);
  useEffect(() => {
    const el = list.current; if (!el || !agent) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom || agent.messages.length !== lastCount.current) el.scrollTop = el.scrollHeight;
    lastCount.current = agent.messages.length;
  }, [agent, open]);
  if (!open || !agent) return null;
  const send = async (e) => {
    e?.preventDefault();
    const t = text.trim(); if (!t || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/agent/${encodeURIComponent(CARD)}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) alert(j.error || "Couldn't send"); else { setText(""); setTimeout(refresh, 800); }
    } finally { setBusy(false); }
  };
  const openInOrca = async () => {
    const r = await fetch(`/api/agent/${encodeURIComponent(CARD)}/open`, { method: "POST" });
    if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error || "Couldn't open it in Orca"); }
  };
  const label = agent.state === "waiting" ? "Waiting on you" : agent.state === "ended" ? "Session closed" : "Working…";
  return (
    <aside className="cv-chat">
      <div className="cv-chat-head">
        <span className={"cv-adot " + agent.state} />
        <div className="cv-chat-titles"><b>{label}</b><span>{agent.title}</span></div>
        {agent.state !== "ended" && <button className="cv-chat-btn hide-sm" onClick={openInOrca} title="Jump to this terminal in Orca">Open ↗</button>}
        <button className="cv-chat-btn" onClick={onClose} title="Close">✕</button>
      </div>
      <div className="cv-chat-msgs" ref={list}>
        {agent.messages.length ? agent.messages.map((m, i) => <div key={i} className={"cv-m md " + m.role} dangerouslySetInnerHTML={{ __html: renderMd(m.text) }} />)
          : <div className="cv-m empty">No messages yet</div>}
      </div>
      {agent.canSend && (
        <form className="cv-chat-send" onSubmit={send}>
          <textarea rows={2} value={text} placeholder="Message this Claude session" onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) send(e); }} />
          <button type="submit" disabled={busy || !text.trim()}>Send</button>
        </form>
      )}
    </aside>
  );
}

// Never lose anything: keep every element from both sides; same element edited on both -> newer edit wins.
// (Deletes in Excalidraw are soft: isDeleted=true with a higher version, so they still win correctly.)
function mergeElements(local, remote) {
  const out = new Map();
  for (const e of [...local, ...remote]) {
    const cur = out.get(e.id);
    if (!cur || e.version > cur.version || (e.version === cur.version && e.versionNonce < cur.versionNonce)) out.set(e.id, e);
  }
  return [...out.values()].sort((a, b) => (a.index || "") < (b.index || "") ? -1 : (a.index || "") > (b.index || "") ? 1 : 0);
}

function isVertical(file) {
  return new Promise(res => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => { res(v.videoHeight > v.videoWidth); URL.revokeObjectURL(v.src); };
    v.onerror = () => res(false);
    v.src = URL.createObjectURL(file);
  });
}

createRoot(document.getElementById("root")).render(<App />);
