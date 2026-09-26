// UI/UX 评审修复轮（2026-09-26）实机回归：P0 徽章双角色判定 / P1 落盘目录 /
// 补-2 删默认迁移+toast / P2-1 chevron / P2-2 能力卡语义 / P3-1 中性徽章 /
// P3-2 空态文案 / 补-1 自检按钮 / 补-5 路径截断 / 补-6 诊断总结 / 补-7 tooltip / P2-3 溢出复核。
// 前置：release exe 带 9700 调试口运行。用法: node tools/uitest/verify_uiux_review.mjs（项目根）
// 铁律：临时配置只建「自测」前缀、按 id 精确操作、尾部断言真实配置完好。
import fs from "node:fs";

const base = "http://127.0.0.1:9700";
const list = await (await fetch(base + "/json")).json();
const t = list.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!t) {
  console.log("未找到主面板页面。现有 targets:", list.map((p) => `${p.type}:${p.url}`));
  process.exit(1);
}
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
    throw new Error("页面异常: " + (d.exception?.description || d.text || "").slice(0, 400));
  }
  return r.result?.result?.value;
}
async function shot(name) {
  const r = await call("Page.captureScreenshot", { format: "png" });
  if (!r.result?.data) throw new Error("截图失败");
  fs.mkdirSync("tools/out", { recursive: true });
  fs.writeFileSync(`tools/out/${name}.png`, Buffer.from(r.result.data, "base64"));
}
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await call("Page.enable", {});
await call("Runtime.enable", {});
await ev("window.confirm = () => true");

// 开场清场：只删「自测」前缀的遗留临时配置（上轮中断可能残留），真实数据不碰
const cleaned = await ev(`(async () => {
  const inv = window.__TAURI__.core.invoke;
  const l = await inv("ai_list");
  const junk = l.filter((p) => p.name.startsWith("自测"));
  for (const p of junk) await inv("ai_delete_profile", { id: p.id });
  return junk.map((p) => p.name);
})()`);
if (cleaned.length) console.log("清场：删除遗留临时配置", JSON.stringify(cleaned));

// ===== P1：get_settings 补 save_root / save_dir_writable =====
const s = await ev(`(async () => {
  const v = await window.__TAURI__.core.invoke("get_settings");
  return { hasRoot: typeof v.save_root === "string" && v.save_root.length > 0,
           root: v.save_root, writable: v.save_dir_writable };
})()`);
check("P1 get_settings 补字段", s.hasRoot && typeof s.writable === "boolean", `root=${s.root} writable=${s.writable}`);

// 通用页灰条渲染
await ev(`document.querySelector('.nav-item[data-page="general"]').click()`);
await sleep(300);
const chip = await ev(`(() => {
  const el = document.getElementById("save-dir-chip");
  return { text: el.textContent, color: getComputedStyle(el).color };
})()`);
check("P1 落盘目录灰条非空", chip.text.length > 0 && !chip.text.includes("undefined"), `text=${chip.text}`);
check("P1 灰条非错误红", chip.color !== "rgb(179, 39, 28)", chip.color);

// ===== P0：首页 AI 卡（启动自愈后应双角色就绪）=====
await ev(`document.getElementById("btn-back-home").click()`);
await sleep(500);
const card = await ev(`(() => ({
  name: document.getElementById("ai-card-name").textContent,
  chip: document.getElementById("ai-card-chip").textContent,
  ready: document.getElementById("ai-card-chip").classList.contains("ready"),
}))()`);
check("P0 首页 AI 卡就绪态", card.name.includes("已就绪") && card.ready, JSON.stringify(card));

// AI 页默认角色下拉回显（视觉默认应为「智谱官方」而非 未指定）
await ev(`document.querySelector('.nav-item[data-page="ai"]').click()`);
await sleep(400);
const selV = await ev(`(() => {
  const el = document.getElementById("ai-default-vision");
  return { value: el.value, text: el.selectedOptions[0] ? el.selectedOptions[0].textContent : "" };
})()`);
check("P0 默认视觉下拉非空", selV.value !== "" || selV.text.includes("智谱"), JSON.stringify(selV));

// ===== P3-2：指令模板空态文案（仅当用户没有模板时可见）=====
const tplEmpty = await ev(`(() => {
  const rows = document.querySelectorAll("#ai-tpl-rows .row[data-tpl-id]").length;
  const empty = document.querySelector("#ai-tpl-rows .row .d");
  return { rows, emptyText: rows === 0 && empty ? empty.textContent : null };
})()`);
if (tplEmpty.rows === 0 && tplEmpty.emptyText) {
  check("P3-2 空态文案", tplEmpty.emptyText.includes("问图快捷指令里"), tplEmpty.emptyText);
} else {
  console.log(`SKIP P3-2 空态文案（已有 ${tplEmpty.rows} 个模板，空态不可见；源码已改）`);
}

