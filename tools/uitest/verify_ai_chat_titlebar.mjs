// AI 聊天窗标题栏极简化回归（2026-09-28）
// 断言：①把手点阵已删（handle 内无 circle）②模型名 span 已删，模型信息进 title 提示
// ③右侧两图标按钮 22×22、无文字 ④标题栏整条拖动有效、按钮不触发拖动
// ⑤清空图标按钮清空对话区并恢复 chips ⑥收起按钮隐藏浮窗
// 前置：release 新构建实例（9700 CDP）。用法: node tools/uitest/verify_ai_chat_titlebar.mjs
const base = "http://127.0.0.1:9700";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jlist = async () => (await (await fetch(base + "/json")).json());
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
import fs from "node:fs";
function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  return new Promise((r, j) => { ws.onopen = () => r(ws); ws.onerror = j; });
}
function mkCaller(ws) {
  let seq = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return async (method, params) => { const id = ++seq; return new Promise((r) => { pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); }); };
}
async function evOf(call, expr) {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("页面异常: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 300));
  return r.result?.result?.value;
}
async function shotOf(call, name) {
  const r = await call("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync("tools/out", { recursive: true });
  fs.writeFileSync(`tools/out/${name}.png`, Buffer.from(r.result.data, "base64"));
}

const mainList = await jlist();
const main = mainList.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!main) { console.log("FAIL 未找到主面板"); process.exit(2); }
const mws = await attach(main.webSocketDebuggerUrl);
const mcall = mkCaller(mws);
const mEv = (expr) => evOf(mcall, expr);

async function waitOverlayOpen() {
  const list = await jlist();
  const ov = list.find((p) => p.type === "page" && p.url.includes("overlay.html"));
  if (!ov) throw new Error("未找到取景层 target");
  const ws = await attach(ov.webSocketDebuggerUrl);
  const call = mkCaller(ws);
  for (let i = 0; i < 20; i++) {
    const active = await evOf(call, `document.body.classList.contains("frozen")`);
    if (active) return call;
    await sleep(250);
  }
  throw new Error("取景层未进入活跃态");
}
async function dragOn(ocall, x1, y1, x2, y2) {
  await ocall("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await ocall("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps, button: "left", buttons: 1 });
    await sleep(30);
  }
  await ocall("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 1 });
}

