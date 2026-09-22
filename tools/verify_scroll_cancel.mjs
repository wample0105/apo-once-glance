// 取消分支：长截图 → endbar ✕（scroll_cancel）→ 再拉起截图断言正常
const base = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => (await (await fetch(base + "/json")).json());
async function conn(t) { const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return ws; }
let nid = 0;
const call = (ws, method, params) => new Promise((r) => { const id = ++nid; const h = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener("message", h); r(m); } }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id, method, params })); });
const ev = (ws, expr) => call(ws, "Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression: expr }).then((m) => m.result?.result?.value);
const mouse = async (ws, type, x, y) => call(ws, "Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });

let ws = await conn((await targets()).find((p) => p.url.includes("overlay")));
await ev(ws, `window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).catch(e=>"ERR:"+e)`);
await sleep(1500);
await mouse(ws, "mousePressed", 400, 250);
await mouse(ws, "mouseMoved", 800, 500); await mouse(ws, "mouseReleased", 800, 500);
await sleep(600);
const rect = await ev(ws, `(function(){const b=document.getElementById('tb-scroll');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
await mouse(ws, "mousePressed", Math.round(rect.x), Math.round(rect.y));
await mouse(ws, "mouseReleased", Math.round(rect.x), Math.round(rect.y));
await sleep(2200);
console.log("点击长截图后 targets:", (await targets()).map((p) => p.url));
const eb = (await targets()).find((p) => p.url.includes("endbar"));
if (!eb) { console.log("endbar 未出现 ✗"); process.exit(1); }
const wse = await conn(eb);
const xr = await ev(wse, `(function(){const b=document.getElementById('x');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
await mouse(wse, "mousePressed", Math.round(xr.x), Math.round(xr.y));
await mouse(wse, "mouseReleased", Math.round(xr.x), Math.round(xr.y));
await sleep(1500);
wse.close();
ws = await conn((await targets()).find((p) => p.url.includes("overlay")));
const r2 = await ev(ws, `window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).then(()=>"ok").catch(e=>"ERR:"+e)`);
await sleep(1800);
const st = await ev(ws, `(function(){const fr=document.getElementById('freeze');return {magSrc: fr && fr.src ? 'set' : 'empty', frozen: document.body.classList.contains('frozen')};})()`);
for (const ty of ["rawKeyDown", "keyUp"]) await call(ws, "Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
ws.close();
const ok = r2 === "ok" && st.frozen && st.magSrc === "set";
console.log("取消后二次拉起:", r2, JSON.stringify(st), ok ? "✓" : "✗");
process.exit(ok ? 0 : 1);
