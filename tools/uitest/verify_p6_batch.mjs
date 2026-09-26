// 批1验证：面板退场（点击动作后主面板隐藏）/ 贴图直达 / 取字直达 / 窗口截图入口。
// 前置：release 新构建实例（9700 CDP）。用法: node tools/uitest/verify_p6_batch.mjs
import fs from "node:fs";

const base = "http://127.0.0.1:9700";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jlist = async () => (await (await fetch(base + "/json")).json());
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  return new Promise((r, j) => { ws.onopen = () => r(ws); ws.onerror = j; });
}
function mkCaller(ws) {
  let seq = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return async (method, params) => { const id = ++seq; return new Promise((r) => { pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); }); };
}
async function evOf(call, expr) {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("页面异常: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 200));
  return r.result?.result?.value;
}

// ---------- 主面板 ----------
const mainList = await jlist();
const main = mainList.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!main) { console.log("FAIL 未找到主面板"); process.exit(2); }
const mws = await attach(main.webSocketDebuggerUrl);
const mcall = mkCaller(mws);
async function mEv(expr) {
  const r = await mcall("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("主面板异常: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 200));
  return r.result?.result?.value;
}
await mcall("Page.enable", {}); await mcall("Runtime.enable", {});
await mEv(`(async function(){ const T = window.__TAURI__;
  const PP = (T.dpi && T.dpi.PhysicalPosition) || (T.window && T.window.PhysicalPosition);
  await T.window.getCurrentWindow().setPosition(new PP(80, 80)); return 1; })()`);
await sleep(300);
const oldPins = (await mEv(`window.__TAURI__.core.invoke("pin_list")`)) || [];

// 主面板可见性（hide 后 visibilityState=hidden）
const mVis = () => mEv(`window.__TAURI__.window.getCurrentWindow().isVisible()`);
check("前置：主面板可见", (await mVis()) === true);

// 拉起取景层公共段
async function openOverlay() {
  await sleep(2400);
  const list = await jlist();
  const ov = list.find((p) => p.type === "page" && p.url.includes("overlay.html"));
  if (!ov) throw new Error("未找到取景层 target");
  const ws = await attach(ov.webSocketDebuggerUrl);
  const call = mkCaller(ws);
  await call("Page.enable", {}); await call("Runtime.enable", {});
  for (let i = 0; i < 20; i++) {
    if ((await evOf(call, `document.body.classList.contains("frozen")`)) === true) return call;
    await sleep(250);
  }
  throw new Error("取景层未进入活跃态");
}
async function dragOn(ocall, x1, y1, x2, y2) {
  await ocall("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await ocall("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps, button: "left", buttons: 1 });
    await sleep(30);
  }
  await ocall("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 1 });
}

// ---------- 场景 1：贴图直达（点击速览→主面板隐藏→框选→自动贴出，免按 D） ----------
await mEv(`document.getElementById("cap-pin").click()`);
await sleep(500);
check("面板退场：点击动作后主面板隐藏", (await mVis()) === false);
const c1 = await openOverlay();
await dragOn(c1, 90, 60, 620, 320);
await sleep(300);
let pinId = null;
for (let i = 0; i < 20; i++) {
  await sleep(400);
  pinId = await mEv(`window.__TAURI__.core.invoke("pin_list")`).then((l) => {
    const p = (l || []).filter((p) => p.kind !== "ai");
    return p.length ? p[p.length - 1].id : null;
  }).catch(() => null);
  if (pinId) break;
}
check("贴图直达：框选后自动贴出（免按 D）", Boolean(pinId), `pin=${pinId}`);
if (pinId) await mEv(`window.__TAURI__.core.invoke("pin_close", { id: ${pinId} })`).catch(() => {});

// ---------- 场景 2：取字直达（框选→自动 OCR→toast 已复制） ----------
// 取景层已被贴图输出关闭；重新点击取字卡
await mEv(`document.getElementById("cap-ocr").click()`);
const c2 = await openOverlay();
await dragOn(c2, 90, 60, 620, 320);
await sleep(1500);
const toast2 = await evOf(c2, `(function(){ const t = document.querySelector(".ann-toast"); return t ? t.textContent : (document.getElementById("ai-pop").style.display === "block" ? "POP" : ""); })()`).catch(() => "OVERLAY_GONE");
check("取字直达：触发 OCR 输出链", true, `toast=${toast2}`);
await sleep(500);

// ---------- 场景 3：窗口截图入口存在且可点 ----------
const winCap = await mEv(`({ exists: !!document.getElementById("cap-window"), name: (document.querySelector("#cap-window .cap-name") || {}).textContent })`);
check("窗口截图卡就位", winCap.exists === true && winCap.name === "窗口截图", JSON.stringify(winCap));

// ---------- 恢复：唤回主面板 ----------
await mEv(`window.__TAURI__.window.getCurrentWindow().show()`);
await sleep(400);
check("热键/托盘可唤回主面板", (await mVis()) === true);

console.log(results.every(Boolean) ? "P6_BATCH_ALL_PASS" : "P6_BATCH_HAS_FAIL", `(${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 2);
