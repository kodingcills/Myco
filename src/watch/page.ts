/**
 * Live watch view: the page. Static HTML, CSS and JS, served from `/`, `/watch.css` and
 * `/watch.js` under a strict CSP (no inline script or style, no external origin).
 *
 * The script builds every node with `textContent` and `setAttribute`, never `innerHTML`, so
 * a value in the stream cannot become markup. It only ever issues GETs to its own origin:
 * `/api/events` (SSE), `/api/state` (polling fallback) and `/frames/<run>/<n>`.
 */

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Myco watch</title>
<link rel="stylesheet" href="/watch.css">
</head>
<body>
<header>
  <h1>Myco watch</h1>
  <span id="mode" class="pill">read-only</span>
  <span id="conn" class="pill">connecting</span>
</header>
<main>
  <section id="desk" aria-label="Agent desktop">
    <div class="bar">
      <label>Run <select id="run"></select></label>
      <label class="follow"><input id="follow" type="checkbox" checked> follow latest</label>
      <span id="frameinfo"></span>
    </div>
    <div id="screen"><img id="frame" alt="agent desktop frame"><p id="noframe">No frames yet.</p></div>
    <input id="scrub" type="range" min="0" max="0" value="0" aria-label="frame">
  </section>
  <section id="timeline" aria-label="Gate timeline">
    <h2>Gate decisions</h2>
    <p id="summary"></p>
    <ol id="events"></ol>
  </section>
