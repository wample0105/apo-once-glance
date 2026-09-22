// 屏幕级可见性回归：循环"拉起→检测屏幕变暗→关闭"。
// 判据 = PIL 全屏平均亮度（OS 合成结果=用户真实所见），不信任 CDP 内部截图。
// 场景覆盖：普通拉起、长截图取消后再拉起（曾触发透明遮罩的路径）。
import { execSync } from "node:child_process";
const base = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lum = () => parseInt(execSync("python tools/_lum.py").toString().trim(), 10);
const targets = async () => (await (await fetch(base + "/json")).json());
async function conn(t) { const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return ws; }
let nid = 0;
const call = (ws, method, params) => new Promise((r) => { const id = ++nid; const h = (e) => { const m = JSON.parse(e.data); if (m.id === id) r(m); }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id, method, params })); });
const ev = (ws, expr) => call(ws, "Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression: expr }).then((m) => m.result?.result?.value);
const ovl = async () => conn((await targets()).find((p) => p.url.includes("overlay")));

const baseLum = lum();
console.log("基准亮度:", baseLum);
let fail = 0;

// 轮 1-2：普通拉起
// 轮 3：长截图会话（模拟 scroll_start 的穿透设置）后取消再拉起 —— 修复前透明遮罩的触发路径
for (let round = 1; round <= 3; round++) {
  const ws = await ovl();
  await ev(ws, `window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).catch(e=>"ERR:"+e)`);
  await sleep(1600);
  let l1 = lum();
  let dim = baseLum - l1;
  if (round === 3) {
    // 走一遍长截图会话：框选→点长截图→立即取消（Esc 经钩子）→再拉起检测
    await ev(ws, `window.__TAURI__.core.invoke("overlay_close").catch(()=>{})`);
    await sleep(600);
    await ev(ws, `window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).catch(e=>"ERR:"+e)`);
    await sleep(1500);
    await call(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x: 500, y: 300, button: "left", buttons: 1, clickCount: 1 });
    await call(ws, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 600, button: "left", buttons: 1 });
    await call(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 900, y: 600, button: "left", buttons: 0, clickCount: 1 });
    await sleep(600);
    const rect = await ev(ws, `(function(){const b=document.getElementById('tb-scroll');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    if (rect) {
      await call(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(rect.x), y: Math.round(rect.y), button: "left", buttons: 1, clickCount: 1 });
      await call(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(rect.x), y: Math.round(rect.y), button: "left", buttons: 0, clickCount: 1 });
      await sleep(2000); // scroll_start：passthrough=true + 键盘钩子
      for (const ty of ["rawKeyDown", "keyUp"]) await call(ws, "Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await sleep(1200); // scroll_cancel：恢复穿透 + park
    }
    await ev(ws, `window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).catch(e=>"ERR:"+e)`);
    await sleep(1600);
    l1 = lum(); dim = baseLum - l1;
  }
  console.log(`轮${round}: 激活后亮度 ${l1}（变暗 ${dim}）→ ${dim >= 2 ? "蒙版真实可见 ✓" : "疑似透明遮罩 ✗"}`);
  if (dim < 2) fail++;
  await ev(ws, `window.__TAURI__.core.invoke("overlay_close").catch(()=>{})`);
  await sleep(800);
  ws.close();
}
// 终态：确认 overlay 已移出屏幕（不挡点击）
const fin = await (async () => { const ws = await ovl(); const v = await ev(ws, `JSON.stringify([window.screenX, window.screenY])`); ws.close(); return JSON.parse(v); })();
console.log("终态 overlay 屏幕坐标:", fin, fin[0] < -5000 ? "已移出 ✓" : "仍在屏上 ✗");
if (fin[0] >= -5000) fail++;
console.log(fail === 0 ? "屏幕级回归全绿 ✓" : `有 ${fail} 项失败 ✗`);
process.exit(fail === 0 ? 0 : 1);
