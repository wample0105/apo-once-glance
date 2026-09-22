// 马赛克工具功能链路验证（切工具/拖画/属性按钮）
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const ROOT = resolve(import.meta.dirname, "../..");
const BED = "file:///" + resolve(ROOT, "tools/uitest/testbed.html").replace(/\\/g, "/");
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--window-size=1400,900", "--remote-debugging-port=9338",
  "--user-data-dir=" + resolve(ROOT, "tools/uitest/.p6"), "about:blank",
], { stdio: "ignore" });
await sleep(1800);
function c(ws) {
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
}
const list = await (await fetch("http://127.0.0.1:9338/json")).json();
const ws = new WebSocket(list.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const call = c(ws);
await call("Runtime.enable");
await call("Page.navigate", { url: BED });
await sleep(1200);
const evl = async (expr) => (await call("Runtime.evaluate", { expression: expr, returnByValue: true })).result.result.value;

const r1 = await evl(`(function(){
  window.__errs = []; window.onerror = (m)=>window.__errs.push(String(m));
  setSel({ x: 100, y: 100, w: 600, h: 400 }); setState("selected");
  document.getElementById("toolbar").style.display = "flex";
  setTool("mosaic");
  return { tool, pointer: document.getElementById("layer").style.pointerEvents };
})()`);
console.log("切工具:", JSON.stringify(r1));
await evl(`(function(){
  const lay = document.getElementById("layer");
  const fire = (t, x, y) => lay.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  fire("mousedown", 200, 200); fire("mousemove", 350, 300); fire("mousemove", 400, 320); fire("mouseup", 400, 320);
  return "painted";
})()`);
await sleep(400);
const r2 = await evl(`(function(){
  return { objs: document.querySelectorAll('#layer .obj').length, kinds: [...document.querySelectorAll('#layer .obj')].map(e=>e.dataset.k), errs: window.__errs };
})()`);
console.log("画后:", JSON.stringify(r2));
const r3 = await evl(`(function(){
  const blurBtn = document.querySelector('#pr-mos-mode button[data-mm="blur"]');
  if (blurBtn) blurBtn.click();
  const heavyBtn = document.querySelector('#pr-mos-strong button[data-m="20"]');
  if (heavyBtn) heavyBtn.click();
  const modes = [...document.querySelectorAll('#pr-mos-mode button')].map(b => b.classList.contains("on") ? b.dataset.mm : null).filter(Boolean);
  const strengths = [...document.querySelectorAll('#pr-mos-strong button')].map(b => b.classList.contains("on") ? b.dataset.m : null).filter(Boolean);
  return { activeMode: modes, activeStrength: strengths };
})()`);
console.log("属性按钮点击后激活态:", JSON.stringify(r3));
chrome.kill();