// 1) 打开取景层并框选
await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`);
await sleep(900);
const ocall = await waitOverlayOpen();
await dragOn(ocall, 300, 300, 860, 520);
await sleep(500);

// 2) 点工具条「AI 问图」打开聊天窗
await evOf(ocall, `document.getElementById("tb-ai-ask").click()`);
await sleep(700);

// 3) 结构断言
const struct = await evOf(ocall, `(() => {
  const h = document.getElementById("ai-pop-handle");
  if (!h) return { missing: "handle" };
  const r = h.getBoundingClientRect();
  return {
    circles: h.querySelectorAll("circle").length,
    modelSpan: !!document.getElementById("ai-pop-model"),
    buttons: [...h.querySelectorAll("button")].map((b) => ({
      id: b.id, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height),
      text: b.textContent.trim(), hasSvg: !!b.querySelector("svg"), title: b.title,
    })),
    handleRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    title: h.title,
    cursor: getComputedStyle(h).cursor,
  };
})()`);
if (struct.missing) { console.log("FAIL 聊天窗未打开: " + struct.missing); process.exit(2); }
check("把手点阵已删（无 circle）", struct.circles === 0, `circles=${struct.circles}`);
check("模型名 span 已删", struct.modelSpan === false);
check("标题栏悬浮光标为 grab", struct.cursor === "grab", struct.cursor);
check("tooltip 含模型信息", struct.title.startsWith("拖动窗口") && struct.title.includes("·"), struct.title);
check("右侧恰好两个图标按钮", struct.buttons.length === 2 && struct.buttons.every((b) => b.hasSvg && b.text === ""), JSON.stringify(struct.buttons));
check("按钮 22×22 带悬浮提示", struct.buttons.every((b) => b.w === 22 && b.h === 22 && b.title.length > 4), struct.buttons.map((b) => `${b.id}:${b.w}x${b.h}`).join(","));

// 4) 标题栏整条拖动（抓标题文字处，避开按钮）
const hr = struct.handleRect;
const popBefore = await evOf(ocall, `(() => { const r = document.getElementById("ai-pop").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
// 向左上拖（右下可能触到 clampAiPop 视口底缘回弹，属设计内行为）
await dragOn(ocall, hr.x + 60, hr.y + Math.round(hr.h / 2), hr.x + 60 - 120, hr.y + Math.round(hr.h / 2) - 100);
await sleep(300);
const popAfter = await evOf(ocall, `(() => { const r = document.getElementById("ai-pop").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
check("标题栏拖动移动浮窗", Math.abs(popAfter.x - popBefore.x + 120) <= 6 && Math.abs(popAfter.y - popBefore.y + 100) <= 6, `${popBefore.x},${popBefore.y} → ${popAfter.x},${popAfter.y}`);

// 5) 按钮不触发拖动（mousedown 在按钮上，浮窗位置不变）
const posGuard = await evOf(ocall, `(() => { const r = document.getElementById("ai-pop").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
await dragOn(ocall, struct.buttons[0].w ? (await evOf(ocall, `(() => { const r = document.getElementById("ai-chat-clear").getBoundingClientRect(); return Math.round(r.x + r.width / 2); })()`)) : 0, (await evOf(ocall, `(() => { const r = document.getElementById("ai-chat-clear").getBoundingClientRect(); return Math.round(r.y + r.height / 2); })()`)), 400, 400);
await sleep(200);
const posAfterBtn = await evOf(ocall, `(() => { const r = document.getElementById("ai-pop").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
check("按钮不触发拖动", posAfterBtn.x === posGuard.x && posAfterBtn.y === posGuard.y, `${posGuard.x},${posGuard.y} → ${posAfterBtn.x},${posAfterBtn.y}`);

// 6) 清空按钮：注入两条气泡 → 清空 → 消息区空 + chips 恢复
await evOf(ocall, `(() => {
  const m = document.getElementById("ai-msgs");
  m.innerHTML = '<div class="ai-msg user">测试用户消息</div><div class="ai-msg ai">测试 AI 回复</div>';
  document.getElementById("ai-chips").style.display = "none";
})()`);
await evOf(ocall, `document.getElementById("ai-chat-clear").click()`);
await sleep(200);
const afterClear = await evOf(ocall, `(() => ({ msgs: document.getElementById("ai-msgs").children.length, chips: document.getElementById("ai-chips").style.display }))()`);
check("清空按钮清空对话并恢复 chips", afterClear.msgs === 0 && afterClear.chips === "flex", JSON.stringify(afterClear));

// 7) 收起按钮：浮窗隐藏
await evOf(ocall, `document.getElementById("ai-pop-min").click()`);
await sleep(200);
const minHidden = await evOf(ocall, `document.getElementById("ai-pop").style.display === "none"`);
check("收起按钮隐藏浮窗", minHidden === true);

// 8) 重开 + 造一段演示对话，截图交付
await evOf(ocall, `document.getElementById("tb-ai-ask").click()`);
await sleep(600);
await evOf(ocall, `(() => {
  const m = document.getElementById("ai-msgs");
  m.innerHTML = '<div class="ai-msg user">解释这段内容</div><div class="ai-msg ai">这是一段示例回复：选中区域经视觉模型识别后，回答会以气泡形式呈现在这里，支持继续追问。</div>';
  document.getElementById("ai-chips").style.display = "none";
})()`);
const vw = await evOf(ocall, `window.innerWidth`);
const vh = await evOf(ocall, `window.innerHeight`);
await shotOf(ocall, "ai-chat-titlebar-full");
console.log(`INFO viewport ${vw}x${vh}, pop at ${popAfter.x},${popAfter.y}`);

// Esc 收尾（回选区编辑态 → 再 Esc 退出取景层）
await evOf(ocall, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await sleep(400);

const pass = results.filter(Boolean).length, total = results.length;
console.log(`RESULT ${pass}/${total} ${pass === total ? "ALL PASS" : "HAS FAIL"}`);
process.exit(pass === total ? 0 : 1);
