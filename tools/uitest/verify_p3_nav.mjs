// P3 设置收敛导航验证：去侧栏后 齿轮→设置视图→四分组切换→返回；卡片/状态点跳转；nav-to 事件链。
// 前置：release 新构建实例（9700 CDP）。用法: node tools/uitest/verify_p3_nav.mjs
import fs from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = "http://127.0.0.1:9700";
const list = await (await fetch(base + "/json")).json();
const main = list.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!main) { console.log("FAIL 未找到主面板"); process.exit(2); }
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const call = async (method, params) => { const id = ++seq; return new Promise((r) => { pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); }); };
const ev = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("页面异常: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 300));
  return r.result?.result?.value;
};
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
const shot = async (name) => {
  const r = await call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`tools/out/${name}.png`, Buffer.from(r.result.data, "base64"));
};
const state = () => ev(`(function(){
  const on = [...document.querySelectorAll(".page.on")].map((p) => p.id);
  const at = document.querySelector(".nav-item.active");
  return { on, tabs: document.getElementById("settings-tabs").style.display,
           gear: document.getElementById("btn-settings-open").style.display,
           back: document.getElementById("btn-back-home").style.display,
           activeTab: at ? at.getAttribute("data-page") : null };
})()`);

await call("Page.enable", {}); await call("Runtime.enable", {});
// 页面是持久会话：重置齿轮记忆（main.js 顶层 let 在全局词法环境，CDP 可读写），保证「默认通用组」可断言
await ev(`(function(){ try { lastSettingPage = "general"; } catch (e) {} return 1; })()`);

// ---------- 初始：首页视图，顶行为首页形态（tabs/gear 未内联设置时读空串=取 CSS 默认） ----------
await ev(`(function(){ if (!document.getElementById("page-history").classList.contains("on")) document.getElementById("btn-back-home").click(); return 1; })()`);
await sleep(300);
let s = await state();
check("初始：首页视图 + 首页顶行形态", s.on.includes("page-history") && s.tabs !== "flex" && s.gear !== "none" && s.back === "none", JSON.stringify(s));

// ---------- 齿轮 → 设置视图（默认上次分组=通用） ----------
await ev(`document.getElementById("btn-settings-open").click()`);
await sleep(500);
s = await state();
check("齿轮→设置视图（默认通用组）", s.on.includes("page-general") && s.tabs === "flex" && s.back === "inline-flex" && s.gear === "none" && s.activeTab === "general", JSON.stringify(s));
check("通用组内容渲染（标注默认值）", await ev(`document.querySelectorAll("#page-general .row, #page-general label, #page-general .themevals *, #page-general *").length > 20`));
await shot("p3-settings-general");

// ---------- 四分组切换 ----------
await ev(`document.querySelector('.nav-item[data-page="ai"]').click()`);
await sleep(500);
s = await state();
check("切 AI 组", s.on.includes("page-ai") && s.activeTab === "ai", JSON.stringify(s));
check("AI 组内容渲染（配置列表）", await ev(`!!document.getElementById("ai-profiles")`));
await shot("p3-settings-ai");

await ev(`document.querySelector('.nav-item[data-page="agent"]').click()`);
await sleep(600);
s = await state();
check("切 AI 助手组", s.on.includes("page-agent") && s.activeTab === "agent", JSON.stringify(s));

await ev(`document.querySelector('.nav-item[data-page="doctor"]').click()`);
await sleep(800);
s = await state();
check("切诊断组", s.on.includes("page-doctor") && s.activeTab === "doctor", JSON.stringify(s));
await shot("p3-settings-doctor");

// ---------- 首页 AI 能力卡 → 设置 AI 组 ----------
await ev(`document.getElementById("btn-back-home").click()`);
await sleep(300);
s = await state();
check("返回首页", s.on.includes("page-history") && s.tabs !== "flex" && s.gear !== "none", JSON.stringify(s));
await ev(`document.getElementById("card-ai").click()`);
await sleep(500);
s = await state();
check("首页 AI 卡 → 设置 AI 组", s.on.includes("page-ai") && s.tabs === "flex", JSON.stringify(s));

// ---------- 首页接入卡 → AI 助手组 ----------
await ev(`document.getElementById("btn-back-home").click()`);
await sleep(200);
await ev(`document.getElementById("card-agent").click()`);
await sleep(600);
s = await state();
check("首页接入卡 → AI 助手组", s.on.includes("page-agent") && s.tabs === "flex", JSON.stringify(s));

// ---------- nav-to 事件（Rust ai_open_settings / 托盘路径） ----------
await ev(`window.__TAURI__.event.emit("nav-to", "doctor")`);
await sleep(600);
s = await state();
check("nav-to 事件 → 诊断组", s.on.includes("page-doctor") && s.activeTab === "doctor", JSON.stringify(s));

// ---------- 齿轮记忆： doctor 后回首页再点齿轮应回诊断组 ----------
await ev(`document.getElementById("btn-back-home").click()`);
await sleep(200);
await ev(`document.getElementById("btn-settings-open").click()`);
await sleep(400);
s = await state();
check("齿轮记忆上次分组", s.on.includes("page-doctor"), JSON.stringify(s));
await ev(`document.getElementById("btn-back-home").click()`);
await sleep(200);

console.log(results.every(Boolean) ? "P3_NAV_ALL_PASS" : "P3_NAV_HAS_FAIL", `(${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 2);
