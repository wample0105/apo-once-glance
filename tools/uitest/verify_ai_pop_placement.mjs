// AI 浮层智能避让 + 手柄拖动 真机验证（2026-09-26）
// 断言：①选区中部→浮层向下弹，不与选区相交 ②选区贴底→工具条翻转在上、浮层向上弹，不与选区相交
// ③手柄拖动→浮层自由定位且在屏幕内 ④Esc 关面板回选区编辑态（分层语义不回归）
// 前置：release 新构建实例（9700 CDP）。用法: node tools/uitest/verify_ai_pop_placement.mjs
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

// ---------- 主面板 ----------
const mainList = await jlist();
const main = mainList.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!main) { console.log("FAIL 未找到主面板"); process.exit(2); }
const mws = await attach(main.webSocketDebuggerUrl);
const mcall = mkCaller(mws);
const mEv = (expr) => evOf(mcall, expr);

// overlay 状态确定性：开着就 toggle 关
async function ensureClosed() {
  const list = await jlist();
  const ov = list.find((p) => p.type === "page" && p.url.includes("overlay.html"));
  if (!ov) return;
  const ws = await attach(ov.webSocketDebuggerUrl);
  const call = mkCaller(ws);
  for (let i = 0; i < 5; i++) {
    const active = await evOf(call, `document.body.classList.contains("frozen")`);
    if (!active) return;
    await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`);
    await sleep(900);
  }
  throw new Error("无法关闭残留取景层会话");
}
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
async function escSession(ocall) {
  await evOf(ocall, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(500);
}
// 读三类矩形与相交判定
const geomExpr = `(function(){
  const pop = document.getElementById("ai-pop");
  const pr = pop.getBoundingClientRect();
  const box = document.getElementById("sel");
  const br = box ? box.getBoundingClientRect() : null;
  const tb = document.getElementById("toolbar").getBoundingClientRect();
  const hit = !br ? null : !(pr.right <= br.left || pr.left >= br.right || pr.bottom <= br.top || pr.top >= br.bottom);
  return { pop: { l: Math.round(pr.left), t: Math.round(pr.top), r: Math.round(pr.right), b: Math.round(pr.bottom) },
           sel: br ? { l: Math.round(br.left), t: Math.round(br.top), r: Math.round(br.right), b: Math.round(br.bottom) } : null,
           toolbar: { t: Math.round(tb.top), b: Math.round(tb.bottom) }, hit,
           vw: innerWidth, vh: innerHeight };
})()`;

// ================= 场景 1：选区中部 → 工具条在下 → 浮层向下弹，不遮选区 =================
await ensureClosed();
await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`);
const c1 = await waitOverlayOpen();
const vh1 = await evOf(c1, `innerHeight`);
await dragOn(c1, 300, Math.round(vh1 * 0.25), 900, Math.round(vh1 * 0.55));
await sleep(400);
const g1a = await evOf(c1, geomExpr);
check("场景1 框选后工具条在选区下方", g1a.toolbar.t >= g1a.sel.b - 2, JSON.stringify({ tb: g1a.toolbar, sel: g1a.sel }));
await evOf(c1, `document.getElementById("tb-ocr").click()`);
await sleep(700); // 识别中浮层已弹（本地 OCR 快，直接读几何）
const g1b = await evOf(c1, geomExpr);
check("场景1 AI 浮层向下弹（不与选区相交）", g1b.pop && g1b.hit === false, JSON.stringify({ pop: g1b.pop, hit: g1b.hit }));
await shotOf(c1, "ai-pop-below-sel");
await escSession(c1); // Esc：关浮层/面板回选区
await escSession(c1); // 退出会话

// ================= 场景 2：选区贴底 → 工具条翻到上方 → 浮层向上弹，不遮选区 =================
await ensureClosed();
await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`);
const c2 = await waitOverlayOpen();
const vh2 = await evOf(c2, `innerHeight`);
await dragOn(c2, 300, vh2 - 260, 900, vh2 - 30); // 贴底框选
await sleep(400);
const g2a = await evOf(c2, geomExpr);
check("场景2 框选后工具条翻到选区上方", g2a.toolbar.b <= g2a.sel.t + 2, JSON.stringify({ tb: g2a.toolbar, sel: g2a.sel }));
await evOf(c2, `document.getElementById("tb-ocr").click()`);
await sleep(700);
const g2b = await evOf(c2, geomExpr);
check("场景2 AI 浮层向上弹（不与选区相交）", g2b.pop && g2b.hit === false, JSON.stringify({ pop: g2b.pop, hit: g2b.hit }));
await shotOf(c2, "ai-pop-above-sel");

// ================= 场景 3：手柄拖动 → 自由定位 + 屏幕钳制 =================
// 用 CDP 物理拖动手柄（client 坐标）
const hp = await evOf(c2, `(function(){ const h = document.getElementById("ai-pop-handle").getBoundingClientRect();
  return { x: Math.round(h.left + h.width / 2), y: Math.round(h.top + h.height / 2) }; })()`);
const tx = 150, ty = 60;
await c2("Input.dispatchMouseEvent", { type: "mousePressed", x: hp.x, y: hp.y, button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 10; i++) {
  await c2("Input.dispatchMouseEvent", { type: "mouseMoved", x: hp.x + (tx - hp.x) * i / 10, y: hp.y + (ty - hp.y) * i / 10, button: "left", buttons: 1 });
  await sleep(25);
}
await c2("Input.dispatchMouseEvent", { type: "mouseReleased", x: tx, y: ty, button: "left", buttons: 1 });
await sleep(400);
const g3 = await evOf(c2, geomExpr);
const moved = Math.abs(g3.pop.l - g2b.pop.l) + Math.abs(g3.pop.t - g2b.pop.t) > 40;
const inScreen = g3.pop.l >= 0 && g3.pop.t >= 0 && g3.pop.r <= g3.vw && g3.pop.b <= g3.vh;
check("场景3 手柄拖动生效（位置大幅变化）", moved, JSON.stringify({ from: g2b.pop, to: g3.pop }));
check("场景3 拖后浮层完整在屏幕内", inScreen, JSON.stringify(g3.pop));
await shotOf(c2, "ai-pop-dragged");

// ================= 场景 4：Esc 关面板回选区编辑态（拖动后 Esc 分层不回归）=================
await escSession(c2);
const g4 = await evOf(c2, `(function(){
  const pop = document.getElementById("ai-pop");
  return { popHidden: pop.style.display === "none", frozen: document.body.classList.contains("frozen") };
})()`);
check("场景4 Esc 只关 AI 面板，会话保持", g4.popHidden === true && g4.frozen === true, JSON.stringify(g4));
await escSession(c2);

// ================= 场景 5：退场复位（新会话恢复自动避让）=================
await ensureClosed();
await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`);
const c5 = await waitOverlayOpen();
const vh5 = await evOf(c5, `innerHeight`);
await dragOn(c5, 300, Math.round(vh5 * 0.25), 900, Math.round(vh5 * 0.55));
await sleep(400);
await evOf(c5, `document.getElementById("tb-ocr").click()`);
await sleep(600);
const g5 = await evOf(c5, geomExpr);
check("场景5 新会话浮层恢复自动避让（向下弹）", g5.pop && g5.hit === false, JSON.stringify({ pop: g5.pop, hit: g5.hit }));
await escSession(c5); await escSession(c5);

const pass = results.filter(Boolean).length;
console.log(`\n===== ${pass}/${results.length} PASS =====`);
process.exit(pass === results.length ? 0 : 1);
