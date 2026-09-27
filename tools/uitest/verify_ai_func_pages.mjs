// AI 设置两层制换轴 真机验证（2026-09-27）
// 断言：①子导航四子页切换（翻译/识别/问图/模型服务）②功能位渲染（迁移值正确回显）
// ③识别引擎卡片单选+builtin 默认+paddle 已装徽章+在线区预填 ④模型服务弹窗无模型字段
// ⑤服务页测试 Key（真 Key 真请求）⑥功能位改即存往返 ⑦识别页在线预填→引擎切 builtin 不残留
// 前置：release 新构建实例（9700 CDP）。用法: node tools/uitest/verify_ai_func_pages.mjs
const base = "http://127.0.0.1:9700";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jlist = async () => (await (await fetch(base + "/json")).json());
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
import fs from "node:fs";
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
async function shotOf(call, name) {
  const r = await call("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync("tools/out", { recursive: true });
  fs.writeFileSync(`tools/out/${name}.png`, Buffer.from(r.result.data, "base64"));
}

const mainList = await jlist();
const main = mainList.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!main) { console.log("FAIL 未找到主面板"); process.exit(2); }
const mws = await attach(main.webSocketDebuggerUrl);
const mcall = mkCaller(mws);
const mEv = (expr) => evOf(mcall, expr);
await mcall("Page.enable", {});

// 进 AI 页
await mEv(`document.querySelector('.nav-item[data-page="ai"]').click()`);
await sleep(800);

// ① 子导航存在且四个子页切换
const subCount = await mEv(`document.querySelectorAll("#ai-subnav [data-aisub]").length`);
check("① 子导航四项", subCount === 4, `count=${subCount}`);
for (const sub of ["translate", "ocr", "ask", "profiles"]) {
  await mEv(`document.querySelector('#ai-subnav [data-aisub="${sub}"]').click()`);
  await sleep(120);
  const on = await mEv(`document.getElementById("ai-sub-${sub}").classList.contains("on")`);
  check(`① 切到 ${sub}`, !!on);
}

// ② 翻译子页渲染（迁移回显：智谱官方 + glm-4-flash）
await mEv(`document.querySelector('#ai-subnav [data-aisub="translate"]').click()`);
await sleep(300);
const trProfile = await mEv(`document.getElementById("ai-tr-profile").value`);
const trModel = await mEv(`document.getElementById("ai-tr-model").value`);
const trStat = await mEv(`document.getElementById("ai-tr-stat").textContent`);
check("② 翻译服务=智谱官方", trProfile === "pvn4v", trProfile);
check("② 翻译模型=glm-4-flash", trModel === "glm-4-flash", trModel);
check("② 状态行含 Key ✓", /Key ✓/.test(trStat), trStat);

// ③ 识别子页：builtin 默认选中 + paddle 已装徽章 + 在线区预填
await mEv(`document.querySelector('#ai-subnav [data-aisub="ocr"]').click()`);
await sleep(300);
const builtinOn = await mEv(`document.querySelector('.engcard[data-engine="builtin"]').classList.contains("on")`);
const paddleBadge = await mEv(`document.getElementById("ai-paddle-badge").textContent`);
const ocrModel = await mEv(`document.getElementById("ai-ocr-model").value`);
const privNote = await mEv(`!!document.querySelector(".privnote")`);
check("③ 内置引擎默认选中", !!builtinOn);
check("③ paddle 徽章=已安装", paddleBadge === "已安装", paddleBadge);
check("③ 在线识别预填 glm-4.5v", ocrModel === "glm-4.5v", ocrModel);
check("③ 在线隐私警示存在", !!privNote);
await shotOf(mcall, "ai-ocr-builtin");

// ③b 引擎切换往返：切 online（后端预填自问图位）→ 状态回落 builtin
await mEv(`document.querySelector('.engcard[data-engine="online"]').click()`);
await sleep(400);
const onlineOn = await mEv(`document.querySelector('.engcard[data-engine="online"]').classList.contains("on")`);
const engineNow = await mEv(`window.__TAURI__.core.invoke("get_settings").then(s => s.ai.ocr.engine)`);
await mEv(`document.querySelector('.engcard[data-engine="builtin"]').click()`);
await sleep(400);
const engineBack = await mEv(`window.__TAURI__.core.invoke("get_settings").then(s => s.ai.ocr.engine)`);
check("③b 切 online 生效", !!onlineOn && engineNow === "online", engineNow);
check("③b 回切 builtin 生效", engineBack === "builtin", engineBack);

// ④ 模型服务弹窗瘦身：无文字/视觉模型字段
await mEv(`document.querySelector('#ai-subnav [data-aisub="profiles"]').click()`);
await sleep(300);
const rows = await mEv(`document.querySelectorAll("#ai-profiles .row").length`);
check("④ 连接列表渲染", rows >= 1, `rows=${rows}`);
await mEv(`document.querySelector('#ai-sub-profiles [data-ai-edit="pvn4v"]').click()`);
await sleep(300);
const hasText = await mEv(`!!document.getElementById("ai-f-text")`);
const hasVision = await mEv(`!!document.getElementById("ai-f-vision")`);
const modalTitle = await mEv(`document.getElementById("ai-modal-title").textContent`);
check("④ 弹窗无模型字段", !hasText && !hasVision, `title=${modalTitle}`);
await shotOf(mcall, "ai-profiles-modal");
await mEv(`document.getElementById("ai-modal-close").click()`);
await sleep(200);

// ⑤ 服务页测试 Key（真 Key 真请求：/models）
await mEv(`document.querySelector('#ai-sub-profiles [data-ai-test-btn="pvn4v"]').click()`);
await sleep(4000);
const testOut = await mEv(`document.querySelector('[data-ai-test="pvn4v"]').textContent`);
check("⑤ 测试 Key 走通", /✓ Key 有效/.test(testOut), testOut.slice(0, 60));

// ⑥ 功能位改即存往返：翻译模型改 glm-4.6 → 校验落库 → 回写 glm-4-flash
await mEv(`document.querySelector('#ai-subnav [data-aisub="translate"]').click()`);
await sleep(200);
await mEv(`(i => { const el = document.getElementById("ai-tr-model"); el.value = "glm-4.6"; el.dispatchEvent(new Event("change")); })(0)`);
await sleep(400);
const saved = await mEv(`window.__TAURI__.core.invoke("get_settings").then(s => s.ai.translate.model)`);
await mEv(`(i => { const el = document.getElementById("ai-tr-model"); el.value = "glm-4-flash"; el.dispatchEvent(new Event("change")); })(0)`);
await sleep(400);
const restored = await mEv(`window.__TAURI__.core.invoke("get_settings").then(s => s.ai.translate.model)`);
check("⑥ 改即存生效", saved === "glm-4.6", saved);
check("⑥ 回写恢复", restored === "glm-4-flash", restored);

// ⑦ 截图：四子页最终状态
await mEv(`document.querySelector('#ai-subnav [data-aisub="translate"]').click()`); await sleep(300);
await shotOf(mcall, "ai-sub-translate");
await mEv(`document.querySelector('#ai-subnav [data-aisub="ask"]').click()`); await sleep(300);
await shotOf(mcall, "ai-sub-ask");

const pass = results.filter(Boolean).length;
console.log(`\n==== ${pass}/${results.length} PASS ====`);
process.exit(pass === results.length ? 0 : 1);
