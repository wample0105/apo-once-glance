// 首页双态验证（2026-09-26 重排后）：
//   效率态（有历史）= 动作条 7 项 + 状态行 2 chip + 最近截图主内容；
//   引导态（无历史）= 动作三卡 + 能力速览 6 项（结构保留断言）。
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

// 双态前提与可见性
const mode = await ev(`(() => ({
  effShown: document.getElementById("home-eff").style.display !== "none",
  guideShown: document.getElementById("home-guide").style.display !== "none",
  cards: document.querySelectorAll("#recent-strip .card").length,
  empty: !!document.querySelector("#recent-strip .empty"),
}))()`);
const hasHistory = mode.cards > 0;
check("双态与历史一致（有历史→效率态）", hasHistory ? (mode.effShown && !mode.guideShown) : (!mode.effShown && mode.guideShown),
  JSON.stringify({ cards: mode.cards, effShown: mode.effShown, guideShown: mode.guideShown }));

// 引导态结构保留（首启用户仍见三卡+能力速览；隐藏态下 DOM 断言）。
// 窗口截图已从 GUI 移除（2026-09-26 用户裁定）：速览 6→5 卡
const guide = await ev(`(() => ({
  heroes: [...document.querySelectorAll("#home-guide .actiongrid .hero-card")].map((b) => b.id),
  caps: document.querySelectorAll("#home-guide .capgrid .cap").length,
  capIcons: document.querySelectorAll("#home-guide .cap-ic").length,
}))()`);
check("引导态结构保留：三卡+速览 5 项+icon 全覆盖",
  guide.heroes.length === 3 && guide.heroes.includes("act-region") && guide.heroes.includes("card-ai") && guide.heroes.includes("card-agent")
  && guide.caps === 5 && guide.capIcons === 5, JSON.stringify(guide));

// 效率态：动作条 6 项全部接线（窗口截图已移除）、首项主按钮；状态行 2 chip 有内容
const eff = await ev(`(() => {
  const ids = ["strip-region","strip-ocr","strip-scroll","strip-pin","strip-translate","strip-ask"];
  const wired = ids.filter((id) => typeof document.getElementById(id).onclick === "function").length;
  const gone = !document.getElementById("strip-window");
  return { wired, gone,
    firstPrimary: document.getElementById("strip-region").classList.contains("primary"),
    aiText: document.getElementById("strip-ai-text").textContent,
    aiCls: document.getElementById("strip-ai").className,
    agentText: document.getElementById("strip-agent-text").textContent };
})()`);
check("效率态动作条 6 项全接线且窗口已移除", eff.wired === 6 && eff.firstPrimary && eff.gone, `wired=${eff.wired}`);
check("AI 状态 chip 内容与色态", /已就绪|部分就绪|未配置|检测中/.test(eff.aiText), `${eff.aiText} [${eff.aiCls}]`);
check("AI 助手 chip 内容", eff.agentText.includes("AI 助手"), eff.agentText);

// 状态 chip 与 AI 卡同源一致（refreshAiCard 双路驱动）
const aiCardText = await ev(`document.getElementById("ai-card-name").textContent`);
const aiConsistent = (eff.aiText === "AI 已就绪" && aiCardText.includes("已就绪"))
  || (eff.aiText === "AI 部分就绪" && aiCardText.includes("部分就绪"))
  || (eff.aiText === "AI 未配置" && aiCardText.includes("开启 AI"));
check("AI chip 与 AI 卡状态一致", aiConsistent, `chip=${eff.aiText} card=${aiCardText}`);

const r = await call("Page.captureScreenshot", { format: "png" });
fs.writeFileSync("tools/out/now-home-v3.png", Buffer.from(r.result.data, "base64"));
console.log(results.every(Boolean) ? "HOME_ALL_PASS" : "HOME_HAS_FAIL", `(${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 2);
