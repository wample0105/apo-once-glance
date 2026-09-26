// M1 实机自测：主面板 AI 页 + 配置 CRUD + 凭据库 + 假 Key 错误路径 + 审计。
// 前置：生产 exe 已带 9222 调试口运行。用法: node tools/uitest/verify_ai.mjs
// 文件系统断言（settings.json 明文检查 / cmdkey 凭据库清单）由外层 bash 执行，见 handoff 二十二段。
import fs from "node:fs";

const base = "http://127.0.0.1:9700";
const list = await (await fetch(base + "/json")).json();
const t = list.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!t) {
  console.log("未找到主面板页面。现有 targets:", list.map((p) => `${p.type}:${p.url}`));
  process.exit(1);
}
console.log("主面板 target:", t.url);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function call(method, params) {
  const id = ++seq;
  return new Promise((r) => { pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
}
async function ev(expr) {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    const d = r.result.exceptionDetails;
    throw new Error("页面异常: " + (d.exception?.description || d.text || "").slice(0, 300));
  }
  return r.result?.result?.value;
}
async function shot(name) {
  const r = await call("Page.captureScreenshot", { format: "png" });
  if (!r.result?.data) throw new Error("截图失败");
  const p = `tools/out/${name}.png`;
  fs.mkdirSync("tools/out", { recursive: true });
  fs.writeFileSync(p, Buffer.from(r.result.data, "base64"));
  console.log("截图:", p);
}

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };

await call("Page.enable", {});
await call("Runtime.enable", {});

// 1. AI 导航存在且可进入
const navOk = await ev(`(function(){
  const btn = document.querySelector('.nav-item[data-page="ai"]');
  if (!btn) return { exists: false };
  btn.click();
  const page = document.getElementById("page-ai");
  return { exists: true, on: !!(page && page.classList.contains("on")) };
})()`);
check("AI 导航与页面", navOk.exists && navOk.on, JSON.stringify(navOk));
await shot("ai-page-empty");

// 2. 保存配置（含假 Key）→ 返回配置且自动担任默认角色
const saved = await ev(`window.__TAURI__.core.invoke("ai_save_profile", { profile: {
  id: "", name: "自测智谱", provider: "zhipu",
  base_url: "https://open.bigmodel.cn/api/paas/v4",
  text_model: "glm-4.6", vision_model: "glm-4.5v"
}, apiKey: "sk-fake-m1-check-12345" })`);
const pid = saved && saved.profiles && saved.profiles[0] && saved.profiles[0].id;
check("ai_save_profile", Boolean(pid && saved.default_text === pid && saved.default_vision === pid), `id=${pid}`);

// 3. 列表视图 has_key（凭据库真实写入）
const listView = await ev(`window.__TAURI__.core.invoke("ai_list")`);
check("ai_list has_key", Array.isArray(listView) && listView.length === 1 && listView[0].has_key === true, JSON.stringify(listView?.[0]?.has_key));

// 4. 假 Key 连接测试：走完整链路（凭据库取 Key → HTTP → 状态码映射 → 审计）
const testText = await ev(`window.__TAURI__.core.invoke("ai_test", { id: "${pid}", kind: "text" })`);
check("ai_test 假 Key 错误路径", testText.ok === false && typeof testText.message === "string" && testText.message.length > 0, testText.message?.slice(0, 80));
const testVision = await ev(`window.__TAURI__.core.invoke("ai_test", { id: "${pid}", kind: "vision" })`);
check("ai_test 视觉链路（假 Key）", testVision.ok === false, testVision.message?.slice(0, 80));

// 5. 审计含 AI 调用元数据（provider/model/已发送图像）
const audit = await ev(`window.__TAURI__.core.invoke("read_audit", { limit: 10 })`);
const aiEntries = (audit || []).filter((a) => a.command === "ai.test");
check("审计记录 AI 调用", aiEntries.length >= 2 && aiEntries.some((a) => a.provider === "zhipu" && a.model === "glm-4.5v" && a.sent_image === true),
  `${aiEntries.length} 条`);

// 6. 带配置的页面视觉（重进页面触发重渲染）+ 表单展开视觉
await ev(`document.querySelector('.nav-item[data-page="ai"]').click()`);
await new Promise((r) => setTimeout(r, 400));
await shot("ai-page-profile");
await ev(`document.getElementById("ai-add").click()`);
await new Promise((r) => setTimeout(r, 250));
await shot("ai-page-form");
await ev(`document.getElementById("ai-f-cancel").click()`);

// 7. 留下配置供重启持久化检查（外层 bash 重启后再跑 verify_ai_persist.mjs），先输出 id
fs.writeFileSync("tools/out/ai-test-pid.txt", pid || "");
console.log("PROFILE_ID=" + pid);
console.log(results.every((r) => r.ok) ? "ALL_PASS" : "HAS_FAIL");
process.exit(results.every((r) => r.ok) ? 0 : 2);
