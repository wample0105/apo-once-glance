// 翻译执行态真机验证：浮层进度卡（spinner+秒数+目标语言）/ 防重 / Esc 转后台后结果仍贴出。
// 前置：release 新构建实例（9700 CDP）+ 智谱 Key。用法: node tools/uitest/verify_m2_tr.mjs
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

// ---------- 取景层 + 拖选 ----------
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

// ---------- 点截图翻译按钮（P1 拆按钮后直达，无菜单层） ----------
async function clickOv(x, y) {
  await ocall("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await ocall("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left" });
}
const aiBtn = await oEv(`(function(){ const b = document.getElementById("tb-ai-translate").getBoundingClientRect(); return { x: b.x + b.width/2, y: b.y + b.height/2 }; })()`);
await clickOv(aiBtn.x, aiBtn.y);

// ---------- 执行态断言（点翻译后立即） ----------
await sleep(200);
const busy = await oEv(`(function(){
  return { pop: document.getElementById("ai-pop").style.display,
           tr: document.getElementById("ai-tr-body").style.display,
           askHidden: document.getElementById("ai-ask-body").style.display === "none",
           spin: document.getElementById("ai-tr-spin").style.display,
           status: document.getElementById("ai-tr-status").textContent,
           lang: document.getElementById("ai-tr-lang").textContent };
})()`);
check("浮层切到翻译执行态", busy.pop === "block" && busy.tr === "block" && busy.askHidden === true);
check("spinner 可见", busy.spin === "inline-block");
check("状态行含秒数", /^正在翻译选区文字 · \d+s$/.test(busy.status), busy.status);
check("显示目标语言", busy.lang.startsWith("译为："), busy.lang);
await shotOf(ocall, "ux-tr-busy");

// ---------- 防重：生成中重复触发（直接调入口） ----------
await oEv(`aiTranslateRun()`);
await oEv(`aiTranslateRun()`);

// ---------- Esc（全局语义）：界面取消但翻译转后台 ----------
await sleep(300);
await oEv(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await sleep(300);
const afterEsc = await oEv(`({ pop: document.getElementById("ai-pop").style.display,
  toast: (document.querySelector(".ann-toast") || {}).textContent || "" })`);
check("Esc：浮层随界面取消", afterEsc.pop !== "block");
check("Esc：提示生成仍在后台", afterEsc.toast.includes("后台"), afterEsc.toast);

// ---------- 结果仍贴出 + 审计恰好 +1 ----------
let pinId = null;
for (let i = 0; i < 150; i++) {
  await sleep(500);
  pinId = await mEv(`window.__TAURI__.core.invoke("pin_list")`).then((l) => {
    const ai = (l || []).filter((p) => p.kind === "ai");
    return ai.length ? ai[ai.length - 1].id : null;
  }).catch(() => null);
  if (pinId) break;
}
check("Esc 取消界面后结果仍贴出", Boolean(pinId), `pin=${pinId}`);
await sleep(1000);
const trNow = ((await mEv(`window.__TAURI__.core.invoke("read_audit", { limit: 60 })`)) || []).filter((a) => a.command === "ai.translate").length;
check("防重：重复触发只发一次请求", trNow - trBase === 1, `基线${trBase} → ${trNow}`);
if (pinId) {
  const meta = await mEv(`window.__TAURI__.core.invoke("pin_meta", { id: ${pinId} })`);
  check("译文内容非空", (meta.ai_text || "").length > 0, (meta.ai_text || "").slice(0, 40));
  await mEv(`window.__TAURI__.core.invoke("pin_close", { id: ${pinId} })`);
}

console.log(results.every(Boolean) ? "TR_UX_ALL_PASS" : "TR_UX_HAS_FAIL", `(${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 2);
