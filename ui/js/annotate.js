// 定影标注编辑器 —— 按 docs/ui-prototype-v2.html「标注编辑器」场景实现。
// 工具：选择V/箭头A/形状(矩形R·椭圆O，合并槽位+小三角菜单)/文字T/序号N/高亮H/马赛克M/橡皮擦E/裁剪C
//       + 撤销重做(20步) + 另存为/保存 + 未保存弹窗 + 上下文属性行 + footbar 状态 + 主题记忆。
// 保存：画布对象按 DOM 顺序序列化为 AnnotationScript(px, 基图坐标系)，由 Rust 渲染引擎出衍生图。
const { invoke: annInvoke } = window.__TAURI__.core;
let ann = null; // 编辑器会话句柄（非空=编辑中）
let rememberOn = true;

// 编辑器状态（字段与 docs/ui-prototype-v2.html 的 ED 一致）
const ED = {
  tool: "select", shape: "rect", color: "#FF3B30", lw: 8, fs: 44,
  start: 1, lastNum: 0, nextNum: 1, fill: "stroke", hlop: 40, mos: 12, numStyle: "solid",
  font: "Microsoft YaHei UI", tb: false, ti: false, tu: false, tshadow: false, talign: "left", tline: "1.5",
  undo: [], redo: [], sel: null, dirty: false, cropRing: null,
  crop: null, // 最近一次生效的裁剪 {at:[x,y], size:[w,h]}（基图像素）
};

const ED_COLORS = ["#FF3B30", "#FA5151", "#FF7A45", "#FFB020", "#FFD100", "#B8E986", "#34C98E", "#10B981",
  "#0A84FF", "#2E5BFF", "#6C5CE7", "#B689FF", "#FF6FA5", "#8E8E93", "#FFFFFF", "#1D1D1F"];
const ED_TOOLS = {
  select: ["选择", "拖动移动 · 方向键微调 1px（⇧ 10px）· Delete 删除 · 双击文字再编辑"],
  arrow: ["箭头", "拖出箭头 · 按住 Shift 锁定水平 / 垂直 / 45°"],
  rect: ["矩形", "拖出矩形 · 上方可切描边 / 填充"],
  ellipse: ["椭圆", "拖出椭圆 · 上方可切描边 / 填充"],
  text: ["文字", "点画布输入 · Ctrl+Enter 确认（Enter 换行）"],
  num: ["序号", "连点自增 · 按 Alt 用上一个序号"],
  highlight: ["高亮", "拖出高亮条 · 正片叠底，不遮住下面的字"],
  mosaic: ["马赛克", "拖出区域 · 强度三档（轻 8 / 中 12 / 重 16）"],
  eraser: ["橡皮擦", "点一下删掉单个标注 · 可撤销"],
  crop: ["裁剪", "拖出保留区 · 双击或 Enter 确认 · Esc 取消"],
};
const ED_SHOW = {
  select: ["tip"], arrow: ["color", "width"], rect: ["color", "width", "fill"], ellipse: ["color", "width", "fill"],
  text: ["color", "fs", "txstyle"], num: ["color", "start", "numstyle"], highlight: ["hlop"], mosaic: ["mos"],
  eraser: ["tip"], crop: ["tip"],
};
const ED_TIP = {
  select: "属性行随工具变化；改动会自动记住为默认值，可在「标注主题」页关闭记忆",
  eraser: "悬停会高亮要删的对象，点一下即删，可撤销",
  crop: "裁剪同样生成衍生图，原图永不被覆盖",
};

function dpr() { return window.devicePixelRatio || 1; }

/* ============ 进入编辑器 ============ */
// 从历史文件进入（详情页「编辑」）：支持 lineage 横幅
async function startAnnotateFromFile(p) {
  p = p || (await annInvoke("annotate_file_payload").catch(() => null));
  if (!p) { annInvoke("overlay_close").catch(() => {}); return; }
  // 画布铺在屏幕中央（文件编辑没有"原选区"）
  const sw = window.innerWidth, sh = window.innerHeight;
  const maxW = Math.min(sw * 0.82, 1280), maxH = sh * 0.66;
  const s = Math.min(maxW / p.width, maxH / p.height, 1);
  const cw = Math.round(p.width * s), chh = Math.round(p.height * s);
  const cx = Math.round((sw - cw) / 2), cy = Math.round(Math.max(24, (sh - chh) / 2 - 40));
  openEditor(p.path, p.width, p.height, cx, cy, cw, chh, p.parent || null);
}

function openEditor(basePath, baseW, baseH, cx, cy, cw, chh, parentFile) {
  state = "annotating";
  ann = {
    basePath, baseW, baseH, cx, cy, cw, chh,
    scale: cw / baseW, // css px / image px
    parentFile, dirty: false,
  };
  ED.undo = []; ED.redo = []; ED.sel = null; ED.cropRing = null; ED.nextNum = ED.start; ED.lastNum = 0;
  buildEditor();
  edRestoreTheme();
}

