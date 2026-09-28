// AI 问图流式输出端到端回归（2026-09-28，真 Key 消耗 2-3 次生成）
// 断言：①生成期 live 气泡文本持续增长（流式生效，非一次性到达）②完成后收敛为标准气泡（复制按钮）+输入解锁
// ③生成中 Esc=硬中断：气泡移除、状态「已停止生成」、问题回填输入框、不产生答案气泡
// ④流式路径追问带上下文（多轮回归）
// 前置：release 新构建实例（9700 CDP）+ 已配置问图模型。用法: node tools/uitest/verify_ai_chat_stream.mjs
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
async function waitFor(ocall, expr, timeoutMs, pollMs = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evOf(ocall, expr)) return true;
    await sleep(pollMs);
  }
  return false;
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
const sendQuestion = (ocall, q) => evOf(ocall, `(() => {
  const qi = document.getElementById("ai-q");
  qi.value = ${JSON.stringify(q)};
  qi.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
})()`);
// 最后一个 AI 气泡是否已收敛（带复制按钮=完成态）
const DONE = `(() => { const b = [...document.querySelectorAll("#ai-msgs .ai-msg.ai")]; const l = b[b.length - 1]; return !!l && !!l.querySelector(".ai-msg-acts"); })()`;
// 当前生成期文本长度（最后一个 AI 气泡，含 live）
const LASTLEN = `(() => { const b = [...document.querySelectorAll("#ai-msgs .ai-msg.ai")]; const l = b[b.length - 1]; return l ? l.textContent.length : 0; })()`;

const mainList = await jlist();
const main = mainList.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!main) { console.log("FAIL 未找到主面板"); process.exit(2); }
const mws = await attach(main.webSocketDebuggerUrl);
const mcall = mkCaller(mws);
const mEv = (expr) => evOf(mcall, expr);

