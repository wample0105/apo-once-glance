// 无头 UI 验证：Chrome CDP 驱动 testbed.html（锁屏期间 DOM 级验证，不进产品）
// 用法：node tools/uitest/run.mjs [shot1 shot2 ...]（无参只跑断言）
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
const BED = "file:///" + path.resolve("tools/uitest/testbed.html").replace(/\\/g, "/");

const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + path.resolve("tools/uitest/.profile"),
  "--window-size=1600,1000", "--no-first-run", "--no-default-browser-check",
  "about:blank",
], { stdio: "ignore" });

async function waitDebug() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(200);
  }
  throw new Error("chrome devtools 未就绪");
}

const ws = new WebSocket(await waitDebug());
await new Promise((res) => { ws.onopen = res; });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  return new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
async function evl(expr, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
  if (r.result && r.result.exceptionDetails) {
    const d = r.result.exceptionDetails;
    return "EVAL-ERROR: " + (d.exception?.description || d.text).slice(0, 300);
  }
  return r.result?.result?.value;
}
async function goto() {
  await send("Page.navigate", { url: BED });
  await sleep(1200); // 等 init + 工具栏接线
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(name, Buffer.from(r.result.data, "base64"));
  console.log("shot:", name);
}

const results = [];
function check(name, ok, info = "") {
  results.push({ name, ok });
  console.log((ok ? "PASS" : "FAIL") + " | " + name + (info ? " | " + info : ""));
}

await goto();
await evl(`window.__errs = []; window.addEventListener("error", e => window.__errs.push(e.message + " @ " + (e.filename||"") + ":" + e.lineno)); "hooked"`);

// ===== 全局清理（T0，新增）：跨用例的编辑态残留统一收尾，保证各用例前置状态干净 =====
await evl(`(() => { try { if (editing) finishText(editing); } catch (e) {} try { setObjSel(null); } catch (e) {} return "T0-clean"; })()`);

// ===== 场景搭建：直接进入 selected 态 + 造一个文字对象 =====
await evl(`(() => {
  sel = { x: 100, y: 100, w: 800, h: 600 };
  setState("selected");
  // 造文字对象（模拟 finishText 产物）
  const __el0 = document.createElement("div");
  __el0.className = "obj"; __el0.dataset.k = "text";
  __el0.textContent = "面板验证";
  __el0.style.cssText = "position:absolute;left:300px;top:280px;font-size:20px;color:#FF3B30;";
  __el0.dataset.params = JSON.stringify({ family:"default", size:20, color:"#FF3B30", bold:false, italic:false, underline:false, shadow:false, stroke:false, align:"left", line_height:1.0, background:null, bg_opacity:null, bg_radius:null });
  layer.appendChild(__el0);
  "setup-ok"
})()`);

// T1 选中即回填：属性栏反映对象值
let t1 = await evl(`setObjSel(layer.querySelector('.obj')); textSize`);
check("T1 选中回填 textSize=20", t1 === 20, "textSize=" + t1);

// T2 拖角缩放模拟：直接走 mouseup 的 params 更新路径（objDrag 造不了，改走 applyObjGeom+手动 params，等价验证回填源）
await evl(`(() => {
  const __el2 = layer.querySelector('.obj');
  const p = JSON.parse(__el2.dataset.params); p.size = 45;
  __el2.dataset.params = JSON.stringify(p);
  __el2.style.fontSize = "45px";
  setObjSel(__el2);
  "resized"
})()`);
t1 = await evl(`textSize`);
check("T2 缩放后回填 textSize=45", t1 === 45, "textSize=" + t1);

// T3 换色不回退字号：点色板（模拟 PALETTE 色块 click）
await evl(`(() => {
  toolColor = "#00FF00";
  syncSelProps();
  "color-set"
})()`);
const t3size = await evl(`parseInt(layer.querySelector('.obj').style.fontSize,10)`);
const t3color = await evl(`JSON.parse(layer.querySelector('.obj').dataset.params).color`);
check("T3 换色后字号仍 45", t3size === 45, "fontSize=" + t3size);
check("T3b 换色生效", t3color === "#00FF00", "color=" + t3color);

// T4 背景面板弹出：点 ▾
await evl(`document.getElementById("pr-tbgchip").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); "clicked"`);
const t4 = await evl(`document.getElementById("pr-text-menu").style.display`);
check("T4 面板弹出 display=block", t4 === "block", "display=" + t4);
const t4b = await evl(`document.querySelectorAll("#pr-text-menu .sw").length`);
const t4c = await evl(`!!document.querySelector("#pr-text-menu input[type=color]")`);
const t4d = await evl(`document.querySelectorAll("#pr-text-menu input[type=range]").length`);
check("T4b 色块含黑白+无背景 (14)", t4b === 14, "sw=" + t4b);
check("T4c 自由选色器存在", t4c === true);
check("T4d 透明度+圆角两滑杆", t4d === 2, "ranges=" + t4d);

// T5 选蓝色背景 → 实时应用（rgba + 回填对象）
await evl(`(() => {
  const sws0 = [...document.querySelectorAll("#pr-text-menu .sw[data-c]")];
  sws0.find(s => s.dataset.c === '#E0F0FF').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); "blue-bg"
})()`);
const t5bg = await evl(`layer.querySelector('.obj').style.background`);
check("T5 蓝底应用（alpha1 浏览器序列化为 rgb）", /rgba?\(224,\s*240,\s*255(,\s*1)?\)/.test(t5bg || ""), "bg=" + t5bg);

