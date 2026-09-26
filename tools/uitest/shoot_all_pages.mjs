// 全页面截图（五项导航版）：逐页导航截屏 + 关键滚动位，供 UI 查看。
// 前置：实例运行中（9700 CDP）。用法: node tools/uitest/shoot_all_pages.mjs
import fs from "node:fs";

const base = "http://127.0.0.1:9700";
const list = await (await fetch(base + "/json")).json();
const t = list.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!t) { console.log("未找到主面板 target:", list.map((p) => `${p.type}:${p.url}`)); process.exit(2); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const call = (method, params) => { const id = ++seq; return new Promise((r) => { pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await call("Page.enable", {});
await call("Runtime.enable", {});
fs.mkdirSync("tools/out", { recursive: true });

async function shot(name) {
  const r = await call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`tools/out/${name}.png`, Buffer.from(r.result.data, "base64"));
  console.log("shot", name);
}
const nav = (page) => call("Runtime.evaluate", { expression: `document.querySelector('.nav-item[data-page="${page}"]').click()` });

// 首页
await nav("history"); await sleep(700);
await shot("now-home");

// AI 页（含智谱官方配置行）
await nav("ai"); await sleep(600);
await shot("now-ai");

// AI 助手页
await nav("agent"); await sleep(1500);
await shot("now-agent");

// 通用页（顶部 + 标注默认值滚动位）
await nav("general"); await sleep(500);
await shot("now-general");
await call("Runtime.evaluate", { expression: `document.getElementById("theme-values").scrollIntoView({block:"center"})` });
await sleep(300);
await shot("now-general-theme");

// 诊断页
await nav("doctor"); await sleep(1300);
await shot("now-doctor");

console.log("DONE");
async function noop() {}
