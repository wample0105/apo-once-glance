// 诊断 layer.mosaic 守卫条件 + draft 创建
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const ROOT = resolve(import.meta.dirname, "../..");
const BED = "file:///" + resolve(ROOT, "tools/uitest/testbed.html").replace(/\\/g, "/");
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--remote-debugging-port=9340",
  "--user-data-dir=" + resolve(ROOT, "tools/uitest/.p8"), "about:blank",
], { stdio: "ignore" });
await sleep(1800);
function c(ws) {
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
}
const list = await (await fetch("http://127.0.0.1:9340/json")).json();
const ws = new WebSocket(list.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const call = c(ws);
await call("Runtime.enable");
await call("Page.navigate", { url: BED });
await sleep(1200);
const evl = async (e) => (await call("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
console.log("守卫:", await evl(`(function(){
  setSel({x:100,y:100,w:600,h:400}); setState("selected");
  document.getElementById("toolbar").style.display="flex";
  setTool("mosaic");
  return { tool, editing: editing ? "YES" : "null", objDrag: objDrag ? "YES" : "null", layerPE: document.getElementById("layer").style.pointerEvents };
})()`));
console.log("派发后:", await evl(`(function(){
  const lay = document.getElementById("layer");
  lay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 200, clientY: 200, button: 0 }));
  return { draftCreated: draft ? draft.k : null, objs: document.querySelectorAll("#layer .obj").length };
})()`));
console.log("对比 rect:", await evl(`(function(){
  draft = null; document.querySelectorAll("#layer .obj").forEach(e=>e.remove());
  setTool("rect");
  const lay = document.getElementById("layer");
  lay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 200, clientY: 200, button: 0 }));
  return { draftCreated: draft ? draft.k : null, objs: document.querySelectorAll("#layer .obj").length };
})()`));
chrome.kill();
