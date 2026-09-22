// 物理鼠标链复现：开面板 → Input.dispatchMouseEvent 点黑块 → 查 chip 状态（真机"点黑块 chip 不变"复现）
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const ROOT = resolve(import.meta.dirname, "../..");
const BED = "file:///" + resolve(ROOT, "tools/uitest/testbed.html").replace(/\\/g, "/");
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--window-size=1400,900", "--remote-debugging-port=9345",
  "--user-data-dir=" + resolve(ROOT, "tools/uitest/.p13"), "about:blank",
], { stdio: "ignore" });
await sleep(1800);
function c(ws) {
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
}
const list = await (await fetch("http://127.0.0.1:9345/json")).json();
const ws = new WebSocket(list.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const call = c(ws);
await call("Runtime.enable");
await call("Page.navigate", { url: BED });
await sleep(1200);
const evl = async (e) => (await call("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;

await evl(`(function(){
  window.__errs = []; window.onerror = (m) => window.__errs.push(String(m));
  setSel({ x: 100, y: 100, w: 600, h: 400 }); setState("selected");
  document.getElementById("toolbar").style.display = "flex";
  setTool("text");
  document.getElementById("pr-tbgchip").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  return "panel-open";
})()`);

const pos = await evl(`(function(){
  const b = [...document.querySelectorAll("#pr-text-menu .sw[data-c]")].find(s => s.dataset.c === "#000000");
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2];
})()`);
console.log("黑块视口坐标:", pos);
if (!pos) process.exit(1);

await call("Input.dispatchMouseEvent", { type: "mousePressed", x: pos[0], y: pos[1], button: "left", clickCount: 1 });
await sleep(60);
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos[0], y: pos[1], button: "left", clickCount: 1 });
await sleep(300);

const st = await evl(`(function(){
  const ch = document.getElementById("pr-tbgchip");
  const b = [...document.querySelectorAll("#pr-text-menu .sw[data-c]")].find(s => s.dataset.c === "#000000");
  return { textBackground, textBgColor, chipNone: ch.classList.contains("none"), chipBg: ch.style.background, blackOn: b.classList.contains("on"), errs: window.__errs };
})()`);
console.log("物理点击后:", JSON.stringify(st));
chrome.kill();
