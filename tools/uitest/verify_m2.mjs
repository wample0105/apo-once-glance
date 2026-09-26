// M2 全链路真机验证：取景层拖选 → AI 菜单 → 问图（真 Key 视觉模型）→ 结果贴图；
// 翻译链路：定位主面板后框选文字区域 → OCR+文字模型；失败分支（无文字）人话报错。
// 前置：release 实例（9700 CDP）+ 主面板在 (80,80)。用法: node tools/uitest/verify_m2.mjs
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
await mEv(`window.confirm = () => true`);

// 主面板定位到 (80,80) 物理坐标（拖选区域可控）
await mEv(`(async function(){ const T = window.__TAURI__;
  const PP = (T.dpi && T.dpi.PhysicalPosition) || (T.window && T.window.PhysicalPosition);
  await T.window.getCurrentWindow().setPosition(new PP(80, 80)); return 1; })()`);
await sleep(300);

// ---------- 记录审计基线 ----------
const auditBase = ((await mEv(`window.__TAURI__.core.invoke("read_audit", { limit: 5 })`)) || []).filter(a => a.command.startsWith("ai.")).length;

// ---------- 拉起取景层并切到 overlay 页 ----------
// start_overlay 是 toggle 语义：先关掉可能的残留会话，再开新会话
await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" }).catch(function(){ return 1; })`);
await sleep(800);
await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`);
await sleep(2200);
const list2 = await jlist();
const ov = list2.find((p) => p.type === "page" && p.url.includes("overlay.html"));
if (!ov) { console.log("FAIL 未找到取景层 target"); process.exit(2); }
const ows = await attach(ov.webSocketDebuggerUrl);
const ocall = mkCaller(ows);
async function oEv(expr) {
  const r = await ocall("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("取景层异常: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 300));
  return r.result?.result?.value;
}
await ocall("Page.enable", {}); await ocall("Runtime.enable", {});

// 物理鼠标拖选：CSS 坐标 (90,60) → (620,320)（覆盖主面板文字区）
async function drag(x1, y1, x2, y2) {
  await ocall("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await ocall("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps, button: "left", buttons: 1 });
    await sleep(30);
  }
  await ocall("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 1 });
}
await drag(90, 60, 620, 320);
await sleep(300);
const selState = await oEv(`({ state, sel: { x: sel.x, y: sel.y, w: sel.w, h: sel.h } })`);
check("拖选出选区", selState.state === "selected" && selState.sel.w > 100, JSON.stringify(selState));

// ---------- 问图全链路（真 Key 视觉模型） ----------
// AI 双直达入口（P1 拆按钮后）：问图按钮直点，无菜单层
const aiBtn = await oEv(`(function(){ const b = document.getElementById("tb-ai-ask").getBoundingClientRect();
  return { x: b.x + b.width/2, y: b.y + b.height/2 }; })()`);
await ocall("Input.dispatchMouseEvent", { type: "mousePressed", x: aiBtn.x, y: aiBtn.y, button: "left", buttons: 1, clickCount: 1 });
await ocall("Input.dispatchMouseEvent", { type: "mouseReleased", x: aiBtn.x, y: aiBtn.y, button: "left" });
await sleep(400);
const popOpen = await oEv(`document.getElementById("ai-pop").style.display === "block" && document.getElementById("ai-ask-body").style.display === "block"`);
check("问图输入浮层展开", popOpen === true);
const chipCount = await oEv(`document.querySelectorAll("#ai-chips button").length`);
check("预置指令 chips ≥ 4", chipCount >= 4, `${chipCount} 个`);
await shotOf(mcall, "m2-ask-popover");

// 点第一个 chip（解释这段内容）→ 等结果贴图
await oEv(`document.querySelector("#ai-chips button").click()`);
let pinId = null;
for (let i = 0; i < 120; i++) {
  await sleep(500);
  pinId = await mEv(`window.__TAURI__.core.invoke("pin_list")`).then((l) => {
    const ai = (l || []).filter((p) => p.kind === "ai");
    return ai.length ? ai[ai.length - 1].id : null;
  }).catch(() => null);
  if (pinId) break;
}
check("问图生成并贴出结果", Boolean(pinId), `pin=${pinId}`);
if (!pinId) {
  const st = await oEv(`document.getElementById("ai-status").textContent`);
  console.log("浮层状态：", st);
}

// 结果贴图内容与操作
if (pinId) {
  const meta = await mEv(`window.__TAURI__.core.invoke("pin_meta", { id: ${pinId} })`);
  check("结果贴图形态", meta.kind === "ai" && (meta.ai_text || "").length > 0, (meta.ai_meta || "") + " · " + (meta.ai_text || "").slice(0, 30));
  // 关闭结果贴图（清理）
  await mEv(`window.__TAURI__.core.invoke("pin_close", { id: ${pinId} })`);
}

// 审计含 ai.ask
const auditAsk = await mEv(`window.__TAURI__.core.invoke("read_audit", { limit: 10 })`);
check("审计含 ai.ask", (auditAsk || []).some((a) => a.command === "ai.ask" && a.provider === "zhipu" && a.sent_image === true), "");

// ---------- 翻译全链路（OCR + 文字模型） ----------
// 重新拉起取景层（上一轮结束后已关闭），框选主面板文字区
await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`);
await sleep(2200);
const list3 = await jlist();
const ov2 = list3.find((p) => p.type === "page" && p.url.includes("overlay.html"));
const ows2 = await attach(ov2.webSocketDebuggerUrl);
const ocall2 = mkCaller(ows2);
await ocall2("Page.enable", {}); await ocall2("Runtime.enable", {});
await drag(90, 60, 620, 320);
await sleep(300);
const aiBtn2 = await (async () => {
  const r = await ocall2("Runtime.evaluate", { expression: `(function(){ const b = document.getElementById("tb-ai-translate").getBoundingClientRect(); return { x: b.x + b.width/2, y: b.y + b.height/2 }; })()`, returnByValue: true });
  return r.result.result.value;
})();
await ocall2("Input.dispatchMouseEvent", { type: "mousePressed", x: aiBtn2.x, y: aiBtn2.y, button: "left", buttons: 1, clickCount: 1 });
await ocall2("Input.dispatchMouseEvent", { type: "mouseReleased", x: aiBtn2.x, y: aiBtn2.y, button: "left" });
pinId = null;
for (let i = 0; i < 120; i++) {
  await sleep(500);
  pinId = await mEv(`window.__TAURI__.core.invoke("pin_list")`).then((l) => {
    const ai = (l || []).filter((p) => p.kind === "ai");
    return ai.length ? ai[ai.length - 1].id : null;
  }).catch(() => null);
  if (pinId) break;
}
check("翻译生成并贴出结果", Boolean(pinId), `pin=${pinId}`);
if (pinId) {
  const meta = await mEv(`window.__TAURI__.core.invoke("pin_meta", { id: ${pinId} })`);
  check("翻译结果内容非空", (meta.ai_text || "").length > 0, (meta.ai_text || "").slice(0, 40));
  await mEv(`window.__TAURI__.core.invoke("pin_close", { id: ${pinId} })`);
}
const auditTr = await mEv(`window.__TAURI__.core.invoke("read_audit", { limit: 10 })`);
check("审计含 ai.translate", (auditTr || []).some((a) => a.command === "ai.translate"), "");

console.log(results.every(Boolean) ? "M2_ALL_PASS" : "M2_HAS_FAIL", `(${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 2);
