// P1 修复验证：①卡片只显示文件名（无路径分隔符）②「未识别」噪音行消失
// ③诊断页检查项中文化。前置：实例运行中（9700 CDP）。
// 用法: node tools/uitest/verify_p1_fixes.mjs
import fs from "node:fs";

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

await call("Page.enable", {}); await call("Runtime.enable", {});

// ① 首页横排
await ev(`document.querySelector('.nav-item[data-page="history"]').click()`);
await sleep(700);
const homeNames = await ev(`[...document.querySelectorAll("#recent-strip .cardname")].map(e=>e.textContent)`);
check("首页卡片为纯文件名", homeNames.length > 0 && homeNames.every((n) => !/[\\/]/.test(n)), JSON.stringify(homeNames.slice(0, 3)));
const homeOcr = await ev(`[...document.querySelectorAll("#recent-strip .cardocr")].map(e=>e.textContent)`);
check("首页无「未识别」噪音行", !homeOcr.some((x) => x.includes("未识别")), `${homeOcr.length} 行有内容`);
await shot("review-home-fixed");

// ② 全量历史视图
await ev(`document.getElementById("recent-all").click()`);
await sleep(700);
const fullNames = await ev(`[...document.querySelectorAll("#history-list .cardname")].map(e=>e.textContent)`);
check("全量视图卡片为纯文件名", fullNames.length > 0 && fullNames.every((n) => !/[\\/]/.test(n)), JSON.stringify(fullNames.slice(0, 3)));
const fullOcr = await ev(`[...document.querySelectorAll("#history-list .cardocr")].map(e=>e.textContent)`);
check("全量视图无「未识别」噪音行", !fullOcr.some((x) => x.includes("未识别")), `${fullOcr.length} 行有内容`);

// ③ 诊断页中文化
await ev(`document.querySelector('.nav-item[data-page="doctor"]').click()`);
await sleep(1300);
const doctorText = await ev(`document.getElementById("doctor-list").innerText`);
const hasAll = ["捕获", "保存目录", "OCR 引擎", "运行时", "MCP 连接", "AI 模型"].every((k) => doctorText.includes(k));
const noRawKeys = !["capture", "save_dir", "ocr_engine", "ai_model"].some((k) => doctorText.includes(k));
check("诊断检查项中文化", hasAll && noRawKeys, hasAll ? "" : doctorText.replace(/\n/g, " ").slice(0, 120));
await shot("review-doctor-fixed");

console.log(results.every(Boolean) ? "P1_ALL_PASS" : "P1_HAS_FAIL", `(${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 2);
