// 用户真实序列复现：逐步记录 (EXSTYLE, 位置, 屏幕亮度, JS frozen) 四元组，抓翻车转变点
import { execSync } from "node:child_process";
const base = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = () => JSON.parse(execSync("python tools/_snap.py").toString().trim());
const targets = async () => (await (await fetch(base + "/json")).json());
async function conn(t) { const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return ws; }
let nid = 0;
const call = (ws, method, params) => new Promise((r) => { const id = ++nid; const h = (e) => { const m = JSON.parse(e.data); if (m.id === id) r(m); }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id, method, params })); });
const ev = (ws, expr) => call(ws, "Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression: expr }).then((m) => m.result?.result?.value);
const ovl = async () => conn((await targets()).find((p) => p.url.includes("overlay")));
const mouse = async (ws, type, x, y) => call(ws, "Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
const hotkey = (ws) => ev(ws, `window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).then(()=>"ok").catch(e=>"ERR:"+e)`);
const esc = async (ws) => { for (const ty of ["rawKeyDown", "keyUp"]) await call(ws, "Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); };

let prevLum = snap().lum;
function judge(s, jsFrozen) {
  const onScreen = s.found && s.x > -5000;
  const issues = [];
  if (onScreen && !jsFrozen) issues.push("在屏上但未激活(透明挡板)");
  if (onScreen && s.lay) issues.push("LAY残留");
  if (onScreen && s.trn) issues.push("TRN残留");
  if (!onScreen && s.found && s.x > -30000 && s.x < -5000) { /* 屏外正常 */ }
  return issues;
}
async function record(label, ws) {
  await sleep(1200);
  const s = snap();
  const js = ws ? await ev(ws, `(function(){return {frozen: document.body.classList.contains('frozen'), sx: window.screenX, sy: window.screenY};})()`) : { frozen: null };
  const dim = prevLum - s.lum;
  const issues = judge(s, js.frozen);
  console.log(`${label.padEnd(18)} | win:${s.found ? `${s.x},${s.y} lay=${+s.lay} trn=${+s.trn} top=${+s.top}` : "none"} | dim=${String(dim).padStart(3)} | js.frozen=${js.frozen} ${issues.length ? "✗ " + issues.join(",") : "✓"}`);
  prevLum = s.lum;
  return issues;
}

let ws = await ovl();
let total = 0;
const step = async (label) => { if ((await record(label, ws)).length) total++; };

// 序列 1：普通开关
await hotkey(ws); await step("①拉起");
await esc(ws); await sleep(400); await step("②Esc");
// 序列 2：长截图+钩子Esc
await hotkey(ws); await sleep(300); await step("③再拉起");
await mouse(ws, "mousePressed", 500, 300);
await mouse(ws, "mouseMoved", 900, 600);
await mouse(ws, "mouseReleased", 900, 600);
await sleep(500);
const rect = await ev(ws, `(function(){const b=document.getElementById('tb-scroll');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
await mouse(ws, "mousePressed", Math.round(rect.x), Math.round(rect.y));
await mouse(ws, "mouseReleased", Math.round(rect.x), Math.round(rect.y));
await sleep(1500); await step("④长截图会话");
await esc(ws); await sleep(800); await step("⑤钩子Esc取消");
// 序列 3：取消后拉起
await hotkey(ws); await step("⑥取消后拉起");
await esc(ws); await sleep(400); await step("⑦Esc");
// 序列 4：toggle 连打
await hotkey(ws); await sleep(500); await step("⑧再按(toggle关)");
await hotkey(ws); await step("⑨toggle后再拉起");
await esc(ws); await sleep(400);
// 序列 5：长截图未退直接热键（乱序）
await hotkey(ws); await sleep(300);
await mouse(ws, "mousePressed", 500, 300);
await mouse(ws, "mouseMoved", 900, 600);
await mouse(ws, "mouseReleased", 900, 600);
await sleep(400);
const rect2 = await ev(ws, `(function(){const b=document.getElementById('tb-scroll');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
if (rect2) {
  await mouse(ws, "mousePressed", Math.round(rect2.x), Math.round(rect2.y));
  await mouse(ws, "mouseReleased", Math.round(rect2.x), Math.round(rect2.y));
  await sleep(1500);
  await hotkey(ws); await step("⑩长截图进行中热键");
  await esc(ws); await sleep(800); await step("⑪钩子Esc");
}
await hotkey(ws); await step("⑫最终拉起");
await ev(ws, `window.__TAURI__.core.invoke("overlay_close").catch(()=>{})`);
await sleep(600); await step("⑬清理park");
ws.close();
console.log(total === 0 ? "\n全序列无翻车 ✓（未复现，需用户提供更精确操作序列）" : `\n复现 ${total} 个翻车步 ✗`);
process.exit(total === 0 ? 0 : 1);