/* ============ DOM 构建 ============ */
function buildEditor() {
  const wrap = document.createElement("div");
  wrap.id = "annwrap";
  wrap.innerHTML = `
    <div id="ann-shade"></div>
    <div id="ann-banner" class="ed-banner" style="display:none"></div>
    <div id="ann-canvas" class="crosshair">
      <img id="annbase" draggable="false">
      <div id="ed-shot"></div>
    </div>
    <div id="ann-float">
      <div class="ed-head" id="ed-head"></div>
      <div class="ed-props" id="ed-props"></div>
      <div class="ed-footbar" id="ed-footbar"></div>
    </div>
    <div class="ed-shapemenu" id="ed-shapemenu">
      <button data-shape="rect"><span class="g">▭</span>矩形<i class="k">R</i></button>
      <button data-shape="ellipse"><span class="g">◯</span>椭圆<i class="k">O</i></button>
    </div>
    <div class="ed-mask" id="ed-mask">
      <div class="ed-modal" role="dialog" aria-modal="true" aria-label="未保存的标注">
        <div class="ttl">有未保存的标注</div>
        <p>离开将丢失本次全部操作。也可以先保存——会生成新的衍生图，原图永远不会被覆盖。</p>
        <div class="btns">
          <button id="ed-m-cancel">取消</button>
          <button id="ed-m-discard">不保存</button>
          <button class="pri" id="ed-m-save">保存</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const canvas = wrap.querySelector("#ann-canvas");
  canvas.style.left = ann.cx + "px";
  canvas.style.top = ann.cy + "px";
  canvas.style.width = ann.cw + "px";
  canvas.style.height = ann.chh + "px";

  // lineage 横幅（在衍生图上继续编辑）
  if (ann.parentFile) {
    const b = wrap.querySelector("#ann-banner");
    b.style.display = "block";
    b.style.position = "absolute";
    b.style.left = ann.cx + "px";
    b.style.top = Math.max(0, ann.cy - 30) + "px";
    b.style.width = ann.cw + "px";
    b.style.boxSizing = "border-box";
    b.textContent = `这是在「${ann.parentFile}」的标注上继续编辑，保存将生成新衍生图（原图永不被覆盖）`;
  }

  buildHead(wrap.querySelector("#ed-head"));
  buildProps(wrap.querySelector("#ed-props"));
  buildFootbar(wrap.querySelector("#ed-footbar"));

  // 底图
  const img = wrap.querySelector("#annbase");
  img.alt = "";
  annInvoke("thumbnail", { path: ann.basePath, maxW: 2400 })
    .then((url) => { img.src = url; })
    .catch(() => {});

  // 工具栏贴画布下沿；空间不足翻上方；水平对齐画布中心并收进屏幕
  const float = wrap.querySelector("#ann-float");
  positionFloat(float);
  requestAnimationFrame(() => positionFloat(float));

  wireCanvas();
  setTool(ED.tool);
  edStackUI();
  if (ann.parentFile) { ED.dirty = false; } // 从衍生图进入，未画不算脏
}

function positionFloat(float) {
  const below = window.innerHeight - (ann.cy + ann.chh);
  const fh = float.offsetHeight || 120;
  let top;
  if (below >= fh + 16) top = ann.cy + ann.chh + 10;
  else top = Math.max(8, ann.cy - fh - 10);
  float.style.top = top + "px";
  const w = float.offsetWidth || 560;
  let left = ann.cx + ann.cw / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  float.style.left = left + "px";
}

function buildHead(head) {
  head.innerHTML = `
    <button class="ed-tool" data-tool="select" title="选择 V"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="display:block;margin:auto"><path d="M5 3l14 8.5-6.2 1.4L16 20l-2.8 1.2-3.2-7-4.5 4.2z"/></svg></button>
    <button class="ed-tool" data-tool="arrow" title="箭头 A">↗</button>
    <button class="ed-tool" data-tool="shape" title="形状 · 点按=上次形状（默认矩形 R）· 点右下角小三角切换矩形 / 椭圆"><span id="ed-shape-glyph">▭</span><i class="ed-tri" id="ed-tri"></i></button>
    <button class="ed-tool" data-tool="text" title="文字 T">T</button>
    <button class="ed-tool" data-tool="num" title="序号 N">①</button>
    <button class="ed-tool" data-tool="highlight" title="高亮 H">▬</button>
    <button class="ed-tool" data-tool="mosaic" title="马赛克 M">▦</button>
    <button class="ed-tool" data-tool="eraser" title="橡皮擦 E（点一下删掉单个标注）">⌫</button>
    <button class="ed-tool" data-tool="crop" title="裁剪 C">⌗</button>
    <span class="sep"></span>
    <button class="ed-tool" id="ed-undo" title="撤销 Ctrl+Z">↶</button>
    <button class="ed-tool" id="ed-redo" title="重做 Ctrl+Shift+Z">↷</button>
    <div class="right">
      <button id="ed-saveas" title="保存副本后继续编辑（原图不动）">另存为</button>
      <button id="ed-exit" title="关闭（有未保存标注会先询问）">✕</button>
      <button class="pri" id="ed-save">保存 <span class="kb">Ctrl+S</span></button>
    </div>`;
  head.querySelector("#ed-save").addEventListener("click", () => doSave(false));
  head.querySelector("#ed-saveas").addEventListener("click", () => doSave(true));
  head.querySelector("#ed-exit").addEventListener("click", requestClose);
  head.querySelector("#ed-undo").addEventListener("click", edUndo);
  head.querySelector("#ed-redo").addEventListener("click", edRedo);
}

function buildProps(props) {
  const swatches = ED_COLORS.map(
    (c, i) => `<button class="ed-sw${i === 0 ? " on" : ""}" data-c="${c}" title="${i === 0 ? "教程红（主题默认）" : c}" style="background:${c}"></button>`
  ).join("");
  props.innerHTML = `
    <span data-g="color" style="display:none;align-items:center;gap:8px"><span style="font-size:11px">颜色</span>
      <span style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;max-width:270px" id="ed-colors">${swatches}</span></span>
    <span data-g="width" style="display:none;align-items:center;gap:6px">线宽 <span class="num" id="ed-lw">${ED.lw}</span>
      <input type="range" min="2" max="24" value="${ED.lw}" id="ed-lwr" style="width:104px"></span>
    <span data-g="fill" style="display:none" class="ed-seg" id="ed-fill">
      <button data-f="stroke" class="on">描边</button><button data-f="fill">填充</button><button data-f="both">描边+浅填充</button></span>
    <span data-g="fs" style="display:none;align-items:center;gap:6px">字号 <span class="num" id="ed-fs">${ED.fs}</span>
      <input type="range" min="16" max="96" value="${ED.fs}" id="ed-fsr" style="width:96px"></span>
    <span data-g="txstyle" style="display:none;align-items:center;gap:7px">
      <select id="ed-font" title="字体（本机字体）" style="max-width:150px">
        <option value="Microsoft YaHei UI" selected>Microsoft YaHei UI</option>
        <option value="Microsoft YaHei">微软雅黑</option>
        <option value="SimSun">宋体</option>
        <option value="SimHei">黑体</option>
        <option value="KaiTi">楷体</option>
        <option value="Arial">Arial</option>
        <option value="Segoe UI">Segoe UI</option>
        <option value="Consolas">Consolas</option>
        <option value="Georgia">Georgia</option>
      </select>
      <span class="ed-seg" id="ed-tstyle">
        <button data-ts="b" title="加粗"><b>B</b></button>
        <button data-ts="i" title="斜体"><i>I</i></button>
        <button data-ts="u" title="下划线"><u>U</u></button>
        <button data-ts="shadow" title="阴影">Ⓐ</button></span>
      <span class="ed-seg" id="ed-talign" title="对齐">
        <button data-ta="left" class="on" title="左对齐">⇤</button>
        <button data-ta="center" title="居中">↔</button>
        <button data-ta="right" title="右对齐">⇥</button></span>
      <select id="ed-lh" title="行距">
        <option value="1.2">行距 1.2</option>
        <option value="1.5" selected>行距 1.5</option>
        <option value="1.8">行距 1.8</option>
      </select></span>
    <span data-g="hlop" style="display:none;align-items:center;gap:6px">不透明度 <span class="num" id="ed-hlopv">${ED.hlop}</span>
      <input type="range" min="10" max="90" value="${ED.hlop}" id="ed-hlopr" style="width:96px"></span>
    <span data-g="mos" style="display:none;align-items:center;gap:4px">强度
      <span class="ed-seg ed-seg-prev" id="ed-mos">
        <button data-m="8" title="轻 · 像素块 8px"><i class="mos-prev" style="background:repeating-linear-gradient(90deg,#8E8E93 0 4px,#C9C9CF 4px 8px,#9A9AA0 8px 12px)"></i></button>
        <button data-m="12" class="on" title="中 · 像素块 12px"><i class="mos-prev" style="background:repeating-linear-gradient(90deg,#8E8E93 0 6px,#C9C9CF 6px 12px,#9A9AA0 12px 18px)"></i></button>
        <button data-m="16" title="重 · 像素块 16px"><i class="mos-prev" style="background:repeating-linear-gradient(90deg,#8E8E93 0 8px,#C9C9CF 8px 16px,#9A9AA0 16px 24px)"></i></button></span></span>
    <span data-g="start" style="display:none;align-items:center;gap:6px">序号起始
      <input type="number" value="${ED.start}" min="1" id="ed-start" style="width:52px"></span>
    <span data-g="numstyle" style="display:none;align-items:center;gap:4px">样式
      <span class="ed-seg ed-seg-prev" id="ed-ns">
        <button data-ns="solid" class="on" title="实心圆：色块白字"><i class="ns-prev ns-solid">1</i></button>
        <button data-ns="outline" title="描边圆：白底色边"><i class="ns-prev ns-outline">1</i></button>
        <button data-ns="plain" title="纯数字：加粗大号"><i class="ns-prev ns-plain">1</i></button></span></span>
    <span data-g="tip" style="display:none;align-items:center;color:var(--ov-fg-dim);font-size:11px" id="ed-tip"></span>
    <span style="margin-left:auto;color:var(--ov-fg-dim)">标注主题：教程红 · 改动自动记住为默认（可在「标注主题」页关闭）</span>`;
  wireProps(props);
}

function buildFootbar(fb) {
  fb.innerHTML = `
    <span>${ann.baseW} × ${ann.baseH}</span><span>·</span>
    <span>工具：<span class="toolname" id="ed-tname">选择</span><span id="ed-thint"></span></span><span>·</span>
    <span id="ed-coord">光标 0, 0</span><span>·</span><span id="ed-stack">撤销栈 0 步</span>
    <span class="outname">将生成 ${outName()}</span>`;
}

function outName() {
  const m = String(ann.basePath).match(/([^\\/]+)\.(png|jpe?g)$/i);
  return (m ? m[1] : "image") + "-ann.png";
}

/* ============ 主题记忆（settings.annotation ↔ 编辑器） ============ */
function edRemember() {
  if (!ann || !rememberOn) return;
  annInvoke("set_setting", {
    key: "annotation",
    value: {
      color: ED.color, arrow_width: ED.lw, shape_width: ED.lw, text_size: ED.fs,
      text_bold: ED.tb, text_italic: ED.ti, text_underline: ED.tu, text_shadow: ED.tshadow,
      text_align: ED.talign, step_diameter: 56, step_style: ED.numStyle === "outline" ? "outline" : "solid",
      mosaic_strength: ED.mos, highlight_opacity: ED.hlop / 100,
    },
  }).catch(() => {});
}
async function edRestoreTheme() {
  try {
    const s = await annInvoke("get_settings");
    rememberOn = s.remember_annotation !== false;
    const a = s.annotation || {};
    if (ED_COLORS.includes(a.color)) ED.color = a.color;
    if (a.arrow_width >= 2 && a.arrow_width <= 24) ED.lw = Math.round(a.arrow_width);
    if (a.text_size >= 16 && a.text_size <= 96) ED.fs = Math.round(a.text_size);
    if (a.mosaic_strength >= 8 && a.mosaic_strength <= 16) ED.mos = a.mosaic_strength;
    if (a.highlight_opacity >= 0.1 && a.highlight_opacity <= 0.9) ED.hlop = Math.round(a.highlight_opacity * 100);
    if (a.step_style === "outline" || a.step_style === "solid") ED.numStyle = a.step_style;
    ED.nextNum = ED.start;
    edShowProps();
    edSyncControls();
  } catch (e) { /* 主题读取失败不影响编辑 */ }
}
function edSyncControls() {
  const q = (s2) => document.querySelector(s2);
  const lw = q("#ed-lwr"), fs = q("#ed-fsr"), hl = q("#ed-hlopr");
  if (lw) { lw.value = ED.lw; q("#ed-lw").textContent = ED.lw; }
  if (fs) { fs.value = ED.fs; q("#ed-fs").textContent = ED.fs; }
  if (hl) { hl.value = ED.hlop; q("#ed-hlopv").textContent = ED.hlop; }
  document.querySelectorAll("#ed-colors .ed-sw").forEach((x) => x.classList.toggle("on", x.dataset.c === ED.color));
  document.querySelectorAll(".ns-prev").forEach((p) => p.style.setProperty("--ed-c", ED.color));
}

/* ============ 工具与属性行 ============ */
const ED_SHAPE_GLYPH = { rect: "▭", ellipse: "◯" };

function edShowProps() {
  document.querySelectorAll("#ed-props [data-g]").forEach((el) => {
    el.style.display = ED_SHOW[ED.tool].indexOf(el.dataset.g) >= 0 ? "flex" : "none";
  });
  const tip = document.getElementById("ed-tip");
  if (tip) tip.textContent = ED_TIP[ED.tool] || "";
}

function edShapeUI() {
  const g = document.getElementById("ed-shape-glyph");
  if (g) g.textContent = ED_SHAPE_GLYPH[ED.shape];
  document.querySelectorAll("#ed-shapemenu button").forEach((b) => b.classList.toggle("on", b.dataset.shape === ED.shape));
}

function setTool(t) {
  if (!ann) return;
  ED.tool = t;
  if (t === "rect" || t === "ellipse") { ED.shape = t; edShapeUI(); }
  document.querySelectorAll("[data-tool]").forEach((b) => {
    const on = b.dataset.tool === "shape" ? (t === "rect" || t === "ellipse") : b.dataset.tool === t;
    b.classList.toggle("on", on);
  });
  const canvas = document.getElementById("ann-canvas");
  if (canvas) {
    canvas.classList.toggle("tool-select", t === "select");
    canvas.classList.toggle("tool-eraser", t === "eraser");
    canvas.classList.toggle("crosshair", t !== "select" && t !== "eraser");
  }
  edDeselect();
  if (ED.cropRing) { ED.cropRing.remove(); ED.cropRing = null; }
  edShowProps();
  const tn = document.getElementById("ed-tname"), th = document.getElementById("ed-thint");
  if (tn) tn.textContent = ED_TOOLS[t][0];
  if (th) th.textContent = " · " + ED_TOOLS[t][1];
}

function wireProps(props) {
  props.querySelectorAll("#ed-colors .ed-sw").forEach((s2) => {
    s2.addEventListener("click", () => {
      ED.color = s2.dataset.c;
      document.querySelectorAll(".ns-prev").forEach((p) => p.style.setProperty("--ed-c", ED.color));
      props.querySelectorAll("#ed-colors .ed-sw").forEach((x) => x.classList.toggle("on", x === s2));
    });
  });
  props.querySelector("#ed-lwr").addEventListener("input", function () {
    ED.lw = Number(this.value); props.querySelector("#ed-lw").textContent = this.value;
  });
  props.querySelector("#ed-fsr").addEventListener("input", function () {
    ED.fs = Number(this.value); props.querySelector("#ed-fs").textContent = this.value;
  });
  props.querySelector("#ed-hlopr").addEventListener("input", function () {
    ED.hlop = Number(this.value); props.querySelector("#ed-hlopv").textContent = this.value;
  });
  props.querySelector("#ed-start").addEventListener("input", function () {
    ED.start = Math.max(1, Number(this.value) || 1); ED.nextNum = ED.start;
  });
  props.querySelectorAll("#ed-fill button").forEach((b) => {
    b.addEventListener("click", () => {
      ED.fill = b.dataset.f;
      props.querySelectorAll("#ed-fill button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  props.querySelectorAll("#ed-ns button").forEach((b) => {
    b.addEventListener("click", () => {
      ED.numStyle = b.dataset.ns;
      props.querySelectorAll("#ed-ns button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  props.querySelectorAll("#ed-tstyle button").forEach((b) => {
    b.addEventListener("click", () => {
      const k = { b: "tb", i: "ti", u: "tu", shadow: "tshadow" }[b.dataset.ts];
      ED[k] = !ED[k]; b.classList.toggle("on", ED[k]);
    });
  });
  props.querySelectorAll("#ed-talign button").forEach((b) => {
    b.addEventListener("click", () => {
      ED.talign = b.dataset.ta;
      props.querySelectorAll("#ed-talign button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  const font = props.querySelector("#ed-font");
  if (font) font.addEventListener("change", function () { ED.font = this.value; });
  const lh = props.querySelector("#ed-lh");
  if (lh) lh.addEventListener("change", function () { ED.tline = this.value; });
}

/* ============ 撤销 / 重做（20 步，add/del/move/crop 四类） ============ */
function edStackUI() {
  const el = document.getElementById("ed-stack");
  if (el) el.textContent = `撤销栈 ${ED.undo.length} 步`;
}
function edPush(u) {
  ED.undo.push(u);
  if (ED.undo.length > 20) ED.undo.shift();
  ED.redo = []; ED.dirty = true;
  edStackUI();
}
function edApply(u, back) {
  if (u.t === "add") { back ? u.el.remove() : u.parent.appendChild(u.el); }
  else if (u.t === "del") { back ? u.el.remove() : u.parent.appendChild(u.el); }
  else if (u.t === "move") { u.el.style.left = (back ? u.x : u.nx) + "px"; u.el.style.top = (back ? u.y : u.ny) + "px"; }
  else if (u.t === "crop") { u.shot.style.clipPath = back ? u.prev : u.next; ED.crop = back ? null : u.rect; }
}
function edUndo() {
  const u = ED.undo.pop(); if (!u) return;
  edApply(u, true); ED.redo.push(u); edStackUI();
}
function edRedo() {
  const u = ED.redo.pop(); if (!u) return;
  edApply(u, false); ED.undo.push(u); edStackUI();
}

/* ============ 画布交互 ============ */
function edshot() { return document.getElementById("ed-shot"); }
function edPt(e) {
  const r = edshot().getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function edSelect(el) { edDeselect(); ED.sel = el; el.classList.add("sel"); }
function edDeselect() { if (ED.sel) { ED.sel.classList.remove("sel"); ED.sel = null; } }

let edDrag = null, edDraft = null, edEditing = null;

function edObj() {
  const el = document.createElement("span");
  el.className = "ed-ann ed-obj";
  return el;
}
function hexA(h, a) {
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function edArrowSvg(el, sx, sy, ex, ey) {
  const l = Math.min(sx, ex) - 24, t = Math.min(sy, ey) - 24;
  const w = Math.max(Math.abs(ex - sx), 1) + 48, h = Math.max(Math.abs(ey - sy), 1) + 48;
  el.style.left = l + "px"; el.style.top = t + "px";
  el.style.width = w + "px"; el.style.height = h + "px";
  el.setAttribute("width", w); el.setAttribute("height", h); el.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const x1 = sx - l, y1 = sy - t, x2 = ex - l, y2 = ey - t;
  el.querySelector("line").setAttribute("x1", x1);
  el.querySelector("line").setAttribute("y1", y1);
  el.querySelector("line").setAttribute("x2", x2);
  el.querySelector("line").setAttribute("y2", y2);
  el.querySelector("line").setAttribute("stroke", ED.color);
  el.querySelector("line").setAttribute("stroke-width", ED.lw);
  const ang = Math.atan2(y2 - y1, x2 - x1), s = 8 + ED.lw;
  const p = (a) => `${x2 - Math.cos(ang + a) * s} ${y2 - Math.sin(ang + a) * s}`;
  el.querySelector("path").setAttribute("d", `M${x2} ${y2} L${p(0.45)} L${p(-0.45)} Z`);
  el.querySelector("path").setAttribute("fill", ED.color);
  el.dataset.geom = JSON.stringify({ x1: sx, y1: sy, x2: ex, y2: ey, lw: ED.lw, color: ED.color });
}

function edShapeStyle(el, tool) {
  if (tool === "rect") {
    el.style.border = ED.lw + "px solid " + ED.color; el.style.borderRadius = "6px";
    el.style.boxSizing = "border-box";
    if (ED.fill === "fill") el.style.background = ED.color;
    if (ED.fill === "both") el.style.background = hexA(ED.color, 0.12);
  } else if (tool === "ellipse") {
    el.style.border = ED.lw + "px solid " + ED.color; el.style.borderRadius = "50%";
    el.style.boxSizing = "border-box";
    if (ED.fill === "fill") el.style.background = ED.color;
    if (ED.fill === "both") el.style.background = hexA(ED.color, 0.12);
  } else if (tool === "highlight") {
    el.style.background = `rgba(255,176,32,${ED.hlop / 100})`; el.style.mixBlendMode = "multiply";
  } else if (tool === "mosaic") {
    const m = ED.mos;
    el.style.background = `repeating-linear-gradient(90deg,#8E8E93 0 ${m}px,#C9C9CF ${m}px ${2 * m}px)`;
    el.style.borderRadius = "2px";
  }
}

