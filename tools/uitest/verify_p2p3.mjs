// P2+P3 优化验证：两阶段。
//   phase1: 导航 5 项与更名 / 标注默认值并入通用 / AI 助手页分组 / 表单 label /
//           删除内联二次确认（武装→回落→二次删除）/ 窗口尺寸记忆落盘
//   phase2: 重启后尺寸恢复 + 智谱官方配置回归
// 用法: node tools/uitest/verify_p2p3.mjs phase1|phase2
import fs from "node:fs";

const mode = process.argv[2] || "phase1";
const base = "http://127.0.0.1:9700";
const list = await (await fetch(base + "/json")).json();
const t = list.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!t) { console.log("未找到主面板 target"); process.exit(2); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const call = (method, params) => { const id = ++seq; return new Promise((r) => { pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expr) {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("页面异常: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 300));
  return r.result?.result?.value;
}
async function shot(name) {
  const r = await call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`tools/out/${name}.png`, Buffer.from(r.result.data, "base64"));
}
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
const settingsPath = process.env.APPDATA + "/Onceglance/settings.json";

await call("Page.enable", {}); await call("Runtime.enable", {});

if (mode === "phase1") {
  // ① 导航结构：5 项、更名、无标注主题
  const nav = await ev(`[...document.querySelectorAll(".nav-item")].map(b => b.dataset.page + ":" + b.textContent.trim())`);
  check("导航 5 项", nav.length === 5, nav.join(" | "));
  check("「AI 助手」更名", nav.some((n) => n === "agent:AI 助手"));
  check("标注主题已移出导航", !nav.some((n) => n.includes("theme") || n.includes("标注主题")));

  // ② 标注默认值并入通用页（含主题值渲染）
  await ev(`document.querySelector('.nav-item[data-page="general"]').click()`);
  await sleep(500);
  const genText = await ev(`document.getElementById("page-general").innerText`);
  check("通用页含「标注默认值」", genText.includes("标注默认值") && genText.includes("自动记到这里"));
  check("主题值在通用页渲染", await ev(`document.getElementById("theme-values").innerText.includes("主题色")`));
  await shot("p2-general");

  // ③ AI 助手页：页题 + 隐私与安全分组
  await ev(`document.querySelector('.nav-item[data-page="agent"]').click()`);
  await sleep(400);
  const agText = await ev(`document.getElementById("page-agent").innerText`);
  check("页题「AI 助手」", agText.includes("AI 助手") && agText.includes("把你自己的 AI 助手"));
  check("隐私与安全分组", agText.includes("隐私与安全") && agText.includes("App 黑名单") && agText.includes("审计日志"));
  await shot("p2-agent");

  // ④ AI 表单 label 关联
  await ev(`document.querySelector('.nav-item[data-page="ai"]').click()`);
  await sleep(400);
  const labelCount = await ev(`document.querySelectorAll('#ai-form label[for]').length`);
  check("表单 label[for] × 6", labelCount === 6, `got ${labelCount}`);

  // ⑤ 删除内联二次确认：武装 → 回落 → 双击删除（只针对「临时P2」这一行，不碰真实配置）
  const existing = await ev(`window.__TAURI__.core.invoke("ai_list")`);
  let dummyId = (existing.find((p) => p.name === "临时P2") || {}).id;
  if (!dummyId) {
    const saved = await ev(`window.__TAURI__.core.invoke("ai_save_profile", { profile: { id:"", name:"临时P2", provider:"zhipu", base_url:"https://open.bigmodel.cn/api/paas/v4", text_model:"", vision_model:"" }, apiKey: null })`);
    dummyId = saved.profiles.find((p) => p.name === "临时P2").id;
    await sleep(250);
  }
  await ev(`document.querySelector('.nav-item[data-page="ai"]').click()`);
  await sleep(400);
  const delSel = `[data-ai-del="${dummyId}"]`;
  await ev(`(function(){ const b=document.querySelector(${JSON.stringify(delSel)}); b.click(); return 1; })()`);
  await sleep(200);
  const armed = await ev(`(function(){ const b=document.querySelector(${JSON.stringify(delSel)}); return { t:b.textContent, armed:b.classList.contains("armed") }; })()`);
  check("首击进入武装态", armed.t === "确认删除？" && armed.armed === true, JSON.stringify(armed));
  await sleep(3300);
  const reverted = await ev(`(function(){ const b=document.querySelector(${JSON.stringify(delSel)}); return b ? b.textContent : "(gone)"; })()`);
  check("3 秒无操作回落", reverted === "删除", reverted);
  await ev(`(function(){ const b=document.querySelector(${JSON.stringify(delSel)}); b.click(); return 1; })()`);
  await sleep(250);
  await ev(`(function(){ const b=document.querySelector(${JSON.stringify(delSel)}); if (b) b.click(); return 1; })()`);
  await sleep(400);
  const list = await ev(`window.__TAURI__.core.invoke("ai_list")`);
  check("二次点击完成删除", !list.some((p) => p.id === dummyId), `剩 ${list.length} 套`);
  if (list.some((p) => p.id === dummyId)) await ev(`window.__TAURI__.core.invoke("ai_delete_profile", { id: ${JSON.stringify(dummyId)} })`);

  // ⑥ 窗口尺寸记忆落盘
  await ev(`(function(){ const LS = window.__TAURI__.window.LogicalSize; window.__TAURI__.window.getCurrentWindow().setSize(new LS(1000, 700)); return 1; })()`);
  await sleep(1600);
  const ws = JSON.parse(fs.readFileSync(settingsPath, "utf8")).win_size;
  check("尺寸记忆落盘", Array.isArray(ws) && Math.abs(ws[0] - 1000) < 30 && Math.abs(ws[1] - 700) < 30, JSON.stringify(ws));
  await ev(`document.querySelector('.nav-item[data-page="ai"]').click()`);
  await sleep(300);
  await shot("p2-ai-final");
} else {
  // phase2：重启后
  const size = await ev(`[window.innerWidth, window.innerHeight]`);
  check("重启后恢复记忆尺寸", Math.abs(size[0] - 1000) < 40 && Math.abs(size[1] - 700) < 40, JSON.stringify(size));
  const profiles = await ev(`window.__TAURI__.core.invoke("ai_list")`);
  check("智谱官方配置回归", (profiles || []).some((p) => p.name === "智谱官方" && p.has_key));
}

console.log(results.every(Boolean) ? `${mode}_ALL_PASS` : `${mode}_HAS_FAIL`, `(${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 2);