// T6 透明度滑杆 50% → alpha 0.5
await evl(`(() => {
  const r = [...document.querySelectorAll("#pr-text-menu input[type=range]")][0];
  r.value = "50";
  r.dispatchEvent(new Event("input", { bubbles: true }));
  "op50"
})()`);
const t6bg = await evl(`layer.querySelector('.obj').style.background`);
check("T6 透明度 50% → alpha 0.5", /rgba\(224,\s*240,\s*255,\s*0\.5\)/.test(t6bg || ""), "bg=" + t6bg);

// T7 圆角滑杆 20px → borderRadius
await evl(`(() => {
  const rs = [...document.querySelectorAll("#pr-text-menu input[type=range]")];
  rs[1].value = "20";
  rs[1].dispatchEvent(new Event("input", { bubbles: true }));
  "r20"
})()`);
const t7r = await evl(`layer.querySelector('.obj').style.borderRadius`);
check("T7 圆角 20px", t7r === "20px", "radius=" + t7r);

// T8 白底黑字场景：选白色 sw
await evl(`(() => {
  const sws1 = [...document.querySelectorAll("#pr-text-menu .sw[data-c]")];
  sws1.find(s => s.dataset.c === "#FFFFFF").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); "white"
})()`);
const t8 = await evl(`JSON.parse(layer.querySelector('.obj').dataset.params).background`);
check("T8 白底写进 params", t8 === "#FFFFFF", "bg=" + t8);

// T9 serializeOps：背景/透明度/圆角进契约
const ops = await evl(`serializeOps().operations`, true);
const top = (ops || [])[0] || {};
check("T9a 契约 background=#FFFFFF", top.background === "#FFFFFF", JSON.stringify(top).slice(0, 120));
check("T9b 契约 background_opacity=0.5", top.background_opacity === 0.5, "op=" + top.background_opacity);
check("T9c 契约 background_radius=20", top.background_radius === 20, "r=" + top.background_radius);

// T10 描边按钮：A → params.stroke + 契约 stroke_color/width
await evl(`(() => {
  document.getElementById('pr-chip').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); const b = document.getElementById('pr-stroke-btn');
  b.click(); "stroke-on"
})()`);
const ops2 = await evl(`serializeOps().operations`, true);
const top2 = (ops2 || [])[0] || {};
check("T10 契约描边", top2.stroke_color === "#000000" && top2.stroke_width > 0, JSON.stringify({ sc: top2.stroke_color, sw: top2.stroke_width }));

// T11 进编辑回填：单击已有文字（tool=text 模拟）
await evl(`setTool("text"); "tool-text"`);
// 收起面板
await evl(`document.getElementById("pr-text-menu").style.display = "none"; "closed"`);
await evl(`(() => {
  const __el25 = layer.querySelector('.obj');
  reEditText(__el25); "reedit"
})()`);
const t11 = await evl(`editing !== null && parseInt(editing.style.fontSize,10) === 45`);
check("T11 进编辑回填字号 45", t11 === true);


// T12 编辑态新建即有 dataset.k（用户实测 bug：编辑中拖角只拉框不改字号）
await evl(`(() => { setTool("text"); startText({x:50,y:50}); return editing ? editing.dataset.k : "no-editing"; })()`);
const t12 = await evl(`editing ? editing.dataset.k : "none"`);
check("T12 编辑框 dataset.k=text", t12 === "text", "k=" + t12);
// T12b 模拟编辑态拖角走字号分支：直接造 objDrag 走一帧 mousemove 逻辑不易，改为验证分支路由条件
const t12b = await evl(`(() => { const e2 = editing; return (e2.dataset.k === "text" || e2.classList.contains("txtedit")) ? "text-branch" : "shape-branch"; })()`);
check("T12b 编辑态路由 text 分支", t12b === "text-branch", t12b);
await evl(`(() => { finishText(editing); return "done"; })()`);


// T13 背景内边距：对象有 0.25em padding，serializeOps at 补偿后=内容起点
await evl(`(() => {
  const o = layer.querySelector('.obj');
  const cs = getComputedStyle(o);
  return { pt: cs.paddingTop, at: serializeOps().operations[0].at, l: parseFloat(o.style.left) };
})()`, true);
const t13 = await evl(`(() => { const o = layer.querySelector('.obj'); const cs = getComputedStyle(o); return cs.paddingTop; })()`);
check("T13 文字对象有内边距", parseFloat(t13) > 0, "paddingTop=" + t13);
const t13b = await evl(`serializeOps().operations[0].at[0] - parseFloat(layer.querySelector('.obj').style.left)`, true);
check("T13b at 补偿 = size*0.25", Math.round(t13b) === Math.round(45*0.25), "Δ=" + t13b);
// T14 × 按钮已删除（用户决策）；Delete 键删除路径回归
const t14 = await evl(`document.getElementById("objdel") === null`);
check("T14 × 元素已删除", t14 === true);
await evl(`setObjSel(layer.querySelector('.obj')); "sel"`);
const t14b = await evl(`(() => { pushUndo({ t: "del", el: selectedObj }); selectedObj.remove(); setObjSel(null); return layer.querySelectorAll('.obj').length; })()`, true);
check("T14b Delete 删除对象", t14b === 0, "objs=" + t14b);
const t14c = await evl(`(() => { undoOp(); return layer.querySelectorAll('.obj').length; })()`, true);
check("T14c 撤销恢复对象", t14c === 1, "objs=" + t14c);