function placeNum(p, alt) {
  const n = alt && ED.lastNum ? ED.lastNum : ED.nextNum, d = 30;
  const el = edObj(); el.dataset.k = "num";
  el.dataset.params = JSON.stringify({ label: n, color: ED.color, d, style: ED.numStyle });
  el.style.cssText = `position:absolute;left:${p.x - d / 2}px;top:${p.y - d / 2}px;width:${d}px;height:${d}px;`;
  const span = document.createElement("span");
  span.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;";
  if (ED.numStyle === "outline") {
    span.style.cssText += `border-radius:50%;background:#fff;color:${ED.color};border:3px solid ${ED.color};box-shadow:0 2px 6px rgba(0,0,0,.35);font-size:15px;font-weight:500;`;
  } else if (ED.numStyle === "plain") {
    span.style.cssText += `color:${ED.color};font-weight:700;font-size:${d + 6}px;text-shadow:0 1px 3px rgba(0,0,0,.4);`;
  } else {
    span.style.cssText += `border-radius:50%;background:${ED.color};color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.35);font-size:15px;font-weight:500;`;
  }
  span.textContent = n;
  el.appendChild(span);
  edshot().appendChild(el);
  ED.lastNum = n; if (!alt) ED.nextNum++;
  edPush({ t: "add", el, parent: edshot() });
}