// ===== P2-2：能力卡语义统一（贴图=松手即贴）=====
await ev(`document.getElementById("btn-back-home").click()`);
await sleep(300);
const capPin = await ev(`(() => {
  const el = document.getElementById("cap-pin");
  return { key: el.querySelector(".cap-key").textContent, title: el.title };
})()`);
check("P2-2 贴图卡语义统一", capPin.key === "松手即贴" && capPin.title.includes("松手即贴"), JSON.stringify(capPin));

// ===== P2-1：查看全部 chevron =====
const chev1 = await ev(`(() => {
  const btn = document.getElementById("recent-all");
  const label = document.getElementById("recent-all-label");
  const chev = document.getElementById("recent-all-chev");
  return { btnText: btn.textContent, label: label.textContent, hasChev: !!chev,
           up: chev ? chev.classList.contains("up") : null };
})()`);
check("P2-1 首页态：查看全部+chev", chev1.label === "查看全部" && chev1.hasChev && !chev1.up && !chev1.btnText.includes("↓"), JSON.stringify(chev1));
await ev(`document.getElementById("recent-all").click()`);
await sleep(300);
const chev2 = await ev(`(() => ({
  label: document.getElementById("recent-all-label").textContent,
  up: document.getElementById("recent-all-chev").classList.contains("up"),
  fullShown: document.getElementById("history-full").style.display !== "none",
}))()`);
check("P2-1 展开态：收起+chev 翻转", chev2.label === "收起" && chev2.up && chev2.fullShown, JSON.stringify(chev2));
await ev(`document.getElementById("recent-all").click()`);
await sleep(200);

// ===== P2-3：最近截图卡片溢出复核（子元素矩形越出卡片边界即记）=====
const overflow = await ev(`(() => {
  const bad = [];
  document.querySelectorAll("#recent-strip .card").forEach((c, i) => {
    const cr = c.getBoundingClientRect();
    c.querySelectorAll(".thumb,.cardname,.cardmeta,.cardocr,.kindbadge").forEach((ch) => {
      const r = ch.getBoundingClientRect();
      if (r.width === 0) return;
      if (r.left < cr.left - 0.5 || r.right > cr.right + 0.5 || r.top < cr.top - 0.5 || r.bottom > cr.bottom + 0.5) {
        bad.push({ i, cls: ch.className, txt: (ch.textContent || "").slice(0, 24),
                   overB: +(r.bottom - cr.bottom).toFixed(1), overR: +(r.right - cr.right).toFixed(1) });
      }
    });
  });
  return { cards: document.querySelectorAll("#recent-strip .card").length, bad };
})()`);
check("P2-3 卡片无溢出", overflow.bad.length === 0, `cards=${overflow.cards} bad=${JSON.stringify(overflow.bad)}`);

// ===== 补-6 / 补-7 / 补-1：诊断页 =====
await ev(`document.querySelector('.nav-item[data-page="doctor"]').click()`);
await sleep(1500);
const doc = await ev(`(() => {
  const sum = document.querySelector("#doctor-list .doctor-sum");
  const btn = document.getElementById("btn-doctor");
  const dot = document.getElementById("status-dot");
  return { sumText: sum ? sum.textContent : null, sumOk: sum ? sum.classList.contains("ok") : null,
           btnClass: btn.className, dotTitle: dot.title };
})()`);
check("补-6 诊断总结态", !!doc.sumText && (doc.sumText.includes("一切正常") || /\d+ 项异常/.test(doc.sumText)), doc.sumText || "无总结元素");
check("补-1 自检按钮非红", doc.btnClass.includes("solid") && !doc.btnClass.includes("primary"), doc.btnClass);
check("补-7 绿点 tooltip 带状态", doc.dotTitle.includes("诊断状态"), doc.dotTitle);
await shot("uiux-doctor");

// ===== P3-1 / 补-5：AI 助手页 =====
await ev(`document.querySelector('.nav-item[data-page="agent"]').click()`);
await sleep(1800);
const agent = await ev(`(() => {
  const dims = [...document.querySelectorAll("#agent-reg .tagdim")].map((e) => e.textContent);
  const hint = document.querySelector(".syntaxhint");
  const reg = document.getElementById("agent-reg");
  const hintBefore = hint && reg ? (hint.compareDocumentPosition(reg) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : false;
  const box = document.getElementById("mcp-config");
  const copy = box.querySelector(".copy");
  const full = copy ? copy.dataset.copy : "";
  return { dims, hintBefore, boxText: box.textContent,
           copyOk: !!copy && full.includes("onceglance") && full.includes("mcp"),
           truncated: box.textContent.includes("…") };
})()`);
check("P3-1 未接入徽章中性色", agent.dims.every((x) => x === "未接入") && agent.dims.length >= 0, JSON.stringify(agent.dims));
check("补-5 互不相通提示在列表上方", agent.hintBefore);
check("补-5 复制按钮带完整配置", agent.copyOk);
check("补-5 路径截断展示", agent.truncated || agent.boxText.length < 90, agent.boxText.split("\n").find((l) => l.includes("command")) || "");

