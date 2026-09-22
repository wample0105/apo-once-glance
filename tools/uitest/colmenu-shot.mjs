// 颜色浮层布局截图（无头渲染，与真机同渲染引擎的布局层）
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const ROOT = resolve(import.meta.dirname, "../..");
const BED = "file:///" + resolve(ROOT, "tools/uitest/testbed.html").replace(/\\/g, "/");
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--window-size=1400,900", "--remote-debugging-port=9347",
  "--user-data-dir=" + resolve(ROOT, "tools/uitest/.p15"), "about:blank",
], { stdio: "ignore" });
await sleep(1800);
function c(ws) {
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
}
const list = await (await fetch("http://127.0.0.1:9347/json")).json();
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
  setTool("text");
  document.getElementById("pr-chip").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  return "open";
})()`);
await sleep(300);
const shot = await call("Page.captureScreenshot", { format: "png" });
const fs = { writeFileSync: (await import("node:fs")).writeFileSync };
fs.writeFileSync(resolve(ROOT, "tools/out/colmenu_headless.png"), Buffer.from(shot.result.data, "base64"));
console.log("saved");
// 对齐断言：lbl 右缘一致性（颜色/HEX/描边三行的 lbl 宽度）
const align = await evl(`(function(){
  const rows = document.querySelectorAll("#pr-color-menu .row");
  return { rows: rows.length, lblW: [...rows].map(r => { const l = r.querySelector(".lbl"); return l ? Math.round(l.getBoundingClientRect().width) : null; }) };
})()`);
console.log("lbl 宽度:", JSON.stringify(align));
chrome.kill();