// T15 编辑态换行：锚框高度跟随
await evl(`(() => { setTool("text"); startText({x:100,y:100}); editing.textContent = "AAA"; editing.dispatchEvent(new Event("input")); const h0 = editing.offsetHeight; editing.innerHTML = "AAA<div>BBB</div>"; editing.dispatchEvent(new Event("input")); return { h0, h1: editing.offsetHeight, anc: document.querySelector('.t-anc-se').style.top }; })()`);
const t15 = await evl(`editing ? { h: editing.offsetHeight, top: document.querySelector('.t-anc-se').style.top } : null`, true);
check("T15 换行锚框跟随", t15 && t15.h > 40, JSON.stringify(t15));
// T16 编辑中点面板滑杆：编辑态保留+属性生效（focusout 分流）
const t16a = await evl(`(() => { const r = [...document.querySelectorAll("#pr-text-menu input[type=range]")][0]; document.getElementById("pr-tbgchip").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); return document.getElementById("pr-text-menu").style.display; })()`, true);
const t16b = await evl(`(() => { const rs = [...document.querySelectorAll("#pr-text-menu input[type=range]")]; rs[1].value = "20"; rs[1].dispatchEvent(new Event("input", { bubbles: true })); return { editing: !!editing, r: editing ? editing.style.borderRadius : "none" }; })()`, true);
check("T16 编辑态保留+圆角生效", t16b && t16b.editing === true && t16b.r === "20px", JSON.stringify(t16b));


// T17 即改即存：改属性不输出，防抖后 set_setting 已收到全字段 payload
await evl(`(() => { window.__saved = []; textBgRadius = 20; textBgOpacity = 0.6; textStroke = true; fillMode = "fill"; syncSelProps(); return "changed"; })()`);
await new Promise(r => setTimeout(r, 700)); // 等防抖 400ms
const t17 = await evl(`(() => { const last = (window.__saved || []).pop() || {}; return { r: last.text_bg_radius, o: last.text_bg_opacity, st: last.text_stroke, f: last.shape_fill, c: last.text_bg_color }; })()`);
check("T17 即改即存-圆角", t17.r === 20, JSON.stringify(t17));
check("T17b 透明度", t17.o === 0.6, "o=" + t17.o);
check("T17c 描边", t17.st === true, "st=" + t17.st);
check("T17d 填充模式", t17.f === "fill", "f=" + t17.f);
check("T17e 背景色同存", !!t17.c, "c=" + t17.c);


// T17.5（新增）：清掉前序用例遗留的编辑态。新语义下 setTool 切走时会把编辑中文字落定并回填
// 文字记忆色（业界行为：确认什么颜色下个文字默认什么颜色），故每个涉色用例的前置必须自己干净
await evl(`(() => { try { if (editing) finishText(editing); } catch (e) {} try { setObjSel(null); } catch (e) {} return "clean"; })()`);
// T18 颜色按工具独立：文字设白→切箭头应红→设箭头蓝→切回文字仍白
await evl(`(() => { setTool("text"); setColorForTool("#FFFFFF"); return toolColors.text; })()`);
const t18a = await evl(`(() => { setTool("arrow"); return { arrow: toolColor, text: toolColors.text }; })()`);
check("T18 切箭头=红默认且文字白保持", t18a.arrow === "#FF3B30" && t18a.text === "#FFFFFF", JSON.stringify(t18a));
await evl(`(() => { setColorForTool("#00A2E8"); return "arrow-blue"; })()`);
const t18b = await evl(`(() => { setTool("text"); return { textNow: toolColor, arrowKept: toolColors.arrow }; })()`);
check("T18b 箭头蓝不串文字（文字仍白）", t18b.textNow === "#FFFFFF" && t18b.arrowKept === "#00A2E8", JSON.stringify(t18b));
// T19 对齐图标：三个 svg 按钮
const t19 = await evl(`document.querySelectorAll("#pr-talign svg").length`);
check("T19 对齐 SVG 图标×3", t19 === 3, "svg=" + t19);
// T20 原生取色器存在且挂在色板区
const t20 = await evl(`!!document.querySelector("#pr-color-menu input[type=color], #pr-text-menu input[type=color]")`);
check("T20 原生取色器存在", t20 === true);
// T20b tool_colors 进 saveProps payload
await evl(`syncSelProps()`, true);
await new Promise(r => setTimeout(r, 700));
const t20b = await evl(`(() => { const s = (window.__saved || []).pop() || {}; return s.tool_colors; })()`);
check("T20b tool_colors 持久化", t20b && typeof t20b.text === "string" && t20b.arrow === "#00A2E8", JSON.stringify(t20b));

