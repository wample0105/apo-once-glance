// blur 框 DOM+computedStyle 验证（物理拖画链）
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const ROOT = resolve(import.meta.dirname, "../..");
const BED = "file:///" + resolve(ROOT, "tools/uitest/testbed.html").replace(/\\/g, "/");
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--window-size=1400,900", "--remote-debugging-port=9346",
  "--user-data-dir=" + resolve(ROOT, "tools/uitest/.p14"), "about:blank",
], { stdio: "ignore" });
await sleep(1800);
function c(ws) {
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
}
const list = await (await fetch("http://127.0.0.1:9346/json")).json();
const ws = new WebSocket(list.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const call = c(ws);
await call("Runtime.enable");
await call("Page.navigate", { url: BED });
await sleep(1200);
const evl = async (e) => (await call("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;

await evl(`(function(){
  setSel({ x: 100, y: 100, w: 600, h: 400 }); setState("selected");
  document.getElementById("toolbar").style.display = "flex";
  setTool("mosaic");
  document.querySelector('#pr-mos-mode button[data-mm="blur"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  const lay = document.getElementById("layer");
  lay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 200, clientY: 200, button: 0 }));
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 350, clientY: 300 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  return "painted:" + mosMode;
})()`);
const mid = await evl(`(function(){
  // 模拟"按下框内"（objmove 启动，无移动）
  const m = document.querySelector('#layer .obj[data-k="mosaic"]');
  const r = m.getBoundingClientRect();
  lay2 = m; window.__bgBefore = m.style.background.slice(0, 30);
  const lay = document.getElementById("layer");
  lay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, button: 0 }));
  window.__bgAfterDown = m.style.background.slice(0, 30);
  // 模拟移动 30px
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.left + r.width/2 + 30, clientY: r.top + r.height/2 }));
  window.__bgAfterMove = m.style.background.slice(0, 30);
  window.__dragType = objDrag ? objDrag.type : "null";
  return { before: window.__bgBefore, afterDown: window.__bgAfterDown, afterMove: window.__bgAfterMove, dragType: window.__dragType };
})()`);
console.log("按下/移动:", JSON.stringify(mid));
const st = await evl(`(function(){
  const m = document.querySelector('#layer .obj[data-k="mosaic"]');
  if (!m) return { found: false };
  const cs = getComputedStyle(m);
  return { found: true, mode: JSON.parse(m.dataset.params).mode,
    styleFilter: m.style.filter, styleBgImg: (m.style.backgroundImage || "").slice(0, 30),
    styleBgPos: m.style.backgroundPosition, styleBgSize: m.style.backgroundSize,
    csFilter: cs.filter, csBgImg: cs.backgroundImage.slice(0, 30), w: m.style.width };
})()`);
console.log(JSON.stringify(st, null, 1));
chrome.kill();
