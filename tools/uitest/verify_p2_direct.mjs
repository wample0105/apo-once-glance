// 首页 AI 卡一步直达真机验证：点击速览卡 → 取景层带 ai_action → 松手自动执行。
// 场景：翻译直达（真 Key 全链路）/ 问图直达（浮层弹出）/ 取消后动作作废（不污染热键路径）。
// start_overlay 是 toggle 语义：脚本先用 frozen class 探测活跃态、确保关闭后再发起单次调用。
// 前置：release 新构建实例（9700 CDP）+ 智谱 Key。用法: node tools/uitest/verify_p2_direct.mjs
import fs from "node:fs";

const base = "http://127.0.0.1:9700";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jlist = async () => (await (await fetch(base + "/json")).json());
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
async function shotOf(call, name) {
  const r = await call("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync("tools/out", { recursive: true });
  fs.writeFileSync(`tools/out/${name}.png`, Buffer.from(r.result.data, "base64"));
}
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
  if (r.result?.exceptionDetails) throw new Error("页面异常: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 300));
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
  if (r.result?.exceptionDetails) throw new Error("主面板异常: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 300));
  return r.result?.result?.value;
}
await mcall("Page.enable", {}); await mcall("Runtime.enable", {});
await mEv(`(async function(){ const T = window.__TAURI__;
  const PP = (T.dpi && T.dpi.PhysicalPosition) || (T.window && T.window.PhysicalPosition);
  await T.window.getCurrentWindow().setPosition(new PP(80, 80)); return 1; })()`);
await sleep(300);
const oldPins = (await mEv(`window.__TAURI__.core.invoke("pin_list")`)) || [];
for (const p of oldPins.filter((p) => p.kind === "ai")) {
  await mEv(`window.__TAURI__.core.invoke("pin_close", { id: ${p.id} })`).catch(() => {});
}
const trBase = ((await mEv(`window.__TAURI__.core.invoke("read_audit", { limit: 60 })`)) || []).filter((a) => a.command === "ai.translate").length;

// ---------- overlay 状态确定性工具 ----------
// 探测活跃态（frozen class），开着就 toggle 关——保证后续单次调用必然是"打开"
async function ensureClosed() {
  const list = await jlist();
  const ov = list.find((p) => p.type === "page" && p.url.includes("overlay.html"));
  if (!ov) return;
  const ws = await attach(ov.webSocketDebuggerUrl);
  const call = mkCaller(ws);
  for (let i = 0; i < 5; i++) {
    const active = await evOf(call, `document.body.classList.contains("frozen")`);
    if (!active) return;
    await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`);
    await sleep(900);
  }
  throw new Error("无法关闭残留取景层会话");
}
// 等待取景层进入活跃态（frozen=true），返回 attach 后的 call
async function waitOverlayOpen() {
  const list = await jlist();
  const ov = list.find((p) => p.type === "page" && p.url.includes("overlay.html"));
  if (!ov) throw new Error("未找到取景层 target");
  const ws = await attach(ov.webSocketDebuggerUrl);
  const call = mkCaller(ws);
  for (let i = 0; i < 20; i++) {
    const active = await evOf(call, `document.body.classList.contains("frozen")`);
    if (active) return call;
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
async function escSession(ocall) {
  await evOf(ocall, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(500);
}

// ---------- 场景 1：首页点「截图翻译」→ 松手自动进入翻译执行态 ----------
await ensureClosed();
await mEv(`document.getElementById("cap-translate").click()`);
const c1 = await waitOverlayOpen();
const p1 = await evOf(c1, `({ pending: typeof pendingAction !== "undefined" ? pendingAction : "NO_VAR" })`);
check("直达激活：取景层带预绑定动作", p1.pending === "translate", JSON.stringify(p1));
await dragOn(c1, 90, 60, 620, 320);
await sleep(400);
const busy1 = await evOf(c1, `(function(){
  return { trShown: document.getElementById("ai-tr-body").style.display === "block",
           spin: document.getElementById("ai-tr-spin").style.display,
           status: document.getElementById("ai-tr-status").textContent,
           consumed: pendingAction === null };
})()`);
check("松手自动执行：翻译浮层执行态", busy1.trShown === true && busy1.spin === "inline-block", JSON.stringify(busy1));
check("预绑定动作已消费（一次性）", busy1.consumed === true);
await shotOf(c1, "p2-direct-tr-busy");
// 等结果贴图（真 Key 全链路）
let pinId = null;
for (let i = 0; i < 150; i++) {
  await sleep(500);
  pinId = await mEv(`window.__TAURI__.core.invoke("pin_list")`).then((l) => {
    const ai = (l || []).filter((p) => p.kind === "ai");
    return ai.length ? ai[ai.length - 1].id : null;
  }).catch(() => null);
  if (pinId) break;
}
check("翻译直达：结果贴图贴出", Boolean(pinId), `pin=${pinId}`);
await sleep(800);
const trNow = ((await mEv(`window.__TAURI__.core.invoke("read_audit", { limit: 60 })`)) || []).filter((a) => a.command === "ai.translate").length;
check("审计 ai.translate +1", trNow - trBase === 1, `基线${trBase} → ${trNow}`);
if (pinId) await mEv(`window.__TAURI__.core.invoke("pin_close", { id: ${pinId} })`);
// 会话已被成功路径关闭（closeOverlay）；若残留则关掉
await ensureClosed();

// ---------- 场景 2：首页点「AI 问图」→ 松手自动弹输入浮层 ----------
await mEv(`document.getElementById("cap-ask").click()`);
const c2 = await waitOverlayOpen();
const p2 = await evOf(c2, `({ pending: pendingAction })`);
check("问图直达：预绑定动作", p2.pending === "ask", JSON.stringify(p2));
await dragOn(c2, 90, 60, 620, 320);
await sleep(400);
const busy2 = await evOf(c2, `(function(){
  return { pop: document.getElementById("ai-pop").style.display,
           ask: document.getElementById("ai-ask-body").style.display };
})()`);
check("松手自动执行：问图输入浮层弹出", busy2.pop === "block" && busy2.ask === "block", JSON.stringify(busy2));
await shotOf(c2, "p2-direct-ask-pop");
await escSession(c2);

// ---------- 场景 3：取消后动作作废（热键路径恢复普通截图） ----------
await ensureClosed();
await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`);
const c3 = await waitOverlayOpen();
const p3 = await evOf(c3, `({ pending: pendingAction })`);
check("取消后直达动作作废（热键路径无动作）", p3.pending === null, JSON.stringify(p3));
await dragOn(c3, 90, 60, 620, 320);
await sleep(300);
const idle3 = await evOf(c3, `(function(){
  return { trHidden: document.getElementById("ai-tr-body").style.display !== "block",
           popHidden: document.getElementById("ai-pop").style.display !== "block" };
})()`);
check("普通框选不触发 AI", idle3.trHidden === true && idle3.popHidden === true, JSON.stringify(idle3));
await escSession(c3);

console.log(results.every(Boolean) ? "P2_DIRECT_ALL_PASS" : "P2_DIRECT_HAS_FAIL", `(${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 2);