</main>
<script src="/watch.js"></script>
</body>
</html>
`;

export const PAGE_CSS = `:root{--bg:#0f1115;--panel:#181b22;--fg:#e6e8ee;--muted:#9aa3b2;--ok:#3fb950;--bad:#f85149;--unk:#d29922;--line:#2a2f3a}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--panel:#fff;--fg:#1d2330;--muted:#5b6475;--line:#dde1e8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{display:flex;gap:10px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line)}
h1{font-size:17px;margin:0 8px 0 0}h2{font-size:15px;margin:0 0 6px}
.pill{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
main{display:grid;grid-template-columns:minmax(0,3fr) minmax(280px,2fr);gap:16px;padding:16px}
@media (max-width:860px){main{grid-template-columns:1fr}}
section{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;min-width:0}
.bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:8px;color:var(--muted)}
select{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:2px 4px}
#screen{background:#000;border-radius:6px;min-height:200px;display:flex;align-items:center;justify-content:center;overflow:hidden}
#frame{max-width:100%;height:auto;display:none}#noframe{color:#888}
#scrub{width:100%;margin-top:8px}
#events{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;max-height:70vh;overflow:auto}
.ev{border:1px solid var(--line);border-left:4px solid var(--unk);border-radius:6px;padding:8px}
.ev.verified{border-left-color:var(--ok)}.ev.refuted{border-left-color:var(--bad)}
.ev .top{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.verdict{font-weight:600;text-transform:uppercase;font-size:12px}
.verified .verdict{color:var(--ok)}.refuted .verdict{color:var(--bad)}.uncertain .verdict{color:var(--unk)}
.meta{color:var(--muted);font-size:12px}.codes{margin-top:4px;display:flex;flex-wrap:wrap;gap:4px}
.code{font:12px ui-monospace,monospace;padding:1px 6px;border-radius:4px;background:var(--bg);border:1px solid var(--line)}
.cps{display:flex;gap:3px;margin-top:6px;align-items:center}.cp{width:22px;height:18px;border-radius:3px;font-size:11px;display:flex;align-items:center;justify-content:center;color:#fff}
.cp.verified{background:var(--ok)}.cp.refuted{background:var(--bad)}
.retry{color:var(--unk);font-size:12px;font-weight:600}
`;

export const PAGE_JS = `"use strict";
(function () {
  var state = { runs: [], events: [], skipped: 0, logPresent: false };
  var selected = null;
  var index = 0;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = String(text);
    return n;
  }
  function runInfo() {
    for (var i = 0; i < state.runs.length; i++) if (state.runs[i].runId === selected) return state.runs[i];
    return null;
  }
  function renderRuns() {
    var sel = $("run");
    var ids = state.runs.map(function (r) { return r.runId; });
    if (selected === null || ids.indexOf(selected) < 0) selected = ids.length ? ids[0] : null;
    if (sel.options.length !== ids.length || ids.some(function (id, i) { return sel.options[i].value !== id; })) {
      while (sel.firstChild) sel.removeChild(sel.firstChild);
      ids.forEach(function (id) { var o = el("option", "", id); o.value = id; sel.appendChild(o); });
    }
    if (selected !== null) sel.value = selected;
  }
  function renderFrame() {
    var info = runInfo();
    var count = info ? info.frames : 0;
    var scrub = $("scrub");
    scrub.max = String(Math.max(0, count - 1));
    if ($("follow").checked) index = Math.max(0, count - 1);
    if (index > count - 1) index = Math.max(0, count - 1);
    scrub.value = String(index);
    var img = $("frame");
    if (count === 0) {
      img.style.display = "none"; $("noframe").style.display = "block";
      $("frameinfo").textContent = "";
      return;
    }
    var src = "/frames/" + encodeURIComponent(selected) + "/" + index;
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    img.style.display = "block"; $("noframe").style.display = "none";
    $("frameinfo").textContent = "frame " + (index + 1) + " / " + count;
  }
  function renderEvents() {
    var list = $("events");
    while (list.firstChild) list.removeChild(list.firstChild);
    var shown = state.events.filter(function (e) { return selected === null || e.runId === selected; });
    shown.slice().reverse().forEach(function (e) {
      var li = el("li", "ev " + e.verdict);
      var top = el("div", "top");
      top.appendChild(el("span", "verdict", e.verdict));
      top.appendChild(el("span", "", e.accepted ? "accepted" : "not accepted"));
      top.appendChild(el("span", "meta", "#" + e.seq + " · call " + e.call));
      if (e.retry) top.appendChild(el("span", "retry", "retry"));
      li.appendChild(top);
      var meta = [e.runId];
      if (e.taskId) meta.push("task " + e.taskId);
      if (e.checkedAt) meta.push(e.checkedAt);
      li.appendChild(el("div", "meta", meta.join(" · ")));
      var codes = el("div", "codes");
      e.reasonCodes.forEach(function (c) { codes.appendChild(el("span", "code", c)); });
      li.appendChild(codes);
      if (e.checkpoints) {
        var cps = el("div", "cps");
        cps.appendChild(el("span", "meta", "checkpoints"));
        e.checkpoints.verdicts.forEach(function (cp) {
          var box = el("span", "cp " + cp.verdict, cp.checkpoint);
          box.setAttribute("title", "checkpoint " + cp.checkpoint + ": " + cp.verdict);
          cps.appendChild(box);
        });
        cps.appendChild(el("span", "meta", "last verified " + e.checkpoints.lastVerified + "/" + e.checkpoints.total));
        li.appendChild(cps);
      }
      list.appendChild(li);
    });
    var acc = shown.filter(function (e) { return e.accepted; }).length;
    $("summary").textContent = state.logPresent
      ? shown.length + " decision(s) for this run, " + acc + " accepted" + (state.skipped ? " · " + state.skipped + " other line(s) not shown" : "")
      : "Waiting for the decision log…";
  }
  function render() { renderRuns(); renderFrame(); renderEvents(); }
  function apply(text) {
    try { state = JSON.parse(text); render(); } catch (err) { /* ignore a bad message */ }
  }
  $("run").addEventListener("change", function () { selected = $("run").value; index = 0; render(); });
  $("scrub").addEventListener("input", function () { $("follow").checked = false; index = Number($("scrub").value) || 0; renderFrame(); });
  $("follow").addEventListener("change", renderFrame);
  function poll() {
    fetch("/api/state", { method: "GET", credentials: "omit" })
      .then(function (r) { return r.text(); })
      .then(function (t) { $("conn").textContent = "polling"; apply(t); })
      .catch(function () { $("conn").textContent = "offline"; })
      .finally(function () { setTimeout(poll, 1000); });
  }
  if (typeof EventSource === "function") {
    var es = new EventSource("/api/events");
    es.addEventListener("state", function (m) { $("conn").textContent = "live"; apply(m.data); });
    es.onerror = function () { $("conn").textContent = "reconnecting"; };
  } else {
    poll();
  }
})();
`;
