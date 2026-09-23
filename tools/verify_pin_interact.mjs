// 端到端贴图交互验证：滚轮缩放后双击关闭（用户报障场景）+ Ctrl+滚轮透明度 10 档 + HUD
const base = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => (await (await fetch(base + "/json")).json());
const pinTargets = async () => (await targets()).filter((p) => p.url.includes("pin.html"));

function mkws(url) {
  let nid = 0; const handlers = [];
  const ws = new WebSocket(url);
  const openP = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); for (const h of handlers) h(m); };
  const call = (method, params) => new Promise(async (r) => {
    await openP; const id = ++nid; handlers.push((m) => { if (m.id === id) r(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    const m = await call("Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression: expr });
    if (m.result?.exceptionDetails) return "EVALERR:" + JSON.stringify(m.result.exceptionDetails).slice(0, 250);
    return m.result?.result?.value;
  };
  return { ws, call, ev };
}

// 在 overlay 页上创建一张贴图，返回 { dpr, sel, pinTarget, ws }

async function makePin() {
  const oc = mkws((await targets()).find((p) => p.url.includes("overlay")).webSocketDebuggerUrl);
  await oc.ev(`window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).catch(e=>"ERR:"+e)`);
  await sleep(1600);
  const dpr = await oc.ev(`dprV`);
  const mouse = async (type, x, y, cc = 1, extra = {}) => oc.call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: cc, ...extra });
  await mouse("mousePressed", 500 / dpr, 300 / dpr);
  await mouse("mouseMoved", 900 / dpr, 600 / dpr);
  await mouse("mouseReleased", 900 / dpr, 600 / dpr);
  await sleep(400);
  const sel = await oc.ev(`JSON.stringify({x:toPhys(sel.x),y:toPhys(sel.y),w:toPhys(sel.w),h:toPhys(sel.h)})`);
  const beforeIds = new Set((await pinTargets()).map((p) => p.id));
  await oc.ev(`document.getElementById("tb-pin").click()`);
  await sleep(1200);
  const pin = (await pinTargets()).find((p) => !beforeIds.has(p.id));
  oc.ws.close();
  return { dpr, sel: JSON.parse(sel), pin };
}

// 合成 WheelEvent：WebView2 的 CDP mouseWheel 分发不生效（实测计数 0），合成事件走真实 handler→Rust 链路；
// 双击必须用物理 CDP（Chromium 原生双击检测不可合成）
async function wheelSynth(pc, x, y, deltaY, ctrl) {
  await pc.ev(`window.dispatchEvent(new WheelEvent("wheel", { deltaY: ${deltaY}, ctrlKey: ${!!ctrl}, clientX: ${x}, clientY: ${y} }))`);
}
// 物理双击：两次 down/up，第二次 clickCount=2（Chromium 双击判定）
async function dblclick(c, x, y) {
  for (const [type, cc, btns] of [["mousePressed", 1, 1], ["mouseReleased", 1, 0], ["mousePressed", 2, 1], ["mouseReleased", 2, 0]]) {
    await c.call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: btns, clickCount: cc });
  }
}

async function pinGeoAndState(pin) {
  const pc = mkws(pin.webSocketDebuggerUrl);
  let st = null;
  for (let i = 0; i < 15; i++) {
    st = await pc.ev(`(async()=>{if(typeof window.__TAURI__==="undefined"||!window.__TAURI__.window)return "PENDING";const w=window.__TAURI__.window.getCurrentWindow();const p=await w.outerPosition();const s=await w.outerSize();const hud=document.getElementById("ophud");return JSON.stringify({x:p.x,y:p.y,w:s.width,h:s.height,dpr:devicePixelRatio,imgOp:document.getElementById("img").style.opacity||"1",hud:hud?hud.textContent:null,hudShown:hud?hud.style.display:null});})()`);
    if (typeof st === "string" && (st.startsWith("EVALERR:") || st === "PENDING")) { if (i === 14) console.log("GEO ERR:", st); await sleep(300); continue; }
    break;
  }
  pc.ws.close();
  return JSON.parse(st);
}

const results = [];
const check = (name, ok, info = "") => { results.push(ok); console.log((ok ? "PASS " : "FAIL ") + name + " | " + info); };

const cleanup = async () => {
  const c = mkws((await targets()).find((p) => p.url.includes("overlay")).webSocketDebuggerUrl);
  await c.ev(`window.__TAURI__.core.invoke("pin_close_all").catch(e=>0)`);
  c.ws.close();
};

// ===== 场景 1：滚轮缩放后双击关闭（用户报障：缩放前能关、缩放后不能关） =====
{
  const { dpr, sel, pin } = await makePin();
  const g = await pinGeoAndState(pin);
  const pad = Math.round(24 * dpr);
  const cx = (g.x + pad + (sel.w) / 2) / dpr, cy = (g.y + pad + (sel.h) / 2) / dpr; // 贴图图像区中心（视口坐标）
  const wc = mkws(pin.webSocketDebuggerUrl);
  await wheelSynth(wc, cx, cy, 120); await sleep(250);
  await wheelSynth(wc, cx, cy, 120); await sleep(500); // 缩小两档（真实 set_size）
  wc.ws.close();
  const g2 = await pinGeoAndState(pin);
  await dblclick(mkws(pin.webSocketDebuggerUrl), cx, cy);
  await sleep(900);
  const gone = !(await pinTargets()).some((p) => p.id === pin.id);
  check("缩放后双击关闭（用户报障场景）", gone && g2.w < g.w, "缩放前 " + g.w + "x" + g.h + " → 缩放后 " + g2.w + "x" + g2.h + " 双击后 pin 存在=" + !gone);
}

// ===== 场景 2：Ctrl+滚轮透明度 10 档步进 + HUD 反馈 =====
{
  const { dpr, sel, pin } = await makePin();
  const g = await pinGeoAndState(pin);
  const pad = Math.round(24 * dpr);
  const cx = (g.x + pad + sel.w / 2) / dpr, cy = (g.y + pad + sel.h / 2) / dpr;
  const wc = mkws(pin.webSocketDebuggerUrl);
  await wheelSynth(wc, cx, cy, 120, true); await sleep(250);
  await wheelSynth(wc, cx, cy, 120, true); await sleep(250);
  wc.ws.close();
  const g2 = await pinGeoAndState(pin);
  // 期望：两档下滚 1.0 → 0.8（10 档步进）；HUD 显示 80%
  check("Ctrl+滚轮透明度 10 档（1.0→0.8）+ HUD=80%", g2.imgOp === "0.8" && g2.hud === "80%", JSON.stringify(g2));
  await cleanup();
}

// ===== 场景 3（回归）：不缩放直接双击关闭（阈值拖动不得破坏双击） =====
{
  const { pin } = await makePin();
  const g = await pinGeoAndState(pin);
  const cx = (g.x + g.w / 2) / g.dpr, cy = (g.y + g.h / 2) / g.dpr; // 窗口中心（含 pad，仍在 img 内因 pad 对称）
  const pc = mkws(pin.webSocketDebuggerUrl);
  await dblclick(pc, cx, cy);
  pc.ws.close();
  await sleep(900);
  const gone = !(await pinTargets()).some((p) => p.id === pin.id);
  check("直接双击关闭（回归）", gone, "双击后 pin 存在=" + !gone);
  await cleanup();
}

process.exit(results.every(Boolean) ? 0 : 1);
