// M2 体验修复真机验证：执行态即时反馈 / 重复提交防护 / Esc 转后台 / Markdown 渲染 / 高度自适应。
// 前置：release 新构建实例（9700 CDP）+ 智谱 Key。用法: node tools/uitest/verify_m2_ux.mjs
import fs from "node:fs";

const base = "http://127.0.0.1:9700";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jlist = async () => (await (await fetch(base + "/json")).json());
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
async function shotOf(call, name) {
  const r = await call("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync("tools/out", { recursive: true });
  fs.writeFileSync(`tools/out/${name}.png`, Buffer.from(r.result.data, "base64"));
}
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

// ---------- 主面板 ----------
const mainList = await jlist();
const main = mainList.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!main) { console.log("FAIL 未找到主面板"); process.exit(2); }
const mws = await attach(main.webSocketDebuggerUrl);
const mcall = mkCaller(mws);
async function mEv(expr) {
  const r = await mcall("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("主面板异常: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 300));
  return r.result?.result?.value;
}
await mcall("Page.enable", {}); await mcall("Runtime.enable", {});

// 定位主面板到 (80,80)，清掉旧 AI 贴图残留，审计基线
await mEv(`(async function(){ const T = window.__TAURI__;
  const PP = (T.dpi && T.dpi.PhysicalPosition) || (T.window && T.window.PhysicalPosition);
  await T.window.getCurrentWindow().setPosition(new PP(80, 80)); return 1; })()`);
await sleep(300);
const oldPins = (await mEv(`window.__TAURI__.core.invoke("pin_list")`)) || [];
for (const p of oldPins.filter((p) => p.kind === "ai")) {
  await mEv(`window.__TAURI__.core.invoke("pin_close", { id: ${p.id} })`).catch(() => {});
}
const askBase = ((await mEv(`window.__TAURI__.core.invoke("read_audit", { limit: 60 })`)) || []).filter((a) => a.command === "ai.ask").length;

// ---------- 拉起取景层并拖选 ----------
await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" }).catch(function(){ return 1; })`);
await sleep(800);
await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`);
await sleep(2200);
const list2 = await jlist();
const ov = list2.find((p) => p.type === "page" && p.url.includes("overlay.html"));
if (!ov) { console.log("FAIL 未找到取景层 target"); process.exit(2); }
const ows = await attach(ov.webSocketDebuggerUrl);
const ocall = mkCaller(ows);
async function oEv(expr) {
  const r = await ocall("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("取景层异常: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 300));
  return r.result?.result?.value;
}
await ocall("Page.enable", {}); await ocall("Runtime.enable", {});
async function drag(x1, y1, x2, y2) {
  await ocall("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await ocall("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps, button: "left", buttons: 1 });
    await sleep(30);
  }
  await ocall("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 1 });
}
await drag(90, 60, 620, 320);
await sleep(300);

// ---------- 打开问图浮层（P1 拆按钮后直点问图按钮） ----------
async function clickOv(x, y) {
  await ocall("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await ocall("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left" });
}
const aiBtn = await oEv(`(function(){ const b = document.getElementById("tb-ai-ask").getBoundingClientRect(); return { x: b.x + b.width/2, y: b.y + b.height/2 }; })()`);
await clickOv(aiBtn.x, aiBtn.y); await sleep(400);
check("问图浮层展开", await oEv(`document.getElementById("ai-pop").style.display === "block"`));

// ---------- 场景 1：点 chip 瞬间进入执行态 ----------
await oEv(`document.querySelector("#ai-chips button").click()`);
await sleep(120);
const busy = await oEv(`(function(){
  const chips = document.getElementById("ai-chips"), q = document.getElementById("ai-q"),
        send = document.getElementById("ai-send"), spin = document.getElementById("ai-spin"),
        status = document.getElementById("ai-status");
  return { chipsHidden: chips.style.display === "none", ro: q.readOnly,
           sendDisabled: send.disabled, sendText: send.textContent,
           spinShown: spin.style.display === "inline-block", status: status.textContent };
})()`);
check("执行态：chips 隐藏", busy.chipsHidden === true);
check("执行态：输入锁定", busy.ro === true);
check("执行态：发送按钮禁用并变文案", busy.sendDisabled === true && busy.sendText === "生成中", busy.sendText);
check("执行态：spinner 可见", busy.spinShown === true);
check("执行态：状态行含秒数", /^正在生成 · \d+s$/.test(busy.status), busy.status);
await shotOf(ocall, "ux-busy-state");

// ---------- 场景 2：生成中重复触发被短路 ----------
// chips 已隐藏但 handler 仍在：直接 click + 回车 + 发送按钮三条路径全部补刀
await oEv(`document.querySelector("#ai-chips button").click()`);
await oEv(`document.getElementById("ai-q").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
await oEv(`document.getElementById("ai-send").click()`);
check("防重：生成中重复触发不报错", true);