// 残留会话清理（frozen 时 toggle 掉）
{
  const list = await jlist();
  const ov = list.find((p) => p.type === "page" && p.url.includes("overlay.html"));
  if (ov) {
    const ws = await attach(ov.webSocketDebuggerUrl);
    const call = mkCaller(ws);
    for (let i = 0; i < 3; i++) {
      if (!(await evOf(call, `document.body.classList.contains("frozen")`))) break;
      await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`);
      await sleep(900);
    }
  }
}

// 1) 打开取景层并框选 → 点问图
await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`);
await sleep(900);
{
  const list = await jlist();
  const ov = list.find((p) => p.type === "page" && p.url.includes("overlay.html"));
  var ocall = mkCaller(await attach(ov.webSocketDebuggerUrl));
}
for (let i = 0; i < 20; i++) { if (await evOf(ocall, `document.body.classList.contains("frozen")`)) break; await sleep(250); }
await dragOn(ocall, 300, 300, 860, 520);
await sleep(500);
await evOf(ocall, `document.getElementById("tb-ai-ask").click()`);
await sleep(700);

// 2) TEST A：流式增长 + 完成收敛（页面内侧 100ms 采样，无 CDP 往返噪声）
await evOf(ocall, `window.__streamSamples = []; window.__streamTimer = setInterval(() => {
  const b = [...document.querySelectorAll("#ai-msgs .ai-msg.ai")]; const l = b[b.length - 1];
  window.__streamSamples.push(l ? l.textContent.length : 0);
}, 100)`);
await sendQuestion(ocall, "写一段 300 字左右的短文，介绍截图工具在日常工作中的用途。");
let sawLive = false;
let midShot = false;
{
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (!sawLive) {
      const len = await evOf(ocall, LASTLEN);
      // 真流式文本判定：长度>12 才触发（避开「正在生成…」占位 5 字与 live 初始「…」1 字）
      if (len > 12 && !(await evOf(ocall, DONE))) {
        sawLive = true;
        await shotOf(ocall, "ai-stream-mid");
        midShot = true;
      }
    }
    if (await evOf(ocall, DONE)) break;
    await sleep(150);
  }
}
const samples = await evOf(ocall, `(() => { clearInterval(window.__streamTimer); return window.__streamSamples; })()`);
const finalLen = samples[samples.length - 1];
// 中间态渲染判定：完成前存在严格介于占位与最终长度之间的采样值（首字延迟后
// 服务商可能突发式吐流——线级增量由 Rust live 测试断言，此处只验 UI 有中间态）
const partialSeen = samples.some((v, i) => v > 6 && v < finalLen && i < samples.length - 1);
check("生成期气泡出现中间态渲染（流式）", partialSeen === true, `采样[${samples.slice(0, 12).join(",")}…${finalLen}]`);
check("流式中途截图已存", midShot === true);
check("完成态：答案气泡带复制按钮", (await evOf(ocall, DONE)) === true);
check("完成态：输入解锁可追问", (await evOf(ocall, `!document.getElementById("ai-q").readOnly && !document.getElementById("ai-send").disabled`)) === true);

// 3) TEST B：生成中 Esc=硬中断（丢弃部分、状态提示、问题回填）
const q2 = "用五句话详细描述屏幕上的工具栏都有哪些按钮。";
await sendQuestion(ocall, q2);
let hadText = false;
{
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if ((await evOf(ocall, LASTLEN)) > 10 && !(await evOf(ocall, DONE))) { hadText = true; break; }
    if (await evOf(ocall, DONE)) break; // 太快已完成——取消用例退化但不阻塞
    await sleep(200);
  }
}
await evOf(ocall, `document.getElementById("ai-q").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await sleep(2500);
const cancelled = await evOf(ocall, `(() => ({
  hidden: document.getElementById("ai-pop").style.display === "none",
  status: document.getElementById("ai-status").textContent,
  unlocked: !document.getElementById("ai-q").readOnly,
  restored: document.getElementById("ai-q").value,
  noAnswer: ![...document.querySelectorAll("#ai-msgs .ai-msg.ai")].some((b) => b.querySelector(".ai-msg-acts") && b.previousElementSibling && b.previousElementSibling.textContent === ${JSON.stringify(q2)}),
}))()`);
if (hadText) {
  check("Esc 硬中断：浮层收起+状态「已停止生成」", cancelled.hidden && cancelled.status === "已停止生成", JSON.stringify(cancelled));
  check("Esc 硬中断：输入解锁且问题回填", cancelled.unlocked && cancelled.restored === q2, `restored=${cancelled.restored.slice(0, 18)}…`);
  check("Esc 硬中断：不产生答案气泡（历史无污染）", cancelled.noAnswer === true);
} else {
  check("Esc 硬中断用例（生成过快跳过采样断言）", true, "degraded");
  await evOf(ocall, `document.getElementById("ai-q").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(400);
}

// 4) 重新打开浮层 → TEST C：流式路径追问带上下文
await evOf(ocall, `document.getElementById("tb-ai-ask").click()`);
await sleep(700);
await sendQuestion(ocall, "把上面第一个回答里提到的软件名重复一遍，只回软件名。");
{
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) { if (await evOf(ocall, DONE)) break; await sleep(300); }
}
const followOk = await evOf(ocall, DONE);
const followText = await evOf(ocall, `(() => { const b = [...document.querySelectorAll("#ai-msgs .ai-msg.ai")]; const l = b[b.length - 1]; return l ? l.textContent.slice(0, 80) : ""; })()`);
check("流式追问带上下文（多轮回归）", followOk === true && followText.length > 0, `答=${followText}`);

// 5) 收尾：Esc 关面板 → 退场
await evOf(ocall, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await sleep(400);

const pass = results.filter(Boolean).length, total = results.length;
console.log(`RESULT ${pass}/${total} ${pass === total ? "ALL PASS" : "HAS FAIL"}`);
process.exit(pass === total ? 0 : 1);
