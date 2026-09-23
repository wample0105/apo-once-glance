// 端到端：建文字（视口 666,466）→ 物理单击 → 断言进编辑（全链唯一裁定）
const base = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = (await (await fetch(base + "/json")).json()).find((p) => p.url.includes("overlay"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nid = 0;
const call = (method, params) => new Promise((r) => { const id = ++nid; const h = (e) => { const m = JSON.parse(e.data); if (m.id === id) r(m); }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id, method, params })); });
const ev = (expr) => call("Runtime.evaluate", { returnByValue: true, expression: expr }).then((m) => m.result?.result?.value);
const mouse = async (type, x, y) => call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
await ev(`window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).catch(e=>"ERR:"+e)`);
await sleep(1600);
await mouse("mousePressed", 500, 300);
await mouse("mouseMoved", 900, 600);
await mouse("mouseReleased", 900, 600);
await sleep(500);
// 场景：先 rect 工具画一个矩形（复刻"画了其他形状"），再切回 text 画文字，再切回 rect，最后单击文字
await ev(`setTool("rect")`);
await mouse("mousePressed", 750, 350);
await mouse("mouseMoved", 850, 420);
await mouse("mouseReleased", 850, 420);
await sleep(250);
await ev(`setTool("text")`);
await mouse("mousePressed", 666, 466);
await mouse("mouseReleased", 666, 466);
await sleep(300);
await ev(`editing && (editing.textContent = "端到端文字", finishText(editing))`);
await sleep(250);
await ev(`setTool("rect")`);
await sleep(200);
// 物理单击文字中心
await mouse("mousePressed", 666, 466);
await mouse("mouseReleased", 666, 466);
await sleep(400);
const r = await ev(`(function(){
  const el = [...document.querySelectorAll('#layer .obj')].find(o => o.dataset.text === "端到端文字");
  return { editing: !!editing, editingText: editing ? editing.dataset.text : null, ce: editing ? editing.contentEditable : null,
    rects: [...document.querySelectorAll('#layer .obj')].filter(o => o.dataset.k === "rect").length,
    errs: (window.__errs||[]).slice(-3) };
})()`);
console.log(JSON.stringify(r, null, 2));
const ok = r.editing && r.editingText === "端到端文字" && r.ce === "true" && r.rects === 1;
console.log(ok ? "端到端 ✓ rect工具下物理单击文字直接进编辑（内容正确、无误画）" : "端到端 ✗");
for (const ty of ["rawKeyDown", "keyUp"]) await call("Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(250);
for (const ty of ["rawKeyDown", "keyUp"]) await call("Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
ws.close();
process.exit(ok ? 0 : 1);
