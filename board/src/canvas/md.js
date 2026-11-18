// Small, safe markdown -> HTML for chat bubbles. Everything is escaped first; only http(s) links allowed.
function esc(s) { return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/__(.+?)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|\W)_(?!\s)(.+?)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}
export function renderMd(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  let html = "", para = [], list = null, i = 0;
  const flushP = () => { if (para.length) { html += `<p>${para.map(inline).join("<br>")}</p>`; para = []; } };
  const flushL = () => { if (list) { html += `<${list.t}>${list.items.map(x => `<li>${inline(x)}</li>`).join("")}</${list.t}>`; list = null; } };
  while (i < lines.length) {
    const ln = lines[i];
    if (/^\s*```/.test(ln)) {
      flushP(); flushL();
      const body = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      html += `<pre><code>${esc(body.join("\n"))}</code></pre>`; i++; continue;
    }
    let m;
    if ((m = ln.match(/^\s*(#{1,4})\s+(.*)$/))) { flushP(); flushL(); html += `<h${Math.min(m[1].length + 2, 6)}>${inline(m[2])}</h${Math.min(m[1].length + 2, 6)}>`; }
    else if ((m = ln.match(/^\s*[-*•]\s+(.*)$/))) { flushP(); if (!list || list.t !== "ul") { flushL(); list = { t: "ul", items: [] }; } list.items.push(m[1]); }
    else if ((m = ln.match(/^\s*\d+[.)]\s+(.*)$/))) { flushP(); if (!list || list.t !== "ol") { flushL(); list = { t: "ol", items: [] }; } list.items.push(m[1]); }
    else if ((m = ln.match(/^\s*>\s?(.*)$/))) { flushP(); flushL(); html += `<blockquote>${inline(m[1])}</blockquote>`; }
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln)) { flushP(); flushL(); html += "<hr>"; }
    else if (!ln.trim()) { flushP(); flushL(); }
    else { flushL(); para.push(ln); }
    i++;
  }
  flushP(); flushL();
  return html;
}
