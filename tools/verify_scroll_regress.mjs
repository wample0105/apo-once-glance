// 验证"长截图后区域截图无反应"修复：长截图全流程 → 完成 → 再拉起截图断言蒙版渲染
const base = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() { return (await (await fetch(base + "/json")).json()); }
async function conn(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
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
const ev = (ws, expr) => call(ws, "Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression: expr }).then((m) => m.result?.result?.value);
async function mouse(ws, type, x, y) {
  await call(ws, "Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
}

// 1. 拉起 + 框选
let t = (await targets()).find((p) => p.url.includes("overlay"));
let ws = await conn(t);
console.log("start_overlay:", await ev(ws, `window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).then(()=>"ok").catch(e=>"ERR:"+e)`));
await sleep(1500);
await mouse(ws, "mousePressed", 500, 300);
await mouse(ws, "mouseMoved", 700, 450); await mouse(ws, "mouseMoved", 1000, 700);
await mouse(ws, "mouseReleased", 1000, 700);
await sleep(700);

// 2. 点长截图按钮 → startLongshot（overlay_hide=park → scroll_start → endbar）
const rect = await ev(ws, `(function(){const b=document.getElementById('tb-scroll');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width};})()`);
console.log("tb-scroll rect:", JSON.stringify(rect));
if (!rect || rect.w <= 0) { console.log("长截图按钮不可见 ✗"); process.exit(1); }
await mouse(ws, "mousePressed", Math.round(rect.x), Math.round(rect.y));
await mouse(ws, "mouseReleased", Math.round(rect.x), Math.round(rect.y));
await sleep(2500);

// 3. endbar 出现 → 点完成（scroll_finish）
let eb = (await targets()).find((p) => p.url.includes("endbar"));
if (!eb) { console.log("endbar 未出现 ✗ targets:", (await targets()).map((p) => p.url)); process.exit(1); }
console.log("endbar 出现 ✓");
const wse = await conn(eb);
const drect = await ev(wse, `(function(){const b=document.getElementById('done');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
console.log("done rect:", JSON.stringify(drect));
await mouse(wse, "mousePressed", Math.round(drect.x), Math.round(drect.y));
await mouse(wse, "mouseReleased", Math.round(drect.x), Math.round(drect.y));
await sleep(3000); // scroll_finish + 保存落盘 + toast
wse.close();

// 4. 再次拉起区域截图 → 断言蒙版与冻结图真实渲染
ws = await conn((await targets()).find((p) => p.url.includes("overlay")));
console.log("第二次 start_overlay:", await ev(ws, `window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).then(()=>"ok").catch(e=>"ERR:"+e)`));
await sleep(1800);
const st = await ev(ws, `(function(){
  const fr = document.getElementById('freeze');
  const hint = document.getElementById('cancelhint');
  return { magSrc: fr && fr.src ? fr.src.slice(0,22) : 'empty',
    frozen: document.body.classList.contains('frozen'),
    dimIdle: document.getElementById('stage') ? document.getElementById('stage').classList.contains('dim-idle') : false,
    hint: hint ? hint.textContent.slice(0,12) : null };})()`);
console.log("二次拉起状态:", JSON.stringify(st));
const shot = await call(ws, "Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("tools/out/after_scroll_overlay.png", Buffer.from(shot.result.data, "base64"));
  console.log("overlay 画面已存 tools/out/after_scroll_overlay.png");
}
// 清场：Esc 退出
for (const ty of ["rawKeyDown", "keyUp"]) await call(ws, "Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(300);
for (const ty of ["rawKeyDown", "keyUp"]) await call(ws, "Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
ws.close();
const ok = st && st.frozen && st.magSrc !== 'empty' && st.hint;
console.log(ok ? "长截图后区域截图恢复正常 ✓" : "仍然异常 ✗");
process.exit(ok ? 0 : 1);