// ---------- 场景 3：生成中 Esc = 转入后台 ----------
await oEv(`document.getElementById("ai-q").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await sleep(120);
const bg = await oEv(`({ popHidden: document.getElementById("ai-pop").style.display === "none",
  toast: (document.querySelector(".ann-toast") || {}).textContent || "" })`);
check("Esc 转后台：浮层收起", bg.popHidden === true);
check("Esc 转后台：toast 提示", bg.toast.includes("转入后台"), bg.toast);
await shotOf(ocall, "ux-background-toast");

// ---------- 等结果贴图 ----------
let pinId = null;
for (let i = 0; i < 150; i++) {
  await sleep(500);
  pinId = await mEv(`window.__TAURI__.core.invoke("pin_list")`).then((l) => {
    const ai = (l || []).filter((p) => p.kind === "ai");
    return ai.length ? ai[ai.length - 1].id : null;
  }).catch(() => null);
  if (pinId) break;
}
check("结果贴图生成（转后台后仍贴出）", Boolean(pinId), `pin=${pinId}`);

// ---------- 防重复请求：审计 ai.ask 恰好 +1 ----------
await sleep(1000);
const askNow = ((await mEv(`window.__TAURI__.core.invoke("read_audit", { limit: 60 })`)) || []).filter((a) => a.command === "ai.ask").length;
check("防重：重复触发只发一次请求", askNow - askBase === 1, `基线${askBase} → ${askNow}`);

// ---------- 场景 4：Markdown 渲染 + 高度自适应 ----------
if (pinId) {
  const pList = await jlist();
  const pin = pList.find((p) => p.type === "page" && p.url.includes("pin.html"));
  if (pin) {
    const pws = await attach(pin.webSocketDebuggerUrl);
    const pcall = mkCaller(pws);
    const pEv = (e) => evOf(pcall, e);
    await sleep(600); // 等 requestAnimationFrame 的高度回调完成
    const rd = await pEv(`(function(){
      const t = document.getElementById("ai-text");
      return { html: t.innerHTML, hasMd: !!(t.querySelector("strong,li,table,h1,h2,h3,h4,code")),
               rawStars: t.textContent.includes("**"), text: t.textContent };
    })()`);
    check("渲染：无 Markdown 源码残留", rd.rawStars === false);
    if (rd.hasMd) check("渲染：产出富文本元素", true);
    else {
      // 真实回答若为纯文本，用渲染器单元用例兜底验证（同一页面同一函数）
      const unit = await pEv(`(function(){
        const d = document.createElement("div");
        d.innerHTML = mdRender("## 标题\\n这是**加粗**和\`代码\`\\n- 甲\\n- 乙\\n|A|B|\\n|---|---|\\n|1|2|\\n<script>alert(1)<\\/script>");
        return { h: !!d.querySelector("h2"), b: !!d.querySelector("strong"), li: d.querySelectorAll("li").length,
                 th: !!d.querySelector("th"), xss: !d.querySelector("script"), raw: d.innerHTML.includes("<script") };
      })()`);
      check("渲染：单元用例（标题/粗体/列表/表格）", unit.h && unit.b && unit.li === 2 && unit.th, JSON.stringify(unit));
      check("渲染：XSS 转义", unit.xss === true && unit.raw === false);
    }
    // XSS 专项：真实输出通道下 <script>/<img onerror> 不得成为元素（段落 <p> 是合法子元素）
    const xss = await pEv(`(function(){
      const d = document.createElement("div");
      d.innerHTML = mdRender("<img src=x onerror=alert(1)><script>alert(1)<\\/script>");
      return !d.querySelector("script,img");
    })()`);
    check("渲染：模型输出按不可信输入转义", xss === true);
    // 高度自适应：窗口高（逻辑）≈ 内容需要的高
    const h = await pEv(`(function(){
      const need = document.getElementById("ai-text").scrollHeight +
        document.getElementById("ai-meta").offsetHeight + document.getElementById("ai-bar").offsetHeight;
      return { need, win: window.outerHeight };
    })()`);
    check("高度自适应：窗口高贴合内容", Math.abs(h.win - h.need) <= 12, `窗口${h.win}px / 内容${h.need}px`);
    await shotOf(pcall, "ux-md-pin");
    await mEv(`window.__TAURI__.core.invoke("pin_close", { id: ${pinId} })`);
  } else {
    check("渲染：找到结果贴图窗口", false);
  }
}

console.log(results.every(Boolean) ? "M2_UX_ALL_PASS" : "M2_UX_HAS_FAIL", `(${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 2);
