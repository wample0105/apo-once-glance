// 贴图全 CDP 驱动验证：start_overlay → Input 域框选 → 点贴图 → 读 pin 窗口图片状态
// 不使用 SendInput/物理键鼠，纯 CDP（trusted 事件），不会被取消也不干扰用户
const base = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(t) {
  return new Promise(async (res, rej) => {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    ws.onopen = () => res(ws); ws.onerror = rej;
  });
}
let nid = 0;
function call(ws, method, params) {
  return new Promise((r) => {
    const id = ++nid;
    const h = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener("message", h); r(m); } };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const ev = (ws, expr) => call(ws, "Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression: expr })
  .then((m) => m.result?.result?.value);
async function mouse(ws, type, x, y, extra = {}) {
  await call(ws, "Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
}

// 1. overlay target
const list = await (await fetch(base + "/json")).json();
const t = list.find((p) => p.url.includes("overlay"));
if (!t) { console.log("无 overlay target:", list.map((p) => p.url)); process.exit(1); }
const ws = await connect(t);

// 2. 拉起截图（等价热键）
const pull = await ev(ws, `window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).then(()=>"ok").catch(e=>"ERR:"+e)`);
console.log("start_overlay:", pull);
if (pull !== "ok") process.exit(1);
await sleep(3000);

// 3. 框选 (500,300)→(1000,700)
await mouse(ws, "mousePressed", 500, 300);
await mouse(ws, "mouseMoved", 650, 420); await mouse(ws, "mouseMoved", 820, 560); await mouse(ws, "mouseMoved", 1000, 700);
await mouse(ws, "mouseReleased", 1000, 700);
await sleep(700);

// 4. 定位贴图按钮并点击（trusted 事件）
const rect = await ev(ws, `(function(){const b=document.getElementById('tb-pin');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()`);
console.log("tb-pin rect:", JSON.stringify(rect));
if (!rect || rect.w <= 0) { console.log("贴图按钮不可见"); process.exit(1); }
await mouse(ws, "mousePressed", Math.round(rect.x), Math.round(rect.y));
await mouse(ws, "mouseReleased", Math.round(rect.x), Math.round(rect.y));
await sleep(2500);

// 5. 找 pin target，读注入与图片加载状态
const list2 = await (await fetch(base + "/json")).json();
const p = list2.find((q) => /pin\.html/.test(q.url));
if (!p) { console.log("未发现 pin 窗口。targets:", list2.map((q) => q.url)); process.exit(1); }
console.log("pin target:", p.url);
const ws2 = await connect(p);
const v = await ev(ws2, `(function(){
  const img = document.getElementById('img'); const src = window.__PIN_SRC || '';
  return { injected: src.startsWith('data:image/png;base64,'), injected_len: src.length,
    has_img: !!img, complete: img ? img.complete : null,
    natural_w: img ? img.naturalWidth : null, natural_h: img ? img.naturalHeight : null,
    img_src_head: img ? img.src.slice(0,30) : null, win: [innerWidth, innerHeight] };})()`);
console.log(JSON.stringify(v, null, 2));
// 截屏存档（贴图窗口自身画面）
const shot = await call(ws2, "Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("tools/out/pin_cdp_shot.png", Buffer.from(shot.result.data, "base64"));
  console.log("贴图窗口截图已存 tools/out/pin_cdp_shot.png");
}
ws2.close();

// 6. 清场：Esc 退出 overlay + 关闭贴图
for (const ty of ["rawKeyDown", "keyUp"]) await call(ws, "Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(400);
for (const ty of ["rawKeyDown", "keyUp"]) await call(ws, "Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await ev(ws, `window.__TAURI__.core.invoke("pin_close_all").catch(()=>{})`);
ws.close();

const ok = v && v.injected && v.natural_w > 0;
console.log(ok ? "贴图渲染 ✓（data URL 注入 + 图片加载成功）" : "贴图仍有问题 ✗");
process.exit(ok ? 0 : 1);
