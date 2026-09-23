// 端到端贴图验证：点贴图按钮 / 按 F3 → 贴图窗口=选区原位原大+四边阴影边距，overlay park 退场
// 断言期望值全部在页面内按产品坐标体系计算（sel 物理 + dprV），避免手动换算踩坐标坑
const base = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getTargets = async () => (await (await fetch(base + "/json")).json());
const overlayWs = async () => {
  const t = (await getTargets()).find((p) => p.url.includes("overlay"));
  if (!t) throw new Error("overlay target 不存在");
  return t.webSocketDebuggerUrl;
};
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
    if (m.result?.exceptionDetails) return "EVALERR:" + JSON.stringify(m.result.exceptionDetails).slice(0, 300);
    return m.result?.result?.value;
  };
  return { ws, call, ev };
}
// pin 页冷启动慢（debug 构建+大图注入），轮询等 tauri API 就绪再取几何
async function pinGeoOf(target) {
  const pc = mkws(target.webSocketDebuggerUrl);
  let geo = null;
  for (let i = 0; i < 20; i++) {
    geo = await pc.ev(`(async()=>{if(typeof window.__TAURI__==="undefined"||!window.__TAURI__.window)return "PENDING";const w=window.__TAURI__.window.getCurrentWindow();const p=await w.outerPosition();const s=await w.outerSize();return JSON.stringify({x:p.x,y:p.y,w:s.width,h:s.height,dpr:devicePixelRatio,padStyle:document.body.style.padding||null});})()`);
    if (typeof geo === "string" && geo.startsWith("EVALERR:")) { await sleep(300); continue; }
    if (geo === "PENDING") { await sleep(300); continue; }
    break;
  }
  pc.ws.close();
  return geo;
}
const mouse = (c, type, x, y) => c.call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });

async function pinWins() { return (await getTargets()).filter((p) => p.url.includes("pin.html")); }

async function runFlow(trigger) {
  const oc = mkws(await overlayWs());
  await oc.ev(`window.__errs=[];window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).catch(e=>"ERR:"+e)`);
  await sleep(1600);
  const dpr = await oc.ev(`dprV`);
  // 物理选区 (500,300)-(900,600)；Input 坐标=视口 CSS px
  await mouse(oc, "mousePressed", 500 / dpr, 300 / dpr);
  await mouse(oc, "mouseMoved", 900 / dpr, 600 / dpr);
  await mouse(oc, "mouseReleased", 900 / dpr, 600 / dpr);
  await sleep(400);
  const selPhys = await oc.ev(`JSON.stringify({x:toPhys(sel.x),y:toPhys(sel.y),w:toPhys(sel.w),h:toPhys(sel.h)})`);
  const beforeIds = new Set((await pinWins()).map((p) => p.id));
  const before = beforeIds.size;
  if (trigger === "button") {
    await oc.ev(`document.getElementById("tb-pin").click()`);
  } else {
    for (const ty of ["rawKeyDown", "keyUp"]) await oc.call("Input.dispatchKeyEvent", { type: ty, key: "F3", code: "F3", windowsVirtualKeyCode: 114 });
  }
  await sleep(900);
  const after = await pinWins();
  const ovPos = await oc.ev(`(async()=>{const w=window.__TAURI__.window.getCurrentWindow();const p=await w.outerPosition();return JSON.stringify(p);})()`);
  // 新出现的 pin target：按 target id 差集精确匹配（列表顺序不可靠）
  const newPin = after.find((p) => !beforeIds.has(p.id)) || null;
  let pinGeo = null;
  if (newPin) pinGeo = await pinGeoOf(newPin);
  const jp = (tag, s) => { try { return JSON.parse(s); } catch (e) { console.log("RAW " + tag + ":", s); return null; } };
  const r = { dpr, selPhys: jp("selPhys", selPhys), pinCount: after.length, ovPos: jp("ovPos", ovPos), pinGeo: pinGeo ? jp("pinGeo", pinGeo) : null, errs: await oc.ev(`(window.__errs||[]).slice(-3)`) };
  oc.ws.close();
  return r;
}

function judge(tag, r) {
  const pad = Math.round(24 * r.dpr);
  const s = r.selPhys;
  const near = (a, b) => Math.abs(a - b) <= 2; // 拖框取整允许 ±2px
  const g = r.pinGeo;
  const ok = g && typeof g === "object"
    && near(g.x, s.x - pad) && near(g.y, s.y - pad)
    && near(g.w, s.w + 2 * pad) && near(g.h, s.h + 2 * pad)
    && g.padStyle === pad / g.dpr + "px"
    && r.ovPos && r.ovPos.x <= -19000;
  console.log((ok ? "PASS " : "FAIL ") + tag + " | " + JSON.stringify(r));
  return ok;
}

const cleanup = async () => {
  try {
    const c = mkws(await overlayWs());
    await c.ev(`window.__TAURI__.core.invoke("pin_close_all").catch(e=>0)`);
    c.ws.close();
  } catch (e) {}
};

const a = await runFlow("button");
const okA = judge("按钮贴图：原位原大+pad 阴影边距+overlay park", a);
await cleanup(); await sleep(300);
const b = await runFlow("f3");
const okB = judge("F3 贴图：同语义", b);
await cleanup();
process.exit(okA && okB ? 0 : 1);
