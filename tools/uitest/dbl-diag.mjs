// 诊断版：状态 + Enter 派发 + invoke 计数
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "../..");
const BED = "file:///" + resolve(ROOT, "tools/uitest/testbed.html").replace(/\\/g, "/");

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--window-size=1400,900", "--remote-debugging-port=9336",
  "--user-data-dir=" + resolve(ROOT, "tools/uitest/.prof4"), "about:blank",
], { stdio: "ignore" });
await sleep(1800);

function c(ws) {
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
}

const list = await (await fetch("http://127.0.0.1:9336/json")).json();
const ws = new WebSocket(list.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const call = c(ws);
await call("Runtime.enable");
await call("Page.navigate", { url: BED });
await sleep(1200);
const evl = async (expr) => await call("Runtime.evaluate", { expression: expr, returnByValue: true });

const d = await evl(`(function(){ return { setState: typeof setState, output: typeof output, stateNow: (typeof state !== "undefined") ? state : "n/a" }; })()`);
console.log("诊断:", JSON.stringify(d.result.result.value), d.exceptionDetails ? "EX:" + d.exceptionDetails.exception?.description : "");

const r2 = await evl(`(function(){
  window.__calls = [];
  const raw = window.__TAURI__.core.invoke;
  window.__TAURI__.core.invoke = async (cmd, args) => { window.__calls.push(cmd); return raw(cmd, args); };
  setSel({ x: 10, y: 10, w: 100, h: 80 });
  setState("selected");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  return "sent,state=" + state;
})()`);
console.log(r2.result.result.value, r2.exceptionDetails ? "EX:" + r2.exceptionDetails.exception?.description : "");
await sleep(900);
const r3 = await evl(`JSON.stringify(window.__calls)`);
console.log("calls:", r3.result.result.value, r3.exceptionDetails ? "EX:" + r3.exceptionDetails.exception?.description : "");
chrome.kill();
