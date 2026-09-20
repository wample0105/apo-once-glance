// 定影覆盖层 —— 业界同款截图交互（对标 docs/ui-prototype-v2.html 与业界最佳实践）：
// 冻结画布 → 窗口/控件自动识别（单击选中，Tab 切换）→ 拖拽框选 → 8 手柄调整/整框移动
// → 尺寸牌常显 + 放大镜(8× 十字线+像素坐标+HEX 取色) → 两行工具栏即画 → 一键输出。
// 冻结、取色、识别、交付均由 Rust 命令支撑（freeze_*/detect_candidates/scroll_*）。
const { invoke, convertFileSrc } = window.__TAURI__.core;
let kind = new URLSearchParams(location.search).get("kind") || "region";
document.body.dataset.kind = kind;

const stage = document.getElementById("stage");
const selEl = document.getElementById("sel");
const detEl = document.getElementById("det");
const sizechip = document.getElementById("sizechip");
const magnifier = document.getElementById("magnifier");
const magcv = document.getElementById("magcv");
const magImg = document.getElementById("freeze");
const layer = document.getElementById("layer");
const toolbar = document.getElementById("toolbar");
const cancelhint = document.getElementById("cancelhint");

let state = "idle"; // idle | dragging | selected | adjusting | drawing
let sel = { x: 0, y: 0, w: 0, h: 0 }; // css px
let dprV = window.devicePixelRatio || 1;
let candidates = [], candIdx = 0;
let drag = null; // {type:"new"|"move"|"resize", handle, sx, sy}
let pressPt = null; // 单击判定（识别选中）
let tool = null; // null=选择；arrow|pen|marker|rect|ellipse|text|num|mosaic|eraser
let toolColor = "#FF3B30", toolW = 8, fillMode = "outline", mosStrength = 14;
// schema v1.1 工具属性（默认值 init 时从 settings.annotation 覆盖）
let arrowHeads = "end", arrowLineStyle = "solid";
let shapeDash = false, shapeRadius = false, shapeOpacity = 1.0;
let textFont = "default", textSize = 20, textBold = false, textItalic = false, textUnderline = false, textAlign = "left", textLineHeight = 1.0, textBackground = false;
let numStyle = "solid", numDiameter = 32, numStart = 1;
let mosMode = "mosaic";
let rememberProps = true;
let objStack = { undo: [], redo: [] };
let draft = null, editing = null, numNext = 1;
let ann = null; // 历史「编辑」完整编辑器模式的会话标记（annotate.js 维护）

const MIN = 8; // css px 最小选区
function dpr() { return window.devicePixelRatio || 1; }
function toPhys(v) { return Math.round(v * dpr()); }

/* ================= 初始化 / 冻结 ================= */
async function init() {
  try {
    const k2 = await invoke("get_overlay_kind");
    if (k2) { kind = k2; document.body.dataset.kind = kind; }
  } catch (e) {}
  if (kind === "annotate") {
    // 历史「编辑」入口：文件为底图的完整编辑器
    stage.style.display = "none";
    cancelhint.style.display = "none";
    try {
      const p = await invoke("annotate_file_payload");
      if (p) { startAnnotateFromFile(p); return; }
    } catch (e) {}
    await closeOverlay();
    return;
  }
  // 冻结画布
  try {
    const f = await invoke("freeze_begin");
    magImg.src = f.dataUrl; // JPEG data URL：不受 asset 作用域限制，100% 可加载
    await new Promise((res) => { if (magImg.complete && magImg.naturalWidth) res(); else magImg.onload = res; });
    document.body.classList.add("frozen");
    stage.classList.add("dim-idle");
  } catch (e) {
    cancelhint.textContent = "冻结失败：" + e;
  }
  if (kind === "scroll") {
    cancelhint.textContent = "长截图：拖出滚动区域（只调上下边界）· Esc 取消";
  }
  // 标注属性：默认值来自 settings.annotation（跟随主题记忆）
  try {
    const s = await invoke("get_settings");
    const a = s.annotation || {};
    if (a.color) toolColor = a.color;
    if (a.shape_width) toolW = Math.round(a.shape_width);
    if (a.arrow_heads) arrowHeads = a.arrow_heads;
    if (a.arrow_line_style) arrowLineStyle = a.arrow_line_style;
    else if (a.arrow_dash) arrowLineStyle = "dashed";
    if (a.shape_dash != null) shapeDash = !!a.shape_dash;
    if (a.shape_radius != null) shapeRadius = !!a.shape_radius;
    if (a.shape_opacity) shapeOpacity = a.shape_opacity;
    if (a.text_size) textSize = Math.round(a.text_size);
    if (a.text_family) textFont = a.text_family;
    textBold = !!a.text_bold; textItalic = !!a.text_italic; textUnderline = !!a.text_underline;
    if (a.text_align) textAlign = a.text_align;
    if (a.text_line_height) textLineHeight = a.text_line_height;
    if (a.text_background != null) textBackground = !!a.text_background;
    if (a.step_style) numStyle = a.step_style;
    if (a.step_diameter) numDiameter = Math.round(a.step_diameter);
    if (a.mosaic_strength) mosStrength = a.mosaic_strength;
    if (a.mosaic_mode) mosMode = a.mosaic_mode;
    if (a.num_start != null) { numStart = a.num_start; numNext = numStart; }
    rememberProps = s.remember_annotation !== false;
  } catch (e) {}
  syncPropsUI();
  setTimeout(() => { cancelhint.style.transition = "opacity .4s"; cancelhint.style.opacity = "0"; }, 2600);
}