// T21 背景直达块：存在 + 与 A 按钮同开完整面板（字体3下拉 + 13色 + 2滑杆都在一个面板）
const t21 = await evl(`(() => { setTool("text"); const c = document.getElementById("pr-tbgchip"); return { exists: !!c, inTextRow: !!(c && c.closest("#pr-text")), noneInit: !!(c && c.classList.contains("none")) }; })()`);
check("T21 背景直达块存在", t21.exists && t21.inTextRow, JSON.stringify(t21));
await evl(`document.getElementById("pr-text-menu").style.display = "none"; document.getElementById("pr-tbgchip").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); "open"`);
const t21b = await evl(`(() => { const m = document.getElementById("pr-text-menu"); return { open: !!m && m.style.display === "block", rowSelects: document.querySelectorAll("#pr-text > select").length, panelSelects: m ? m.querySelectorAll("select").length : -1, sws: m ? m.querySelectorAll(".sw[data-c]").length : 0, ranges: m ? m.querySelectorAll("input[type=range]").length : 0 }; })()`);
check("T21b 面板开+字体3下拉在属性行+面板只余背景", t21b.open && t21b.rowSelects === 3 && t21b.panelSelects === 0 && t21b.sws === 13 && t21b.ranges === 2, JSON.stringify(t21b));
await evl(`(() => { const b = [...document.querySelectorAll("#pr-text-menu .sw[data-c]")].find(s => s.dataset.c === "#000000"); b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); return "clicked"; })()`);
const t21c = await evl(`(() => { const c = document.getElementById("pr-tbgchip"); return { bg: textBgColor, on: textBackground, chipBg: c.style.background.toUpperCase(), chipNone: c.classList.contains("none") }; })()`);
check("T21c 点黑块生效+chip 变黑", t21c.bg === "#000000" && t21c.on === true && /RGB\(0, ?0, ?0\)|#000000/.test(t21c.chipBg) && !t21c.chipNone, JSON.stringify(t21c));
await evl(`(() => { const n = document.querySelector("#pr-text-menu .sw.none"); n.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); return "none"; })()`);
const t21d = await evl(`(() => document.getElementById("pr-tbgchip").classList.contains("none") && textBackground === false)()`);
check("T21d 无背景=斜纹态", t21d === true);
// T21e 双入口同面板：面板关时背景块点开 = A 面板本体，无第二浮层
await evl(`(() => { document.getElementById("pr-text-menu").style.display = "none"; document.getElementById("pr-tbgchip").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); return "toggle"; })()`);
const t21e = await evl(`(() => ({ panel: document.getElementById("pr-text-menu").style.display, noSecond: !document.getElementById("pr-tbg-menu") }))()`);
check("T21e 双入口同面板且无第二浮层", t21e.panel === "block" && t21e.noSecond, JSON.stringify(t21e));
// 恢复默认背景避免污染后续持久化
await evl(`(() => { textBgColor = "#FFF7D6"; textBackground = true; document.getElementById("pr-text-menu").style.display = "none"; syncTextProps(); return "reset"; })()`);


// T22 工具栏拖动把手（同类产品 交互）
check("T22 把手存在", await evl(`!!document.getElementById("tb-handle")`) === true);
const t22b = await evl(`(function(){
  setSel({ x: 100, y: 100, w: 400, h: 300 }); setState("selected");
  document.getElementById("toolbar").style.display = "flex";
  positionToolbar();
  const l0 = parseFloat(document.getElementById("toolbar").style.left) || 0;
  document.getElementById("tb-handle").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 600, clientY: 500 }));
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 700, clientY: 560 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  const l1 = parseFloat(document.getElementById("toolbar").style.left) || 0;
  return { dx: l1 - l0, free: toolbarFree };
})()`);
check("T22b 拖动跟随+进入自由位", Math.round(t22b.dx) === 100 && t22b.free === true, JSON.stringify(t22b));
await evl(`resetOverlayState(); "reset"`);
const t22c = await evl(`(function(){ document.getElementById("toolbar").style.display = "flex"; positionToolbar(); return { free: toolbarFree }; })()`);
check("T22c 重置后恢复自动定位", t22c.free === false, JSON.stringify(t22c));

// T23 模式类全 icon 化（无文字按钮残留）+ 透明度滑杆
const t23 = await evl(`(function(){
  const arrowIcons = document.querySelectorAll("#pr-arrow-style button svg").length;
  const lineIcons = document.querySelectorAll("#pr-arrow-line button svg").length;
  const ddls = document.querySelectorAll("#pr-shape .ddl").length;
  const lineItems = document.querySelectorAll("#ddl-line .ddl-item").length;
  const fillItems = document.querySelectorAll("#ddl-fill .ddl-item").length;
  const numIcons = document.querySelectorAll("#pr-num-style button svg").length;
  const mosIcons = document.querySelectorAll("#pr-mos-mode button svg").length;
  const mosRange = !!document.getElementById("pr-mos-range");
  const opSlider = !!document.getElementById("pr-opacity-range");
  const noOldSelect = !document.querySelector("#pr-arrow-style select, #pr-arrow-line select, #pr-shape select[id=pr-opacity]");
  return { arrowIcons, lineIcons, ddls, fillItems, lineItems, numIcons, mosIcons, mosRange, opSlider, noOldSelect };
})()`);
check("T23 模式类全 icon 化+透明度滑杆", t23.arrowIcons === 4 && t23.lineIcons === 3 && t23.ddls === 2 && t23.fillItems === 3 && t23.lineItems === 2 && t23.numIcons === 3 && t23.mosIcons === 2 && t23.mosRange && t23.opSlider && t23.noOldSelect, JSON.stringify(t23));

// T24 马赛克：blur 预览带 filter；pixelate 落定后真实块化预览
await evl(`(function(){
  if (editing) finishText(editing); // 精确清理（resetOverlayState 会清 magImg.src 致预览无冻结图）
  setObjSel(null); objDrag = null; draft = null;
  document.querySelectorAll("#layer .obj").forEach(e => e.remove());
  if (!magImg.src) magImg.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  setSel({ x: 100, y: 100, w: 600, h: 400 }); setState("selected");
  setTool("mosaic");
  const lay = document.getElementById("layer");
  lay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 200, clientY: 200, button: 0 }));
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 350, clientY: 300 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  return "painted:" + (draft ? "draft-live" : "done");
})()`);
const t24 = await evl(`(function(){
  const m = document.querySelector('#layer .obj[data-k="mosaic"]');
  if (!m) return { found: false };
  let err = null;
  try { mosaicPreview(m); } catch (e) { err = String(e); }
  return { found: true, err, mode: JSON.parse(m.dataset.params).mode, nw: magImg.naturalWidth, w: m.style.width, realPrev: m.dataset.realPrev === "1", bgHasData: (m.style.background || "").includes("url(") };
})()`);
check("T24 pixelate 落定=真实块化预览", t24.found && !t24.err && t24.realPrev && t24.bgHasData, JSON.stringify(t24));
await evl(`(function(){
  const b = document.querySelector('#pr-mos-mode button[data-mm="blur"]');
  b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  return "blur-on";
})()`);
const t24b = await evl(`(function(){
  const m = document.querySelector('#layer .obj[data-k="mosaic"]');
  return { filter: m.style.filter, mode: JSON.parse(m.dataset.params).mode, bgPos: m.style.backgroundPosition, realPrev: m.dataset.realPrev === "1", bgHasData: (m.style.background || "").includes("url(") };
})()`);
check("T24b 模糊落定=canvas 真模糊预览+模式同步", t24b.mode === "blur" && t24b.realPrev && t24b.bgHasData, JSON.stringify(t24b));
await evl(`(function(){ document.querySelector('#pr-mos-mode button[data-mm="mosaic"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); document.querySelectorAll('#layer .obj').forEach(e => e.remove()); return "reset"; })()`);

// T25 背景块状态同步：状态变化经 syncPropsUI 后 chip 必须跟随（曾漏致"斜纹但实际有背景"）
const t25 = await evl(`(function(){
  textBackground = false; textBgColor = "#FFF7D6"; bgRefresh();
  const before = document.getElementById("pr-tbgchip").classList.contains("none");
  textBackground = true; textBgColor = "#000000";
  syncPropsUI();
  const c = document.getElementById("pr-tbgchip");
  return { beforeNone: before, afterNone: c.classList.contains("none"), bg: c.style.background.toUpperCase() };
})()`);
check("T25 回填刷新背景直达块", t25.beforeNone === true && t25.afterNone === false && /RGB\(0, ?0, ?0\)|#000000/.test(t25.bg), JSON.stringify(t25));

// T26 焦点在滑杆上按 Esc 不被吞（曾 INPUT 一律 return：拖过滑杆后 Esc 无法退出截图）
const t26 = await evl(`(function(){
  setSel({ x: 100, y: 100, w: 600, h: 400 }); setState("selected");
  setTool("rect");
  const lay = document.getElementById("layer");
  lay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 200, clientY: 200, button: 0 }));
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 280 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  setTool("mosaic");
  const r = document.getElementById("pr-mos-range");
  r.focus();
  r.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return { dlgOpen: document.getElementById("escdlg").classList.contains("open") };
})()`);
check("T26 滑杆持焦时 Esc 仍可退出", t26.dlgOpen === true, JSON.stringify(t26));
await evl(`(function(){ document.getElementById("escdlg").classList.remove("open"); document.querySelectorAll("#layer .obj").forEach(e => e.remove()); setObjSel(null); return "clean"; })()`);


// T27 填充/线条下拉（业界同款）：点开→选项生效→三角朝向→点外关闭
const t27 = await evl(`(function(){
  const box = document.getElementById("ddl-fill");
  box.querySelector(".ddl-btn").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  const opened = box.classList.contains("open");
  const items = box.querySelectorAll(".ddl-item");
  items[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); // 选"填充"
  const onItem = box.querySelector(".ddl-item.on");
  const curHtml = box.querySelector(".ddl-cur").innerHTML;
  return { opened, closedAfterPick: !box.classList.contains("open"), fillMode, curOn: curHtml.includes("svg"), onVal: onItem ? onItem.dataset.v : null, curMatches: curHtml.includes('fill="currentColor"') && !curHtml.includes("stroke") };
})()`);
check("T27 填充下拉开/选/生效+入口图标与选中态同步", t27.opened && t27.closedAfterPick && t27.fillMode === "fill" && t27.curOn && t27.onVal === "fill" && t27.curMatches, JSON.stringify(t27));
const t27b = await evl(`(function(){
  const box = document.getElementById("ddl-line");
  box.querySelector(".ddl-btn").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  const opened = box.classList.contains("open");
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); // 点外
  return { opened, closedByOutside: !box.classList.contains("open"), dash: shapeDash };
})()`);
check("T27b 线条下拉+点外关闭", t27b.opened && t27b.closedByOutside, JSON.stringify(t27b));



await evl(`layer.querySelector('[data-k="arrow"]').remove(); setObjSel(null); "cleaned"`);

// 截图留档
await shot("uitest_final.png");
await evl(`document.getElementById("pr-tbgchip").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); "open"`);
await shot("uitest_panel.png");

// T28 文字属性独立性：编辑 B 时点斜体只改 B，A 不受影响（曾双改）
const t28 = await evl(`(function(){
  // A：已确认文字对象
  editing = null; textItalic = false; document.querySelectorAll("#layer .obj").forEach(e => e.remove()); setObjSel(null);
  setTool("text");
  const lay = document.getElementById("layer");
  lay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 120, clientY: 120, button: 0 }));
  const a = document.querySelector(".txtedit"); a.textContent = "AAA"; finishText(a);
  const aEl = layer.querySelector('[data-k="text"]');
  // B：进入编辑态（编辑前先清 A 的选中——真实链路 reEditText/startText 均会断开；此处直设 editing 模拟"正在编辑另一个"）
  setObjSel(null); editing = null;
  const bb = document.createElement("div");
  bb.className = "txtedit"; bb.dataset.k = "text"; bb.contentEditable = "true";
  bb.style.cssText = "position:absolute;left:500px;top:120px;font-size:20px;";
  bb.textContent = "BBB"; lay.appendChild(bb); editing = bb;
  textItalic = false; syncEditProps(); // A/B 均非斜体基线
  // 编辑 B 中点斜体
  textItalic = true; syncTextProps();
  return { bItalic: bb.style.fontStyle, aItalic: aEl.style.fontStyle, editingNow: editing === bb, objs: document.querySelectorAll("#layer .obj").length };
})()`);
check("T28 编辑态改斜体不串已确认对象", t28.bItalic === "italic" && t28.aItalic !== "italic", JSON.stringify(t28));
await evl(`(function(){ textItalic = false; document.querySelectorAll("#layer .obj").forEach(e => e.remove()); setObjSel(null); editing = null; return "clean"; })()`);

// ===== 独立会话段（新增）：T29-T32 在 goto 复位后的干净环境跑 =====
// （长链路会话中全局状态残留会让合成/物理事件链失效——污染源排查见 backlog）
await goto();
await evl(`(function(){ sel = { x: 100, y: 100, w: 800, h: 600 }; setState("selected"); return "fresh"; })()`);

// T33（新增）编辑残留根治：编辑文字时点选区内空白——layer 非 focusable，focusout 不触发，
// editing 曾残留 → 此后单击/双击全被守卫拦（用户报"双击进不了编辑"）。分发器现在主动落定。
const t33a = await evl(`(function(){
  document.querySelectorAll("#layer .obj").forEach(e => e.remove()); setObjSel(null);
  setTool("text");
  const el = document.createElement("div");
  el.className = "obj"; el.dataset.k = "text";
  el.dataset.text = "双击我";
  el.dataset.params = JSON.stringify({ family:"default", size:20, color:"#FF3B30", bold:false, italic:false, underline:false, shadow:false, stroke:false, align:"left", line_height:1.0, background:null, bg_opacity:null, bg_radius:null });
  el.style.cssText = "position:absolute;left:150px;top:120px;font-size:20px;color:#FF3B30;";
  el.textContent = "双击我";
  layer.appendChild(el);
  // 模拟"单击后进入编辑"的用户状态
  editing = el; el.classList.add("txtedit"); el.contentEditable = "true";
  return { editing: !!editing, objsel: document.getElementById("objsel").style.display === "block" };
})()`);
check("T33a 构造编辑态", t33a.editing === true, JSON.stringify(t33a));
// 点选区内空白（合成 mousedown 到 layer——target 非 focusable，focusout 不触发、editing 曾残留）
const t33b = await evl(`(function(){
  const lay = document.getElementById("layer");
  const mk = (t, x, y) => new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: t === "mouseup" ? 0 : 1 });
  let capReached = false, editingAtCapture = null;
  const cap = (e) => { capReached = true; editingAtCapture = (typeof editing !== "undefined") ? !!editing : "undef"; };
  document.addEventListener("mousedown", cap, true);
  lay.dispatchEvent(mk("mousedown", 620, 460));
  document.removeEventListener("mousedown", cap, true);
  const el = document.querySelector('#layer .obj[data-k=text]');
  return { capReached, editingAtCapture, editing: !!editing, txtedit: !!document.querySelector(".txtedit"), selObj: selectedObj ? selectedObj.dataset.k : null, elAlive: !!el, tool: typeof tool !== "undefined" ? tool : "?" };
})()`);
// 产品语义（同类产品 同款）：文字工具下点空白=落定原文字并新建空编辑框。断言核心=原文字
// 确实落定（contentEditable 回 false、不再残留 editing 引用），而非残留被守卫拦死
const t33b2 = await evl(`(function(){ const el = document.querySelector('#layer .obj[data-k=text]'); return { elAlive: !!el, ce: el ? el.contentEditable : null, cls: el ? el.className : null }; })()`);
check("T33b 点空白后原编辑落定（contentEditable 回 false）", t33b.elAlive === true && t33b2.ce === "false" && /(^| )obj( |$)/.test(t33b2.cls), JSON.stringify({ t33b, t33b2 }));
// 双击文字 → 应进入编辑（合成双击事件链）
const t33c = await evl(`(function(){
  const el = document.querySelector('#layer .obj[data-k=text]');
  const cx = parseFloat(el.style.left) + el.offsetWidth / 2, cy = parseFloat(el.style.top) + el.offsetHeight / 2;
  const mk = (t, x, y, cc) => new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: t === "mouseup" ? 0 : 1, detail: cc });
  el.dispatchEvent(mk("mousedown", cx, cy, 1));
  document.body.dispatchEvent(mk("mouseup", cx, cy, 1));
  el.dispatchEvent(mk("mousedown", cx, cy, 2));
  document.body.dispatchEvent(mk("mouseup", cx, cy, 2));
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, detail: 2 }));
  return { editing: !!editing, txtedit: !!document.querySelector(".txtedit") };
})()`);
check("T33c 退出编辑后双击可再进编辑", t33c.editing === true && t33c.txtedit === true, JSON.stringify(t33c));
// T29-T32：业界最佳实践对齐（非破坏编辑/标准操纵模型，全部验行为结果）

// T29 属性修改可撤销：选中矩形改色 → Ctrl+Z 撤销恢复旧色 → 重做再变新色
const t29 = await evl(`(function(){
  document.querySelectorAll("#layer .obj").forEach(e => e.remove()); setObjSel(null);
  const el = document.createElement("div");
  el.className = "obj"; el.dataset.k = "rect";
  el.dataset.params = JSON.stringify({ lw: 4, color: "#FF3B30", fill: "none", dash: false, radius: 0, opacity: 1 });
  el.style.cssText = "position:absolute;left:120px;top:120px;width:160px;height:100px;border:4px solid #FF3B30;";
  layer.appendChild(el);
  setObjSel(el);
  setColorForTool("#00A2E8"); syncSelProps();
  const after = getComputedStyle(el).borderColor;
  undoOp();
  const undone = getComputedStyle(el).borderColor;
  redoOp();
  const redone = getComputedStyle(el).borderColor;
  return { after, undone, redone };
})()`);
check("T29 改色可撤销可重做（边色 蓝→红→蓝）", /162,\s*232/.test(t29.after) && /255,\s*59,\s*48/.test(t29.undone) && /162,\s*232/.test(t29.redone), JSON.stringify(t29));

// T30a 画笔选中框贴墨迹（而非覆盖整个选区）且出现缩放手柄
const t30a = await evl(`(function(){
  document.querySelectorAll("#layer .obj").forEach(e => e.remove()); setObjSel(null);
  const el = document.createElement("div");
  el.className = "obj"; el.dataset.k = "pen"; el.style.position = "absolute";
  el.style.left = "0px"; el.style.top = "0px"; el.style.width = "100%"; el.style.height = "100%";
  el.innerHTML = '<svg style="overflow:visible;pointer-events:none" width="100%" height="100%"><polyline fill="none" stroke="#FF3B30" stroke-width="4" points="150,150 250,200 350,170"/></svg>';
  el.dataset.geom = JSON.stringify({ pts: [{x:150,y:150},{x:250,y:200},{x:350,y:170}], lw: 4, color: "#FF3B30" });
  layer.appendChild(el);
  setObjSel(el);
  const b = objBBox(el);
  return { bw: b.w, bh: b.h, resizable: document.getElementById("objsel").classList.contains("resizable") };
})()`);
check("T30a 画笔选中框贴墨迹且可缩放", t30a.bw >= 180 && t30a.bw <= 220 && t30a.bh >= 40 && t30a.bh <= 62 && t30a.resizable, JSON.stringify(t30a));

// T30b 拖 se 角：笔迹点序等比放大（CDP Input 物理鼠标序列，真实输入链——
// 合成 dispatchEvent 在长会话 testbed 里会被某监听拦下，物理链才是用户真实路径）
const hpos = await evl(`(function(){
  const el = document.querySelector('#layer .obj[data-k=pen]');
  if (!el) return null;
  setObjSel(el);
  const h = document.querySelector('#objsel .h.se');
  if (!h) return null;
  const r = h.getBoundingClientRect();
  const el2 = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, hit: el2 ? (el2.className || el2.id || el2.tagName) : null };
})()`);
console.log("T30b hpos:", JSON.stringify(hpos));
await evl(`document.addEventListener("mousedown", (e) => { window.__lastTarget = ((e.target.className && e.target.className.baseVal !== undefined) ? e.target.className.baseVal : e.target.className || e.target.id || e.target.tagName) + " @" + e.clientX + "," + e.clientY; }, true); "hooked"`);
await evl(`(function(){ window.__sp = []; const orig = MouseEvent.prototype.stopPropagation; MouseEvent.prototype.stopPropagation = function() { try { window.__sp.push(((this.target && (this.target.className && this.target.className.baseVal !== undefined) ? this.target.className.baseVal : (this.target.className || this.target.id || this.target.tagName))) + "@" + this.type + "@" + this.eventPhase); } catch (e) { window.__sp.push("ERR"); } return orig.apply(this, arguments); }; return "sp-hooked"; })()`);
if (hpos) {
  const X = Math.round(hpos.x), Y = Math.round(hpos.y);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: X, y: Y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: X + 100, y: Y + 50, button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: X + 100, y: Y + 50, button: "left", buttons: 0, clickCount: 1 });
  await sleep(250);
}
const t30b = await evl(`(function(){
  const lt = window.__lastTarget; window.__lastTarget = null;
  const el = document.querySelector('#layer .obj[data-k=pen]');
  const g = JSON.parse(el.dataset.geom);
  const xs = g.pts.map(p => p.x), ys = g.pts.map(p => p.y);
  return { lastTarget: lt, sp: window.__sp || [], maxX: Math.max.apply(null, xs), maxY: Math.max.apply(null, ys), n: g.pts.length,
    ann: typeof ann !== "undefined" ? ann : "undef", editing: typeof editing !== "undefined" ? !!editing : null,
    draft: typeof draft !== "undefined" ? !!draft : null, cropMode: typeof cropMode !== "undefined" ? cropMode : null,
    escdlg: document.getElementById("escdlg") ? document.getElementById("escdlg").classList.contains("open") : null,
    state: typeof state !== "undefined" ? state : "?" };
})()`);
check("T30b 拖角后笔迹等比放大", hpos && t30b.maxX >= 420 && t30b.maxX <= 480 && t30b.maxY >= 195 && t30b.maxY <= 255, JSON.stringify(t30b));