function edTextCSS(el) {
  el.style.fontFamily = `'${ED.font}','Microsoft YaHei UI',sans-serif`;
  el.style.fontWeight = ED.tb ? "700" : "400";
  el.style.fontStyle = ED.ti ? "italic" : "normal";
  el.style.textDecoration = ED.tu ? "underline" : "none";
  el.style.textShadow = ED.tshadow ? "0 2px 6px rgba(0,0,0,.55)" : "none";
  el.style.textAlign = ED.talign; el.style.lineHeight = ED.tline;
}

function startText(p) {
  const el = document.createElement("div");
  el.className = "ed-txtedit"; el.contentEditable = "true"; el.spellcheck = false;
  el.style.left = p.x + "px"; el.style.top = p.y + "px";
  el.style.fontSize = ED.fs + "px"; el.style.color = ED.color;
  edTextCSS(el);
  edshot().appendChild(el); el.focus(); edEditing = el;
  el.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); edFinishText(); }
  });
  el.addEventListener("blur", () => edFinishText());
}

function edFinishText() {
  if (!edEditing) return;
  const el = edEditing; edEditing = null;
  const txt = el.textContent.trim();
  if (!txt) { el.remove(); return; }
  el.contentEditable = "false";
  el.classList.remove("ed-txtedit"); el.classList.add("ed-ann", "ed-obj"); el.dataset.k = "text";
  el.dataset.params = JSON.stringify({ fs: ED.fs, color: ED.color, font: ED.font, tb: ED.tb, ti: ED.ti, tu: ED.tu, tshadow: ED.tshadow, talign: ED.talign, tline: ED.tline });
  edPush({ t: "add", el, parent: edshot() });
}

