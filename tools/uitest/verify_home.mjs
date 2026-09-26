// 首页改造验证：三卡并排 / AI 卡就绪态 / 核心能力速览行 6 项（2 项灰态）。
// 用法: node tools/uitest/verify_home.mjs
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
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };

await call("Page.enable", {}); await call("Runtime.enable", {});
// P3 去侧栏后无 history 导航项：首页本就是默认视图，改为确保回到首页视图
await ev(`(function(){ if (!document.getElementById("page-history").classList.contains("on") && document.getElementById("btn-back-home")) document.getElementById("btn-back-home").click(); return 1; })()`);
await sleep(800);

const cards = await ev(`[...document.querySelectorAll(".actiongrid .hero-card")].map(b => b.id)`);
check("三卡并排", cards.length === 3 && cards.includes("act-region") && cards.includes("card-ai") && cards.includes("card-agent"), cards.join(","));
const aiCard = await ev(`({ name: document.getElementById("ai-card-name").textContent, chip: document.getElementById("ai-card-chip").textContent, ready: document.getElementById("ai-card-chip").classList.contains("ready") })`);
check("AI 卡就绪态", aiCard.name.includes("已就绪") && aiCard.chip === "已就绪" && aiCard.ready === true, JSON.stringify(aiCard));
const caps = await ev(`({ total: document.querySelectorAll(".capgrid .cap").length, disabled: document.querySelectorAll(".capgrid .cap.disabled").length, first: (document.querySelector(".capgrid .cap .cap-name") || {}).textContent,
  icCount: document.querySelectorAll(".capgrid .cap-ic").length,
  trClick: typeof document.getElementById("cap-translate").onclick === "function", askClick: typeof document.getElementById("cap-ask").onclick === "function" })`);
check("能力速览 6 项", caps.total === 6, JSON.stringify(caps));
check("能力卡 icon 全覆盖", caps.icCount === 6, JSON.stringify(caps));
check("翻译/问图已解锁且可点", caps.disabled === 0 && caps.trClick === true && caps.askClick === true);
check("速览首项为窗口截图", caps.first === "窗口截图");

const r = await call("Page.captureScreenshot", { format: "png" });
fs.writeFileSync("tools/out/now-home-v2.png", Buffer.from(r.result.data, "base64"));
console.log(results.every(Boolean) ? "HOME_ALL_PASS" : "HOME_HAS_FAIL", `(${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 2);