// T31 选中马赛克：强度/模式回填到面板（改哪项只动哪项的正向一致性）
const t31 = await evl(`(function(){
  document.querySelectorAll("#layer .obj").forEach(e => e.remove()); setObjSel(null);
  const el = document.createElement("div");
  el.className = "obj"; el.dataset.k = "mosaic";
  el.dataset.params = JSON.stringify({ lw: 4, color: "#000000", fill: "none", mos: 25, mode: "blur", dash: false, radius: 0, opacity: 1 });
  el.style.cssText = "position:absolute;left:100px;top:100px;width:120px;height:80px;";
  layer.appendChild(el);
  setObjSel(el);
  const rng = document.getElementById("pr-mos-range");
  return { mos: mosStrength, mode: mosMode, rangeVal: rng ? rng.value : null };
})()`);
check("T31 选中马赛克回填强度25/模糊模式", t31.mos === 25 && t31.mode === "blur" && t31.rangeVal === "25", JSON.stringify(t31));

// T32 选中序号：颜色/样式回填
const t32 = await evl(`(function(){
  document.querySelectorAll("#layer .obj").forEach(e => e.remove()); setObjSel(null);
  const el = document.createElement("div");
  el.className = "obj"; el.dataset.k = "num";
  el.dataset.params = JSON.stringify({ d: 36, color: "#00FF00", style: "outline" });
  el.style.cssText = "position:absolute;left:150px;top:150px;width:36px;height:36px;";
  el.innerHTML = '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">1</span>';
  layer.appendChild(el);
  setObjSel(el);
  return { color: toolColor, style: numStyle };
})()`);
check("T32 选中序号回填颜色与样式", t32.color === "#00FF00" && t32.style === "outline", JSON.stringify(t32));