function edEditText(el) {
  el.classList.remove("ed-obj"); el.classList.add("ed-txtedit");
  el.contentEditable = "true"; edEditing = el; el.focus();
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  el.addEventListener("blur", function h() {
    el.removeEventListener("blur", h); edEditing = null; el.contentEditable = "false";
    el.classList.remove("ed-txtedit"); el.classList.add("ed-obj");
    if (!el.textContent.trim()) { edPush({ t: "del", el, parent: edshot() }); el.remove(); }
  });
}

function edCancelDraw() {
  if (edDraft && edDraft.el) edDraft.el.remove();
  edDraft = null;
  if (ED.cropRing) { ED.cropRing.remove(); ED.cropRing = null; }
  edDeselect();
}

function edApplyCrop() {
  const ring = ED.cropRing; if (!ring) return;
  const l = parseFloat(ring.style.left), t = parseFloat(ring.style.top);
  const w = parseFloat(ring.style.width), h = parseFloat(ring.style.height);
  const prev = edshot().style.clipPath || "none";
  const clip = `inset(${t}px ${edshot().clientWidth - l - w}px ${edshot().clientHeight - t - h}px ${l}px round 8px)`;
  edshot().style.clipPath = clip;
  const f = 1 / ann.scale;
  const rect = { at: [Math.round(l * f), Math.round(t * f)], size: [Math.round(w * f), Math.round(h * f)] };
  edPush({ t: "crop", shot: edshot(), prev, next: clip, rect });
  ring.remove(); ED.cropRing = null;
  const th = document.getElementById("ed-thint");
  if (th) th.textContent = " · 已按保留区裁剪（生成衍生图，原图不动）";
}