/* 把持久化的工具属性同步到属性行控件高亮 */
function syncPropsUI() {
  const seg = (sel, attr, val) => {
    document.querySelectorAll(sel + " button").forEach((b) => b.classList.toggle("on", b.dataset[attr] === String(val)));
  };
  document.querySelectorAll("#pr-color .sw").forEach((b) => b.classList.toggle("on", (b.dataset.c || "").toUpperCase() === toolColor.toUpperCase()));
  document.getElementById("pr-width-sel").value = String(toolW);
  document.getElementById("pr-arrow-style").value = arrowHeads;
  document.getElementById("pr-arrow-line").value = arrowLineStyle;
  seg("#pr-fill", "f", fillMode);
  seg("#pr-round", "r", shapeRadius ? 1 : 0);
  seg("#pr-dash", "dash", shapeDash ? 1 : 0);
  document.getElementById("pr-font").value = textFont;
  document.getElementById("pr-tsize").value = String(textSize);
  document.getElementById("pr-opacity").value = String(shapeOpacity);
  document.getElementById("pr-tlh").value = String(textLineHeight);
  document.getElementById("pr-num-size").value = String(numDiameter);
  seg("#pr-tstyle", "t", textBold ? "bold" : textItalic ? "italic" : textUnderline ? "underline" : "");
  document.querySelector('#pr-tstyle button[data-t="bold"]').classList.toggle("on", textBold);
  document.querySelector('#pr-tstyle button[data-t="italic"]').classList.toggle("on", textItalic);
  document.querySelector('#pr-tstyle button[data-t="underline"]').classList.toggle("on", textUnderline);
  seg("#pr-talign", "a", textAlign);
  seg("#pr-tlh", "lh", textLineHeight);
  document.querySelectorAll("#pr-tbg button").forEach((b) => b.classList.toggle("on", textBackground));
  seg("#pr-num-style", "ns", numStyle);
  document.getElementById("num-start").value = numStart;
  seg("#pr-mos-mode", "mm", mosMode);
  seg("#pr-mos-strong", "m", mosStrength);
}

/* 输出前把当前工具属性写回主题记忆（SET-7 记住上次） */
function saveProps() {
  if (!rememberProps) return;
  invoke("set_setting", { key: "annotation", value: {
    color: toolColor, arrow_width: toolW, shape_width: toolW,
    text_size: textSize, text_bold: textBold, text_italic: textItalic, text_underline: textUnderline,
    text_shadow: false, text_align: textAlign, text_family: textFont, text_line_height: textLineHeight,
    text_background: textBackground, step_diameter: numDiameter, step_style: numStyle,
    mosaic_strength: mosStrength, highlight_opacity: 0.4,
    arrow_dash: arrowLineStyle === "dashed", arrow_double_head: arrowHeads === "both",
    arrow_heads: arrowHeads, arrow_line_style: arrowLineStyle,
    shape_dash: shapeDash, shape_radius: shapeRadius, shape_opacity: shapeOpacity,
    mosaic_mode: mosMode, num_start: numStart,
  } }).catch(() => {});
}

/* ================= 窗口/控件自动识别 ================= */
let detTimer = null;
function scheduleDetect(cssX, cssY) {
  if (detTimer) return;
  detTimer = setTimeout(async () => {
    detTimer = null;
    if (state !== "idle") return;
    try {
      candidates = await invoke("detect_candidates", { x: toPhys(cssX), y: toPhys(cssY) });
      candIdx = 0;
      if (candidates.length) showDet(candidates[0]);
    } catch (e) {}
  }, 60);
}
function showDet(c) {
  detEl.style.display = "block";
  detEl.style.left = c.rect[0] / dprV + "px";
  detEl.style.top = c.rect[1] / dprV + "px";
  detEl.style.width = c.rect[2] / dprV + "px";
  detEl.style.height = c.rect[3] / dprV + "px";
  detEl.querySelector(".tag").textContent = (c.title || c.class || "窗口").slice(0, 40);
}
function hideDet() { detEl.style.display = "none"; }
function cycleCandidate() {
  if (!candidates.length) return;
  candIdx = (candIdx + 1) % candidates.length;
  showDet(candidates[candIdx]);
}
function selectCandidate() {
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const r = { x: c.rect[0] / dprV, y: c.rect[1] / dprV, w: c.rect[2] / dprV, h: c.rect[3] / dprV };
    if (r.w >= MIN && r.h >= MIN) {
      candIdx = i;
      setSel(r); setState("selected"); hideDet();
      return true;
    }
  }
  return false;
}

/* ================= 选区状态 ================= */
function setSel(r) {
  sel = r;
  selEl.style.left = r.x + "px"; selEl.style.top = r.y + "px";
  selEl.style.width = r.w + "px"; selEl.style.height = r.h + "px";
  // 尺寸牌常显
  sizechip.style.display = "block";
  sizechip.style.left = r.x + "px";
  sizechip.style.top = (r.y - 30 < 4 ? r.y + 6 : r.y - 30) + "px";
  sizechip.textContent = `${Math.round(r.w * dprV)} × ${Math.round(r.h * dprV)} px`;
  // 画图层同步
  layer.style.left = r.x + "px"; layer.style.top = r.y + "px";
  layer.style.width = r.w + "px"; layer.style.height = r.h + "px";
  positionToolbar();
}
function setState(s) {
  state = s;
  document.body.classList.toggle("selected", s === "selected" || s === "drawing");
  document.body.classList.toggle("dragging", s === "dragging");
  stage.className = s === "idle" ? "dim-idle" : "cross";
  if (s === "dragging") {
    // 拖拽中也要有视觉反馈：选区框 + 9999px 挖洞阴影（框外压暗）
    selEl.style.display = "block";
    toolbar.style.display = "none";
    magnifier.style.display = "none";
  } else if (s === "selected" || s === "drawing") {
    selEl.style.display = "block";
    layer.style.display = "block";
    toolbar.style.display = "flex";
    magnifier.style.display = "none"; // 选区提交后放大镜不再跟随（挡画布视线）
    positionToolbar();
  } else if (s === "idle") {
    selEl.style.display = "none";
    layer.style.display = "none";
    toolbar.style.display = "none";
    sizechip.style.display = "none";
    layer.innerHTML = ""; objStack = { undo: [], redo: [] };
    tool = null; setTool(null);
  }
}

