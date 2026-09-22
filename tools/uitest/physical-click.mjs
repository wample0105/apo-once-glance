// 关键实验：testbed 上用 CDP Input.dispatchMouseEvent（真实 mousedown/focusout/click 链）点背景块
// 对比：程序化 .click()（T21b 通过）vs 物理事件序列（真机不弹）
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "../..");
const BED = "file:///" + resolve(ROOT, "tools/uitest/testbed.html").replace(/\\/g, "/");

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--window-size=1400,900", "--remote-debugging-port=9333",
  "--user-data-dir=" + resolve(ROOT, "tools/uitest/.prof"), "about:blank",
], { stdio: "ignore" });
await sleep(1800);

function c(ws) {
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
}

const list = await (await fetch("http://127.0.0.1:9333/json")).json();
const page = list.find((p) => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const call = c(ws);
await call("Runtime.enable");
await call("Page.navigate", { url: BED });
await sleep(1200);

const evl = async (expr) => (await call("Runtime.evaluate", { expression: expr, returnByValue: true })).result.result.value;

// 进入文字编辑态（复现真机：编辑框聚焦，点击工具栏触发 focusout 链）
await evl(`(function(){ setTool("text"); window.__errs = []; window.onerror = (m) => { window.__errs.push(String(m)); };
  setSel({ x: 100, y: 100, w: 600, h: 300 }); positionToolbar(); document.getElementById("toolbar").style.display = "flex";
  return document.getElementById("pr-tbgchip") ? "chip-ok" : "chip-missing"; })()`);

// 获取 tbgchip 视口坐标
const rect = await evl(`(function(){ const r = document.getElementById("pr-tbgchip").getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()`);
console.log("tbgchip 视口坐标:", rect);

// 建编辑框（模拟正在输入）
await evl(`(function(){ const lay = document.getElementById("layer"); const t = document.createElement("div"); t.className = "txtedit"; t.contentEditable = "true"; t.textContent = "BG"; lay.appendChild(t); t.focus(); return "editing"; })()`);

// 物理事件序列：mousedown → mouseup → click（走完整 focusout 链）
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: rect[0], y: rect[1], button: "left", clickCount: 1 });
await sleep(80);
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect[0], y: rect[1], button: "left", clickCount: 1 });
await sleep(300);

const st = await evl(`(function(){ const m = document.getElementById("pr-tbg-menu"); return { found: !!m, count: document.querySelectorAll("#pr-tbg-menu").length, display: m ? m.style.display : null, errs: window.__errs }; })()`);
console.log("物理点击后浮层状态:", JSON.stringify(st));

// 程序化对照
await evl(`document.getElementById("pr-tbgchip").click(); "click"`);
const st2 = await evl(`(function(){ const m = document.getElementById("pr-tbg-menu"); return { display: m ? m.style.display : null, errs: window.__errs }; })()`);
console.log("程序化 click 后浮层状态:", JSON.stringify(st2));
chrome.kill();