function wireCanvas() {
  const canvas = document.getElementById("ann-canvas");
  const shot = edshot();

  // window 级监听只挂一次（跨会话复用，处理器内部以 ann 为空守卫）
  if (!window.__annWindowWired) {
    window.__annWindowWired = true;
    window.addEventListener("mousemove", (e) => {
      if (!ann) return;
      if (edDrag) {
        const q = edPt(e);
        edDrag.el.style.left = (q.x - edDrag.dx) + "px";
        edDrag.el.style.top = (q.y - edDrag.dy) + "px";
        edDrag.moved = true; return;
      }
      if (!edDraft) return;
      const p = edPt(e);
      let x2 = p.x, y2 = p.y;
      if (edDraft.k === "arrow" && e.shiftKey) {
        const dx = x2 - edDraft.x, dy = y2 - edDraft.y;
        const ang = Math.atan2(dy, dx), snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
        x2 = edDraft.x + Math.cos(snap) * len; y2 = edDraft.y + Math.sin(snap) * len;
      }
      if (edDraft.k === "crop") {
        const ring = ED.cropRing;
        ring.style.left = Math.min(edDraft.x, x2) + "px"; ring.style.top = Math.min(edDraft.y, y2) + "px";
        ring.style.width = Math.abs(x2 - edDraft.x) + "px"; ring.style.height = Math.abs(y2 - edDraft.y) + "px";
        return;
      }
      const el = edDraft.el;
      if (edDraft.k === "arrow") { edArrowSvg(el, edDraft.x, edDraft.y, x2, y2); return; }
      el.style.left = Math.min(edDraft.x, x2) + "px"; el.style.top = Math.min(edDraft.y, y2) + "px";
      el.style.width = Math.abs(x2 - edDraft.x) + "px"; el.style.height = Math.abs(y2 - edDraft.y) + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!ann) return;
      if (edDrag) {
        if (edDrag.moved) edPush({ t: "move", el: edDrag.el, x: edDrag.x, y: edDrag.y, nx: parseFloat(edDrag.el.style.left), ny: parseFloat(edDrag.el.style.top) });
        edDrag = null; return;
      }
      if (!edDraft) return;
      const d = edDraft; edDraft = null;
      if (d.k === "crop") {
        const w = parseFloat(ED.cropRing.style.width), h = parseFloat(ED.cropRing.style.height);
        if (w < 12 || h < 12) { ED.cropRing.remove(); ED.cropRing = null; return; }
        const th = document.getElementById("ed-thint");
        if (th) th.textContent = " · 双击或 Enter 确认裁剪 · Esc 取消";
        return;
      }
      if (d.k === "arrow" || parseFloat(d.el.style.width) > 6 || parseFloat(d.el.style.height) > 6) {
        edPush({ t: "add", el: d.el, parent: edshot() });
      } else d.el.remove();
    });
  }

  shot.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || edEditing) return;
    const t = e.target;
    if (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "BUTTON") return;
    const p = edPt(e);
    if (ED.tool === "select") {
      const obj = t.closest ? t.closest(".ed-obj") : null;
      if (obj && shot.contains(obj)) {
        edSelect(obj);
        edDrag = { el: obj, dx: p.x - parseFloat(obj.style.left), dy: p.y - parseFloat(obj.style.top), x: parseFloat(obj.style.left), y: parseFloat(obj.style.top), moved: false };
      } else edDeselect();
      return;
    }
    if (ED.tool === "eraser") {
      const del = t.closest ? t.closest(".ed-obj") : null;
      if (del && shot.contains(del)) { edPush({ t: "del", el: del, parent: shot }); del.remove(); }
      return;
    }
    if (ED.tool === "text") { startText(p); return; }
    if (ED.tool === "num") { placeNum(p, e.altKey); return; }
    e.preventDefault();
    if (ED.tool === "crop") {
      const ring = edObj(); ring.classList.add("ed-cropring");
      ring.style.left = p.x + "px"; ring.style.top = p.y + "px";
      ring.style.width = "0px"; ring.style.height = "0px";
      shot.appendChild(ring); ED.cropRing = ring;
      edDraft = { k: "crop", x: p.x, y: p.y };
      return;
    }
    let el;
    if (ED.tool === "arrow") {
      el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      el.setAttribute("class", "ed-ann ed-obj"); el.dataset.k = "arrow";
      el.innerHTML = '<line stroke-linecap="round"/><path/>';
    } else {
      el = edObj(); el.dataset.k = ED.tool;
      el.dataset.params = JSON.stringify({ lw: ED.lw, color: ED.color, fill: ED.fill, hlop: ED.hlop, mos: ED.mos });
      edShapeStyle(el, ED.tool);
    }
    el.style.left = p.x + "px"; el.style.top = p.y + "px";
    if (ED.tool !== "arrow") { el.style.width = "0px"; el.style.height = "0px"; }
    shot.appendChild(el);
    edDraft = { k: ED.tool, el, x: p.x, y: p.y };
  });

  shot.addEventListener("dblclick", (e) => {
    if (ED.tool === "crop" && ED.cropRing) { edApplyCrop(); return; }
    if (ED.tool === "select") {
      const obj = e.target.closest ? e.target.closest(".ed-obj") : null;
      if (obj && obj.dataset.k === "text") edEditText(obj);
      if (obj && obj.dataset.k === "num") {
        const n = prompt("改为序号", obj.querySelector("span").textContent);
        if (n !== null && n.trim() !== "") {
          obj.querySelector("span").textContent = n.trim();
          const params = JSON.parse(obj.dataset.params); params.label = parseInt(n, 10) || params.label;
          obj.dataset.params = JSON.stringify(params);
        }
      }
    }
  });

  // footbar 光标坐标（换算回基图像素）
  canvas.addEventListener("mousemove", (e) => {
    const c = document.getElementById("ed-coord");
    if (!c) return;
    const p = edPt(e);
    c.textContent = `光标 ${Math.round(p.x / ann.scale)}, ${Math.round(p.y / ann.scale)}`;
  });

  // 形状槽位：点按=上次形状；小三角展开菜单
  const shapeBtn = document.querySelector('[data-tool="shape"]');
  const shapeMenu = document.getElementById("ed-shapemenu");
  shapeBtn.addEventListener("click", (e) => {
    if (e.target.id === "ed-tri") {
      const r = shapeBtn.getBoundingClientRect();
      shapeMenu.style.left = r.left + "px";
      shapeMenu.style.top = r.bottom + 7 + "px";
      shapeMenu.classList.toggle("on");
      return;
    }
    shapeMenu.classList.remove("on");
    setTool(ED.shape);
  });
  shapeMenu.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    ED.shape = b.dataset.shape; edShapeUI();
    shapeMenu.classList.remove("on");
    setTool(ED.shape);
  });
  document.addEventListener("click", (e) => {
    if (shapeMenu.classList.contains("on") && !e.target.closest("#ed-shapemenu") && e.target.id !== "ed-tri" && e.target.closest('[data-tool="shape"]') === null)
      shapeMenu.classList.remove("on");
  }, true);

  // 工具按钮
  document.querySelectorAll("[data-tool]").forEach((b) => {
    if (b.dataset.tool === "shape") return;
    b.addEventListener("click", () => setTool(b.dataset.tool));
  });

  // 记忆挂钩：编辑器内任何交互后统一"记住上次"
  ["click", "input", "change"].forEach((evt) => {
    document.getElementById("annwrap").addEventListener(evt, () => setTimeout(edRemember, 0), true);
  });

  // 未保存弹窗
  document.getElementById("ed-m-cancel").addEventListener("click", () => { document.getElementById("ed-mask").classList.remove("on"); });
  document.getElementById("ed-m-discard").addEventListener("click", () => { ED.dirty = false; closeEditor(); });
  document.getElementById("ed-m-save").addEventListener("click", () => doSave(false));
}

