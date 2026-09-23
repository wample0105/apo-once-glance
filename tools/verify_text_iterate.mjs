// 真机抽查文字编辑反复修改场景：Esc 退出 / 右键确认 / 二次编辑撤销（CDP 驱动，行为断言）
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

// 直构已确认文字 → reEditText 真实进入二次编辑
const setup = await ev(ws, `(function(){
  const el = document.createElement("div");
  el.className = "obj"; el.dataset.k = "text";
  el.dataset.text = "原文内容";
  el.dataset.params = JSON.stringify({ family:"default", size:20, color:"#FF3B30", bold:false, italic:false, underline:false, shadow:false, stroke:false, align:"left", line_height:1.0, background:null, bg_opacity:null, bg_radius:null });
  el.style.cssText = "position:absolute;left:150px;top:120px;font-size:20px;color:#FF3B30;";
  el.textContent = "原文内容";
  layer.appendChild(el);
  setTool("text"); setObjSel(el); reEditText(el);
  return { editing: !!editing, ce: el.contentEditable };
})()`);
check("进入二次编辑", setup.editing === true && setup.ce === "true", setup);

// 1. 编辑中 Esc → 退出编辑保留内容保持选中
await ev(ws, `editing.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }))`);
await sleep(250);
const r1 = await ev(ws, `(function(){ const el = document.querySelector('#layer .obj[data-k=text]'); return { editing: !!editing, ce: el.contentEditable, txt: el.dataset.text, selObj: selectedObj === el }; })()`);
check("①编辑中 Esc 退出保留内容保持选中", r1.editing === false && r1.ce === "false" && r1.txt === "原文内容" && r1.selObj === true, r1);

// 2. 再进编辑 → 编辑中右键 → 确认退出
await ev(ws, `setObjSel(document.querySelector('#layer .obj[data-k=text]')); reEditText(document.querySelector('#layer .obj[data-k=text]'))`);
await sleep(200);
await ev(ws, `editing.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 700, clientY: 430, button: 2 }))`);
await sleep(250);
const r2 = await ev(ws, `(function(){ const el = document.querySelector('#layer .obj[data-k=text]'); return { editing: !!editing, ce: el.contentEditable, ctxmenuHidden: document.getElementById("ctxmenu").style.display !== "block" }; })()`);
check("②编辑中右键=确认退出（不弹输出菜单）", r2.editing === false && r2.ce === "false" && r2.ctxmenuHidden === true, r2);

// 3. 再进编辑改内容 → 确认 → Ctrl+Z 撤销 → 内容回滚
await ev(ws, `setObjSel(document.querySelector('#layer .obj[data-k=text]')); reEditText(document.querySelector('#layer .obj[data-k=text]'))`);
await sleep(200);
await ev(ws, `editing.textContent = "改过的内容"; finishText(editing);`);
await sleep(200);
const r3a = await ev(ws, `document.querySelector('#layer .obj[data-k=text]').dataset.text`);
// Ctrl+Z 物理键盘链
await ev(ws, `document.body.focus && document.body.focus(); "f"`);
await call(ws, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 2 });
await call(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 2 });
await sleep(300);
const r3b = await ev(ws, `document.querySelector('#layer .obj[data-k=text]').dataset.text`);
check("③二次编辑改内容可撤销", r3a === "改过的内容" && r3b === "原文内容", { after: r3a, undone: r3b });

// 清场
for (const ty of ["rawKeyDown", "keyUp"]) await call(ws, "Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(250);
for (const ty of ["rawKeyDown", "keyUp"]) await call(ws, "Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
ws.close();
console.log(fail === 0 ? "\n真机抽查全绿 ✓" : `\n${fail} 项失败 ✗`);
process.exit(fail === 0 ? 0 : 1);
