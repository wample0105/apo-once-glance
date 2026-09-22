// 复现双输出：testbed 上模拟框选后按一次 Enter，数 freeze_deliver/annotate_save 调用次数
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "../..");
const BED = "file:///" + resolve(ROOT, "tools/uitest/testbed.html").replace(/\\/g, "/");

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--window-size=1400,900", "--remote-debugging-port=9334",
  "--user-data-dir=" + resolve(ROOT, "tools/uitest/.prof2"), "about:blank",
], { stdio: "ignore" });
await sleep(1800);

function c(ws) {
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
}

const list = await (await fetch("http://127.0.0.1:9334/json")).json();
const ws = new WebSocket(list.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const call = c(ws);
await call("Runtime.enable");
await call("Page.navigate", { url: BED });
await sleep(1200);
const evl = async (expr) => (await call("Runtime.evaluate", { expression: expr, returnByValue: true })).result.result.value;

// 计数 mock：包一层原始 invoke
await evl(`(function(){
  window.__calls = [];
  const raw = window.__TAURI__.core.invoke;
  window.__TAURI__.core.invoke = async (cmd, args) => { window.__calls.push(cmd); return raw(cmd, args); };
  // freeze_take_region mock（output 首步）
  return "mocked";
})()`);

// 模拟框选完成态 + 按 Enter（真实 KeyboardEvent）
await evl(`(function(){ setSel({ x: 100, y: 100, w: 300, h: 200 }); setState("selected"); return state; })()`);
await evl(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); "enter"`);
await sleep(800);
const calls1 = await evl(`JSON.stringify(window.__calls)`);
console.log("按一次 Enter 后 invoke 序列:", calls1);

// 再按一次（overlay 未真关，state 可能已 idle）
await evl(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); "enter2"`);
await sleep(500);
console.log("第二次 Enter 后:", await evl(`JSON.stringify(window.__calls)`));
chrome.kill();
