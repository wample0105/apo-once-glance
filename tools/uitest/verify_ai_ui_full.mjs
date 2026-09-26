// M1 全量 UI 真机测试（16 项交互矩阵）：表单/服务商切换/双配置/默认角色/无 Key 分支/
// 假 Key 401/审计/诊断/文案/删除联动/明文与凭据库断言。全程驱动真实 DOM，产物截图留档。
// 前置：debug exe（9700 CDP）运行中。用法: node tools/uitest/verify_ai_ui_full.mjs
import fs from "node:fs";
import { execSync } from "node:child_process";

const base = "http://127.0.0.1:9700";
const list = await (await fetch(base + "/json")).json();
const t = list.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!t) { console.log("未找到主面板 target:", list.map((p) => `${p.type}:${p.url}`)); process.exit(2); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const call = (method, params) => { const id = ++seq; return new Promise((r) => { pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); }); };
async function ev(expr) {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("页面异常: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 400));
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(name) {
  const r = await call("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync("tools/out", { recursive: true });
  fs.writeFileSync(`tools/out/${name}.png`, Buffer.from(r.result.data, "base64"));
}
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
const nav = (page) => ev(`document.querySelector('.nav-item[data-page="${page}"]').click()`);
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const settingsPath = process.env.APPDATA + "/Onceglance/settings.json";
const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const cmdkeyList = () => { try { return execSync("cmdkey /list", { encoding: "utf8" }); } catch { return ""; } };
async function invoke(cmd, args) { return ev(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})})`); }
async function fillForm(f) {
  await ev(`(function(){
    document.getElementById("ai-f-name").value = ${JSON.stringify(f.name)};
    const sel = document.getElementById("ai-f-provider");
    sel.value = ${JSON.stringify(f.provider)};
    sel.dispatchEvent(new Event("change"));
    document.getElementById("ai-f-url").value = ${JSON.stringify(f.base_url)};
    document.getElementById("ai-f-key").value = ${JSON.stringify(f.key || "")};
    document.getElementById("ai-f-text").value = ${JSON.stringify(f.text || "")};
    document.getElementById("ai-f-vision").value = ${JSON.stringify(f.vision || "")};
    return 1; })()`);
  await sleep(120);
  await ev(`document.getElementById("ai-f-save").click()`);
  await sleep(250);
}
const rowText = (i) => ev(`(function(){ const rows = document.querySelectorAll("#ai-profiles .row"); return rows[${i}] ? rows[${i}].innerText : ""; })()`);
// 按 id 取行文本（历史教训：行序选择器在有用户真实配置时错位，曾致「编辑/改名/删除」误作用到真实配置）
const rowTextById = (id) => ev(`(function(){ const b=document.querySelector('[data-ai-edit="${id}"]'); return b ? b.closest(".row").innerText : ""; })()`);
const editClick = (id) => ev(`(function(){ const el=document.querySelector('[data-ai-edit="${id}"]'); if (el) el.click(); return !!el; })()`);

await call("Page.enable", {}); await call("Runtime.enable", {});

// 0. 清场：只删测试自建的「自测」前缀配置（历史教训：曾误删用户真实「智谱官方」配置+凭据）；
//    删除为内联二次确认（首击武装、再击删除），无需覆写 confirm
const clearTestProfiles = async () => {
  for (const p of ((await invoke("ai_list")) || []).filter((p) => p.name.startsWith("自测"))) {
    await ev(`(function(){ const el=document.querySelector('[data-ai-del="${p.id}"]'); if (el) el.click(); return !!el; })()`);
    await sleep(150);
    await ev(`(function(){ const el=document.querySelector('[data-ai-del="${p.id}"]'); if (el) el.click(); return !!el; })()`);
    await sleep(250);
  }
};
await clearTestProfiles();
const hadProfiles = ((await invoke("ai_list")) || []).length > 0; // 已有真实配置时，新建配置不抢默认角色

// 1. 导航与配置列表渲染（不再清场：用户真实配置保留在列，按「自测」前缀隔离测试数据）
await nav("ai"); await sleep(300);
check("1 AI 页进入", await ev(`document.getElementById("page-ai").classList.contains("on")`));
const preText = await ev(`${q("#ai-profiles")}.innerText`);
check("2 配置列表渲染", preText.length > 0, preText.slice(0, 40));
await shot("ui-1-empty");

// 2. 表单展开与服务商预设联动
await ev(`document.getElementById("ai-add").click()`); await sleep(200);
check("3 表单展开", await ev(`${q("#ai-form")}.style.display !== "none"`));
const presetCount = await ev(`document.getElementById("ai-f-provider").options.length`);
check("4 服务商预设 8 项", presetCount === 8, `got ${presetCount}`);
const zhipuUrl = await ev(`document.getElementById("ai-f-url").value`);
check("5 智谱预设地址", zhipuUrl.includes("open.bigmodel.cn"), zhipuUrl);
await ev(`(function(){ const s=document.getElementById("ai-f-provider"); s.value="deepseek"; s.dispatchEvent(new Event("change")); return 1; })()`);
await sleep(150);
const dsUrl = await ev(`document.getElementById("ai-f-url").value`);
check("6 切服务商地址联动", dsUrl.includes("deepseek"), dsUrl);
await ev(`(function(){ const s=document.getElementById("ai-f-provider"); s.value="zhipu"; s.dispatchEvent(new Event("change")); return 1; })()`);
await sleep(150);

// 3. 保存配置 A（假 Key）→ 行渲染 + 角色徽章
await fillForm({ name: "自测A", provider: "zhipu", base_url: "https://open.bigmodel.cn/api/paas/v4", key: "sk-fake-A-1234567890", text: "glm-4.6", vision: "glm-4.5v" });
const idA0 = ((await invoke("ai_list")) || []).find((p) => p.name === "自测A").id;
const rowA = await rowTextById(idA0);
// hadProfiles：本轮开始时已有真实配置 → 新建的 A 不应抢默认角色（首套自动任默认仅在空列表时成立）
check("7 配置 A 行渲染", rowA.includes("自测A") && rowA.includes("Key 已保存") && (hadProfiles ? !rowA.includes("默认") : rowA.includes("默认文字") && rowA.includes("默认视觉")), rowA.replace(/\n/g, " ").slice(0, 80));
check("8 settings 零明文", !fs.readFileSync(settingsPath, "utf8").includes("sk-fake-A-1234567890"));
check("9 凭据库已写入", cmdkeyList().includes("ai-key-" + idA0));
await shot("ui-2-profile-a");

// 4. 编辑回填与改名（按 id 定位编辑按钮，绝不碰用户真实配置）
await editClick(idA0); await sleep(200);
const editName = await ev(`document.getElementById("ai-f-name").value`);
const keyPlaceholder = await ev(`document.getElementById("ai-f-key").placeholder`);
check("10 编辑回填与 Key 占位", editName === "自测A" && keyPlaceholder.includes("留空表示不修改"), `${editName} / ${keyPlaceholder}`);
await fillForm({ name: "自测A2", provider: "zhipu", base_url: "https://open.bigmodel.cn/api/paas/v4", key: "", text: "glm-4.6", vision: "glm-4.5v" });
check("11 改名保存（Key 不动）", (await rowTextById(idA0)).includes("自测A2") && (await invoke("ai_list")).find((p) => p.id === idA0).has_key === true);

// 5. 配置 B（DeepSeek 纯文字）
await ev(`document.getElementById("ai-add").click()`); await sleep(150);
await fillForm({ name: "自测B", provider: "deepseek", base_url: "https://api.deepseek.com/v1", key: "sk-fake-B-0987654321", text: "deepseek-chat", vision: "" });
const list2 = await invoke("ai_list");
const idA = list2.find((p) => p.name === "自测A2").id, idB = list2.find((p) => p.name === "自测B").id; // 供本步及后续全部步骤按 id 定位
check("12 双配置共存", list2.length >= 2 && list2.every((p) => p.has_key));
const rowA2 = await rowTextById(idA0), rowB = await rowTextById(idB);
check("13 徽章归属正确", !rowB.includes("默认"), "B 行不带默认徽章；当前默认归属视 hadProfiles 而定");

// 6. 默认角色切换到 B 再切回
await ev(`(function(){ const s=document.getElementById("ai-default-vision"); s.value=${JSON.stringify(idB)}; s.dispatchEvent(new Event("change")); return 1; })()`);
await sleep(300);
const afterSwitch = await invoke("ai_list");
check("14 默认视觉切到 B", afterSwitch.find((p) => p.id === idB).is_default_vision === true && afterSwitch.find((p) => p.id === idA).is_default_vision === false);
await ev(`(function(){ const s=document.getElementById("ai-default-vision"); s.value=${JSON.stringify(idA)}; s.dispatchEvent(new Event("change")); return 1; })()`);
await sleep(300);
await shot("ui-3-two-profiles");

// 7. 假 Key 连接测试（真实 HTTP → 401 → 行内人话提示）——按 id 定位，防止点到用户真实配置的行
await ev(`document.querySelector('[data-ai-test-btn="${idA}"]').click()`);
let testLine = "";
for (let i = 0; i < 60; i++) { await sleep(500); testLine = await ev(`(function(){ const el=document.querySelector('[data-ai-test="${idA}"]'); return el ? el.innerText : ""; })()`); if (testLine.trim() && !testLine.includes("测试中")) break; }
check("15 假 Key 测试行内报错", testLine.includes("✕") && testLine.includes("Key"), testLine.slice(0, 70));

// 8. 无 Key 分支：配置 C 不填 Key
await ev(`document.getElementById("ai-add").click()`); await sleep(150);
await fillForm({ name: "自测C", provider: "zhipu", base_url: "https://open.bigmodel.cn/api/paas/v4", key: "", text: "glm-4-flash", vision: "" });
const list3 = await invoke("ai_list");
const idC = list3.find((p) => p.name === "自测C").id;
check("16 无 Key 标红", list3.find((p) => p.id === idC).has_key === false && (await rowTextById(idC)).includes("未配 Key"));
await ev(`document.querySelector("[data-ai-test-btn=\\"${idC}\\"]").click()`); await sleep(400);
const cLine = await ev(`(function(){ const el=document.querySelector('[data-ai-test="${idC}"]'); return el ? el.innerText : ""; })()`);
check("17 无 Key 点测试被拦截", cLine.includes("未配 Key"), cLine.slice(0, 50));
await invoke("ai_delete_profile", { id: idC }); await sleep(200);

// 9. 诊断页 ai_model 项（P1 修复后诊断标签已中文化：DOCTOR_LABEL["ai_model"]="AI 模型"）
await nav("doctor"); await sleep(800);
const doctorText = await ev(`${q("#doctor-list")}.innerText`);
const expectN = ((await invoke("ai_list")) || []).length;
check("18 诊断含 AI 配置项", doctorText.includes("AI 模型") && doctorText.includes(`已配置 ${expectN} 套`), doctorText.includes("AI 模型") ? (doctorText.match(/AI 模型[^\n]*/)?.[0] || "") : doctorText.slice(0, 60));
await shot("ui-4-doctor");

// 10. 通用页隐私文案
await nav("general"); await sleep(250);
const genText = await ev(`${q("#page-general")}.innerText`);
check("19 隐私新文案", genText.includes("本地优先") && genText.includes("Key 加密存本机") && !genText.includes("零云端承诺"));

// 11. Agent 页审计显示 AI 调用
await nav("agent"); await sleep(800);
const auditText = await ev(`${q("#audit-list")}.innerText`);
check("20 审计含 AI 调用明细", auditText.includes("ai.test") && auditText.includes("zhipu"), "");

// 12. 删除联动：删 B、删 A → 测试配置清空 + 凭据清空（内联二次确认：首击武装、再击删除）。
//     用户真实配置（非「自测」前缀）保留不动
const delClick = (id) => ev(`(function(){ const el=document.querySelector('[data-ai-del="${id}"]'); if (el) el.click(); return !!el; })()`);
await nav("ai"); await sleep(300);
await delClick(idB); await sleep(200); await delClick(idB); await sleep(500);
const listAfterB = await invoke("ai_list");
check("21 删除 B", listAfterB.every((p) => p.id !== idB) && listAfterB.some((p) => p.id === idA), `剩 ${listAfterB.length}`);
await delClick(idA); await sleep(200); await delClick(idA); await sleep(500);
const listAfterA = await invoke("ai_list");
check("22 删除 A → 测试配置清零", listAfterA.every((p) => !p.name.startsWith("自测")));
check("23 凭据库连带清空（测试凭据不残留）", !cmdkeyList().includes("ai-key-" + idA) && !cmdkeyList().includes("ai-key-" + idB));
await shot("ui-5-final-empty");

const pass = results.every(Boolean);
console.log(pass ? "UI_FULL_ALL_PASS" : "UI_FULL_HAS_FAIL", `(${results.filter(Boolean).length}/${results.length})`);
process.exit(pass ? 0 : 2);