/* ============ 关闭 / 保存 ============ */
function requestClose() {
  if (ED.dirty) { document.getElementById("ed-mask").classList.add("on"); return; }
  closeEditor();
}
function closeEditor() {
  const w = document.getElementById("annwrap");
  if (w) w.remove();
  ann = null; state = "idle";
  annInvoke("overlay_close").catch(() => {});
}

function serializeOps() {
  // DOM 顺序 → AnnotationScript operations；CSS px → 基图像素 px（除以 scale）
  const f = 1 / ann.scale;
  const shot = edshot();
  const ops = [];
  shot.querySelectorAll(".ed-obj").forEach((el) => {
    if (!shot.contains(el)) return;
    const k = el.dataset.k;
    const l = parseFloat(el.style.left) || 0, t = parseFloat(el.style.top) || 0;
    const w = parseFloat(el.style.width) || 0, h = parseFloat(el.style.height) || 0;
    const px = (v) => Math.max(0, Math.min(ann.baseW - 1, Math.round(v * f)));
    const py = (v) => Math.max(0, Math.min(ann.baseH - 1, Math.round(v * f)));
    if (k === "arrow") {
      const g = JSON.parse(el.dataset.geom);
      ops.push({ type: "arrow", from: [px(g.x1), py(g.y1)], to: [px(g.x2), py(g.y2)], color: g.color, width: Math.max(2, Math.round(g.lw * f)) });
    } else if (k === "rect" || k === "ellipse") {
      const p = JSON.parse(el.dataset.params);
      const style = p.fill === "fill" ? "fill" : p.fill === "both" ? "outline_fill" : "outline";
      ops.push({ type: k, at: [px(l), py(t)], size: [Math.max(2, Math.round(w * f)), Math.max(2, Math.round(h * f))], style, color: p.color, width: Math.max(2, Math.round(p.lw * f)) });
    } else if (k === "num") {
      const p = JSON.parse(el.dataset.params);
      ops.push({ type: "step_number", at: [px(l + p.d / 2), py(t + p.d / 2)], label: p.label, color: p.color, diameter: Math.round(p.d * f), style: p.style });
    } else if (k === "text") {
      const p = JSON.parse(el.dataset.params);
      ops.push({ type: "text", at: [px(l), py(t)], text: el.textContent, size: Math.max(8, Math.round(p.fs * f)), color: p.color });
    } else if (k === "highlight") {
      const p = JSON.parse(el.dataset.params);
      ops.push({ type: "highlight", at: [px(l), py(t)], size: [Math.max(2, Math.round(w * f)), Math.max(2, Math.round(h * f))], color: "#FFB020", opacity: p.hlop / 100 });
    } else if (k === "mosaic") {
      const p = JSON.parse(el.dataset.params);
      ops.push({ type: "mosaic", at: [px(l), py(t)], size: [Math.max(2, Math.round(w * f)), Math.max(2, Math.round(h * f))], mode: "pixelate", strength: p.mos });
    }
  });
  if (ED.crop) {
    ops.push({ type: "crop", at: ED.crop.at, size: ED.crop.size });
  }
  return { unit: "px", operations: ops };
}

