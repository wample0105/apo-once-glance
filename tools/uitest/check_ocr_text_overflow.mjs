// 裁决：结果文本右缘是否被显示层截断（scrollWidth>clientWidth 即真截断；pre-wrap 正常换行不可能横溢）
const base = "http://127.0.0.1:9700";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jlist = async () => (await (await fetch(base + "/json")).json());
function attach(wsUrl) { const ws = new WebSocket(wsUrl); return new Promise((r, j) => { ws.onopen = () => r(ws); ws.onerror = j; }); }
function mkCaller(ws) {
  let seq = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return async (method, params) => { const id = ++seq; return new Promise((r) => { pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); }); };
}
async function evOf(call, expr) {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval err");
  return r.result?.result?.value;
}
const main = (await jlist()).find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
const mws = await attach(main.webSocketDebuggerUrl);
const mcall = mkCaller(mws);
const mEv = (e) => evOf(mcall, e);
await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`).catch(() => {});
await sleep(800);
const list = await jlist();
const ov = list.find((p) => p.type === "page" && p.url.includes("overlay.html"));
const cws = await attach(ov.webSocketDebuggerUrl);
const call = mkCaller(cws);
for (let i = 0; i < 20; i++) { if (await evOf(call, `document.body.classList.contains("frozen")`)) break; await sleep(250); }
const vh = await evOf(call, `innerHeight`);
// 与场景1同区框选
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: 300, y: Math.round(vh * 0.25), button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 12; i++) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300 + 600 * i / 12, y: Math.round(vh * 0.25) + Math.round(vh * 0.3) * i / 12, button: "left", buttons: 1 });
  await sleep(30);
}
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: 900, y: Math.round(vh * 0.55), button: "left", buttons: 1 });
await sleep(400);
await evOf(call, `document.getElementById("tb-ocr").click()`);
let res = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  res = await evOf(call, `(function(){ const b = document.getElementById("ai-result-text");
    if (!b || b.offsetParent === null) return null;
    return { cw: b.clientWidth, sw: b.scrollWidth, overflowX: b.scrollWidth > b.clientWidth,
      lastLine: b.textContent.split("\\n").filter(s => s.trim()).slice(-3) }; })()`).catch(() => null);
  if (res) break;
}
console.log(JSON.stringify(res, null, 1));
console.log(res.overflowX ? "FAIL 文本横向溢出（显示层截断实锤）" : "PASS 无横向溢出——右缘行尾即 OCR 识别内容本身，非显示裁切");
await mEv(`window.__TAURI__.core.invoke("start_overlay", { kind: "region" })`).catch(() => {});
process.exit(0);
