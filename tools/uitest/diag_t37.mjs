// T37 诊断：rect 激活下 单击文字→mouseup→dblclick 每步状态（定位回落引起的编辑入口失效）
import path from "node:path";
import { spawn } from "node:child_process";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9446;
const BED = "file:///" + path.resolve("tools/uitest/testbed.html").replace(/\\/g, "/");
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TEMP}/tb-diag`, "--no-first-run", "--headless=new", BED], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const base = `http://127.0.0.1:${PORT}`;
let list = [];
for (let i = 0; i < 10; i++) { try { list = await (await fetch(base + "/json")).json(); if (list.length) break; } catch (e) {} await new Promise((r) => setTimeout(r, 500)); }
const page = list.find((p) => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const call = async (method, params) => { const id = ++seq; return new Promise((r) => { pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); }); };
const ev = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return "EXC:" + (r.result.exceptionDetails.exception?.description || "").slice(0, 200);
  return r.result?.result?.value;
};
await call("Runtime.enable", {});
// testbed 前置：进入 selected 态（与 run.mjs 相同的初始化，最小化复刻）
await ev(`(function(){ try { activate({ url: "data:image/png;base64,iVBORw0KGgo=", width: 800, height: 600 }); } catch (e) {} return 1; })()`);
await new Promise((r) => setTimeout(r, 600));
await ev(`(function(){ setSel({ x: 50, y: 50, w: 400, h: 300 }); setState("selected"); setTool("rect"); return 1; })()`);
// 放一个文字对象
await ev(`(function(){
  document.querySelectorAll("#layer .obj").forEach(e => e.remove()); setObjSel(null);
  const el = document.createElement("div");
  el.className = "obj"; el.dataset.k = "text"; el.dataset.text = "T";
  el.dataset.params = JSON.stringify({ family:"default", size:20, color:"#FF3B30", bold:false, italic:false, underline:false, shadow:false, stroke:false, align:"left", line_height:1.0, background:null, bg_opacity:null, bg_radius:null });
  el.style.cssText = "position:absolute;left:150px;top:120px;font-size:20px;color:#FF3B30;";
  el.textContent = "T";
  layer.appendChild(el);
  return 1;
})()`);
const steps = [];
const snap = async (tag) => {
  const st = await ev("(function(){ return { tool: tool, editing: !!editing, draft: !!draft, objDrag: !!objDrag, sel: !!selectedObj, state: state }; })()");
  steps.push({ tag, st });
};
// 单击文字（分发器接管路径：mousedown on el → body mouseup）
const pos = await ev(`(function(){ const el = document.querySelector('#layer .obj[data-k=text]'); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(pos.x), y: Math.round(pos.y), button: "left", buttons: 1, clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(pos.x), y: Math.round(pos.y), button: "left", clickCount: 1 });
await snap("after-click");
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(pos.x), y: Math.round(pos.y), button: "left", buttons: 1, clickCount: 2 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(pos.x), y: Math.round(pos.y), button: "left", clickCount: 2 });
await snap("after-dblclick");
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(pos.x), y: Math.round(pos.y), button: "left", buttons: 1, clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(pos.x), y: Math.round(pos.y), button: "left", clickCount: 1 });
await ev(`el && 0`);
const final = await ev(`(function(){ const el = document.querySelector('#layer .obj[data-k=text]'); return { editing: !!editing, tool, rects: [...document.querySelectorAll('#layer .obj')].filter(o => o.dataset.k === 'rect').length, sel: !!selectedObj }; })()`);
console.log(JSON.stringify({ steps, final }, null, 1));
chrome.kill();
process.exit(0);