async function doSave(keepOpen) {
  if (!ann) return;
  const ops = serializeOps();
  if (!ops.operations.length && keepOpen) { annToast("还没有标注——画点什么再保存"); return; }
  if (!ops.operations.length) { annToast("还没有标注——画点什么再保存"); return; }
  try {
    await annInvoke("annotate_save", { basePath: ann.basePath, script: ops });
    ED.dirty = false;
    if (keepOpen) {
      annToast("已另存副本 · 命名规则不变，原图不动");
    } else {
      closeEditor();
    }
  } catch (e) {
    annToast("保存失败：" + (e && e.message ? e.message : e));
  }
}

function annToast(msg) {
  const t = document.createElement("div");
  t.className = "ann-toast";
  t.textContent = msg;
  document.getElementById("annwrap").appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

/* ============ 键盘 ============ */
document.addEventListener("keydown", (e) => {
  if (!ann) return;
  const et = e.target;
  if (et && (et.isContentEditable || et.tagName === "INPUT" || et.tagName === "TEXTAREA")) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (k === "s") { e.preventDefault(); doSave(false); }
    else if (k === "enter" && ED.tool === "crop" && ED.cropRing) { e.preventDefault(); edApplyCrop(); }
    else if (k === "z" && !e.shiftKey) { e.preventDefault(); edUndo(); }
    else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); edRedo(); }
    return;
  }
  const map = { v: "select", a: "arrow", r: "rect", o: "ellipse", t: "text", n: "num", h: "highlight", m: "mosaic", e: "eraser", c: "crop" };
  if (map[k]) { setTool(map[k]); return; }
  if (k === "escape") { requestClose(); return; }
  if (k === "enter" && ED.cropRing) { edApplyCrop(); return; }
  if ((k === "delete" || k === "backspace") && ED.sel) {
    e.preventDefault();
    const el = ED.sel; edDeselect();
    edPush({ t: "del", el, parent: edshot() }); el.remove(); return;
  }
  if (ED.sel && k.indexOf("arrow") === 0) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    const dx = k === "arrowleft" ? -d : k === "arrowright" ? d : 0;
    const dy = k === "arrowup" ? -d : k === "arrowdown" ? d : 0;
    const x = parseFloat(ED.sel.style.left) + dx, y = parseFloat(ED.sel.style.top) + dy;
    edPush({ t: "move", el: ED.sel, x: parseFloat(ED.sel.style.left), y: parseFloat(ED.sel.style.top), nx: x, ny: y });
    ED.sel.style.left = x + "px"; ED.sel.style.top = y + "px";
  }
});
