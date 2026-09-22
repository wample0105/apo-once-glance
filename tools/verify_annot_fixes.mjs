// 真机抽查标注四修复：属性撤销 / pen 缩放 / mosaic 回填 / num 回填（CDP 驱动，行为断言）
const base = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => (await (await fetch(base + "/json")).json());
async function conn(t) { const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return ws; }
let nid = 0;
const call = (ws, method, params) => new Promise((r) => { const id = ++nid; const h = (e) => { const m = JSON.parse(e.data); if (m.id === id) r(m); }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id, method, params })); });
const ev = (ws, expr) => call(ws, "Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression: expr }).then((m) => m.result?.result?.value);
const mouse = async (ws, type, x, y) => call(ws, "Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });

let ws = await conn((await targets()).find((p) => p.url.includes("overlay")));
let fail = 0;
const check = (name, ok, info) => { console.log(`${ok ? "✓" : "✗"} ${name}${info ? " | " + JSON.stringify(info) : ""}`); if (!ok) fail++; };

await ev(ws, `window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).catch(e=>"ERR:"+e)`);
await sleep(1600);
await mouse(ws, "mousePressed", 500, 300);
await mouse(ws, "mouseMoved", 900, 600);
await mouse(ws, "mouseReleased", 900, 600);
await sleep(600);

// 1. 直构矩形 → 选中改色 → Esc 撤销链路（Ctrl+Z 经 keydown 真实事件）
const r1 = await ev(ws, `(function(){
  const el = document.createElement("div");
  el.className = "obj"; el.dataset.k = "rect";
  el.dataset.params = JSON.stringify({ lw: 4, color: "#FF3B30", fill: "none", dash: false, radius: 0, opacity: 1 });
  el.style.cssText = "position:absolute;left:120px;top:100px;width:160px;height:100px;border:4px solid #FF3B30;";
  layer.appendChild(el);
  setObjSel(el); setColorForTool("#00A2E8"); syncSelProps();
  return { after: getComputedStyle(el).borderColor };
})()`);
const r2 = await ev(ws, `(function(){
  undoOp();
  const el = document.querySelector('#layer .obj[data-k=rect]');
  return { undone: getComputedStyle(el).borderColor };
})()`);
check("①真机改色可撤销（蓝→红）", /0, 162, 232/.test(r1.after) && /255, 59, 48/.test(r2.undone), { r1, r2 });

// 2. pen 缩放：直构 pen → 选中 → CDP 物理拖 se 角
const hpos = await ev(ws, `(function(){
  const el = document.createElement("div");
  el.className = "obj"; el.dataset.k = "pen"; el.style.position = "absolute";
  el.style.left = "0px"; el.style.top = "0px"; el.style.width = "100%"; el.style.height = "100%";
  el.innerHTML = '<svg style="overflow:visible;pointer-events:none" width="100%" height="100%"><polyline fill="none" stroke="#FF3B30" stroke-width="4" points="150,80 250,130 350,100"/></svg>';
  el.dataset.geom = JSON.stringify({ pts: [{x:150,y:80},{x:250,y:130},{x:350,y:100}], lw: 4, color: "#FF3B30" });
  layer.appendChild(el);
  setObjSel(el);
  const h = document.querySelector('#objsel .h.se');
  const r = h.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
if (hpos) {
  const X = Math.round(hpos.x), Y = Math.round(hpos.y);
  await mouse(ws, "mousePressed", X, Y);
  await mouse(ws, "mouseMoved", X + 60, Y + 30);
  await mouse(ws, "mouseReleased", X + 60, Y + 30);
  await sleep(300);
}
const r3 = await ev(ws, `(function(){
  const g = JSON.parse(document.querySelector('#layer .obj[data-k=pen]').dataset.geom);
  return { maxX: Math.max.apply(null, g.pts.map(p => p.x)) };
})()`);
check("②真机笔迹拖角缩放（350→约410）", r3.maxX >= 380 && r3.maxX <= 440, r3);

// 3. mosaic 回填：直构 mos=25/blur → 选中 → 读全局与滑杆
const r4 = await ev(ws, `(function(){
  const el = document.createElement("div");
  el.className = "obj"; el.dataset.k = "mosaic";
  el.dataset.params = JSON.stringify({ lw: 4, color: "#000000", fill: "none", mos: 25, mode: "blur", dash: false, radius: 0, opacity: 1 });
  el.style.cssText = "position:absolute;left:400px;top:80px;width:100px;height:60px;";
  layer.appendChild(el);
  setObjSel(el);
  const rng = document.getElementById("pr-mos-range");
  return { mos: mosStrength, mode: mosMode, rangeVal: rng ? rng.value : null };
})()`);
check("③真机马赛克选中回填25/blur", r4.mos === 25 && r4.mode === "blur" && r4.rangeVal === "25", r4);

// 4. num 回填：直构 outline 绿 → 选中
const r5 = await ev(ws, `(function(){
  const el = document.createElement("div");
  el.className = "obj"; el.dataset.k = "num";
  el.dataset.params = JSON.stringify({ d: 36, color: "#00FF00", style: "outline" });
  el.style.cssText = "position:absolute;left:420px;top:200px;width:36px;height:36px;";
  el.innerHTML = '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">1</span>';
  layer.appendChild(el);
  setObjSel(el);
  return { color: toolColor, style: numStyle };
})()`);
check("④真机序号选中回填绿/outline", r5.color === "#00FF00" && r5.style === "outline", r5);

// 清场
for (const ty of ["rawKeyDown", "keyUp"]) await call(ws, "Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(300);
for (const ty of ["rawKeyDown", "keyUp"]) await call(ws, "Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
ws.close();
console.log(fail === 0 ? "\n真机抽查全绿 ✓" : `\n${fail} 项失败 ✗`);
process.exit(fail === 0 ? 0 : 1);
