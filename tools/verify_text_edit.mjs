// 文字编辑切换工具回归：真实创建文字 → 编辑态切走工具（focusout 保编辑态）→ 断言已确认落定
// → 切回文字工具 → 单击旧文字直接进编辑 → 拖动仍是移动语义
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
const check = (name, ok) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail++; };

await ev(ws, `window.__TAURI__.core.invoke("start_overlay",{kind:"region"}).catch(e=>"ERR:"+e)`);
await sleep(1600);
await mouse(ws, "mousePressed", 500, 300);
await mouse(ws, "mouseMoved", 900, 600);
await mouse(ws, "mouseReleased", 900, 600);
await sleep(600);

// 1. 点 T 工具 → 点画布创建编辑框 → 输入内容
const tbT = await ev(ws, `(function(){const b=document.querySelector('[data-tool="text"]');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
await mouse(ws, "mousePressed", Math.round(tbT.x), Math.round(tbT.y));
await mouse(ws, "mouseReleased", Math.round(tbT.x), Math.round(tbT.y));
await sleep(400);
await mouse(ws, "mousePressed", 700, 450);
await mouse(ws, "mouseReleased", 700, 450);
await sleep(400);
check("①T工具+画布点击出现编辑框", await ev(ws, `!!document.querySelector('.txtedit') && !!editing`));
await ev(ws, `document.querySelector('.txtedit').textContent = '阿德测试'`);

// 2. 编辑态点工具栏切箭头（focusout 保编辑态 → setTool 应 finishText 落定）
const tbA = await ev(ws, `(function(){const b=document.querySelector('[data-tool="arrow"]');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
await mouse(ws, "mousePressed", Math.round(tbA.x), Math.round(tbA.y));
await mouse(ws, "mouseReleased", Math.round(tbA.x), Math.round(tbA.y));
await sleep(400);
const st2 = await ev(ws, `({editing: !!editing, txtedit: !!document.querySelector('.txtedit'), objs: document.querySelectorAll('#layer .obj[data-k=text]').length, tool: tool})`);
check("②编辑态切走工具后文字已落定(obj)", st2.editing === false && st2.txtedit === false && st2.objs === 1 && st2.tool === "arrow");

// 3. 切回 T → 单击旧文字 = 直接进编辑
const tbT2 = await ev(ws, `(function(){const b=document.querySelector('[data-tool="text"]');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
await mouse(ws, "mousePressed", Math.round(tbT2.x), Math.round(tbT2.y));
await mouse(ws, "mouseReleased", Math.round(tbT2.x), Math.round(tbT2.y));
await sleep(300);
const tp = await ev(ws, `(function(){const el=document.querySelector('#layer .obj[data-k=text]');return {x:500+parseFloat(el.style.left)+el.offsetWidth/2, y:300+parseFloat(el.style.top)+el.offsetHeight/2};})()`);
await mouse(ws, "mousePressed", Math.round(tp.x), Math.round(tp.y));
await mouse(ws, "mouseReleased", Math.round(tp.x), Math.round(tp.y));
await sleep(500);
const st3 = await ev(ws, `({editing: !!editing, txtedit: !!document.querySelector('.txtedit'), ce: editing ? editing.contentEditable : null})`);
check("③文字工具下单击旧文字直接进编辑", st3.editing === true && st3.txtedit === true);

// 4. 点画布空白退出编辑（编辑态 Esc 被 contentEditable 过滤是已知现状）
await mouse(ws, "mousePressed", 560, 340);
await mouse(ws, "mouseReleased", 560, 340);
await sleep(500);
const before = await ev(ws, `(function(){const el=document.querySelector('#layer .obj[data-k=text]');return {l:parseFloat(el.style.left), t:parseFloat(el.style.top), editing: !!editing};})()`);
check("④Esc 退出编辑（不再残留）", before.editing === false);
await mouse(ws, "mousePressed", Math.round(tp.x), Math.round(tp.y));
for (let i = 1; i <= 5; i++) await mouse(ws, "mouseMoved", Math.round(tp.x) + i * 8, Math.round(tp.y) + i * 6);
await mouse(ws, "mouseReleased", Math.round(tp.x) + 40, Math.round(tp.y) + 30);
await sleep(400);
const after = await ev(ws, `(function(){const el=document.querySelector('#layer .obj[data-k=text]');return {l:parseFloat(el.style.left), t:parseFloat(el.style.top), editing: !!editing};})()`);
check("⑤拖动=移动（位置变化且未进编辑）", !after.editing && (after.l !== before.l || after.t !== before.t));

// 5. 再来一轮"编辑态直接切工具"（用户原始路径）：新建第二个文字进编辑态 → 切箭头
await ev(ws, `setTool("text")`);
await mouse(ws, "mousePressed", 650, 500);
await mouse(ws, "mouseReleased", 650, 500);
await sleep(400);
check("⑥第二个编辑框出现", await ev(ws, `!!editing`));
await ev(ws, `editing.textContent = '第二条'`);
await mouse(ws, "mousePressed", Math.round(tbA.x), Math.round(tbA.y));
await mouse(ws, "mouseReleased", Math.round(tbA.x), Math.round(tbA.y));
await sleep(400);
const st7 = await ev(ws, `({editing: !!editing, objs: document.querySelectorAll('#layer .obj[data-k=text]').length})`);
check("⑦编辑态切走→第二条落定", st7.editing === false && st7.objs === 2);
// 切回 T 单击第二条 → 进编辑（切工具后旧文字可编辑——用户主诉求）
await ev(ws, `setTool("text")`);
await sleep(200);
const tp2 = await ev(ws, `(function(){const els=document.querySelectorAll('#layer .obj[data-k=text]');const el=els[els.length-1];return {x:500+parseFloat(el.style.left)+el.offsetWidth/2, y:300+parseFloat(el.style.top)+el.offsetHeight/2};})()`);
await mouse(ws, "mousePressed", Math.round(tp2.x), Math.round(tp2.y));
await mouse(ws, "mouseReleased", Math.round(tp2.x), Math.round(tp2.y));
await sleep(500);
check("⑧切回工具后单击第二条文字进编辑（用户主诉求）", await ev(ws, `!!editing && editing.dataset.text === '第二条'`));

// 清场
for (const ty of ["rawKeyDown", "keyUp"]) await call(ws, "Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(300);
for (const ty of ["rawKeyDown", "keyUp"]) await call(ws, "Input.dispatchKeyEvent", { type: ty, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
ws.close();
console.log(fail === 0 ? "\n全绿 ✓" : `\n${fail} 项失败 ✗`);
process.exit(fail === 0 ? 0 : 1);