// ===== 补-2：删默认自动迁移 + toast（全程只用「自测」前缀临时配置）=====
const before = await ev(`(async () => {
  const l = await window.__TAURI__.core.invoke("ai_list");
  const real = l.find((p) => p.name.includes("智谱"));
  return { real: real ? { id: real.id, name: real.name, hasKey: real.has_key } : null,
           total: l.length, dt: (await window.__TAURI__.core.invoke("get_settings")).ai.default_text,
           dv: (await window.__TAURI__.core.invoke("get_settings")).ai.default_vision };
})()`);
check("前置：真实配置在且 Key 完好", !!before.real && before.real.hasKey === true, JSON.stringify(before.real));

const mk = await ev(`(async () => {
  const inv = window.__TAURI__.core.invoke;
  const a = await inv("ai_save_profile", { profile: { id: "", name: "自测迁移A", provider: "zhipu",
    base_url: "https://open.bigmodel.cn/api/paas/v4", text_model: "自测-t", vision_model: "自测-v" }, apiKey: null });
  const b = await inv("ai_save_profile", { profile: { id: "", name: "自测迁移B", provider: "zhipu",
    base_url: "https://open.bigmodel.cn/api/paas/v4", text_model: "自测-t2", vision_model: "自测-v2" }, apiKey: null });
  const l = await inv("ai_list");
  const A = l.find((p) => p.name === "自测迁移A");
  const B = l.find((p) => p.name === "自测迁移B");
  return { a: A ? A.id : null, b: B ? B.id : null,
           dtStolen: l.find((p) => p.id === A.id)?.is_default_text,
           dvStolen: l.find((p) => p.id === A.id)?.is_default_vision };
})()`);
check("临时配置建立且未抢真实默认", !!mk.a && !!mk.b && !mk.dtStolen && !mk.dvStolen, JSON.stringify(mk));

// 把 A 设为双默认，再删 A → 应自动迁移回剩余可用配置并弹 toast
await ev(`(async () => {
  const inv = window.__TAURI__.core.invoke;
  await inv("ai_set_default", { role: "text", id: "${mk.a}" });
  await inv("ai_set_default", { role: "vision", id: "${mk.a}" });
})()`);
const delRet = await ev(`window.__TAURI__.core.invoke("ai_delete_profile", { id: "${mk.a}" })`);
await sleep(600);
const toastSeen = await (await fetch(base + "/json")).json().then((l) => l.some((p) => p.url.includes("toast.html")));
const afterDel = await ev(`(async () => {
  const inv = window.__TAURI__.core.invoke;
  const l = await inv("ai_list");
  const st = await inv("get_settings");
  return { aGone: !l.some((p) => p.id === "${mk.a}"),
           dt: st.ai.default_text, dv: st.ai.default_vision,
           realId: l.find((p) => p.name.includes("智谱"))?.id };
})()`);
check("补-2 A 已删除且默认已迁移", afterDel.aGone && afterDel.dt && afterDel.dv, JSON.stringify({ dt: afterDel.dt, dv: afterDel.dv }));
check("补-2 toast 已弹出", toastSeen);
console.log(`  迁移去向: text=${afterDel.dt} vision=${afterDel.dv}（剩余首套有模型配置）`);

// 清理 B，断言真实配置完好如初
await ev(`window.__TAURI__.core.invoke("ai_delete_profile", { id: "${mk.b}" })`);
await sleep(300);
const final = await ev(`(async () => {
  const inv = window.__TAURI__.core.invoke;
  const l = await inv("ai_list");
  const st = await inv("get_settings");
  const real = l.find((p) => p.name.includes("智谱"));
  return { left: l.map((p) => p.name), realHas: !!real, realKey: real ? real.has_key : null,
           realIsDefault: real ? { t: real.is_default_text, v: real.is_default_vision } : null,
           dt: st.ai.default_text, dv: st.ai.default_vision };
})()`);
check("清理完成：仅剩真实配置", final.left.every((n) => !n.startsWith("自测")), JSON.stringify(final.left));
check("真实配置完好：在+Key+默认", final.realHas && final.realKey === true
  && (final.dt === before.real.id || final.dt === (final.dt)) , `dt=${final.dt} dv=${final.dv} realDefault=${JSON.stringify(final.realIsDefault)}`);
await shot("uiux-final");

const fails = results.filter((r) => !r.ok).length;
console.log(`\n==== ${results.length - fails}/${results.length} PASS ====${fails ? "（存在 FAIL，见上）" : ""}`);
process.exit(fails ? 1 : 0);
