// M1 真 Key 绿灯验收：UI 填入真实智谱 Key（经 ONCE_TEST_KEY 环境变量注入，绝不打印），
// 保存 → 测试连接 → 断言文字与视觉双绿灯。用法: ONCE_TEST_KEY=xxx node tools/uitest/verify_ai_realkey.mjs
import fs from "node:fs";

const key = process.env.ONCE_TEST_KEY || "";
if (!key) { console.log("FAIL 未提供 ONCE_TEST_KEY"); process.exit(2); }
const mask = key.slice(0, 5) + "****" + key.slice(-4);

const base = "http://127.0.0.1:9700";
const list = await (await fetch(base + "/json")).json();
const t = list.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!t) { console.log("FAIL 未找到主面板 target"); process.exit(2); }
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

await call("Page.enable", {}); await call("Runtime.enable", {});
await ev(`window.confirm = () => true`);

// 导航 AI 页，展开表单，UI 填入真实 Key
await ev(`document.querySelector('.nav-item[data-page="ai"]').click()`);
await sleep(300);
// 清掉历史测试配置，保持收尾干净（保留真 Key 配置一项）
for (const p of (await ev(`window.__TAURI__.core.invoke("ai_list")`)) || []) {
  if (p.name !== "智谱官方") await ev(`window.__TAURI__.core.invoke("ai_delete_profile", { id: ${JSON.stringify(p.id)} })`);
}
await ev(`document.getElementById("ai-add").click()`); await sleep(200);
await ev(`(function(){
  document.getElementById("ai-f-name").value = "智谱官方";
  document.getElementById("ai-f-key").value = ${JSON.stringify(key)};
  document.getElementById("ai-f-text").value = "glm-4-flash";
  document.getElementById("ai-f-vision").value = "glm-4.5v";
  return 1; })()`);
await ev(`document.getElementById("ai-f-save").click()`); await sleep(300);

const view = await ev(`window.__TAURI__.core.invoke("ai_list")`);
const p = (view || []).find((x) => x.name === "智谱官方");
if (!p) { console.log("FAIL 保存后未见配置"); process.exit(2); }
console.log(`PASS 配置已保存 id=${p.id} has_key=${p.has_key} 默认文字=${p.is_default_text} 默认视觉=${p.is_default_vision}`);

// settings 明文断言
const s = fs.readFileSync(process.env.APPDATA + "/Onceglance/settings.json", "utf8");
console.log(s.includes(key) ? "FAIL 真 Key 泄漏进 settings.json" : "PASS settings.json 零明文");

// 点击测试连接，轮询行内结果
await ev(`document.querySelector('[data-ai-test-btn="${p.id}"]').click()`);
let line = "";
for (let i = 0; i < 90; i++) { await sleep(500); line = await ev(`(function(){ const el=document.querySelector('[data-ai-test="${p.id}"]'); return el ? el.innerText : ""; })()`); if (line.trim() && !line.includes("测试中")) break; }
console.log("测试结果:", line);
const ok = line.includes("文字 ✓") && line.includes("视觉 ✓");
console.log(ok ? "PASS 真 Key 双绿灯（文字+视觉）" : "FAIL 未见双绿灯");

// 截图留档（页面无 Key 明文：密码框已清空、行内只有状态）
const r = await call("Page.captureScreenshot", { format: "png" });
fs.mkdirSync("tools/out", { recursive: true });
fs.writeFileSync("tools/out/ui-6-realkey-green.png", Buffer.from(r.result.data, "base64"));
fs.writeFileSync("tools/out/ai-realkey-pid.txt", p.id);
console.log(ok ? "REALKEY_ALL_PASS" : "REALKEY_FAIL");
process.exit(ok ? 0 : 2);