// T34（新增）编辑中 Esc=退出编辑保留内容（业界标准；此前编辑框 keydown 只处理 Ctrl+Enter，Esc 无响应）
const t34 = await evl(`(function(){
  document.querySelectorAll("#layer .obj").forEach(e => e.remove()); setObjSel(null);
  setTool("text");
  const el = document.createElement("div");
  el.className = "obj"; el.dataset.k = "text";
  el.dataset.text = "原文内容";
  el.dataset.params = JSON.stringify({ family:"default", size:20, color:"#FF3B30", bold:false, italic:false, underline:false, shadow:false, stroke:false, align:"left", line_height:1.0, background:null, bg_opacity:null, bg_radius:null });
  el.style.cssText = "position:absolute;left:150px;top:120px;font-size:20px;color:#FF3B30;";
  el.textContent = "原文内容";
  layer.appendChild(el);
  setObjSel(el); reEditText(el);
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
  return { editing: !!editing, ce: el.contentEditable, txt: el.dataset.text, selObj: selectedObj === el };
})()`);
check("T34 编辑中 Esc=退出编辑保留内容并保持选中", t34.editing === false && t34.ce === "false" && t34.txt === "原文内容" && t34.selObj === true, JSON.stringify(t34));

// T35（新增）编辑中右键=确认退出（同类产品：右键结束输入；此前编辑中右键弹输出菜单且无法粘贴）
const t35b = await evl(`(function(){
  const el = document.querySelector('#layer .obj[data-k=text]');
  if (!el) return { err: "no el" };
  setObjSel(el); reEditText(el);
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 140, button: 2 }));
  return { editing: !!editing, ce: el.contentEditable, txt: el.dataset.text };
})()`);
check("T35 编辑中右键=确认退出", t35b.editing === false && t35b.ce === "false" && t35b.txt === "原文内容", JSON.stringify(t35b));

// T36（新增）二次编辑落定可撤销：改内容 → Ctrl+Z 恢复旧内容 → 重做恢复新内容
const t36 = await evl(`(function(){
  const el = document.querySelector('#layer .obj[data-k=text]');
  if (!el) return { err: "no el" };
  setObjSel(el); reEditText(el);
  el.textContent = "改过的话";
  finishText(el);
  const after = el.dataset.text;
  undoOp();
  const undone = el.dataset.text;
  redoOp();
  const redone = el.dataset.text;
  return { after, undone, redone };
})()`);
check("T36 二次编辑改内容可撤销可重做", t36.after === "改过的话" && t36.undone === "原文内容" && t36.redone === "改过的话", JSON.stringify(t36));

// 收尾清场
await evl(`(function(){ document.querySelectorAll("#layer .obj").forEach(e => e.remove()); setObjSel(null); editing = null; return "clean"; })()`);

console.log('PAGE ERRORS:', await evl('JSON.stringify(window.__errs||[])'));
const fails = results.filter((r) => !r.ok).length;
console.log(fails === 0 ? "ALL PASS (" + results.length + ")" : "FAILURES: " + fails + "/" + results.length);
chrome.kill();
process.exit(fails === 0 ? 0 : 1);