/* ================= 放大镜 ================= */
const ZOOM = 8, MAG = 148;
function moveMagnifier(cssX, cssY) {
  if (state !== "idle") { magnifier.style.display = "none"; return; }
  // 冻结大图偶发未解码完成时 drawImage 会失败留下黑块：未就绪直接不显示
  if (!magImg.complete || !magImg.naturalWidth) { magnifier.style.display = "none"; return; }
  magnifier.style.display = "block";
  magnifier.style.left = Math.min(cssX + 22, innerWidth - MAG - 8) + "px";
  magnifier.style.top = Math.min(cssY + 22, innerHeight - MAG - 40) + "px";
  const iscale = magImg.naturalWidth / innerWidth; // css → 冻结图 px
  const s = MAG / ZOOM;
  let sx = cssX * iscale - (s * iscale) / 2, sy = cssY * iscale - (s * iscale) / 2;
  // 源矩形钳制在图内：贴边时不再画出黑块
  sx = Math.max(0, Math.min(sx, magImg.naturalWidth - s * iscale));
  sy = Math.max(0, Math.min(sy, magImg.naturalHeight - s * iscale));
  try {
    const ctx = magcv.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, MAG, MAG);
    ctx.drawImage(magImg, sx, sy, s * iscale, s * iscale, 0, 0, MAG, MAG);
  } catch (e) {
    magnifier.style.display = "none"; // 绘制失败宁可隐藏也不留黑块
    return;
  }
  document.getElementById("mag-xy").textContent = `${Math.round(cssX * dprV)}, ${Math.round(cssY * dprV)}`;
  invoke("freeze_pixel", { x: toPhys(cssX), y: toPhys(cssY) })
    .then((c) => { document.getElementById("mag-hex").textContent = c.hex; })
    .catch(() => {});
}

/* ================= 拖拽：新建/移动/调整 ================= */
window.addEventListener("mousemove", (e) => {
  if (state === "idle") {
    scheduleDetect(e.clientX, e.clientY);
    moveMagnifier(e.clientX, e.clientY);
    return;
  }
  if (state === "dragging" && drag) {
    if (drag.type === "new") setSel(norm(drag.sx, drag.sy, e.clientX, e.clientY));
    else if (drag.type === "move") setSel({ ...sel, x: drag.orig.x + (e.clientX - drag.sx), y: drag.orig.y + (e.clientY - drag.sy) });
    else if (drag.type === "resize") resizeSel(e.clientX, e.clientY);
  }
});

function norm(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}
function resizeSel(mx, my) {
  const { handle, orig } = drag;
  let { x, y, w, h } = orig;
  if (handle.includes("w")) { const dx = mx - drag.sx; x = orig.x + dx; w = Math.max(MIN, orig.w - dx); }
  if (handle.includes("e")) { w = Math.max(MIN, orig.w + (mx - drag.sx)); }
  if (handle.includes("n")) { const dy = my - drag.sy; y = orig.y + dy; h = Math.max(MIN, orig.h - dy); }
  if (handle.includes("s")) { h = Math.max(MIN, orig.h + (my - drag.sy)); }
  setSel({ x, y, w, h });
}

window.addEventListener("mouseup", (e) => {
  if (e.button !== 0) return;
  if (drag) {
    if (drag.type === "new") {
      setSel(norm(drag.sx, drag.sy, e.clientX, e.clientY));
      if (sel.w < MIN || sel.h < MIN) {
        // 单击：选中识别候选；否则回空闲
        if (pressPt && selectCandidate()) { drag = null; pressPt = null; return; }
        setState("idle"); selEl.style.display = "none"; sizechip.style.display = "none";
      } else {
        setState("selected"); hideDet();
      }
    } else {
      setState("selected"); // move/resize 结束 → 工具栏恢复
    }
    drag = null; pressPt = null;
  }
});

/* ================= 两行工具栏 ================= */
function positionToolbar() {
  if (toolbar.style.display === "none") return;
  const th = toolbar.offsetHeight || 76;
  const below = innerHeight - (sel.y + sel.h);
  const top = below >= th + 14 ? sel.y + sel.h + 10 : Math.max(6, sel.y - th - 10);
  toolbar.style.top = top + "px";
  toolbar.style.left = Math.max(8, Math.min(sel.x, innerWidth - (toolbar.offsetWidth || 560) - 8)) + "px";
}

function wireToolbar() {
  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.addEventListener("click", () => setTool(tool === b.dataset.tool ? null : b.dataset.tool));
  });
  // 16 色板 + 自定义取色
  const PALETTE = ["#FFFFFF", "#1C1C1E", "#FF3B30", "#FF9500", "#FFCC00", "#34C759", "#007AFF", "#AF52DE"];
  const pc = document.getElementById("pr-color");
  PALETTE.forEach((c) => {
    const b = document.createElement("button");
    b.className = "sw" + (c.toUpperCase() === toolColor.toUpperCase() ? " on" : "");
    b.style.background = c; b.dataset.c = c; b.title = c;
    b.addEventListener("click", () => {
      toolColor = c;
      pc.querySelectorAll(".sw").forEach((x) => x.classList.toggle("on", x === b));
    });
    pc.appendChild(b);
  });
  const custom = document.createElement("button");
  custom.className = "sw custom"; custom.title = "自定义颜色：点击输入 HEX"; custom.dataset.custom = "1";
  custom.textContent = "+";
  const hexInput = document.createElement("input");
  hexInput.id = "pr-hex"; hexInput.placeholder = "#FF0000"; hexInput.maxLength = 7;
  hexInput.addEventListener("keydown", (e) => {
    e.stopPropagation(); // 不让按键冒泡成全局热键
    if (e.key === "Enter") {
      const v = hexInput.value.trim();
      if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
        toolColor = v.toUpperCase();
        custom.classList.add("on");
        custom.style.background = toolColor;
        hexInput.value = ""; hexInput.style.display = "none";
        pc.querySelectorAll(".sw:not(.custom)").forEach((x) => x.classList.remove("on"));
      }
    } else if (e.key === "Escape") {
      hexInput.value = ""; hexInput.style.display = "none";
    }
  });
  custom.addEventListener("click", () => {
    const show = hexInput.style.display !== "inline-block";
    hexInput.style.display = show ? "inline-block" : "none";
    if (show) hexInput.focus();
  });
  pc.appendChild(hexInput);
  pc.appendChild(custom);
  document.getElementById("pr-width-sel").addEventListener("change", (e) => { toolW = Number(e.target.value); });
  // 箭头：样式（单/双/反/无）/ 线型（实/虚/点）
  document.getElementById("pr-arrow-style").addEventListener("change", (e) => { arrowHeads = e.target.value; });
  document.getElementById("pr-arrow-line").addEventListener("change", (e) => { arrowLineStyle = e.target.value; });
  // 形状：填充/圆角/虚线/透明度
  document.querySelectorAll("#pr-fill button").forEach((b) => {
    b.addEventListener("click", () => {
      fillMode = b.dataset.f;
      document.querySelectorAll("#pr-fill button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  document.querySelectorAll("#pr-round button").forEach((b) => {
    b.addEventListener("click", () => {
      shapeRadius = b.dataset.r === "1";
      document.querySelectorAll("#pr-round button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  document.querySelectorAll("#pr-dash button").forEach((b) => {
    b.addEventListener("click", () => {
      shapeDash = b.dataset.dash === "1";
      document.querySelectorAll("#pr-dash button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  document.getElementById("pr-opacity").addEventListener("change", (e) => { shapeOpacity = Number(e.target.value); });
  // 文字：字体/字号/粗斜下/对齐/行距/背景
  document.getElementById("pr-font").addEventListener("change", (e) => { textFont = e.target.value; });
  document.getElementById("pr-tsize").addEventListener("change", (e) => { textSize = Number(e.target.value); });
  const tstyle = () => ({
    bold: document.querySelector('#pr-tstyle button[data-t="bold"]'),
    italic: document.querySelector('#pr-tstyle button[data-t="italic"]'),
    underline: document.querySelector('#pr-tstyle button[data-t="underline"]'),
  });
  document.querySelectorAll("#pr-tstyle button").forEach((b) => {
    b.addEventListener("click", () => {
      const t = b.dataset.t;
      if (t === "bold") textBold = !textBold;
      else if (t === "italic") textItalic = !textItalic;
      else if (t === "underline") textUnderline = !textUnderline;
      const m = tstyle();
      m.bold.classList.toggle("on", textBold);
      m.italic.classList.toggle("on", textItalic);
      m.underline.classList.toggle("on", textUnderline);
    });
  });
  document.querySelectorAll("#pr-talign button").forEach((b) => {
    b.addEventListener("click", () => {
      textAlign = b.dataset.a;
      document.querySelectorAll("#pr-talign button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  document.querySelectorAll("#pr-tlh button").forEach((b) => {
    b.addEventListener("click", () => {
      textLineHeight = Number(b.dataset.lh);
      document.querySelectorAll("#pr-tlh button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  document.querySelectorAll("#pr-tbg button").forEach((b) => {
    b.addEventListener("click", () => {
      textBackground = !textBackground;
      b.classList.toggle("on", textBackground);
    });
  });
  // 序号：样式/大小/起始
  document.querySelectorAll("#pr-num-style button").forEach((b) => {
    b.addEventListener("click", () => {
      numStyle = b.dataset.ns;
      document.querySelectorAll("#pr-num-style button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  document.getElementById("pr-num-size").addEventListener("change", (e) => { numDiameter = Number(e.target.value); });
  document.getElementById("num-start").addEventListener("change", (e) => {
    numStart = Math.max(0, parseInt(e.target.value, 10) || 1);
    numNext = numStart;
  });
  // 马赛克：模式/强度
  document.querySelectorAll("#pr-mos-mode button").forEach((b) => {
    b.addEventListener("click", () => {
      mosMode = b.dataset.mm;
      document.querySelectorAll("#pr-mos-mode button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  document.querySelectorAll("#pr-mos-strong button").forEach((b) => {
    b.addEventListener("click", () => {
      mosStrength = Number(b.dataset.m);
      document.querySelectorAll("#pr-mos-strong button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  document.getElementById("tb-copy").addEventListener("click", () => output("copy"));
  document.getElementById("tb-ocr").addEventListener("click", () => output("ocr"));
  document.getElementById("tb-scroll").addEventListener("click", startLongshot);
  document.getElementById("tb-pin").addEventListener("click", () => output("pin"));
  document.getElementById("tb-save").addEventListener("click", () => output("save"));
  document.getElementById("tb-exit").addEventListener("click", cancelAll);
  document.getElementById("tb-undo").addEventListener("click", undoOp);
  document.getElementById("tb-redo").addEventListener("click", redoOp);
}

function setTool(t) {
  tool = t;
  layer.style.pointerEvents = t ? "auto" : "none"; // 无工具时画布不吃指针，保证选区/手柄可拖
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  layer.className = t === "eraser" ? "tool-eraser" : "";
  layer.style.cursor = t ? "crosshair" : "default";
  selEl.classList.toggle("moveable", !t); // 无工具：选区内整体手型可平移
  const show = (id, on) => document.getElementById(id).classList.toggle("on", on);
  show("pr-color", !!t && t !== "eraser");
  show("pr-width", ["arrow", "pen", "marker", "rect", "ellipse", "mosaic"].includes(t));
  show("pr-arrow", t === "arrow");
  show("pr-shape", t === "rect" || t === "ellipse");
  document.getElementById("pr-round").style.display = t === "rect" ? "" : "none";
  show("pr-text", t === "text");
  show("pr-num", t === "num");
  show("pr-mos", t === "mosaic");
  const tips = { arrow: "拖出箭头", pen: "自由画笔", marker: "荧光笔 · 正片叠底", rect: "拖出矩形", ellipse: "拖出椭圆", text: "点画布输入 · Ctrl+Enter 确认", num: "连点自增 · Alt 复用上一号", mosaic: "拖出马赛克", eraser: "点一下删掉标注" };
  document.getElementById("pr-tip").textContent = tips[t] || "";
}

/* ================= 画图（冻结截图上直接画） ================= */
function layerPt(e) {
  const r = layer.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
// 是否位于选区边缘 8px 条带内（画图工具激活时该区域=平移热区，同类产品 手型）
function nearSelEdge(r) {
  const m = 8;
  if (r.x < sel.x - 4 || r.x > sel.x + sel.w + 4 || r.y < sel.y - 4 || r.y > sel.y + sel.h + 4) return false;
  return (r.x - sel.x) <= m || (sel.x + sel.w - r.x) <= m || (r.y - sel.y) <= m || (sel.y + sel.h - r.y) <= m;
}
function mkObj() {
  const el = document.createElement("span");
  el.className = "obj";
  return el;
}
function hexA(h, a) {
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function arrowInto(el, x1, y1, x2, y2) {
  const l = Math.min(x1, x2) - 24, t = Math.min(y1, y2) - 24;
  const w = Math.max(Math.abs(x2 - x1), 1) + 48, h = Math.max(Math.abs(y2 - y1), 1) + 48;
  el.style.left = l + "px"; el.style.top = t + "px"; el.style.width = w + "px"; el.style.height = h + "px";
  // SVG 必须有 <svg> 根节点，裸 <line>/<path> 不会渲染
  const svg = el.querySelector("svg");
  svg.setAttribute("width", w); svg.setAttribute("height", h); svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const ax = x1 - l, ay = y1 - t, bx = x2 - l, by = y2 - t;
  const line = el.querySelector("line");
  line.setAttribute("x1", ax); line.setAttribute("y1", ay);
  line.setAttribute("x2", bx); line.setAttribute("y2", by);
  line.setAttribute("stroke", toolColor); line.setAttribute("stroke-width", toolW);
  if (arrowLineStyle === "dashed") line.setAttribute("stroke-dasharray", `${toolW * 3} ${toolW * 2.2}`);
  if (arrowLineStyle === "dotted") line.setAttribute("stroke-dasharray", `${toolW * 0.5} ${toolW * 1.8}`);
  const ang = Math.atan2(by - ay, bx - ax), s = Math.min(44, Math.max(14, toolW * 3.5));
  const p = (a) => `${bx - Math.cos(ang + a) * s} ${by - Math.sin(ang + a) * s}`;
  let d = "";
  if (arrowHeads !== "none" && arrowHeads !== "start") d += `M${bx} ${by} L${p(0.45)} L${p(-0.45)} Z`;
  if (arrowHeads === "both" || arrowHeads === "start") {
    const q = (a) => `${ax - Math.cos(ang + a) * s} ${ay - Math.sin(ang + a) * s}`;
    d += ` M${ax} ${ay} L${q(0.45)} L${q(-0.45)} Z`;
  }
  el.querySelector("path").setAttribute("d", d);
  el.querySelector("path").setAttribute("fill", toolColor);
  el.dataset.geom = JSON.stringify({ x1, y1, x2, y2, lw: toolW, color: toolColor, heads: arrowHeads, ls: arrowLineStyle });
}
function shapeStyle(el) {
  if (tool === "rect") {
    el.style.border = toolW + "px " + (shapeDash ? "dashed" : "solid") + " " + toolColor;
    el.style.borderRadius = shapeRadius ? "12px" : "4px"; el.style.boxSizing = "border-box";
    if (shapeOpacity < 1) el.style.opacity = shapeOpacity;
    if (fillMode === "fill") el.style.background = toolColor;
  } else if (tool === "ellipse") {
    el.style.border = toolW + "px " + (shapeDash ? "dashed" : "solid") + " " + toolColor;
    el.style.borderRadius = "50%"; el.style.boxSizing = "border-box";
    if (shapeOpacity < 1) el.style.opacity = shapeOpacity;
    if (fillMode === "fill") el.style.background = toolColor;
  } else if (tool === "marker") {
    el.style.background = hexA(toolColor, 0.35); el.style.mixBlendMode = "multiply";
  } else if (tool === "mosaic") {
    el.style.borderRadius = "2px";
    if (mosMode === "blur") {
      // 模糊预览：冻结帧该区域 + CSS blur（序列化 mode=blur，引擎真实模糊）
      el.style.backgroundImage = `url("${magImg.src}")`;
      el.style.backgroundSize = `${layer.clientWidth}px ${layer.clientHeight}px`;
      el.dataset.blurBg = "1";
    } else {
      el.style.background = `repeating-linear-gradient(90deg,#8E8E93 0 ${mosStrength}px,#C9C9CF ${mosStrength}px ${2 * mosStrength}px)`;
    }
  }
}

layer.addEventListener("mousemove", (e) => {
  if (!tool || draft || editing) return;
  const r = layerPt(e);
  const corners = [[0, 0, "nwse-resize"], [1, 0, "nesw-resize"], [0, 1, "nesw-resize"], [1, 1, "nwse-resize"]];
  let cur = "crosshair";
  for (const [fx, fy, cur2] of corners) {
    const cx = sel.x + sel.w * fx, cy = sel.y + sel.h * fy;
    if (Math.hypot(r.x - cx, r.y - cy) <= 8) { cur = cur2; break; }
  }
  if (cur === "crosshair" && nearSelEdge(r)) cur = "move";
  layer.style.cursor = cur;
});
layer.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || editing || !tool) return;
  e.stopPropagation();
  const p = layerPt(e);
  if (tool === "eraser") {
    const del = e.target.closest && e.target.closest(".obj");
    if (del) { objStack.undo.push({ t: "del", el: del }); objStack.redo = []; del.remove(); }
    return;
  }
  if (tool === "text") { e.preventDefault(); startText(p); return; } // preventDefault：否则 mousedown 默认行为夺焦，编辑框立即 blur 自毁
  if (tool === "num") {
    const el = mkObj(); const d = numDiameter; el.dataset.k = "num";
    el.style.cssText = `position:absolute;left:${p.x - d / 2}px;top:${p.y - d / 2}px;width:${d}px;height:${d}px;`;
    const sp = document.createElement("span");
    let spCss = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:" + Math.round(d * 0.52) + "px;font-weight:600;";
    if (numStyle === "solid") spCss += `border-radius:50%;background:${toolColor};color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.35)`;
    else if (numStyle === "outline") spCss += `border-radius:50%;border:${Math.max(2, d * 0.07)}px solid ${toolColor};color:${toolColor};background:rgba(255,255,255,.85)`;
    else spCss += `color:${toolColor};`;
    sp.style.cssText = spCss;
    sp.textContent = numNext;
    el.appendChild(sp);
    el.dataset.params = JSON.stringify({ label: numNext, color: toolColor, d, style: numStyle });
    layer.appendChild(el);
    objStack.undo.push({ t: "add", el }); objStack.redo = [];
    numNext++;
    return;
  }
  e.preventDefault();
  let el;
  if (tool === "pen") {
    // 自由画笔：折线点序，SVG polyline 实时预览
    el = mkObj(); el.dataset.k = "pen"; el.style.position = "absolute";
    el.style.left = "0px"; el.style.top = "0px"; el.style.width = "100%"; el.style.height = "100%";
    el.innerHTML = '<svg style="overflow:visible;pointer-events:none" width="100%" height="100%"><polyline fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const pl = el.querySelector("polyline");
    pl.setAttribute("stroke", toolColor); pl.setAttribute("stroke-width", toolW);
    pl.setAttribute("points", `${p.x},${p.y}`);
    layer.appendChild(el);
    draft = { k: "pen", el, pl, pts: [p] };
    return;
  }
  if (tool === "arrow") {
    el = mkObj(); el.style.position = "absolute"; el.dataset.k = "arrow";
    el.innerHTML = '<svg style="overflow:visible;pointer-events:none"><line stroke-linecap="round"/><path/></svg>';
  } else {
    el = mkObj(); el.dataset.k = tool;
    el.dataset.params = JSON.stringify({ lw: toolW, color: toolColor, fill: fillMode, mos: mosStrength, mode: mosMode, radius: shapeRadius ? 12 : 0, dash: shapeDash, opacity: shapeOpacity });
    shapeStyle(el);
  }
  el.style.left = p.x + "px"; el.style.top = p.y + "px";
  if (tool !== "arrow") { el.style.width = "0px"; el.style.height = "0px"; }
  layer.appendChild(el);
  draft = { k: tool, el, x: p.x, y: p.y };
});

window.addEventListener("mousemove", (e) => {
  if (!draft) return;
  const p = layerPt(e);
  if (draft.k === "pen") {
    const last = draft.pts[draft.pts.length - 1];
    if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) >= 2) {
      draft.pts.push(p);
      draft.pl.setAttribute("points", draft.pts.map((q) => `${q.x},${q.y}`).join(" "));
    }
    return;
  }
  if (draft.k === "arrow") { arrowInto(draft.el, draft.x, draft.y, p.x, p.y); return; }
  draft.el.style.left = Math.min(draft.x, p.x) + "px"; draft.el.style.top = Math.min(draft.y, p.y) + "px";
  draft.el.style.width = Math.abs(p.x - draft.x) + "px"; draft.el.style.height = Math.abs(p.y - draft.y) + "px";
});

window.addEventListener("mouseup", () => {
  if (!draft) return;
  const d = draft; draft = null;
  if (d.k === "pen") {
    if (d.pts.length < 2) { d.el.remove(); return; }
    d.el.dataset.geom = JSON.stringify({ pts: d.pts, lw: toolW, color: toolColor });
  } else {
    const w = parseFloat(d.el.style.width) || 0, h = parseFloat(d.el.style.height) || 0;
    if (d.k !== "arrow" && w < 4 && h < 4) { d.el.remove(); return; }
  }
  objStack.undo.push({ t: "add", el: d.el }); objStack.redo = [];
});

function startText(p) {
  const el = document.createElement("div");
  el.className = "txtedit"; el.contentEditable = "true"; el.spellcheck = false;
  el.style.left = p.x + "px"; el.style.top = p.y + "px";
  el.style.fontSize = textSize + "px"; el.style.color = toolColor;
  el.style.fontFamily = ({ default: "'Microsoft YaHei','微软雅黑',sans-serif", simsun: "SimSun,'宋体',serif", simhei: "SimHei,'黑体',sans-serif", kaiti: "KaiTi,'楷体',serif", segoe: "'Segoe UI',sans-serif" })[textFont] || "sans-serif";
  if (textBold) el.style.fontWeight = "700";
  if (textItalic) el.style.fontStyle = "italic";
  if (textUnderline) el.style.textDecoration = "underline";
  el.style.textAlign = textAlign;
  if (textBackground) el.style.background = "#FFF7D6";
  layer.appendChild(el); editing = el;
  requestAnimationFrame(() => el.focus()); // 下一帧再聚焦，避免与其他焦点操作竞态
  el.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); finishText(el); } });
  el.addEventListener("blur", () => finishText(el));
}
function finishText(el) {
  if (editing === el) editing = null; // 必须清编辑态，否则后续所有画图点击被拦截
  if (!document.body.contains(el) || el.contentEditable !== "true") return;
  const txt = el.textContent.trim();
  if (!txt) { el.remove(); return; }
  el.contentEditable = "false"; el.classList.remove("txtedit"); el.classList.add("obj");
  el.dataset.k = "text"; // 序列化分支依赖 dataset.k
  el.dataset.text = txt;
  // 排版快照（所见即所得：序列化必须与预览一致）
  el.dataset.params = JSON.stringify({
    family: textFont, size: parseInt(el.style.fontSize, 10) || 20, color: el.style.color || toolColor,
    bold: textBold, italic: textItalic, underline: textUnderline, align: el.style.textAlign || "left",
    line_height: textLineHeight, background: textBackground ? "#FFF7D6" : null,
  });
  objStack.undo.push({ t: "add", el });
}

function undoOp() {
  const u = objStack.undo.pop(); if (!u) return;
  if (u.t === "add") u.el.remove();
  else if (u.t === "del") layer.appendChild(u.el); // 橡皮擦撤销：对象放回
  objStack.redo.push(u);
}
function redoOp() {
  const u = objStack.redo.pop(); if (!u) return;
  if (u.t === "add") layer.appendChild(u.el);
  else if (u.t === "del") u.el.remove(); // 橡皮擦重做：再删一次
  objStack.undo.push(u);
}

/* ================= 序列化与输出 ================= */
function serializeOps() {
  const f = dpr();
  const ops = [];
  layer.querySelectorAll(".obj").forEach((el) => {
    const l = parseFloat(el.style.left) || 0, t = parseFloat(el.style.top) || 0;
    const w = parseFloat(el.style.width) || 0, h = parseFloat(el.style.height) || 0;
    const P = (v) => Math.round(v * f);
    if (el.dataset.k === "arrow") {
      const g = JSON.parse(el.dataset.geom);
      ops.push({ type: "arrow", from: [P(g.x1), P(g.y1)], to: [P(g.x2), P(g.y2)], color: g.color, width: Math.max(2, Math.round(g.lw * f)), heads: g.heads || "end", line_style: g.ls || "solid" });
    } else if (el.dataset.k === "pen") {
      const g = JSON.parse(el.dataset.geom);
      ops.push({ type: "pen", points: g.pts.map((q) => [P(q.x), P(q.y)]), color: g.color, width: Math.max(2, Math.round(g.lw * f)), mode: "pen" });
    } else if (el.dataset.k === "rect" || el.dataset.k === "ellipse") {
      const p = JSON.parse(el.dataset.params);
      const base = { type: el.dataset.k, at: [P(l), P(t)], size: [Math.max(2, P(w)), Math.max(2, P(h))], style: p.fill === "fill" ? "fill" : "outline", color: p.color, width: Math.max(2, Math.round(p.lw * f)) };
      if (p.radius) base.radius = Math.round(p.radius * f);
      if (p.dash) base.dash = true;
      if (p.opacity != null && p.opacity < 1) base.opacity = p.opacity;
      ops.push(base);
    } else if (el.dataset.k === "num") {
      const p = JSON.parse(el.dataset.params);
      ops.push({ type: "step_number", at: [P(l + p.d / 2), P(t + p.d / 2)], label: p.label, color: p.color, diameter: Math.round(p.d * f), style: p.style || "solid" });
    } else if (el.dataset.k === "text") {
      let p = {};
      try { p = JSON.parse(el.dataset.params || "{}"); } catch (e) {}
      ops.push({
        type: "text", at: [P(l), P(t)], text: el.dataset.text || el.textContent,
        size: Math.max(8, Math.round((p.size || 20) * f)), color: p.color || "#FF3B30",
        family: p.family || "default", bold: !!p.bold, italic: !!p.italic, underline: !!p.underline,
        align: p.align || "left", line_height: p.line_height || 1.0,
        background: p.background ? p.background : undefined,
      });
    } else if (el.dataset.k === "mosaic") {
      const p = JSON.parse(el.dataset.params);
      ops.push({ type: "mosaic", at: [P(l), P(t)], size: [Math.max(2, P(w)), Math.max(2, P(h))], mode: p.mode === "blur" ? "blur" : "pixelate", strength: p.mos });
    } else if (el.dataset.k === "marker") {
      ops.push({ type: "highlight", at: [P(l), P(t)], size: [Math.max(2, P(w)), Math.max(2, P(h))], color: "#FFB020", opacity: 0.35 });
    }
  });
  return { unit: "px", operations: ops };
}

async function output(action) {
  if (state !== "selected" && state !== "drawing") return;
  const screen = 1;
  const base = await invoke("freeze_take_region", {
    screen, x: toPhys(sel.x), y: toPhys(sel.y), w: toPhys(sel.w), h: toPhys(sel.h),
  });
  const hasOps = layer.querySelectorAll(".obj").length > 0;
  saveProps(); // SET-7 记住上次：输出时写回工具属性
  if (hasOps) {
    // 有标注：引擎渲染衍生图（-ann，原图不动），剪贴板写渲染结果
    await invoke("annotate_save", { basePath: base.path, script: serializeOps() });
  } else if (action === "copy" || action === "save") {
    await invoke("freeze_deliver", { screen, x: toPhys(sel.x), y: toPhys(sel.y), w: toPhys(sel.w), h: toPhys(sel.h), action: "copy" });
  } else if (action === "ocr") {
    await invoke("freeze_deliver", { screen, x: toPhys(sel.x), y: toPhys(sel.y), w: toPhys(sel.w), h: toPhys(sel.h), action: "ocr" });
  } else if (action === "pin") {
    await invoke("pin_create", { path: base.path, x: toPhys(sel.x), y: toPhys(sel.y), scale: 1 / dprV });
  }
  if (action !== "pin") await closeOverlay();
}

async function closeOverlay() {
  try { await invoke("overlay_close"); } catch (e) {}
  try { window.__TAURI__.window.getCurrentWindow().hide(); } catch (e) {}
}

async function startLongshot() {
  // 先隐藏覆盖层再抓第 1 段：否则选区红框/手柄会被烤进长截图首段
  await invoke("overlay_hide");
  await new Promise((r) => setTimeout(r, 180)); // 等 DWM 合成一帧
  await invoke("scroll_start", {
    screen: 1, x: toPhys(sel.x), y: toPhys(sel.y), w: toPhys(sel.w), h: toPhys(sel.h),
  });
}

function cancelAll() {
  if (tool) { setTool(null); return; }
  if (ann) return; // 完整编辑器模式由 annotate.js 接管
  if (state !== "idle") {
    setState("idle");
    selEl.style.display = "none"; sizechip.style.display = "none";
    toolbar.style.display = "none"; layer.style.display = "none"; layer.innerHTML = "";
    return;
  }
  closeOverlay();
}

/* ================= 键盘 ================= */
window.addEventListener("keydown", (e) => {
  const et = e.target;
  if (et && (et.isContentEditable || et.tagName === "INPUT" || et.tagName === "TEXTAREA")) return;
  if (ann) return; // 完整编辑器模式由 annotate.js 接管
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (k === "c") { e.preventDefault(); output("copy"); }
    else if (k === "s") { e.preventDefault(); output("save"); }
    return;
  }
  if (k === "escape") { cancelAll(); return; }
  if (k === "enter") { if (state === "selected" || state === "drawing") output("copy"); return; }
  if (k === "tab") { e.preventDefault(); cycleCandidate(); return; }
  const map = { a: "arrow", r: "rect", o: "ellipse", t: "text", n: "num", h: "marker", m: "mosaic", e: "eraser", p: "pen" };
  if (map[k] && (state === "selected" || state === "drawing")) { setTool(map[k]); return; }
});

/* ================= 统一鼠标分发（修复：元素各自挂监听导致部分点击失效） ================= */
// 焦点曾被主窗口抢走时（点过别的窗口），把键盘焦点收回覆盖层，保证 Esc/Enter/热键可用
document.addEventListener("mousedown", () => { invoke("overlay_focus").catch(() => {}); }, true);
// 任何按下动作都收掉放大镜（防其在选区提交后残留挡视线）
document.addEventListener("mousedown", () => { magnifier.style.display = "none"; }, true);
document.addEventListener("mousedown", (e) => {
  if (ann || e.button !== 0) return;
  if (e.target.closest("#toolbar") || e.target.closest(".txtedit")) return;
  if (state === "selected" || state === "drawing") {
    const h = e.target.closest(".handle");
    if (h) {
      const cls = [...h.classList].find((c) => ["nw","ne","sw","se","n","s","w","e"].includes(c));
      drag = { type: "resize", handle: cls, sx: e.clientX, sy: e.clientY, orig: { ...sel } };
      setState("dragging");               // 必须经 setState 切态，mousemove/视觉才会生效
      e.preventDefault();
      return;
    }
    // 画图工具激活时，手柄(z4)被画图层(z5)盖住点不到：
    // 角 8px → 调整大小；边缘 8px 条带 → 平移选区（同类产品 手型）；其余 → 画图
    if (tool && e.target.closest("#layer")) {
      const r = layerPt(e);
      const corners = [[0, 0, "nw"], [1, 0, "ne"], [0, 1, "sw"], [1, 1, "se"]];
      for (const [fx, fy, cls] of corners) {
        const cx = sel.x + sel.w * fx, cy = sel.y + sel.h * fy;
        if (Math.hypot(r.x - cx, r.y - cy) <= 8) {
          draft = null;
          drag = { type: "resize", handle: cls, sx: e.clientX, sy: e.clientY, orig: { ...sel } };
          setState("dragging");
          e.preventDefault();
          return;
        }
      }
      if (nearSelEdge(r)) {
        draft = null;
        drag = { type: "move", sx: e.clientX, sy: e.clientY, orig: { ...sel } };
        setState("dragging");
        e.preventDefault();
        return;
      }
      return; // 画图起始由 layer 自己处理
    }
    const inSel = e.target.closest("#sel") || e.target.closest("#layer");
    if (inSel && !tool) {
      drag = { type: "move", sx: e.clientX, sy: e.clientY, orig: { ...sel } };
      setState("dragging");
      return;
    }
  }
  // 其余区域：重新框选（实时橡皮筋）
  hideDet();
  drag = { type: "new", sx: e.clientX, sy: e.clientY };
  setState("dragging");
  setSel(norm(e.clientX, e.clientY, e.clientX, e.clientY));
}, true);

/* ================= 启动 ================= */
document.getElementById("cancel-x").addEventListener("click", () => {
  stage.style.display = "";
  cancelAll();
});
// 右键 = 取消/退出（idle 时不弹 WebView 菜单）
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (!ann) cancelAll();
});

wireToolbar();
init();
