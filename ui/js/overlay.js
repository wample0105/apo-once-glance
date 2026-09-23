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
// 颜色按工具独立（同款语义）：箭头/文字/形状/画笔各自记忆，互不串色
let toolColors = { arrow: "#FF3B30", pen: "#FF3B30", marker: "#FFB020", rect: "#FF3B30", ellipse: "#FF3B30", text: "#FFFFFF", num: "#FF3B30" };
let colorKey = null; // 当前色板归属的工具键（切工具/选中对象时更新）
function setColorForTool(c) {
  toolColor = c;
  if (colorKey && toolColors[colorKey] !== undefined) toolColors[colorKey] = c;
}
// schema v1.1 工具属性（默认值 init 时从 settings.annotation 覆盖）
let arrowHeads = "end", arrowLineStyle = "solid";
let shapeDash = false, shapeRadius = false, shapeOpacity = 1.0;
let textFont = "default", textSize = 20, textBold = false, textItalic = false, textUnderline = false, textAlign = "left", textLineHeight = 1.0, textBackground = false, textBgColor = "#FFF7D6", textBgOpacity = 1.0, textBgRadius = 4, textShadow = false, textStroke = false;
let numStyle = "solid", numDiameter = 32, numStart = 1;
let mosMode = "mosaic";
let hlOpacity = 0.4; // 高亮不透明度（本层无控件；读入原样带回，避免整包写回清掉编辑器记忆值）
let rememberProps = true;
// 同类产品 像素级对齐：形状槽位（矩形/椭圆合并按钮）与输出选项
let shapeSlot = "rect"; // 槽位当前形状：rect | ellipse
let cropMode = false; // 裁剪：重新框选中（标注跟随平移）
let outShadow = { on: false, blur: 24, color: "#000000" }; // 输出选项：整图外阴影
let outBorder = { on: false, w: 6, color: "#FFFFFF" }; // 输出选项：整图边框
let objStack = { undo: [], redo: [] };
let draft = null, editing = null, numNext = 1;
let selectedObj = null; // 选择工具：当前选中的标注对象（P3）
let escConfirm = { enabled: true, action: "" }; // Esc 退出确认（记住选择后不再弹窗）
let ann = null; // 历史「编辑」完整编辑器模式的会话标记（annotate.js 维护）

const MIN = 8; // css px 最小选区
function dpr() { return window.devicePixelRatio || 1; }
function toPhys(v) { return Math.round(v * dpr()); }

/* ================= 初始化 / 冻结 ================= */
// 预驻留待命：页面加载后只挂激活监听；热键时 Rust 冻结+显示+推事件（秒开路径）
// 每次激活前清上次会话（预驻留窗口复用，状态不残留）
function resetOverlayState() {
  document.body.classList.remove("ls-mode"); // 退出长截图采集模式（选区框/蒙版还原）
  numGhostHide();
  layer.innerHTML = ""; layer.style.display = "none"; layer.className = "";
  selEl.style.display = "none"; sizechip.style.display = "none";
  toolbar.style.display = "none";
  magnifier.style.display = "none"; detEl && (detEl.style.display = "none");
  document.getElementById("escdlg").classList.remove("open");
  document.getElementById("pr-text-menu").style.display = "none";
  document.getElementById("pr-color-menu").style.display = "none";
  document.getElementById("ctxmenu").classList.remove("open");
  hideTxtAnchors(); setObjSel(null); setHover(null);
  selectedObj = null; editing = null; objDrag = null; draft = null; drag = null; propsUndo = null; editBeforeSnap = null;
  objStack = { undo: [], redo: [] };
  cropMode = false; cropSaved = null; numNext = numStart;
  tool = null; setSel({ x: 0, y: 0, w: 0, h: 0 }); setState("idle");
  toolbarFree = false; // 工具栏恢复自动定位（拖动把手是本次会话内的临时摆放）
  magImg.removeAttribute("src"); // 清冻结图：驻留/复用瞬间不显示上一轮画面
  document.body.classList.remove("frozen", "obj-selected");
  stage.classList.remove("dim-idle");
  cancelhint.style.opacity = ""; cancelhint.style.transition = "";
  cancelhint.textContent = "拖出区域截图 · 或点击识别窗口 · Esc 退出";
}

async function init() {
  const ev = window.__TAURI__ && window.__TAURI__.event;
  if (ev && ev.listen) {
    try {
      await ev.listen("overlay-activate", (e2) => {
        activate(e2.payload || {});
      });
      // 驻留清屏：Rust 在 park 屏外前发来，清掉旧画面（下次移回只显示空白）
      await ev.listen("overlay-cleared", () => {
        try { resetOverlayState(); } catch (e) {}
      });
    } catch (err) { /* 监听失败：fallback 由下次显式激活兜底 */ }
    try { invoke("overlay_ready"); } catch (e) {} // 就绪握手：Rust 等 this 再 emit
    // 冷启动竞态兜底：若 emit 早于监听注册，取走存好的 payload 补激活
    try {
      const pending = await invoke("overlay_take_pending");
      if (pending && pending.kind && !document.body.classList.contains("frozen")) activate(pending);
    } catch (e) {}
    return; // 待命：不截屏不探测，窗口屏外驻留
  }
  await activate({}); // 无事件环境（无头测试）兜底走旧路径
}

// 激活：重置上次会话状态 → 冻结（优先 Rust 已截好的 dataUrl）→ 蒙版 → 设置
async function activate(payload) {
  try { resetOverlayState(); }
  catch (err) { console.warn("resetOverlayState", err); }
  if (payload.kind) { kind = payload.kind; document.body.dataset.kind = kind; }
  else {
    try {
      const k2 = await invoke("get_overlay_kind");
      if (k2) { kind = k2; document.body.dataset.kind = kind; }
    } catch (e) {}
  }
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
  // 冻结画布：热键路径 Rust 已在显示前截好（payload.dataUrl），零等待直接渲染
  if (payload.dataUrl) {
    magImg.src = payload.dataUrl;
    await new Promise((res, rej) => {
      if (magImg.complete && magImg.naturalWidth) res();
      else {
        magImg.onload = res;
        magImg.onerror = res; // 兜底：加载失败也放行（蒙版降级但流程不死锁）
        setTimeout(res, 1500);
      }
    });
    document.body.classList.add("frozen");
    stage.classList.add("dim-idle");
  } else {
    try {
      const f = await invoke("freeze_begin");
      magImg.src = f.dataUrl; // JPEG data URL：不受 asset 作用域限制，100% 可加载
      await new Promise((res) => { if (magImg.complete && magImg.naturalWidth) res(); else magImg.onload = res; });
      document.body.classList.add("frozen");
      stage.classList.add("dim-idle");
    } catch (e) {
      cancelhint.textContent = "冻结失败：" + e;
    }
  }
  if (kind === "scroll") {
    cancelhint.textContent = "长截图：拖出滚动区域（只调上下边界）· Esc 取消";
  }
  // 标注属性：默认值来自 settings.annotation（跟随主题记忆）
  try {
    const s = await invoke("get_settings");
    const a = s.annotation || {};
    if (a.color) toolColor = a.color;
    if (a.tool_colors) toolColors = { ...toolColors, ...a.tool_colors }; // 每工具独立色（同款语义）
    if (a.shape_width) toolW = Math.round(a.shape_width);
    if (a.arrow_heads) arrowHeads = a.arrow_heads;
    if (a.arrow_line_style) arrowLineStyle = a.arrow_line_style;
    else if (a.arrow_dash) arrowLineStyle = "dashed";
    if (a.shape_radius != null) shapeRadius = !!a.shape_radius;
    if (a.shape_opacity) shapeOpacity = a.shape_opacity;
    if (a.text_size) textSize = Math.round(a.text_size);
    if (a.text_family) textFont = a.text_family;
    textBold = !!a.text_bold; textItalic = !!a.text_italic; textUnderline = !!a.text_underline;
    if (a.text_align) textAlign = a.text_align;
    if (a.text_line_height) textLineHeight = a.text_line_height;
    if (a.text_background != null) textBackground = !!a.text_background;
    if (a.text_bg_color) textBgColor = a.text_bg_color;
    if (a.text_bg_opacity != null) textBgOpacity = a.text_bg_opacity;
    if (a.text_bg_radius != null) textBgRadius = a.text_bg_radius;
    if (a.text_stroke != null) textStroke = !!a.text_stroke;
    if (a.text_shadow != null) textShadow = !!a.text_shadow;
    if (a.step_style) numStyle = a.step_style;
    if (a.step_diameter) numDiameter = Math.round(a.step_diameter);
    if (a.mosaic_strength) mosStrength = a.mosaic_strength;
    if (a.highlight_opacity >= 0.1 && a.highlight_opacity <= 0.9) hlOpacity = a.highlight_opacity;
    if (a.mosaic_mode) mosMode = a.mosaic_mode;
    if (a.num_start != null) { numStart = a.num_start; numNext = numStart; }
    if (a.output_shadow) { outShadow = { on: !!a.output_shadow.on, blur: a.output_shadow.blur || 24, color: a.output_shadow.color || "#000000" }; }
    if (a.output_border) { outBorder = { on: !!a.output_border.on, w: a.output_border.width || 6, color: a.output_border.color || "#FFFFFF" }; }
    rememberProps = s.remember_annotation !== false;
    if (s.esc_exit_confirm) {
      escConfirm = { enabled: s.esc_exit_confirm.enabled !== false, action: s.esc_exit_confirm.action || "" };
    }
  } catch (e) {}
  syncPropsUI();
  setTimeout(() => { cancelhint.style.transition = "opacity .4s"; cancelhint.style.opacity = "0"; }, 2600);
}

/* 把持久化的工具属性同步到属性行控件高亮 */
function syncPropsUI() {
  const seg = (sel, attr, val) => {
    document.querySelectorAll(sel + " button").forEach((b) => b.classList.toggle("on", b.dataset[attr] === String(val)));
  };
  const chipEl = document.getElementById("pr-chip"); // 常驻色板已收进浮层：只刷当前色块
  if (chipEl) chipEl.style.background = toolColor;
  document.getElementById("pr-width-range").value = String(toolW);
  document.getElementById("pr-width-val").textContent = String(toolW);
  document.querySelectorAll("#pr-arrow-style button").forEach((b) => b.classList.toggle("on", b.dataset.a === arrowHeads));
  document.querySelectorAll("#pr-arrow-line button").forEach((b) => b.classList.toggle("on", b.dataset.l === arrowLineStyle));
  document.querySelectorAll(".ddl").forEach((d) => { if (d._ddlUpd) d._ddlUpd(); }); // 填充/线条下拉回填（替换旧 seg）
  seg("#pr-round", "r", shapeRadius ? 1 : 0);
  const f0 = document.getElementById("pr-font"); if (f0) f0.value = textFont;
  const s0 = document.getElementById("pr-tsize");
  if (s0) {
    // 四角锚点等比缩放会产生非标准字号：动态补 option 再回填
    if (![...s0.options].some((o) => +o.value === textSize)) {
      const o = document.createElement("option"); o.value = String(textSize); o.textContent = String(textSize);
      s0.appendChild(o);
    }
    s0.value = String(textSize);
  }
  const op0 = document.getElementById("pr-opacity-range");
  if (op0) { op0.value = String(Math.round(shapeOpacity * 100)); const ov = document.getElementById("pr-opacity-val"); if (ov) ov.textContent = op0.value; }
  const l0 = document.getElementById("pr-tlh"); if (l0) l0.value = String(textLineHeight);
  document.getElementById("pr-num-size").value = String(numDiameter);
  seg("#pr-tstyle", "t", textBold ? "bold" : textItalic ? "italic" : textUnderline ? "underline" : "");
  document.querySelector('#pr-tstyle button[data-t="bold"]').classList.toggle("on", textBold);
  document.querySelector('#pr-tstyle button[data-t="italic"]').classList.toggle("on", textItalic);
  document.querySelector('#pr-tstyle button[data-t="underline"]').classList.toggle("on", textUnderline);
  document.querySelector('#pr-tstyle button[data-t="shadow"]').classList.toggle("on", textShadow);
  seg("#pr-talign", "a", textAlign);
  bgRefresh(); // 背景直达块随全部回填路径刷新（settings 恢复/选中回填/切工具——曾漏致"显示斜纹但实际有背景"）
  seg("#pr-num-style", "ns", numStyle);
  document.getElementById("num-start").value = numStart;
  seg("#pr-mos-mode", "mm", mosMode);
  const mr0 = document.getElementById("pr-mos-range");
  if (mr0) { mr0.value = String(mosStrength); const mv0 = document.getElementById("pr-mos-val"); if (mv0) mv0.textContent = mosStrength; }
}

/* 输出前把当前工具属性写回主题记忆（SET-7 记住上次） */
function saveProps() {
  if (!rememberProps) return;
  invoke("set_setting", { key: "annotation", value: {
    color: toolColor, tool_colors: { ...toolColors }, arrow_width: toolW, shape_width: toolW,
    text_size: textSize, text_bold: textBold, text_italic: textItalic, text_underline: textUnderline,
    text_shadow: textShadow, text_align: textAlign, text_family: textFont, text_line_height: textLineHeight,
    text_background: textBackground, text_bg_color: textBgColor, text_bg_opacity: textBgOpacity, text_bg_radius: textBgRadius, text_stroke: textStroke,
    step_diameter: numDiameter, step_style: numStyle,
    mosaic_strength: mosStrength, highlight_opacity: hlOpacity,
    arrow_dash: arrowLineStyle === "dashed", arrow_double_head: arrowHeads === "both",
    arrow_heads: arrowHeads, arrow_line_style: arrowLineStyle,
    shape_dash: shapeDash, shape_radius: shapeRadius, shape_opacity: shapeOpacity, shape_fill: fillMode,
    mosaic_mode: mosMode, num_start: numStart,
    output_shadow: outShadow, output_border: { on: outBorder.on, width: outBorder.w, color: outBorder.color },
  } }).catch(() => {});
}
// 即改即存（业界实践）：属性一变更就持久化（防抖 400ms 合并连续写），任何退出路径不丢设置
let saveTimer = null;
function scheduleSave() {
  if (!rememberProps) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveProps(); }, 400);
}

/* ================= 窗口/控件自动识别 ================= */
let detTimer = null, detLast = 0, detX = 0, detY = 0;
function scheduleDetect(cssX, cssY) {
  detX = cssX; detY = cssY; // 记最新位置：到点时用当前位置（throttle 跟手，不等人停下）
  if (detTimer) return;
  const wait = Math.max(0, 60 - (performance.now() - detLast));
  detTimer = setTimeout(async () => {
    detTimer = null; detLast = performance.now();
    if (state !== "idle") return;
    try {
      candidates = await invoke("detect_candidates", { x: toPhys(detX), y: toPhys(detY) });
      candIdx = 0;
      if (candidates.length) showDet(candidates[0]);
    } catch (e) {}
  }, wait);
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
  // 选中当前高亮的候选（Tab 切换到哪个就选哪个）；过小则顺延扫描其余候选
  if (!candidates.length) return false;
  const order = [candIdx, ...candidates.keys()].filter((v, i, a) => a.indexOf(v) === i);
  for (const i of order) {
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
// 单击选中兜底：悬停检测有 60ms 去抖，快速移动后立即点击时候选可能过期/为空——
// 以点击点为准再测一次（同款语义：探测后单击即选中该窗口并弹工具栏）
async function clickSelectAt(p) {
  try {
    const list = await invoke("detect_candidates", { x: toPhys(p.x), y: toPhys(p.y) });
    for (const c of list) {
      const r = { x: c.rect[0] / dprV, y: c.rect[1] / dprV, w: c.rect[2] / dprV, h: c.rect[3] / dprV };
      if (r.w >= MIN && r.h >= MIN) {
        candidates = list; candIdx = list.indexOf(c);
        setSel(r); setState("selected"); hideDet();
        return true;
      }
    }
  } catch (e) {}
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
  if (selectedObj) setObjSel(selectedObj); // 选区动，选中框跟随
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
    updateStatusbar();
  } else if (s === "idle") {
    selEl.style.display = "none";
    layer.style.display = "none";
    toolbar.style.display = "none";
    sizechip.style.display = "none";
    layer.innerHTML = ""; objStack = { undo: [], redo: [] };
    tool = null; setTool(null);
  }
  updateStatusbar();
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
        if (cropMode) { drag = null; pressPt = null; return; } // 裁剪中单击：忽略
        // 单击：以点击点实时检测（悬停缓存可能过期——快速移动后点击会选中错误窗口）
        const pt = pressPt;
        drag = null; pressPt = null;
        if (pt) {
          clickSelectAt(pt).then((ok) => {
            if (!ok) { setState("idle"); selEl.style.display = "none"; sizechip.style.display = "none"; }
          });
          return;
        }
        setState("idle"); selEl.style.display = "none"; sizechip.style.display = "none";
      } else if (cropMode) {
        applyCrop();
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
let toolbarFree = false; // 拖动把手后=自由位置，positionToolbar 不再自动重定位（本次截图会话内有效）
function clampToolbar() {
  const w = Math.max(toolbar.offsetWidth, toolbar.scrollWidth, 560);
  const h = toolbar.offsetHeight || 76;
  const l = parseFloat(toolbar.style.left) || 0;
  const t = parseFloat(toolbar.style.top) || 0;
  toolbar.style.left = Math.max(4, Math.min(l, innerWidth - w - 4)) + "px";
  toolbar.style.top = Math.max(4, Math.min(t, innerHeight - h - 4)) + "px";
}
function positionToolbar() {
  if (toolbar.style.display === "none") return;
  if (toolbarFree) { clampToolbar(); return; } // 自由位：仅屏幕钳制（切工具致宽度变化时防出屏）
  const th = toolbar.offsetHeight || 76;
  const below = innerHeight - (sel.y + sel.h);
  const top = below >= th + 14 ? sel.y + sel.h + 10 : Math.max(6, sel.y - th - 10);
  toolbar.style.top = top + "px";
  // scrollWidth 兜住未布局完的属性行（第二行比首行宽时 offsetWidth 偏小 → 右下角出屏）
  const tw = Math.max(toolbar.offsetWidth, toolbar.scrollWidth, 560);
  toolbar.style.left = Math.max(8, Math.min(sel.x, innerWidth - tw - 8)) + "px";
  // 属性行显示/切换后再校准一帧（显示前测量不到真实宽度）
  requestAnimationFrame(() => {
    const tw2 = Math.max(toolbar.offsetWidth, toolbar.scrollWidth);
    if (tw2 > tw) toolbar.style.left = Math.max(8, Math.min(sel.x, innerWidth - tw2 - 8)) + "px";
  });
}
// 弹层面板屏幕钳制：贴右缘时向左收（业界：面板永不超出屏幕）
function clampPanelToScreen(el, anchor) {
  const w = el.offsetWidth || 226;
  const h = el.offsetHeight || 200;
  const l = parseFloat(el.style.left) || 0;
  if (l + w > innerWidth - 8) el.style.left = Math.max(8, innerWidth - w - 8) + "px";
  // 下方放不下时翻转到触发按钮（anchor.top）上方；无锚点则整体压入屏幕（贴底 8px）
  const t = parseFloat(el.style.top) || 0;
  if (t + h > innerHeight - 8) {
    const upTop = anchor && anchor.top ? anchor.top - h - 8 : innerHeight - h - 8;
    el.style.top = Math.max(8, upTop) + "px";
  }
}

function wireToolbar() {
  // 工具栏拖动把手（同类产品 交互）：自由摆放，本次截图会话内有效（下次拉起恢复自动贴选区）
  const tbHandle = document.getElementById("tb-handle");
  tbHandle.addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation(); // 不触发画布/工具逻辑，不夺焦点
    toolbarFree = true;
    tbHandle.classList.add("dragging");
    const sx = e.clientX, sy = e.clientY;
    const sl = parseFloat(toolbar.style.left) || 0;
    const st = parseFloat(toolbar.style.top) || 0;
    const onMove = (ev) => {
      toolbar.style.left = (sl + ev.clientX - sx) + "px";
      toolbar.style.top = (st + ev.clientY - sy) + "px";
      clampToolbar();
    };
    const onUp = () => {
      tbHandle.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.addEventListener("click", () => setTool(tool === b.dataset.tool ? null : b.dataset.tool));
  });
  // 画图经典 20 色板（同类产品 默认板）：收进浮层（属性行只留当前色 chip，点开弹板）
  const PALETTE = [
    "#000000", "#7F7F7F", "#880015", "#ED1C24", "#FF7F27", "#FFF200", "#22B14C", "#00A2E8", "#3F48CC", "#A349A4",
    "#FFFFFF", "#C3C3C3", "#B97A57", "#FFAEC9", "#FFC90E", "#EFE4B0", "#B5E61D", "#99D9EA", "#7092BE", "#C8BFE7",
  ];
  const pc = document.getElementById("pr-color");
  const colorMenu = document.getElementById("pr-color-menu");
  colorMenu.className = "flymenu";
  colorMenu.style.width = "264px"; // 与背景面板同宽（曾缺：默认 236px 且行布局错位——HEX/描边行不齐）
  const swsWrapC = document.createElement("div"); swsWrapC.className = "sws";
  PALETTE.forEach((c) => {
    const b = document.createElement("button");
    b.className = "sw"; b.style.background = c; b.dataset.c = c; b.title = c;
    b.addEventListener("click", () => {
      setColorForTool(c);
      chip.style.background = toolColor;
      swsWrapC.querySelectorAll(".sw").forEach((x) => x.classList.toggle("on", x === b));
      syncTextProps();
    });
    swsWrapC.appendChild(b);
  });
  const colorPick = document.createElement("input");
  colorPick.type = "color"; colorPick.title = "自定义颜色";
  swsWrapC.appendChild(colorPick);
  colorPick.addEventListener("input", () => {
    setColorForTool(colorPick.value.toUpperCase());
    chip.style.background = toolColor;
    swsWrapC.querySelectorAll(".sw[data-c]").forEach((x) => x.classList.remove("on"));
    syncTextProps();
  });
  const rowC = document.createElement("div"); rowC.className = "row";
  rowC.innerHTML = '<span class="lbl">颜色</span>';
  rowC.appendChild(swsWrapC);
  colorMenu.appendChild(rowC);
  // 解释性说明不上 UI（业界：控件自解释+悬停 tooltip）——曾放"线条/文字颜色（背景在 A 面板）"解释行，A 删后无意义已删
  // HEX 精确输入行
  const hexInput = document.createElement("input");
  hexInput.id = "pr-hex"; hexInput.placeholder = "#FF0000"; hexInput.maxLength = 7;
  hexInput.style.cssText = "width:70px;background:var(--ov-surface-2);color:var(--ov-fg);border:1px solid var(--ov-border);border-radius:4px;padding:2px 5px;";
  hexInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const v = hexInput.value.trim();
      if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
        setColorForTool(v.toUpperCase());
        chip.style.background = toolColor;
        hexInput.value = "";
        swsWrapC.querySelectorAll(".sw[data-c]").forEach((x) => x.classList.remove("on"));
        syncTextProps();
      }
    } else if (e.key === "Escape") { hexInput.value = ""; }
  });
  const rowH = document.createElement("div"); rowH.className = "row";
  rowH.innerHTML = '<span class="lbl">HEX</span>';
  rowH.appendChild(hexInput);
  colorMenu.appendChild(rowH);
  // 描边行：描边=文字外轮廓（对比色自动反色，业界惯例）——归位到颜色面板（就近原则）
  const rowSt = document.createElement("div"); rowSt.className = "row";
  rowSt.innerHTML = '<span class="lbl">描边</span>';
  const strokeBtn = document.createElement("button");
  strokeBtn.id = "pr-stroke-btn"; strokeBtn.textContent = "描边";
  strokeBtn.title = "外轮廓自动取反色（白字黑边/红字白边，任何底色都清晰）";
  strokeBtn.style.cssText = "padding:2px 10px;cursor:pointer;border-radius:4px;border:1px solid var(--ov-border);background:var(--ov-surface-2);color:var(--ov-fg);";
  strokeBtn.addEventListener("click", () => {
    textStroke = !textStroke;
    strokeBtn.classList.toggle("on", textStroke);
    syncTextProps();
  });
  rowSt.appendChild(strokeBtn);
  colorMenu.appendChild(rowSt);
  // 属性行的当前色 chip：点击弹色板浮层（同类产品 同款）
  const chip = document.createElement("button");
  chip.id = "pr-chip"; chip.title = "颜色（点击选色）";
  chip.style.cssText = "width:22px;height:22px;border-radius:5px;border:1px solid rgba(255,255,255,.4);cursor:pointer;padding:0;";
  pc.appendChild(chip);
  chip.style.background = toolColor;
  // 线宽滑杆 2–24
  const wr = document.getElementById("pr-width-range");
  wr.addEventListener("input", () => { toolW = Number(wr.value); document.getElementById("pr-width-val").textContent = wr.value; syncSelProps(); });
  wr.addEventListener("change", () => wr.blur()); // 拖完归还焦点：滑杆持焦会吞 Esc（用户实测报障）
  // 形状槽位：点击主体=用当前形状；点击三角=弹出切换菜单
  const shapeBtn = document.getElementById("tb-shape");
  const shapeMenu = document.getElementById("shape-menu");
  shapeBtn.addEventListener("click", (e) => {
    if (e.target.closest("#shape-menu")) return;
    setTool(shapeSlot);
  });
  document.getElementById("shape-tri").addEventListener("click", (e) => {
    e.stopPropagation();
    // 内联 display 控制：不依赖外部 CSS 规则；槽位 .open 联动三角 ▼→▲
    const show = shapeMenu.style.display === "none";
    shapeMenu.style.display = show ? "flex" : "none";
    document.getElementById("tb-shape").classList.toggle("open", show);
  });
  shapeMenu.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      setShapeSlot(b.dataset.shape);
      shapeMenu.style.display = "none";
      setTool(shapeSlot);
    });
  });
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#tb-shape")) { shapeMenu.style.display = "none"; document.getElementById("tb-shape").classList.remove("open"); }
  }, true);
  document.getElementById("tb-crop").addEventListener("click", startCrop);
  // 箭头：样式（单/双/反/无）/ 线型（实/虚/点）
  document.querySelectorAll("#pr-arrow-style button").forEach((b) => b.addEventListener("click", () => {
    arrowHeads = b.dataset.a;
    document.querySelectorAll("#pr-arrow-style button").forEach((x) => x.classList.toggle("on", x === b));
    syncSelProps();
  }));
  document.querySelectorAll("#pr-arrow-line button").forEach((b) => b.addEventListener("click", () => {
    arrowLineStyle = b.dataset.l;
    document.querySelectorAll("#pr-arrow-line button").forEach((x) => x.classList.toggle("on", x === b));
    syncSelProps();
  }));
  // 形状：填充/线条下拉（业界同款：按钮显当前态+▼，展开浮层选择）+ 圆角/透明度
  const DDL_ICONS = {
    "ddl-fill": {
      outline: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2" width="10" height="10" rx="1"/></svg>',
      fill: '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="1" fill="currentColor"/></svg>',
      outline_fill: '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 2h5v10H2z" fill="currentColor"/><rect x="2" y="2" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    },
    "ddl-line": {
      solid: '<svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="2" y1="7" x2="16" y2="7"/></svg>',
      dashed: '<svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="2" y1="7" x2="16" y2="7" stroke-dasharray="3.5 2.5"/></svg>',
    },
  };
  function ddlCloseAll() { document.querySelectorAll(".ddl.open").forEach((d) => d.classList.remove("open")); }
  function ddlWire(id, getVal, setVal) {
    const box = document.getElementById(id);
    const cur = box.querySelector(".ddl-cur");
    const menu = box.querySelector(".ddl-menu");
    const icons = DDL_ICONS[id];
    const upd = () => {
      const v = getVal();
      cur.innerHTML = icons[v] || "";
      menu.querySelectorAll(".ddl-item").forEach((it) => it.classList.toggle("on", it.dataset.v === v));
    };
    box._ddlUpd = upd;
    box.querySelector(".ddl-btn").addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation(); // 真机弹层 click 不可靠，统一 mousedown（与把手/色板同模式）
      const willOpen = !box.classList.contains("open");
      ddlCloseAll();
      box.classList.toggle("open", willOpen);
    });
    menu.querySelectorAll(".ddl-item").forEach((it) => it.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      setVal(it.dataset.v);
      upd(); // 立即刷按钮当前态图标+菜单选中标记（syncSelProps 只应用图形，曾漏致"图形变了入口没变"）
      ddlCloseAll();
      syncSelProps();
    }));
    upd();
  }
  document.addEventListener("mousedown", (e) => { if (!e.target.closest(".ddl")) ddlCloseAll(); }, true);
  ddlWire("ddl-fill", () => fillMode, (v) => { fillMode = v; });
  ddlWire("ddl-line", () => (shapeDash ? "dashed" : "solid"), (v) => { shapeDash = v === "dashed"; });
  document.querySelectorAll("#pr-round button").forEach((b) => {
    b.addEventListener("click", () => {
      shapeRadius = b.dataset.r === "1";
      document.querySelectorAll("#pr-round button").forEach((x) => x.classList.toggle("on", x === b));
      syncSelProps();
    });
  });
  document.getElementById("pr-opacity-range").addEventListener("input", (e) => {
    shapeOpacity = Number(e.target.value) / 100;
    const ov = document.getElementById("pr-opacity-val"); if (ov) ov.textContent = e.target.value;
    syncSelProps();
  });
  document.getElementById("pr-opacity-range").addEventListener("change", (e) => e.target.blur()); // 拖完归还焦点（防吞 Esc）
  // 文字：字体/字号/粗斜下阴影描边/对齐/行距/背景
  const tstyle = () => ({
    bold: document.querySelector('#pr-tstyle button[data-t="bold"]'),
    italic: document.querySelector('#pr-tstyle button[data-t="italic"]'),
    underline: document.querySelector('#pr-tstyle button[data-t="underline"]'),
    shadow: document.querySelector('#pr-tstyle button[data-t="shadow"]'),
  });
  document.querySelectorAll("#pr-tstyle button").forEach((b) => {
    b.addEventListener("click", () => {
      const t = b.dataset.t;
      if (t === "bold") textBold = !textBold;
      else if (t === "italic") textItalic = !textItalic;
      else if (t === "underline") textUnderline = !textUnderline;
      else if (t === "shadow") textShadow = !textShadow;
      const m = tstyle();
      m.bold.classList.toggle("on", textBold);
      m.italic.classList.toggle("on", textItalic);
      m.underline.classList.toggle("on", textUnderline);
      m.shadow.classList.toggle("on", textShadow);
      syncTextProps();
    });
  });
  document.querySelectorAll("#pr-talign button").forEach((b) => {
    b.addEventListener("click", () => {
      textAlign = b.dataset.a;
      document.querySelectorAll("#pr-talign button").forEach((x) => x.classList.toggle("on", x === b));
      syncTextProps();
    });
  });
  // 背景面板：按钮=开关；▾=弹完整面板（黑白+色板+自由选色+透明度+圆角）
  // ===== A 文字设置面板：背景色/透明/圆角 + 描边（字体/字号/行距在属性行直接可调） =====
  const bgMenu = document.getElementById("pr-text-menu");
  bgMenu.className = "flymenu";
  bgMenu.style.width = "264px";
  // 字体/字号/行距：属性行静态 select 直接可调（用户要求回迁；此前收进面板致"不见了"）
  document.getElementById("pr-font").addEventListener("change", (e) => { textFont = e.target.value; syncTextProps(); });
  document.getElementById("pr-tsize").addEventListener("change", (e) => { textSize = Number(e.target.value); syncTextProps(); });
  document.getElementById("pr-tlh").addEventListener("change", (e) => { textLineHeight = Number(e.target.value); syncTextProps(); });
  // —— 分隔线 + 背景段 ——
  const sect = document.createElement("div"); sect.className = "sect"; bgMenu.appendChild(sect);
  const BG_PALETTE = ["#FFFFFF", "#000000", "#FFF7D6", "#FFE0E0", "#E0F0FF", "#DFFFE0", "#F0E4FF", "#FFF0F5", "#FFD8A8", "#C8E8FF", "#C8F8D0", "#F8E8C8", "#E8E8E8"];
  const swsWrap = document.createElement("div");
  swsWrap.className = "sws";
  const swApply = (fn) => (e) => {
    // mousedown 即选（真机 WebView2 物理点击的 click 合成在面板上不稳定——曾致"点了没反应"；与把手/直达块同模式）
    e.preventDefault(); e.stopPropagation();
    fn();
  };
  BG_PALETTE.forEach((c) => {
    const s = document.createElement("button");
    s.className = "sw"; s.style.background = c; s.title = c; s.dataset.c = c;
    s.addEventListener("mousedown", swApply(() => {
      textBgColor = c; textBackground = true;
      syncTextProps();
      if (!editing && !selectedObj) showToast("背景已设置：接下来输入的文字将生效");
    }));
    swsWrap.appendChild(s);
  });
  const noneSw = document.createElement("button");
  noneSw.className = "sw none"; noneSw.title = "无背景";
  noneSw.addEventListener("mousedown", swApply(() => {
    textBackground = false;
    syncTextProps();
  }));
  swsWrap.appendChild(noneSw);
  const colorIn = document.createElement("input");
  colorIn.type = "color"; colorIn.title = "自由选色";
  colorIn.addEventListener("input", () => {
    textBgColor = colorIn.value.toUpperCase(); textBackground = true;
    syncTextProps();
  });
  swsWrap.appendChild(colorIn);
  const row1 = document.createElement("div"); row1.className = "row";
  row1.innerHTML = '<span class="lbl">背景</span>';
  row1.appendChild(swsWrap);
  bgMenu.appendChild(row1);
  // 面板标题：用户曾找不到圆角/透明滑杆——入口可见性是面板的第一性问题
  const bTitle = document.createElement("div");
  bTitle.textContent = "文字背景设置";
  bTitle.style.cssText = "font-size:11px;color:var(--ov-fg-dim);border-bottom:1px solid var(--ov-border);padding-bottom:6px;margin-bottom:8px;";
  bgMenu.appendChild(bTitle);
  const row2 = document.createElement("div"); row2.className = "row";
  row2.innerHTML = '<span class="lbl">透明</span>';
  const opRange = document.createElement("input"); opRange.type = "range"; opRange.min = 10; opRange.max = 100; opRange.step = 5;
  const opVal = document.createElement("span"); opVal.className = "val";
  opRange.addEventListener("input", () => {
    textBgOpacity = Number(opRange.value) / 100;
    opVal.textContent = opRange.value + "%";
    if (!textBackground) { textBackground = true; } // 拖透明度自动开背景
    syncTextProps();
  });
  row2.appendChild(opRange); row2.appendChild(opVal);
  bgMenu.appendChild(row2);
  const row3 = document.createElement("div"); row3.className = "row";
  row3.innerHTML = '<span class="lbl">圆角</span>';
  const rdRange = document.createElement("input"); rdRange.type = "range"; rdRange.min = 0; rdRange.max = 60; rdRange.step = 1;
  const rdVal = document.createElement("span"); rdVal.className = "val";
  rdRange.addEventListener("input", () => {
    textBgRadius = Number(rdRange.value);
    rdVal.textContent = rdRange.value + "px";
    if (!textBackground) { textBackground = true; }
    syncTextProps();
  });
  row3.appendChild(rdRange); row3.appendChild(rdVal);
  bgMenu.appendChild(row3);
  // 描边已归位到颜色面板（rowSt），背景面板只剩背景相关（用户方案：拆散 A 杂烩）
  function refreshBgMenu() {
    opRange.value = String(Math.round(textBgOpacity * 100)); opVal.textContent = opRange.value + "%";
    rdRange.value = String(textBgRadius); rdVal.textContent = rdRange.value + "px";
    colorIn.value = textBgColor.toLowerCase();
    swsWrap.querySelectorAll(".sw[data-c]").forEach((s) => s.classList.toggle("on", s.dataset.c.toUpperCase() === textBgColor.toUpperCase()));
    // 字体/字号/行距的回填在属性行（syncPropsUI），描边回填在颜色面板打开时（colorMenu 段）
  }
  // 入口合一后：背景面板唯一入口=背景色块（tbgChip，见下方 mousedown）；A 按钮已删（描边归颜色面板）
  // 字色浮层打开时刷新描边选中态（描边归位到颜色面板后的回填）
  const strokeSync = () => { const sb = document.getElementById("pr-stroke-btn"); if (sb) sb.classList.toggle("on", textStroke); };
  chip.addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation(); // 真机弹层 click 不可靠，统一 mousedown
    bgMenu.style.display = "none"; // 与背景面板互斥
    strokeSync();
    const r = chip.getBoundingClientRect();
    colorMenu.style.left = Math.round(r.left) + "px";
    colorMenu.style.top = Math.round(r.bottom + 6) + "px";
    colorMenu.style.display = colorMenu.style.display === "block" ? "none" : "block";
    clampPanelToScreen(colorMenu, r);
  });
  // ===== 背景色直达块（B/I/U/S/A 左侧）：与 A 按钮同开一个完整文字设置面板 =====
  // （入口合一：背景/字体/字号/行距/描边全在一面板——背景板与 A 面板分裂曾致用户两次迷路）
  const tbgChip = document.getElementById("pr-tbgchip");
  tbgChip.addEventListener("mousedown", (e) => {
    // mousedown 即开（同类产品 手感）：preventDefault 阻止焦点转移（编辑框光标保持）
    e.preventDefault(); e.stopPropagation();
    colorMenu.style.display = "none"; // 与字色浮层互斥
    refreshBgMenu();
    const r = tbgChip.getBoundingClientRect();
    bgMenu.style.left = Math.round(r.left) + "px";
    bgMenu.style.top = Math.round(r.bottom + 6) + "px";
    bgMenu.style.display = bgMenu.style.display === "block" ? "none" : "block";
    clampPanelToScreen(bgMenu, r);
  });
  tbgChip.addEventListener("click", (e) => e.stopPropagation()); // 吞掉 click，防双触发/冒泡
  bgRefresh();
  // 序号：样式/大小/起始
  document.querySelectorAll("#pr-num-style button").forEach((b) => {
    b.addEventListener("click", () => {
      numStyle = b.dataset.ns;
      document.querySelectorAll("#pr-num-style button").forEach((x) => x.classList.toggle("on", x === b));
      syncSelProps();
    });
  });
  document.getElementById("pr-num-size").addEventListener("change", (e) => { numDiameter = Number(e.target.value); syncSelProps(); });
  document.getElementById("num-start").addEventListener("change", (e) => {
    numStart = Math.max(0, parseInt(e.target.value, 10) || 1);
    numNext = numStart;
  });
  // 马赛克：模式（icon）/强度（滑杆，连续可调——档位 icon 是离散粗调，业界用滑杆）
  document.querySelectorAll("#pr-mos-mode button").forEach((b) => {
    b.addEventListener("mousedown", (e) => {
      // mousedown 即选（真机 WebView2 弹层 click 合成不可靠，与色板/把手同模式）
      e.preventDefault(); e.stopPropagation();
      mosMode = b.dataset.mm;
      document.querySelectorAll("#pr-mos-mode button").forEach((x) => x.classList.toggle("on", x === b));
      syncSelProps();
    });
  });
  const mosRange = document.getElementById("pr-mos-range");
  mosRange.addEventListener("input", (e) => {
    mosStrength = Number(e.target.value);
    const mv = document.getElementById("pr-mos-val"); if (mv) mv.textContent = e.target.value;
    syncSelProps();
  });
  mosRange.addEventListener("change", () => mosRange.blur()); // 拖完归还焦点（防吞 Esc）
  document.getElementById("tb-copy").addEventListener("click", () => output("copy"));
  document.getElementById("tb-ocr").addEventListener("click", () => output("ocr"));
  document.getElementById("tb-scroll").addEventListener("click", startLongshot);
  document.getElementById("tb-pin").addEventListener("click", () => output("pin"));
  document.getElementById("tb-save").addEventListener("click", () => output("saveas")); // 保存=弹对话框选位置（2026-09-23 用户要求；曾误发 "save" 落默认目录不弹框）
  document.getElementById("tb-exit").addEventListener("click", cancelAll);
  document.getElementById("tb-undo").addEventListener("click", undoOp);
  document.getElementById("tb-redo").addEventListener("click", redoOp);
}

// 属性面板显隐：el=选中对象时按对象类型显示（上下文感知面板，业界主流：点谁编辑谁），
// el=null 时按当前画图工具显示（setTool 与取消选中共用）
function syncPanelFor(el) {
  const t = el ? el.dataset.k : tool;
  const show = (id, on) => document.getElementById(id).classList.toggle("on", on);
  show("pr-color", !!t && t !== "eraser" && t !== "mosaic");
  show("pr-width", ["arrow", "pen", "marker", "rect", "ellipse"].includes(t));
  show("pr-arrow", t === "arrow");
  show("pr-shape", t === "rect" || t === "ellipse");
  document.getElementById("pr-round").style.display = t === "rect" ? "" : "none";
  show("pr-text", t === "text");
  show("pr-num", t === "num");
  show("pr-mos", t === "mosaic");
}
function setTool(t) {
  if (t === "select") t = null; // 选择=退出画图模式（点选标注在分发器处理）
  if (t === "shape") t = shapeSlot; // 形状槽位：用当前槽位形状画
  // 切走文字工具时先确认编辑中的文字：编辑中点工具栏会触发 focusout 分流"保编辑态"，
  // editing 残留后 layer mousedown 首行守卫直接 return——画布上点什么都没反应
  //（用户报"来回切换工具后点旧文字点不动、出不了锚点"）
  if (editing && t !== "text") finishText(editing);
  tool = t;
  // 颜色按工具独立：切工具即恢复该工具记忆的色（箭头红/文字白互不干扰）
  colorKey = t && toolColors[t] !== undefined ? t : colorKey;
  if (t && toolColors[t] !== undefined) {
    toolColor = toolColors[t];
    const pc0 = document.getElementById("pr-chip");
    if (pc0) pc0.style.background = toolColor;
  }
  setObjSel(null); setHover(null); // 切工具即取消对象选中（用户选定行为）
  layer.style.pointerEvents = t ? "auto" : "none"; // 无工具时画布不吃指针，保证选区/手柄可拖
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t || (b.dataset.tool === "shape" && (t === "rect" || t === "ellipse"))));
  layer.className = t === "eraser" ? "tool-eraser" : "";
  layer.style.cursor = t ? "crosshair" : "default";
  if (t !== "num") numGhostHide();
  selEl.classList.toggle("moveable", !t); // 无工具：选区内整体手型可平移
  syncPanelFor(null); // 无选中：面板跟随当前画图工具
  const tips = {
    select: "点选标注 · 拖动移动 · 方向键微调 · Delete 删除",
    arrow: "拖出箭头 · Shift 锁 45°", pen: "自由画笔", marker: "荧光笔 · 正片叠底",
    rect: "拖出矩形", ellipse: "拖出椭圆", text: "点画布输入 · Ctrl+Enter 确认",
    num: "连点自增 · Alt 复用上一号", mosaic: "拖出马赛克", eraser: "点一下删掉标注",
  };
  document.getElementById("pr-tip").textContent = tips[t] || "";
  updateStatusbar();
}
function setShapeSlot(s) {
  shapeSlot = s;
  document.getElementById("shape-ic-rect").style.display = s === "rect" ? "" : "none";
  document.getElementById("shape-ic-ellipse").style.display = s === "ellipse" ? "" : "none";
  document.querySelectorAll("#shape-menu button").forEach((b) => b.classList.toggle("on", b.dataset.shape === s));
}

/* ================= 底部状态栏 ================= */
// css 颜色（rgb/rgba 格式）→ #RRGGBB：ops 契约 parse_color 只认 hex
function cssColorToHex(v) {
  if (!v) return "";
  if (v.startsWith("#")) return v;
  const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(v);
  if (!m) return "";
  return "#" + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, "0")).join("").toUpperCase();
}
// 轻提示（渲染失败等需要用户看到的消息）
function showToast(msg) {
  const t = document.createElement("div");
  t.className = "ann-toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
function updateStatusbar() {
  const sb = document.getElementById("statusbar");
  if (state !== "selected" && state !== "drawing") { sb.style.display = "none"; return; }
  sb.style.display = "flex";
  document.getElementById("sb-size").textContent = `${Math.round(sel.w * dprV)} × ${Math.round(sel.h * dprV)}`;
  const names = { arrow: "箭头", pen: "画笔", marker: "荧光笔", rect: "矩形", ellipse: "椭圆", text: "文字", num: "序号", mosaic: "马赛克", eraser: "橡皮擦" };
  document.getElementById("sb-tool").textContent = tool ? `${names[tool] || tool} · ${document.getElementById("pr-tip").textContent}` : "选择 · 点选标注，或直接画图";
  document.getElementById("sb-undo").textContent = `撤销 ${objStack.undo.length}/${objStack.undo.length + objStack.redo.length}`;
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, "0"), mm = String(t.getMinutes()).padStart(2, "0"), ss = String(t.getSeconds()).padStart(2, "0");
  document.getElementById("sb-out").textContent = `将生成 ${hh}${mm}${ss}-…-ann.png`;
}

/* ================= 画图（冻结截图上直接画） ================= */
function layerPt(e) {
  const r = layer.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
// 选区内坐标钳制：标注永不越出高亮区（业界实践：输出=选区，界外标注无意义）
function clampPt(p) {
  return { x: Math.max(0, Math.min(p.x, sel.w)), y: Math.max(0, Math.min(p.y, sel.h)) };
}
// 是否位于选区边缘 8px 条带内（画图工具激活时该区域=平移热区，同类产品 手型）
function nearSelEdge(r) {
  // r 是 layer 本地坐标（0..sel.w × 0..sel.h）——曾误用视口系 sel.x/sel.y 比较，
  // 导致选区左上角附近起笔被误判"贴边"→ 启动选区平移 → 马赛克/图形"拖了没反应"（用户报障根因）
  const m = 8;
  if (r.x < -4 || r.x > sel.w + 4 || r.y < -4 || r.y > sel.h + 4) return false;
  return r.x <= m || (sel.w - r.x) <= m || r.y <= m || (sel.h - r.y) <= m;
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
  const g = { x1, y1, x2, y2, lw: toolW, color: toolColor, heads: arrowHeads, ls: arrowLineStyle };
  el.dataset.geom = JSON.stringify(g);
  drawArrowGeom(el, g);
}
function applyShapeStyle(el, k, p) {
  const dash = p.dash ? "dashed" : "solid";
  // 填充三态与引擎对齐（同类产品 同款）：outline=只描边；fill=纯填充无边框；
  // outline_fill=半透明底(24%×不透明度)+描边——蒙层随"不透明"滑杆全局变淡（与引擎同步）
  if (k === "rect") {
    const op = p.opacity != null && p.opacity < 1 ? p.opacity : 1;
    el.style.border = p.fill === "fill" ? "none" : `${p.lw}px ${dash} ${hexA(p.color, op)}`;
    el.style.borderRadius = p.radius ? "12px" : "4px"; el.style.boxSizing = "border-box";
    el.style.opacity = "";
    el.style.background = p.fill === "fill" ? hexA(p.color, op) : p.fill === "outline_fill" ? hexA(p.color, 0.24 * op) : "";
  } else if (k === "ellipse") {
    const op = p.opacity != null && p.opacity < 1 ? p.opacity : 1;
    el.style.border = p.fill === "fill" ? "none" : `${p.lw}px ${dash} ${hexA(p.color, op)}`;
    el.style.borderRadius = "50%"; el.style.boxSizing = "border-box";
    el.style.opacity = "";
    el.style.background = p.fill === "fill" ? hexA(p.color, op) : p.fill === "outline_fill" ? hexA(p.color, 0.24 * op) : "";
  } else if (k === "marker") {
    el.style.border = "none";
    el.style.background = hexA(p.color, 0.35); el.style.mixBlendMode = "multiply";
  } else if (k === "mosaic") {
    el.style.border = "none"; el.style.borderRadius = "2px"; el.style.mixBlendMode = "";
    if (p.mode === "blur") {
      // 模糊预览：冻结帧该区域 + CSS blur（序列化 mode=blur，引擎真实模糊）
      // filter 必须有——曾缺失时预览与底图逐像素一致，视觉"拖了没反应"（用户报障根因）
      el.style.background = ""; // 先清条纹简写（mosaic→blur 切换残留），再设长写
      el.style.backgroundImage = `url("${magImg.src}")`;
      // 冻结图按"逻辑整屏"铺（magImg 是物理整屏图），el(L,T) 对应冻结图 (sel.x+L, sel.y+T) 区域——
      // 曾误铺成 layer 尺寸：框内显示的是整屏缩影片段（看似"写死的图"），并非框住内容
      el.style.backgroundSize = `${innerWidth}px ${innerHeight}px`;
      const bl = parseFloat(el.style.left) || 0, bt = parseFloat(el.style.top) || 0;
      el.style.backgroundPosition = `-${sel.x + bl}px -${sel.y + bt}px`;
      el.style.filter = `blur(${Math.max(3, Math.round((p.mos || 14) * 0.5))}px)`;
      el.dataset.blurBg = "1";
      delete el.dataset.realPrev;
    } else {
      el.style.backgroundImage = "none"; el.style.filter = "";
      el.style.background = `repeating-linear-gradient(90deg,#8E8E93 0 ${p.mos}px,#C9C9CF ${p.mos}px ${2 * p.mos}px)`;
      delete el.dataset.blurBg;
    }
  }
}
// 真实马赛克预览：把冻结图对应区域 canvas 块化（缩小再放大），mouseup/改属性后替换条纹示意
function mosaicPreview(el) {
  if (!el || el.dataset.k !== "mosaic") return;
  const p = JSON.parse(el.dataset.params || "{}");
  const L = parseFloat(el.style.left) || 0, T = parseFloat(el.style.top) || 0;
  const W = parseFloat(el.style.width) || 0, H = parseFloat(el.style.height) || 0;
  if (p.mode === "blur") {
    // 模糊落定预览：canvas 采样+ctx.filter.blur → dataURL 背景（与块化同管线）。
    // 不用 CSS filter+背景定位方案——真机 WebView2 上不渲染（无头 computed 正确但视觉无效果），
    // 拖动中仍由 applyShapeStyle 的 CSS 版兜底。
    if (!magImg.naturalWidth || W < 6 || H < 6) return;
    try {
      const scl = magImg.naturalWidth / innerWidth;
      const r = Math.max(3, Math.round((p.mos || 14) * 0.5)); // 模糊半径
      const cv = document.createElement("canvas");
      cv.width = Math.round(W); cv.height = Math.round(H);
      const cx = cv.getContext("2d");
      cx.filter = `blur(${r}px)`;
      cx.drawImage(magImg, (sel.x + L) * scl, (sel.y + T) * scl, W * scl, H * scl, 0, 0, cv.width, cv.height);
      el.style.background = `url(${cv.toDataURL()}) no-repeat`;
      el.style.backgroundSize = "100% 100%";
      el.style.filter = "";
      el.dataset.realPrev = "1";
    } catch (e) { /* 退回 CSS 版 */ }
    return;
  }
  if (!magImg.naturalWidth) return;
  if (W < 6 || H < 6) return;
  try {
    const scl = magImg.naturalWidth / innerWidth; // 冻结图(物理整屏) → 视口逻辑坐标比例（=dpr）；曾误除 layer.clientWidth 致采样错位/超界
    const block = Math.max(2, Math.round(p.mos || 14)); // 块尺寸（逻辑 px）
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(W / block));
    small.height = Math.max(1, Math.round(H / block));
    const sc = small.getContext("2d");
    sc.drawImage(magImg, (sel.x + L) * scl, (sel.y + T) * scl, W * scl, H * scl, 0, 0, small.width, small.height);
    const big = document.createElement("canvas");
    big.width = Math.round(W); big.height = Math.round(H);
    const bc = big.getContext("2d");
    bc.imageSmoothingEnabled = false; // 放大不插值=块状像素
    bc.drawImage(small, 0, 0, big.width, big.height);
    el.style.background = `url(${big.toDataURL()}) no-repeat`;
    el.style.backgroundSize = "100% 100%";
    el.dataset.realPrev = "1";
  } catch (e) { /* 预览生成失败退回条纹示意（序列化不受影响） */ }
}
function shapeStyle(el) {
  if (tool === "rect" || tool === "ellipse" || tool === "marker" || tool === "mosaic") {
    applyShapeStyle(el, tool, { lw: toolW, color: toolColor, fill: fillMode, mos: mosStrength, mode: mosMode, radius: shapeRadius ? 12 : 0, dash: shapeDash, opacity: shapeOpacity });
  }
}

layer.addEventListener("mousemove", (e) => {
  if (!tool || draft || editing) return;
  const r = layerPt(e);
  // 悬浮已有标注：文字=文本光标（点字即改）、其他对象=移动光标（同类产品：随时可编辑）
  if (tool !== "eraser") {
    const hov = pickObj(r.x, r.y);
    if (hov) { layer.style.cursor = hov.dataset.k === "text" ? "text" : "move"; return; }
  }
  const corners = [[0, 0, "nwse-resize"], [1, 0, "nesw-resize"], [0, 1, "nesw-resize"], [1, 1, "nwse-resize"]];
  let cur = "crosshair";
  for (const [fx, fy, cur2] of corners) {
    const cx = sel.w * fx, cy = sel.h * fy; // 本地坐标系（与 layerPt 一致）
    if (Math.hypot(r.x - cx, r.y - cy) <= 8) { cur = cur2; break; }
  }
  if (cur === "crosshair" && nearSelEdge(r)) cur = "move";
  layer.style.cursor = cur;
});
layer.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || editing || !tool || objDrag) return; // objDrag：本次点击已被对象编辑接管
  e.stopPropagation();
  const p = layerPt(e);
  if (tool === "eraser") {
    const del = e.target.closest && e.target.closest(".obj");
    if (del) { pushUndo({ t: "del", el: del }); del.remove(); }
    return;
  }
  if (tool === "text") {
    // 同类产品：文字工具下点击已有文字 = 直接进入编辑（而非新建）
    const thit = pickObj(p.x, p.y);
    if (thit && thit.dataset.k === "text") { reEditText(thit); e.preventDefault(); return; }
    e.preventDefault(); startText(p); return; // preventDefault：否则 mousedown 默认行为夺焦，编辑框立即 blur 自毁
  }
  if (tool === "num") {
    const el = mkObj(); const d = numDiameter; el.dataset.k = "num";
    // 序号圆完整落在选区内
    const nl = Math.max(0, Math.min(p.x - d / 2, sel.w - d));
    const nt = Math.max(0, Math.min(p.y - d / 2, sel.h - d));
    el.style.cssText = `position:absolute;left:${nl}px;top:${nt}px;width:${d}px;height:${d}px;`;
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
    pushUndo({ t: "add", el });
    setObjSel(el); // 画完即选中
    if (!e.altKey) numNext++; // Alt=复用上一号（连点自增，Alt 不递增）
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
  // 同款语义：标注约束在选区内——笔画到边界被截断
  const p = clampPt(layerPt(e));
  if (draft.k === "pen") {
    const last = draft.pts[draft.pts.length - 1];
    if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) >= 2) {
      draft.pts.push(p);
      draft.pl.setAttribute("points", draft.pts.map((q) => `${q.x},${q.y}`).join(" "));
    }
    return;
  }
  if (draft.k === "arrow") {
    let q = p;
    const dx = p.x - draft.x, dy = p.y - draft.y;
    const angDeg = Math.atan2(dy, dx) * 180 / Math.PI;
    const snap45 = Math.round(angDeg / 45) * 45;
    const near = Math.abs(angDeg - snap45) < 6; // 接近 45° 倍数 ±6°
    if (e.shiftKey || near) {
      // Shift 强制锁 45°；平时智能磁吸（治手画歪）
      const snapped = snap45 * Math.PI / 180;
      const len = Math.hypot(dx, dy);
      q = { x: draft.x + Math.cos(snapped) * len, y: draft.y + Math.sin(snapped) * len };
    }
    arrowInto(draft.el, draft.x, draft.y, q.x, q.y);
    return;
  }
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
    if (d.k === "arrow") {
      // 箭头按几何判长度：单击（零长度）不产生空箭头
      const g = JSON.parse(d.el.dataset.geom || "{}");
      if (g.x1 != null && Math.hypot(g.x2 - g.x1, g.y2 - g.y1) < 6) { d.el.remove(); return; }
    } else if (w < 4 && h < 4) { d.el.remove(); return; }
  }
  pushUndo({ t: "add", el: d.el });
  mosaicPreview(d.el); // 马赛克：落定后换真实块化预览（拖动中为条纹示意）
  setObjSel(d.el); // 同款语义：画完即选中（手柄/锚点立即显示，可拖可改）
});

/* 选择工具：对象拖动/手柄缩放 */
window.addEventListener("mousemove", (e) => {
  if (!objDrag) return;
  if (objDrag.type === "objmove") {
    // 增量移动：moveObj 是相对平移，用上一帧位置算步长；bbox 钳制在选区内（不可拖出高亮区）
    const stepX = e.clientX - objDrag.lastX, stepY = e.clientY - objDrag.lastY;
    objDrag.lastX = e.clientX; objDrag.lastY = e.clientY;
    const b0 = objBBox(objDrag.el);
    let dx = stepX, dy = stepY;
    if (b0.l + dx < 0) dx = -b0.l;
    if (b0.t + dy < 0) dy = -b0.t;
    if (b0.l + dx + b0.w > sel.w) dx = sel.w - b0.w - b0.l;
    if (b0.t + dy + b0.h > sel.h) dy = sel.h - b0.h - b0.t;
    moveObj(objDrag.el, dx, dy);
    // 注意：拖动中不做重采样——频繁替换背景 dataURL 在真机 WebView2 会露渲染中间态
    // （解码跟不上→显示空白→透出清晰底图，用户曾见"拖动中变清晰"）。
    // 业业折中（同类产品 观感）：拖动中模糊快照整体跟随，mouseup 落定刷新为新位置内容。
  } else if (objDrag.type === "objrot") {
    // 旋转：锚在上方时角度为 0；接近 15° 倍数 ±5° 磁吸
    let ang = Math.atan2(e.clientY - objDrag.cy, e.clientX - objDrag.cx) * 180 / Math.PI + 90;
    const snap = Math.round(ang / 15) * 15;
    if (Math.abs(ang - snap) < 5) ang = snap;
    ang = ((Math.round(ang) % 360) + 360) % 360;
    objDrag.cur = ang;
    applyObjRot(objDrag.el, ang);
    if (editing === objDrag.el) updateTxtAnchors(); // 编辑态旋转：手柄与 ◎ 跟随
  } else if (objDrag.type === "objend") {
    // 箭头端点编辑：拖动端点改方向和长度（钳制在选区内）
    const p = clampPt(layerPt(e));
    const g = JSON.parse(objDrag.el.dataset.geom);
    if (objDrag.end === "start") { g.x1 = p.x; g.y1 = p.y; } else { g.x2 = p.x; g.y2 = p.y; }
    objDrag.el.dataset.geom = JSON.stringify(g);
    drawArrowGeom(objDrag.el, g);
    setObjSel(objDrag.el); // 端点锚与包围框跟随
  } else if (objDrag.el.dataset.k === "text" || objDrag.el.classList.contains("txtedit")) {
    // 文字框（照抄 同类产品）：任意手柄=等比缩放整块文字，字号联动；
    // 未旋转锚定对侧（角→对角/边→对边中点），已旋转绕中心；Shift+拖角=回正角度归 0
    if (e.shiftKey && objRot(objDrag.el)) applyObjRot(objDrag.el, 0);
    const o = objDrag.orig, h = objDrag.handle, rot = objRot(objDrag.el);
    let ax, ay;
    if (rot) {
      ax = o.l + o.w / 2; ay = o.t + o.h / 2; // 旋转中：绕中心
    } else {
      if (h.includes("w")) ax = o.l + o.w; else if (h.includes("e")) ax = o.l; else ax = o.l + o.w / 2;
      if (h.includes("n")) ay = o.t + o.h; else if (h.includes("s")) ay = o.t; else ay = o.t + o.h / 2;
    }
    const d0 = Math.max(8, Math.hypot(objDrag.sx - sel.x - ax, objDrag.sy - sel.y - ay));
    const s = Math.hypot(e.clientX - sel.x - ax, e.clientY - sel.y - ay) / d0;
    // 缩放结果不得越出选区：统一为 a*s+b ≤ 0，a>0 产上限、a<0 产下限
    let smin = 0.04, smax = 20;
    const cons = [
      [o.l - ax, -ax],              // l' = ax+(o.l-ax)s ≥ 0
      [o.t - ay, -ay],
      [o.l + o.w - ax, ax - sel.w], // l'+w' = ax+(o.l+o.w-ax)s ≤ sel.w
      [o.t + o.h - ay, ay - sel.h],
    ];
    for (const [a, b] of cons) {
      if (a > 1e-6) smax = Math.min(smax, -b / a);
      else if (a < -1e-6) smin = Math.max(smin, -b / a);
    }
    const sc = Math.max(smin, Math.min(smax, s));
    const size = Math.round(Math.max(8, Math.min(300, objDrag.origSize * sc)));
    let l, t;
    if (rot) { l = o.l; t = o.t; } // 绕中心：位置不动，尺寸随字号
    else {
      l = ax + (o.l - ax) * sc; t = ay + (o.t - ay) * sc;
      l = Math.max(0, Math.min(sel.w - 8, l)); t = Math.max(0, Math.min(sel.h - 8, t));
    }
    const w = Math.max(8, o.w * (size / Math.max(1, objDrag.origSize)));
    const hh = Math.max(8, o.h * (size / Math.max(1, objDrag.origSize)));
    if (!rot) { // 字号硬限(8..300)使 bbox 与 sc 解耦，仍须钳在选区内
      if (l + w > sel.w) w = sel.w - l;
      if (t + hh > sel.h) hh = sel.h - t;
    }
    objDrag.cur = { l, t, w, hh, size };
    objDrag.el.style.left = l + "px"; objDrag.el.style.top = t + "px";
    if (!objDrag.el.classList.contains("txtedit")) objDrag.el.style.width = w + "px"; // 编辑框自然伸缩，不锁宽
    objDrag.el.style.fontSize = size + "px";
    if (objDrag.el.classList.contains("txtedit")) updateTxtAnchors();
    else placeObjsel({ l, t, w, h: hh });
  } else if (objDrag.el.dataset.k === "pen") {
    // 画笔缩放：以墨迹 bbox 为基准等比变换点序（线宽保持）；geom 在 mouseup 落定
    const dx = e.clientX - objDrag.sx, dy = e.clientY - objDrag.sy;
    const o = objDrag.orig, hd = objDrag.handle;
    let nl = o.l, nt = o.t, nw = o.w, nh = o.h;
    if (hd.includes("w")) { nl = o.l + dx; nw = Math.max(12, o.w - dx); }
    if (hd.includes("e")) { nw = Math.max(12, o.w + dx); }
    if (hd.includes("n")) { nt = o.t + dy; nh = Math.max(12, o.h - dy); }
    if (hd.includes("s")) { nh = Math.max(12, o.h + dy); }
    const skx = nw / Math.max(1, o.w), sky = nh / Math.max(1, o.h);
    objDrag.cur = { l: nl, t: nt, w: nw, hh: nh, sx: skx, sy: sky };
    try {
      const g0 = JSON.parse(objDrag.el.dataset.geom);
      objDrag.el.querySelector("polyline").setAttribute("points",
        g0.pts.map((q) => (nl + (q.x - o.l) * skx) + "," + (nt + (q.y - o.t) * sky)).join(" "));
    } catch (err) {}
    placeObjsel({ l: nl, t: nt, w: nw, h: nh });
  } else {
    // 手柄缩放（rect/ellipse/marker/mosaic）
    const dx = e.clientX - objDrag.sx, dy = e.clientY - objDrag.sy;
    const o = objDrag.orig, h = objDrag.handle;
    let { l, t, w, hh } = { l: o.l, t: o.t, w: o.w, hh: o.h };
    if (h.includes("w")) { l = o.l + dx; w = Math.max(6, o.w - dx); }
    if (h.includes("e")) { w = Math.max(6, o.w + dx); }
    if (h.includes("n")) { t = o.t + dy; hh = Math.max(6, o.h - dy); }
    if (h.includes("s")) { hh = Math.max(6, o.h + dy); }
    // 缩放不越出选区
    if (l < 0) { w += l; l = 0; }
    if (t < 0) { hh += t; t = 0; }
    if (l + w > sel.w) w = sel.w - l;
    if (t + hh > sel.h) hh = sel.h - t;
    objDrag.cur = { l, t, w, hh };
    objDrag.el.style.left = l + "px"; objDrag.el.style.top = t + "px";
    objDrag.el.style.width = w + "px"; objDrag.el.style.height = hh + "px";
    placeObjsel({ l, t, w, h: hh });
  }
});
window.addEventListener("mouseup", () => {
  if (!objDrag) return;
  const d = objDrag; objDrag = null;
  if (d.type === "objmove") {
    const b1 = d.before, b2 = objBBox(d.el);
    const dx = b2.l - b1.l, dy = b2.t - b1.t;
    if (dx || dy) pushUndo({ t: "move", el: d.el, dx, dy });
    mosaicPreview(d.el); // 马赛克/模糊=动态遮罩语义：移动后对新区域重新采样（曾漏：移动后仍是旧位置快照）
    // 任何工具下单击（无位移）已有文字 = 直接进编辑（用户心智：点字即改，无需先切文字工具）；
    // 拖动（有位移）仍是移动。分发器 mousedown 已把点击接管为 objDrag，layer 的 reEditText 分支到不了
    if (!dx && !dy && d.el.dataset.k === "text") { reEditText(d.el); return; }
    setObjSel(d.el);
  } else if (d.type === "objend") {
    const after = JSON.parse(d.el.dataset.geom);
    if (JSON.stringify(after) !== JSON.stringify(d.before)) {
      pushUndo({ t: "geom", el: d.el, before: d.before, after });
    }
    setObjSel(d.el);
  } else if (d.type === "objrot") {
    const after = objRot(d.el);
    if (after !== d.before) pushUndo({ t: "rot", el: d.el, before: d.before, after });
    setObjSel(d.el);
  } else {
    if (d.el.dataset.k === "pen") {
      // 画笔：点序按拖拽比例落定进 geom；撤销走 props 原串快照（style 尺寸是 100% 整层，不适用）
      if (d.cur) {
        const gp = JSON.parse(d.el.dataset.geom);
        gp.pts = gp.pts.map((q) => ({ x: d.cur.l + (q.x - d.orig.l) * d.cur.sx, y: d.cur.t + (q.y - d.orig.t) * d.cur.sy }));
        d.el.dataset.geom = JSON.stringify(gp);
        d.el.querySelector("polyline").setAttribute("points", gp.pts.map((q) => q.x + "," + q.y).join(" "));
      }
      const changed = d.cur && (d.cur.w !== d.orig.w || d.cur.hh !== d.orig.hh);
      if (changed) {
        pushUndo({ t: "props", el: d.el,
          before: { geom: d.beforeGeom, params: null, style: null, points: d.beforePoints, spanStyle: null },
          after: { geom: d.el.dataset.geom, params: null, style: null, points: d.el.querySelector("polyline").getAttribute("points"), spanStyle: null } });
      }
      setObjSel(d.el);
      return;
    }
    const after = { l: parseFloat(d.el.style.left), t: parseFloat(d.el.style.top), w: parseFloat(d.el.style.width), h: parseFloat(d.el.style.height) };
    if (d.el.dataset.k === "num") {
      // 序号保持正方形：直径=缩放后较小边，字号联动
      const dd = Math.max(16, Math.min(after.w, after.h));
      const p = JSON.parse(d.el.dataset.params);
      p.d = dd;
      d.el.dataset.params = JSON.stringify(p);
      d.el.style.width = dd + "px"; d.el.style.height = dd + "px";
      const sp = d.el.querySelector("span");
      if (sp) sp.style.fontSize = Math.round(dd * 0.52) + "px";
      after.w = dd; after.h = dd;
    }
    if (d.el.dataset.k === "text" || d.el.classList.contains("txtedit")) {
      if (d.el.classList.contains("txtedit")) {
        // 编辑中缩放：清掉缩放分支可能写入的 w/h 残留（编辑框应随文字自然伸缩）
        d.el.style.width = ""; d.el.style.height = "";
        if (d.cur) {
          d.el.style.fontSize = d.cur.size + "px";
          textSize = d.cur.size;
          const tse = document.getElementById("pr-tsize");
          if (tse) {
            if (![...tse.options].some((o) => +o.value === textSize)) {
              const o = document.createElement("option"); o.value = String(textSize); o.textContent = String(textSize);
              tse.appendChild(o);
            }
            tse.value = String(textSize);
          }
          updateTxtAnchors();
        }
        return;
      }
      // 字号联动快照进撤销栈；bbox 以渲染实测为准（pre 不换行，自然宽）
      const p = JSON.parse(d.el.dataset.params);
      p.size = d.cur ? d.cur.size : p.size;
      d.el.dataset.params = JSON.stringify(p);
      // 缩放后同步工具变量与下拉框：否则再点色板等属性操作会用旧 textSize 覆盖回小字号
      textSize = p.size;
      const tsel = document.getElementById("pr-tsize");
      if (tsel) {
        if (![...tsel.options].some((o) => +o.value === p.size)) {
          const o = document.createElement("option");
          o.value = String(p.size); o.textContent = String(p.size);
          tsel.appendChild(o);
        }
        tsel.value = String(p.size);
      }
      d.el.style.width = ""; // 归还自然宽，bbox=offsetWidth
      after.w = d.el.offsetWidth; after.h = d.el.offsetHeight;
      after.size = p.size;
    }
    const ch = d.before.l !== after.l || d.before.t !== after.t || d.before.w !== after.w || d.before.h !== after.h || (after.size && after.size !== d.origSize);
    if (ch) {
      if (after.size) { d.before.size = d.origSize; }
      pushUndo({ t: "resize", el: d.el, before: d.before, after });
    }
    mosaicPreview(d.el); // 马赛克缩放后按新尺寸重生成块化预览
    setObjSel(d.el);
  }
});

function startText(p) {
  setObjSel(null); // 新建文字前断开旧选中：否则编辑中新点样式会经 syncSelProps 写回旧对象（用户报"另一个也变斜体"）
  const el = document.createElement("div");
  el.className = "txtedit"; el.contentEditable = "true"; el.spellcheck = false;
  el.dataset.k = "text"; // 编辑态即有类型：拖四角锚走字号缩放分支（否则误入形状 w/h 分支，框大字不变）
  el.style.left = p.x + "px"; el.style.top = p.y + "px";
  el.style.fontSize = textSize + "px"; el.style.color = toolColor;
  el.style.fontFamily = FONT_CSS[textFont] || "sans-serif";
  if (textBold) el.style.fontWeight = "700";
  if (textItalic) el.style.fontStyle = "italic";
  if (textUnderline) el.style.textDecoration = "underline";
  if (textShadow) el.style.textShadow = "2px 2px 3px rgba(0,0,0,0.55)";
  el.style.textAlign = textAlign;
  el.style.lineHeight = textLineHeight;
  if (textBackground) el.style.background = textBgColor;
  if (textStroke) el.style.webkitTextStroke = "1.5px " + strokeContrast(toolColor);
  layer.appendChild(el); editing = el;
  requestAnimationFrame(() => el.focus()); // 下一帧再聚焦，避免与其他焦点操作竞态
  el.addEventListener("input", updateTxtAnchors); // 输入即跟随：四角手柄与 ◎ 贴住文字框
  updateTxtAnchors();
  el.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); finishText(el); }
    else if (ev.key === "Escape") { ev.preventDefault(); finishText(el); } // 编辑中 Esc=退出编辑保留内容（业界标准）
  });
  el.addEventListener("focusout", (ev) => {
    // 失焦分流：焦点去工具栏/面板/锚点 = 属性操作，保编辑态并存光标；其余（点画布等）才确认文字
    const to = ev.relatedTarget;
    if (to && to.closest && (to.closest("#toolbar") || to.closest("#pr-text-menu") || to.closest("#pr-color-menu") || to.closest(".t-anc") || to.closest("#rotanc") || to.closest("#objsel"))) {
      const s0 = window.getSelection();
      if (s0 && s0.rangeCount && el.contains(s0.anchorNode)) savedRange = s0.getRangeAt(0).cloneRange();
      return;
    }
    finishText(el);
  });
}
function finishText(el) {
  if (editing === el) { editing = null; hideTxtAnchors(); } // 必须清编辑态，否则后续所有画图点击被拦截
  if (!document.body.contains(el) || el.contentEditable !== "true") return;
  const txt = el.textContent.trim();
  if (!txt) {
    el.remove();
    if (selectedObj === el) setObjSel(null);
    return;
  }
  el.contentEditable = "false"; el.classList.remove("txtedit"); el.classList.add("obj");
  el.dataset.k = "text"; // 序列化分支依赖 dataset.k
  const reedit = el.dataset.reedit === "1";
  delete el.dataset.reedit;
  savedRange = null;
  el.dataset.text = txt;
  if (reedit) {
    setObjSel(el);
    // 二次编辑落定：内容/样式与编辑前不同则入撤销栈（反复修改场景：Ctrl+Z 可回改前）
    if (editBeforeSnap) {
      const after = { text: el.textContent, geom: null, params: el.dataset.params || null, style: el.getAttribute("style") || "", points: null, spanStyle: null };
      const b = editBeforeSnap;
      if (b.text !== after.text || b.params !== after.params || b.style !== after.style) {
        pushUndo({ t: "props", el, before: b, after });
      }
      editBeforeSnap = null;
    }
  } else {
    // 排版快照（所见即所得：序列化必须与预览一致）
    el.dataset.params = JSON.stringify({
      family: textFont, size: parseInt(el.style.fontSize, 10) || 20, color: cssColorToHex(el.style.color) || toolColor,
      bold: textBold, italic: textItalic, underline: textUnderline, shadow: textShadow, stroke: textStroke, align: el.style.textAlign || "left",
      line_height: textLineHeight, background: textBackground ? textBgColor : null,
      bg_opacity: textBackground ? textBgOpacity : null, bg_radius: textBackground ? textBgRadius : null,
    });
    pushUndo({ t: "add", el });
    setObjSel(el); // 文字确认后保持选中（可拖动/改属性）
  }
}

// 双击文字标注：重新进入编辑（保存前随时可改，业界标配）
// 对象属性 → 工具变量（选中/进编辑时回填：属性栏显示对象当前值，改哪项只动哪项）
function loadTextPropsFrom(el) {
  try {
    const p = JSON.parse(el.dataset.params || "{}");
    if (p.size) textSize = p.size;
    if (p.family) textFont = p.family;
    textBold = !!p.bold; textItalic = !!p.italic; textUnderline = !!p.underline;
    textShadow = !!p.shadow; textStroke = !!p.stroke;
    if (p.align) textAlign = p.align;
    if (p.line_height) textLineHeight = p.line_height;
    if (p.background) { textBackground = true; textBgColor = p.background; } else textBackground = false;
    textBgOpacity = p.bg_opacity != null ? p.bg_opacity : 1.0;
    textBgRadius = p.bg_radius != null ? p.bg_radius : 4;
    if (p.color) { toolColor = p.color; if (toolColors.text !== undefined) toolColors.text = p.color; }
    colorKey = "text";
  } catch (err) {}
  refreshTextToolbar();
}
// 工具变量 → 属性控件 UI（回填后单点修改不重置其他项）
function refreshTextToolbar() {
  const tsel = document.getElementById("pr-tsize");
  if (tsel) {
    if (![...tsel.options].some((o) => +o.value === textSize)) {
      const o = document.createElement("option"); o.value = String(textSize); o.textContent = String(textSize);
      tsel.appendChild(o);
    }
    tsel.value = String(textSize);
  }
  const fsel = document.getElementById("pr-font");
  if (fsel) fsel.value = textFont;
  document.querySelector('#pr-tstyle button[data-t="bold"]').classList.toggle("on", textBold);
  document.querySelector('#pr-tstyle button[data-t="italic"]').classList.toggle("on", textItalic);
  document.querySelector('#pr-tstyle button[data-t="underline"]').classList.toggle("on", textUnderline);
  document.querySelector('#pr-tstyle button[data-t="shadow"]').classList.toggle("on", textShadow);
  document.querySelectorAll("#pr-talign button").forEach((x) => x.classList.toggle("on", x.dataset.a === textAlign));
  document.querySelectorAll("#pr-tlh button").forEach((x) => x.classList.toggle("on", Number(x.dataset.lh) === textLineHeight));
  const pc = document.getElementById("pr-chip");
  if (pc) pc.style.background = toolColor;
}
function reEditText(el) {
  // 入口不变量：任何残留的编辑态先收掉（反复来回修改场景，编辑目标可任意切换）
  if (editing === el) return; // 已在编辑本对象：无操作
  if (editing) finishText(editing);
  if (el.dataset.k !== "text") return;
  objDrag = null; // 双击后不残留拖拽，避免编辑中移动
  setObjSel(null); setHover(null);
  loadTextPropsFrom(el); // 回填：编辑中属性操作基于对象当前值，不重置其他项
  editing = el;
  el.classList.add("txtedit");
  el.contentEditable = "true";
  el.spellcheck = false;
  el.dataset.reedit = "1";
  editBeforeSnap = { text: el.textContent, geom: null, params: el.dataset.params || null, style: el.getAttribute("style") || "", points: null, spanStyle: null };
  if (!el.dataset.kbBound) {
    el.dataset.kbBound = "1";
    el.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); finishText(el); }
      else if (ev.key === "Escape") { ev.preventDefault(); finishText(el); }
    });
  }
  el.addEventListener("input", updateTxtAnchors);
  updateTxtAnchors(); // 编辑态手柄即刻出现
  requestAnimationFrame(() => {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // 光标到末尾
    const s0 = window.getSelection();
    s0.removeAllRanges(); s0.addRange(range);
  });
}

/* 对象悬浮预览：无工具时悬停标注 = 虚线轮廓 + 可点选（保存前随时可编辑） */
let hoverEl = null;
function setHover(el) {
  if (hoverEl === el) return;
  if (hoverEl && hoverEl.classList) hoverEl.classList.remove("obj-hover");
  hoverEl = el;
  if (el && el !== selectedObj) el.classList.add("obj-hover");
}
window.addEventListener("mousemove", (e) => {
  if (draft || objDrag || editing || ann) { setHover(null); return; }
  if (tool === "eraser") return; // 橡皮擦有自己的删除高亮
  if (state !== "selected" && state !== "drawing") return;
  const r = layerPt(e);
  const hov = pickObj(r.x, r.y);
  setHover(hov);
  // 选择模式（layer 不接收指针事件）下同样给可编辑暗示：文字=文本光标、其他=移动光标
  if (!tool) stage.style.cursor = hov ? (hov.dataset.k === "text" ? "text" : "move") : "default";
});
window.addEventListener("dblclick", (e) => {
  // 双击文字进编辑：不再要求 !tool（画完文字 tool 仍为 text）也不看 objDrag
  //（单击选中的拖拽在 mouseup 已清；此处 reEditText 内部再清一次兜底）
  if (editing || ann || draft) return;
  // 任何工具状态下双击文字=进编辑（业界直接操纵惯例；画图起始已被分发器 obj 命中接管，
  // 双击不会误画图形；橡皮擦下第一击已删除对象，此处 pickObj 不中自然无事）
  if (state !== "selected" && state !== "drawing") return;
  const r = layerPt(e);
  const hit = pickObj(r.x, r.y);
  if (hit && hit.dataset.k === "text") {
    e.preventDefault();
    reEditText(hit);
  }
});

const UNDO_MAX = 20; // 同款语义：撤销/重做栈 20 步
function pushUndo(u) {
  objStack.undo.push(u);
  if (objStack.undo.length > UNDO_MAX) objStack.undo.shift();
  objStack.redo = [];
  updateStatusbar();
}
function undoOp() {
  flushPropsUndo();
  const u = objStack.undo.pop(); if (!u) return;
  if (u.t === "props") { applyPropsSnap(u.el, u.before); if (u.el.isConnected) { setObjSel(u.el); placeObjsel(objBBox(u.el)); } objStack.redo.push(u); updateStatusbar(); return; }
  if (u.t === "add") u.el.remove();
  else if (u.t === "del") layer.appendChild(u.el); // 橡皮擦撤销：对象放回
  else if (u.t === "move") moveObj(u.el, -u.dx, -u.dy);
  else if (u.t === "resize") applyObjGeom(u.el, u.before);
  else if (u.t === "geom") applyArrowGeom(u.el, u.before);
  else if (u.t === "rot") applyObjRot(u.el, u.before);
  objStack.redo.push(u);
  updateStatusbar();
}
function redoOp() {
  flushPropsUndo();
  const u = objStack.redo.pop(); if (!u) return;
  if (u.t === "props") { applyPropsSnap(u.el, u.after); if (u.el.isConnected) { setObjSel(u.el); placeObjsel(objBBox(u.el)); } objStack.undo.push(u); updateStatusbar(); return; }
  if (u.t === "add") layer.appendChild(u.el);
  else if (u.t === "del") u.el.remove(); // 橡皮擦重做：再删一次
  else if (u.t === "move") moveObj(u.el, u.dx, u.dy);
  else if (u.t === "resize") applyObjGeom(u.el, u.after);
  else if (u.t === "geom") applyArrowGeom(u.el, u.after);
  else if (u.t === "rot") applyObjRot(u.el, u.after);
  objStack.undo.push(u);
  updateStatusbar();
}
// 箭头几何快照应用（端点编辑撤销/重做）
function applyArrowGeom(el, snap) {
  el.dataset.geom = JSON.stringify(snap);
  drawArrowGeom(el, snap);
  if (selectedObj === el) setObjSel(el);
}

/* ================= 选择工具（业界同款对象编辑） ================= */
const objselEl = document.getElementById("objsel");
let objDrag = null; // {type:"objmove"|"objresize", el, handle, sx, sy, orig, before}
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function objBBox(el) {
  if (el.dataset.k === "pen") {
    try {
      const pts = JSON.parse(el.dataset.geom).pts;
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const q of pts) { x1 = Math.min(x1, q.x); y1 = Math.min(y1, q.y); x2 = Math.max(x2, q.x); y2 = Math.max(y2, q.y); }
      return { l: x1, t: y1, w: x2 - x1, h: y2 - y1 };
    } catch (err) {}
  }
  const l = parseFloat(el.style.left) || 0, t = parseFloat(el.style.top) || 0;
  const w = el.offsetWidth || parseFloat(el.style.width) || 0;
  const h = el.offsetHeight || parseFloat(el.style.height) || 0;
  return { l, t, w, h };
}
let propsUndo = null;
let editBeforeSnap = null; // 二次编辑前的内容/样式快照（落定时 diff 入撤销栈）
function p_int(v) { const n = parseInt(v, 10); return isNaN(n) ? 14 : n; }
function snapProps(el) {
  const sp = el.querySelector("span");
  const pl = el.dataset.k === "pen" ? el.querySelector("polyline") : null;
  return {
    geom: el.dataset.geom || null, params: el.dataset.params || null,
    style: el.getAttribute("style") || "",
    points: pl ? pl.getAttribute("points") : null,
    spanStyle: el.dataset.k === "num" && sp ? sp.getAttribute("style") : null,
    text: el.dataset.k === "text" ? el.textContent : null,
  };
}
function applyPropsSnap(el, sn) {
  if (!el || !el.isConnected) return; // 对象已被后续删除：跳过
  if (sn.geom !== null && sn.geom !== undefined) el.dataset.geom = sn.geom;
  if (sn.params !== null && sn.params !== undefined) el.dataset.params = sn.params;
  if (sn.style !== null && sn.style !== undefined) el.setAttribute("style", sn.style);
  if (sn.points) { const pl = el.querySelector("polyline"); if (pl) pl.setAttribute("points", sn.points); }
  if (sn.spanStyle) { const sp = el.querySelector("span"); if (sp) sp.setAttribute("style", sn.spanStyle); }
  if (sn.text !== null && sn.text !== undefined) { el.textContent = sn.text; el.dataset.text = sn.text; }
  const k = el.dataset.k;
  try {
    if (k === "arrow" && sn.geom) drawArrowGeom(el, JSON.parse(sn.geom));
    else if (k === "mosaic" && sn.params) { const pp = JSON.parse(sn.params); applyShapeStyle(el, k, pp); mosaicPreview(el); }
    else if ((k === "rect" || k === "ellipse" || k === "marker") && sn.params) applyShapeStyle(el, k, JSON.parse(sn.params));
  } catch (err) {}
}
function flushPropsUndo() {
  if (propsUndo && propsUndo.after) {
    const b = propsUndo.before, a = propsUndo.after;
    if (b.geom !== a.geom || b.params !== a.params || b.style !== a.style || b.points !== a.points || b.spanStyle !== a.spanStyle || b.text !== a.text) pushUndo(propsUndo);
  }
  propsUndo = null;
}
// 命中检测：从最上层往下找（箭头/画笔按几何点到线段距离，其余按包围盒）
function pickObj(lx, ly) {
  const objs = [...layer.querySelectorAll(".obj")].reverse();
  for (const el of objs) {
    const k = el.dataset.k;
    // 旋转对象：把点击点逆变换回对象局部坐标再检测
    const rot = objRot(el);
    if (rot) {
      const b = objBBox(el);
      const cx = b.l + b.w / 2, cy = b.t + b.h / 2;
      const rad = -rot * Math.PI / 180;
      const dx = lx - cx, dy = ly - cy;
      lx = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
      ly = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
    }
    if (k === "arrow") {
      const g = JSON.parse(el.dataset.geom);
      // 容差随线宽放大（min 12px）：点击更易命中
      if (distToSeg(lx, ly, g.x1, g.y1, g.x2, g.y2) <= Math.max(12, g.lw)) return el;
    } else if (k === "pen") {
      const g = JSON.parse(el.dataset.geom);
      for (let i = 1; i < g.pts.length; i++) {
        if (distToSeg(lx, ly, g.pts[i - 1].x, g.pts[i - 1].y, g.pts[i].x, g.pts[i].y) <= Math.max(10, g.lw)) return el;
      }
    } else if (k === "text") {
      const b = objBBox(el);
      if (lx >= b.l - 4 && lx <= b.l + b.w + 4 && ly >= b.t - 4 && ly <= b.t + b.h + 4) return el;
    } else {
      const b = objBBox(el);
      if (lx >= b.l && lx <= b.l + b.w && ly >= b.t && ly <= b.t + b.h) return el;
    }
  }
  return null;
}
function setObjSel(el) {
  // 属性撤销链封存：切到别的对象/清空选中时（同对象继续累积，拖滑杆连发合并为一条）
  if (propsUndo && propsUndo.el !== el) flushPropsUndo();
  // 旧选中清辉光
  if (selectedObj && selectedObj.classList) selectedObj.classList.remove("obj-sel-glow");
  selectedObj = el;
  // 选中对象时隐藏选区自己的手柄（同类产品：只显示一层锚点）
  document.body.classList.toggle("obj-selected", !!el);
  // 清掉同对象的悬浮轮廓（否则选中后轮廓残留成多余虚线框）
  if (el && hoverEl === el) setHover(null);
  if (!el) { objselEl.style.display = "none"; clearArrowAnchors(); clearRotAnchor(); syncPanelFor(null); return; }
  const k = el.dataset.k;
  if (k === "text") loadTextPropsFrom(el); // 选中即回填：属性栏显示对象值，单点修改不重置其他项
  else if (k === "arrow" || k === "pen" || k === "rect" || k === "ellipse" || k === "marker") {
    // 形状类回填色/线宽：同文字语义（改哪项只动哪项）
    try {
      const src = k === "arrow" || k === "pen" ? JSON.parse(el.dataset.geom) : JSON.parse(el.dataset.params);
      if (src.color) { toolColor = src.color; if (toolColors[k] !== undefined) toolColors[k] = src.color; }
      colorKey = k;
      if (src.lw) { toolW = src.lw; const wr0 = document.getElementById("pr-width-range"); if (wr0) { wr0.value = String(toolW); document.getElementById("pr-width-val").textContent = String(toolW); } }
      // 矩形/椭圆补全回填：不回填的话，改一项属性会把全局旧值连坐写进对象
      if (k === "rect" || k === "ellipse") {
        if (src.fill) fillMode = src.fill;
        shapeDash = !!src.dash; shapeRadius = !!src.radius;
        if (src.opacity != null) shapeOpacity = src.opacity;
        const df = document.getElementById("ddl-fill"); if (df && df._ddlUpd) df._ddlUpd();
        const dl2 = document.getElementById("ddl-line"); if (dl2 && dl2._ddlUpd) dl2._ddlUpd();
        document.querySelectorAll("#pr-round button").forEach((b) => b.classList.toggle("on", !!shapeRadius === (b.dataset.r === "1")));
        const ov = Math.round(shapeOpacity * 100);
        const or0 = document.getElementById("pr-opacity-range"); if (or0) or0.value = String(ov);
        const ov0 = document.getElementById("pr-opacity-val"); if (ov0) ov0.textContent = String(ov);
      }
      const pc0 = document.getElementById("pr-chip"); if (pc0) pc0.style.background = toolColor;
    } catch (err) {}
  } else if (k === "mosaic") {
    // 马赛克/模糊：强度与模式回填面板（选中旧遮罩后滑杆显示对象值）
    try { const mp = JSON.parse(el.dataset.params); if (mp.mos) mosStrength = p_int(mp.mos); if (mp.mode) mosMode = mp.mode; } catch (err) {}
    const mr1 = document.getElementById("pr-mos-range"); if (mr1) mr1.value = String(mosStrength);
    const mv1 = document.getElementById("pr-mos-val"); if (mv1) mv1.textContent = mosStrength;
    document.querySelectorAll("#pr-mos-mode button").forEach((b) => b.classList.toggle("on", b.dataset.mm === mosMode));
  } else if (k === "num") {
    // 序号：颜色/样式回填
    try { const np = JSON.parse(el.dataset.params); if (np.color) { toolColor = np.color; if (toolColors.num !== undefined) toolColors.num = np.color; } if (np.style) numStyle = np.style; } catch (err) {}
    colorKey = "num";
    const pc1 = document.getElementById("pr-chip"); if (pc1) pc1.style.background = toolColor;
    document.querySelectorAll("#pr-num-style button").forEach((b) => b.classList.toggle("on", b.dataset.ns === numStyle));
  }
  const resizable = ["rect", "ellipse", "marker", "mosaic", "num", "text", "pen"].includes(k);
  objselEl.classList.toggle("resizable", resizable);
  // 箭头：端点锚直接钉在两端视口坐标 + 本体辉光（归属一目了然）
  const isArrow = k === "arrow";
  objselEl.classList.toggle("arrow-mode", isArrow);
  if (isArrow) {
    el.classList.add("obj-sel-glow");
    placeArrowAnchors(el);
    clearRotAnchor();
  } else if (["rect", "ellipse", "marker", "text", "pen"].includes(k)) {
    clearArrowAnchors();
    placeRotAnchor(el);
  } else {
    clearArrowAnchors();
    clearRotAnchor(); // mosaic/num：引擎暂不支持旋转，不提供锚（保证所见即所得）
  }
  syncPanelFor(el); // 上下文感知面板：属性区切换为该对象类型的可编辑项
  const b = objBBox(el);
  placeObjsel(b);
  // 选中框随对象旋转（同类产品：手柄框跟着转，锚点钉在框角）
  const rot0 = objRot(el);
  objselEl.style.transform = rot0 ? `rotate(${rot0}deg)` : "";
  objselEl.style.display = "block";
}
// 旋转锚 ◎：框顶边中点上方，随对象旋转绕中心转动（同类产品 同款随动）
const rotancEl = document.getElementById("rotanc");
function placeRotAnchor(el) {
  const b = objBBox(el);
  const rot = objRot(el);
  const d = b.h / 2 + 34; // 未旋转时在框上方 34px
  const rad = rot * Math.PI / 180;
  const ox = d * Math.sin(rad), oy = -d * Math.cos(rad); // 顺时针旋转后的随动偏移
  const cx = sel.x + b.l + b.w / 2, cy = sel.y + b.t + b.h / 2;
  rotancEl.style.left = (cx + ox - 8) + "px";
  rotancEl.style.top = (cy + oy - 8) + "px";
  rotancEl.style.display = "block";
}
function clearRotAnchor() { rotancEl.style.display = "none"; }


// ================= 文字编辑态：四角拉伸手柄 + 属性实时生效（同类产品 同款） =================
// 点击开始输入文字的那一刻，四角手柄与 ◎ 旋转锚即刻出现；拖角等比缩放字号
const tancEls = {};
["nw", "ne", "sw", "se"].forEach((h) => {
  const a = document.createElement("div");
  a.className = "t-anc t-anc-" + h; a.dataset.h = h;
  document.body.appendChild(a);
  tancEls[h] = a;
});
function updateTxtAnchors() {
  if (!editing || !editing.isConnected) { hideTxtAnchors(); return; }
  const b = objBBox(editing);
  // 锚点外扩 12px（与背景块留 6px 间隙，不骑在标注色块上）
  const L = sel.x + b.l - 12, T = sel.y + b.t - 12, W = b.w + 24, H = b.h + 24;
  const pos = { nw: [L - 6, T - 6], ne: [L + W - 6, T - 6], sw: [L - 6, T + H - 6], se: [L + W - 6, T + H - 6] };
  for (const h in pos) {
    tancEls[h].style.left = pos[h][0] + "px"; tancEls[h].style.top = pos[h][1] + "px";
    tancEls[h].style.display = "block";
  }
  placeRotAnchor(editing);
}
function hideTxtAnchors() {
  for (const h in tancEls) tancEls[h].style.display = "none";
}
// 描边对比色：字色亮 → 黑描边；字色暗 → 白描边
function strokeContrast(color) {
  const hex = cssColorToHex(color);
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#000000";
  const n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r * 0.299 + g * 0.587 + b * 0.114) > 140 ? "#000000" : "#FFFFFF";
}
// 背景样式（GUI 预览）：rgba + 圆角
function bgCss() {
  if (!textBackground) return "";
  const hex = cssColorToHex(textBgColor) || "#FFF7D6";
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `${r},${g},${b}`;
}
// 编辑中改属性：实时应用到编辑框（保存前的文字与已放置文字走 syncSelProps）
let savedRange = null; // 面板操作夺焦时保存的光标位置（操作后恢复原地继续输入）
function refocusEdit() {
  if (!editing || !editing.isConnected) return;
  requestAnimationFrame(() => {
    if (!editing) return;
    editing.focus();
    const s0 = window.getSelection();
    s0.removeAllRanges();
    if (savedRange) s0.addRange(savedRange);
    else { const r = document.createRange(); r.selectNodeContents(editing); r.collapse(false); s0.addRange(r); }
    savedRange = null;
  });
}
function syncEditProps() {
  if (!editing || !editing.isConnected) return;
  editing.style.color = toolColor;
  editing.style.fontSize = textSize + "px";
  editing.style.fontFamily = FONT_CSS[textFont] || "sans-serif";
  editing.style.fontWeight = textBold ? "700" : "";
  editing.style.fontStyle = textItalic ? "italic" : "";
  editing.style.textDecoration = textUnderline ? "underline" : "";
  editing.style.textShadow = textShadow ? "2px 2px 3px rgba(0,0,0,0.55)" : "";
  editing.style.textAlign = textAlign;
  editing.style.lineHeight = textLineHeight;
  editing.style.background = textBackground ? `rgba(${bgCss()},${textBgOpacity})` : "";
  editing.style.borderRadius = textBackground ? textBgRadius + "px" : "";
  editing.style.webkitTextStroke = textStroke ? "1.5px " + strokeContrast(toolColor) : "";
  updateTxtAnchors();
}
function syncTextProps() { syncSelProps(); syncEditProps(); refocusEdit(); bgRefresh(); } // scheduleSave 由 syncSelProps 统一触发

// 刷新文字背景直达块（#pr-tbgchip）：有背景显色，无背景显斜纹
function bgRefresh() {
  const b = document.getElementById("pr-tbgchip");
  if (!b) return;
  b.classList.toggle("none", !textBackground);
  b.style.background = textBackground ? textBgColor : "";
}
// 应用旋转：CSS 预览 + dataset 持久（序列化 rotation 透传引擎）
function applyObjRot(el, deg) {
  el.dataset.rotation = String(deg);
  el.style.transform = deg ? `rotate(${deg}deg)` : "";
  if (selectedObj === el) { setObjSel(el); }
}
function objRot(el) { return Number(el.dataset.rotation || 0); }
// 箭头端点锚：视口坐标直接定位（不依赖 bbox 容器，无归属歧义）
function placeArrowAnchors(el) {
  const g = JSON.parse(el.dataset.geom);
  const s = document.getElementById("eanc-s"), e2 = document.getElementById("eanc-e");
  s.style.left = (sel.x + g.x1 - 5) + "px"; s.style.top = (sel.y + g.y1 - 5) + "px";
  e2.style.left = (sel.x + g.x2 - 5) + "px"; e2.style.top = (sel.y + g.y2 - 5) + "px";
  s.style.display = "block"; e2.style.display = "block";
}
function clearArrowAnchors() {
  document.getElementById("eanc-s").style.display = "none";
  document.getElementById("eanc-e").style.display = "none";
}
// bbox 是 layer 局部坐标，选中框挂在 body 上 → 加选区原点偏移
function placeObjsel(b) {
  // 文字框选中框外扩 12px：手柄与背景块留间隙，不骑在标注色块上（同类产品 同款）
  const pad = selectedObj && selectedObj.dataset.k === "text" ? 12 : 0;
  objselEl.style.left = (sel.x + b.l - pad) + "px"; objselEl.style.top = (sel.y + b.t - pad) + "px";
  objselEl.style.width = (b.w + pad * 2) + "px"; objselEl.style.height = (b.h + pad * 2) + "px";
}
// 平移对象：bbox 类改 left/top；箭头/画笔同步平移几何点并重绘
function moveObj(el, dx, dy) {
  el.style.left = (parseFloat(el.style.left) || 0) + dx + "px";
  el.style.top = (parseFloat(el.style.top) || 0) + dy + "px";
  if (el.dataset.k === "arrow") {
    const g = JSON.parse(el.dataset.geom);
    g.x1 += dx; g.y1 += dy; g.x2 += dx; g.y2 += dy;
    el.dataset.geom = JSON.stringify(g);
    drawArrowGeom(el, g);
  } else if (el.dataset.k === "pen") {
    const g = JSON.parse(el.dataset.geom);
    g.pts = g.pts.map((q) => ({ x: q.x + dx, y: q.y + dy }));
    el.dataset.geom = JSON.stringify(g);
    el.querySelector("polyline").setAttribute("points", g.pts.map((q) => `${q.x},${q.y}`).join(" "));
  } else if (el.dataset.k === "mosaic") {
    // 模糊瓦片按冻结图整层铺底：平移后背景跟着反向偏移，预览才与引擎一致
    const p = JSON.parse(el.dataset.params || "{}");
    if (p.mode === "blur") el.style.backgroundPosition = `-${el.style.left} -${el.style.top}`;
  }
  if (selectedObj === el) setObjSel(el);
}
// 几何快照应用（resize 撤销/重做）
function applyObjGeom(el, snap) {
  el.style.left = snap.l + "px"; el.style.top = snap.t + "px";
  if (snap.w != null) el.style.width = snap.w + "px";
  if (snap.h != null) el.style.height = snap.h + "px";
  if (snap.size != null) {
    // 文字缩放撤销：字号与参数快照同步回滚
    el.style.fontSize = snap.size + "px";
    el.style.width = "";
    try {
      const p = JSON.parse(el.dataset.params || "{}");
      p.size = snap.size;
      el.dataset.params = JSON.stringify(p);
    } catch (err) {}
  }
  if (selectedObj === el) setObjSel(el);
}
// 按几何数据重绘箭头（参数化，不依赖全局工具属性）
function drawArrowGeom(el, g) {
  const x1 = g.x1, y1 = g.y1, x2 = g.x2, y2 = g.y2;
  const l = Math.min(x1, x2) - 24, t = Math.min(y1, y2) - 24;
  const w = Math.max(Math.abs(x2 - x1), 1) + 48, h = Math.max(Math.abs(y2 - y1), 1) + 48;
  el.style.left = l + "px"; el.style.top = t + "px"; el.style.width = w + "px"; el.style.height = h + "px";
  const svg = el.querySelector("svg");
  svg.setAttribute("width", w); svg.setAttribute("height", h); svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const ax = x1 - l, ay = y1 - t, bx = x2 - l, by = y2 - t;
  const heads0 = g.heads || "end";
  const headEnd0 = heads0 !== "none" && heads0 !== "start";
  const headStart0 = heads0 === "both" || heads0 === "start";
  const s0 = Math.min(60, Math.max(18, g.lw * 4.2)); // 与尖等长：线体缩进尖底，圆头端点不再磨圆尖角
  const ux0 = (bx - ax), uy0 = (by - ay);
  const len0 = Math.hypot(ux0, uy0) || 1;
  const line = el.querySelector("line");
  line.setAttribute("x1", ax + (ux0 / len0) * (headStart0 ? s0 : 0));
  line.setAttribute("y1", ay + (uy0 / len0) * (headStart0 ? s0 : 0));
  line.setAttribute("x2", bx - (ux0 / len0) * (headEnd0 ? s0 : 0));
  line.setAttribute("y2", by - (uy0 / len0) * (headEnd0 ? s0 : 0));
  line.setAttribute("stroke", g.color); line.setAttribute("stroke-width", g.lw);
  line.removeAttribute("stroke-dasharray");
  if (g.ls === "dashed") line.setAttribute("stroke-dasharray", `${g.lw * 3} ${g.lw * 2.2}`);
  if (g.ls === "dotted") line.setAttribute("stroke-dasharray", `${g.lw * 0.5} ${g.lw * 1.8}`);
  const heads = g.heads || "end";
  // 业界同款饱满箭头尖：长约 4.2 倍线宽（18–60px），半角 0.5rad（约 57° 全张角）
  const ang = Math.atan2(by - ay, bx - ax), s = Math.min(60, Math.max(18, g.lw * 4.2));
  const p = (a) => `${bx - Math.cos(ang + a) * s} ${by - Math.sin(ang + a) * s}`;
  let d = "";
  if (heads !== "none" && heads !== "start") d += `M${bx} ${by} L${p(0.35)} L${p(-0.35)} Z`;
  if (heads === "both" || heads === "start") {
    // 起点箭头：尖端在起点，翼展伸向线体内侧（整体指向起点外侧）——与引擎 draw_arrow 的
    // head_start 画法一致（引擎尖端 x0/y0、翼展 x0+u*head）。此前翼展画在起点外侧，
    // 三角形朝线体内指，预览方向与出图相反
    const q = (a) => `${ax + Math.cos(ang + a) * s} ${ay + Math.sin(ang + a) * s}`;
    d += ` M${ax} ${ay} L${q(0.35)} L${q(-0.35)} Z`;
  }
  el.querySelector("path").setAttribute("d", d);
  el.querySelector("path").setAttribute("fill", g.color);
}
// 把当前全局工具属性写回选中对象并重绘（属性写回）
function syncSelProps() {
  scheduleSave(); // 即改即存：无选中时改工具属性同样要记住
  // 属性作用目标：正在编辑的优先（编辑态点样式=改编辑框），否则选中对象。
  // 曾只用 selectedObj：双击编辑 B 时 selectedObj 仍是 A → 点斜体改了 A（用户报"另一个也变斜体"）
  if ((!selectedObj || !selectedObj.isConnected)) {
    // 无选中但编辑中（reEditText 会先 setObjSel(null)）：属性作用于编辑框。
    // 曾直接 return——编辑 B 时点斜体落到旧 selectedObj 或丢失（用户报"另一个也变斜体"）
    if (editing && editing.isConnected && editing.dataset.k === "text") syncEditProps();
    return;
  }
  const el = selectedObj, k = el.dataset.k;
  if (!propsUndo || propsUndo.el !== el) propsUndo = { t: "props", el, before: snapProps(el), after: null };
  if (k === "arrow") {
    const g = JSON.parse(el.dataset.geom);
    g.color = toolColor; g.lw = toolW; g.heads = arrowHeads; g.ls = arrowLineStyle;
    el.dataset.geom = JSON.stringify(g);
    drawArrowGeom(el, g);
  } else if (k === "pen") {
    const g = JSON.parse(el.dataset.geom);
    g.color = toolColor; g.lw = toolW;
    el.dataset.geom = JSON.stringify(g);
    const pl = el.querySelector("polyline");
    pl.setAttribute("stroke", g.color); pl.setAttribute("stroke-width", g.lw);
  } else if (k === "rect" || k === "ellipse" || k === "marker" || k === "mosaic") {
    const p = JSON.parse(el.dataset.params);
    if (k === "rect" || k === "ellipse") { p.color = toolColor; p.lw = toolW; p.fill = fillMode; p.dash = shapeDash; p.radius = shapeRadius ? 12 : 0; p.opacity = shapeOpacity; }
    if (k === "marker") p.color = toolColor;
    if (k === "mosaic") { p.mos = mosStrength; p.mode = mosMode; } // 模式也跟随（曾漏：改马赛克/模糊不作用于选中对象）
    el.dataset.params = JSON.stringify(p);
    applyShapeStyle(el, k, p);
    if (k === "mosaic") mosaicPreview(el); // 改强度/模式后刷新真实预览
  } else if (k === "num") {
    const p = JSON.parse(el.dataset.params);
    p.color = toolColor; p.style = numStyle;
    el.dataset.params = JSON.stringify(p);
    const sp = el.querySelector("span");
    let spCss = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:" + Math.round(p.d * 0.52) + "px;font-weight:600;";
    if (p.style === "solid") spCss += `border-radius:50%;background:${p.color};color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.35)`;
    else if (p.style === "outline") spCss += `border-radius:50%;border:${Math.max(2, p.d * 0.07)}px solid ${p.color};color:${p.color};background:rgba(255,255,255,.85)`;
    else spCss += `color:${p.color};`;
    sp.style.cssText = spCss;
  } else if (k === "text") {
    const p = JSON.parse(el.dataset.params);
    Object.assign(p, {
      color: toolColor, family: textFont, size: textSize,
      bold: textBold, italic: textItalic, underline: textUnderline, shadow: textShadow, stroke: textStroke,
      align: textAlign, line_height: textLineHeight,
      background: textBackground ? textBgColor : null,
      bg_opacity: textBackground ? textBgOpacity : null, bg_radius: textBackground ? textBgRadius : null,
    });
    el.dataset.params = JSON.stringify(p);
    el.style.color = p.color;
    el.style.fontSize = p.size + "px";
    el.style.fontFamily = FONT_CSS[p.family] || "sans-serif";
    el.style.fontWeight = p.bold ? "700" : "";
    el.style.fontStyle = p.italic ? "italic" : "";
    el.style.textDecoration = p.underline ? "underline" : "";
    el.style.textShadow = p.shadow ? "2px 2px 3px rgba(0,0,0,0.55)" : "";
    el.style.textAlign = p.align;
    el.style.lineHeight = p.line_height;
    el.style.background = p.background ? `rgba(${bgCss()},${textBgOpacity})` : "";
    el.style.borderRadius = p.background ? textBgRadius + "px" : "";
    el.style.webkitTextStroke = p.stroke ? "1.5px " + strokeContrast(p.color) : "";
    el.dataset.text = el.textContent;
  }
  if (propsUndo && propsUndo.el === el) propsUndo.after = snapProps(el);
  setObjSel(el);
}
// 字体族 → CSS font-family（startText/属性写回共用）
const FONT_CSS = {
  default: "'Microsoft YaHei','微软雅黑',sans-serif",
  simsun: "SimSun,'宋体',serif",
  simhei: "SimHei,'黑体',sans-serif",
  kaiti: "KaiTi,'楷体',serif",
  segoe: "'Segoe UI',sans-serif",
};

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
      const ts = Math.max(8, Math.round((p.size || 20) * f));
      // at=文字内容起点：GUI 的 left/top 是含 0.25em padding 的边框盒，引擎背景再向外扩 pad → 两端一致
      const padC = (p.size || 20) * 0.25;
      const op = {
        type: "text", at: [P(l + padC), P(t + padC)], text: el.dataset.text || el.textContent,
        size: ts, color: cssColorToHex(p.color) || "#FF3B30",
        family: p.family || "default", bold: !!p.bold, italic: !!p.italic, underline: !!p.underline,
        shadow: !!p.shadow, align: p.align || "left", line_height: p.line_height || 1.0,
        background: p.background ? cssColorToHex(p.background) : undefined,
      };
      if (p.background) {
        if (p.bg_opacity != null && p.bg_opacity < 1) op.background_opacity = Math.round(p.bg_opacity * 100) / 100;
        if (p.bg_radius != null) op.background_radius = Math.round(p.bg_radius * f);
      }
      if (p.stroke) { // 描边进契约：宽度约字号 8%，颜色按字色对比自动
        op.stroke_color = strokeContrast(p.color);
        op.stroke_width = Math.max(1.5, Math.round(ts * 0.08 * 10) / 10);
      }
      ops.push(op);
    } else if (el.dataset.k === "mosaic") {
      const p = JSON.parse(el.dataset.params);
      ops.push({ type: "mosaic", at: [P(l), P(t)], size: [Math.max(2, P(w)), Math.max(2, P(h))], mode: p.mode === "blur" ? "blur" : "pixelate", strength: p.mos });
    } else if (el.dataset.k === "marker") {
      ops.push({ type: "highlight", at: [P(l), P(t)], size: [Math.max(2, P(w)), Math.max(2, P(h))], color: "#FFB020", opacity: 0.35 });
    }
  });
  // 旋转角度透传（ops 契约 rotation，围绕对象中心、顺时针度数）
  layer.querySelectorAll(".obj").forEach((el) => {
    const rot = objRot(el);
    if (rot && ops.length) {
      const op = ops[[...layer.querySelectorAll(".obj")].indexOf(el)];
      if (op && op.type !== "step_number") op.rotation = rot;
    }
  });
  // 兜底：任何越界坐标钳回基图内（引擎对越界整单拒绝；交互层已钳，此处保保险）
  const maxW = Math.round(sel.w * f), maxH = Math.round(sel.h * f);
  const cp = (pt) => [Math.max(0, Math.min(Math.round(pt[0]), maxW)), Math.max(0, Math.min(Math.round(pt[1]), maxH))];
  for (const op of ops) {
    if (op.from) op.from = cp(op.from);
    if (op.to) op.to = cp(op.to);
    if (op.points) op.points = op.points.map(cp);
    if (op.at) {
      op.at = cp(op.at);
      // 仅 rect/ellipse/mosaic/marker 的 size 是 [w,h] 数组；text.size 是字号数字，不可走数组钳制
      if (Array.isArray(op.size)) op.size = [Math.max(2, Math.min(op.size[0], maxW - op.at[0])), Math.max(2, Math.min(op.size[1], maxH - op.at[1]))];
    }
  }
  // 输出选项（同类产品 标志性出图效果）进契约：GUI/CLI/MCP 三端同语义
  const script = { unit: "px", operations: ops };
  if (outShadow.on || outBorder.on) {
    script.output = {};
    if (outShadow.on) script.output.shadow = { blur: outShadow.blur, color: outShadow.color };
    if (outBorder.on) script.output.border = { width: outBorder.w, color: outBorder.color };
  }
  return script;
}

async function output(action) {
  flushPropsUndo(); // 输出前封存未入栈的属性修改链
  if (state !== "selected" && state !== "drawing") return;
  const screen = 1;
  const rect = { screen, x: toPhys(sel.x), y: toPhys(sel.y), w: toPhys(sel.w), h: toPhys(sel.h) };
  const hasOps = layer.querySelectorAll(".obj").length > 0;
  const hasOutputFx = outShadow.on || outBorder.on;
  saveProps(); // SET-7 记住上次：输出时写回工具属性
  if (action === "saveas") {
    // 业界语义（同类产品 同款）：另存为只写用户选择的路径——不进默认目录、不进历史、
    // 不占剪贴板；取消对话框不算错误（saved=false 时保持覆盖层可继续编辑）
    const r = (hasOps || hasOutputFx)
      ? await invoke("freeze_annotate_saveas", { ...rect, script: serializeOps() })
      : await invoke("freeze_deliver", { ...rect, action: "saveas" });
    if (r && r.saved === false) return; // 用户取消
  } else if (hasOps || hasOutputFx) {
    // 有标注或输出特效：取底图帧（引擎渲染衍生图 -ann，原图不动），剪贴板写渲染结果
    // 注意 freeze_take_region 自身会落一张正式图（作为原图），只在需要底图时调用——
    // 无标注路径若也预取帧，会与 freeze_deliver 各落一张 → 同秒双输出（2026-09-22 用户实测报障）
    const base = await invoke("freeze_take_region", rect);
    try {
      await invoke("annotate_save", { basePath: base.path, script: serializeOps(), action });
    } catch (err) {
      showToast("标注渲染失败：" + (typeof err === "string" ? err : (err && err.message) || JSON.stringify(err)));
      return; // 渲染失败不关覆盖层，避免看起来像输出成功
    }
  } else if (action === "ocr") {
    await invoke("freeze_deliver", { ...rect, action: "ocr" });
  } else if (action === "pin") {
    // 业界同款贴图：选区图是物理像素，scale=1 → 贴图原位原大覆盖选区；
    // pad=24 逻辑像素的物理值，给四边阴影留绘制区（窗口比图像大一圈）
    const base = await invoke("freeze_take_region", rect);
    await invoke("pin_create", { path: base.path, x: rect.x, y: rect.y, scale: 1, pad: Math.round(24 * dprV) });
    // 贴图即终截图：贴图在选区原位浮出的同时覆盖层退场（同类产品 同款无缝衔接）
    await closeOverlay();
    return;
  } else {
    // copy | save：save 不占剪贴板（Rust 侧按 action 区分）
    await invoke("freeze_deliver", { ...rect, action });
  }
  if (action !== "pin") await closeOverlay();
}

async function closeOverlay() {
  // 只走 Rust：屏外驻留（visible 恒 true）。JS 再 hide() 会让窗口进入 hidden 态，
  // 下次 set_position 移回屏幕也不显示（第二次截图无反应的根因）+ WebView2 隐藏渲染挂起
  try { await invoke("overlay_close"); } catch (e) {}
}

async function startLongshot() {
  // 快照选区物理坐标（滚动采集全程要用）
  const sx = toPhys(sel.x), sy = toPhys(sel.y), sw = toPhys(sel.w), sh = toPhys(sel.h);
  // 业界同款采集模式：webview overlay 彻底退场（滚轮 hover 路由命中其 WebView2 子窗口、
  // 子窗口无法穿透=滚轮被吞的根治），选区框改由 4 条原生 Win32 细窗指示（ls_frame_show），
  // 框线在采集矩形外沿，拼接段零污染；实时画面/尺寸在 endbar 工具条上
  await invoke("overlay_hide");
  await invoke("ls_frame_show", { x: sx, y: sy, w: sw, h: sh });
  await new Promise((r) => setTimeout(r, 180)); // 等 overlay park 落地（overlay-cleared → JS 复位）
  await invoke("scroll_start", { screen: 1, x: sx, y: sy, w: sw, h: sh });
}

function cancelAll() {
  // 编辑态：Esc=先结束编辑（内容保留，不丢会话）
  if (editing) { finishText(editing); return; }
  if (ann) return; // 完整编辑器模式由 annotate.js 接管
  // 有未输出的标注：三键保护（记住选择后直通）——既有需求保留
  if (layer.querySelectorAll(".obj").length > 0) {
    if (!escConfirm.enabled) {
      if (escConfirm.action === "save") { output("copy"); return; }
      layer.innerHTML = ""; objStack = { undo: [], redo: [] };
      closeOverlay();
      return;
    }
    document.getElementById("escdlg").classList.add("open");
    return;
  }
  // 无标注：任何状态（蒙版/选中/画图/裁剪中）一次 Esc 彻底退出（业界共识：Esc=中止截图）
  closeOverlay();
}

/* ================= 裁剪 C：重新框选（标注跟随平移） ================= */
let cropSaved = null;
function startCrop() {
  if ((state !== "selected" && state !== "drawing") || cropMode) return;
  cropSaved = { ...sel };
  cropMode = true;
  setTool(null); setObjSel(null);
  // 只隐藏交互 UI，不清 ops（DOM 保留，确认后平移）
  selEl.style.display = "none";
  toolbar.style.display = "none";
  layer.style.display = "none";
  objselEl.style.display = "none";
  sizechip.style.display = "none";
  cancelhint.style.display = "";
  cancelhint.textContent = "裁剪：拖出新区域 · 单击保持原样 · Esc 取消";
  cancelhint.style.opacity = "1";
  state = "idle"; // 直接赋值：不能用 setState("idle")，会清空标注
}
function applyCrop() {
  const dx = sel.x - cropSaved.x, dy = sel.y - cropSaved.y;
  if (dx || dy) layer.querySelectorAll(".obj").forEach((el) => moveObj(el, -dx, -dy));
  cropMode = false; cropSaved = null;
  restoreHint();
  setState("selected");
}
function abortCrop() {
  cropMode = false;
  setSel(cropSaved || sel);
  cropSaved = null;
  restoreHint();
  setState("selected");
}
function restoreHint() {
  cancelhint.style.opacity = "0";
  cancelhint.textContent = "拖动框选，或单击自动识别的窗口 · Tab 切换候选";
}

/* ================= 键盘 ================= */
window.addEventListener("keydown", (e) => {
  const et = e.target;
  if (et && (et.isContentEditable || et.tagName === "INPUT" || et.tagName === "TEXTAREA")) {
    // Escape 永远放行：焦点在滑杆/输入框时 Esc 也必须一次退出截图
    //（曾直接 return——拖过强度滑杆后 Esc 被吞，需先点别处才能退，用户实测报障）
    if (e.key !== "Escape") return;
  }
  if (ann) return; // 完整编辑器模式由 annotate.js 接管
  if (document.body.classList.contains("ls-mode")) return; // 长截图采集模式：全部按键交给键盘钩子（Esc/Enter 已被钩子吞掉，其余键不得污染工具/选区状态）
  if (document.getElementById("escdlg").classList.contains("open")) {
    if (e.key === "Escape") document.getElementById("escdlg").classList.remove("open");
    return;
  }
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (k === "c") { e.preventDefault(); output("copy"); }
    else if (k === "s") { e.preventDefault(); output("saveas"); } // Ctrl+S 同保存按钮=弹对话框
    else if (k === "z" && e.shiftKey) { e.preventDefault(); redoOp(); }
    else if (k === "z") { e.preventDefault(); undoOp(); }
    return;
  }
  if (k === "escape") { cancelAll(); return; }
  if (k === "delete" || k === "backspace") {
    if (selectedObj) {
      e.preventDefault();
      pushUndo({ t: "del", el: selectedObj });
      selectedObj.remove(); setObjSel(null);
    }
    return;
  }
  if (k.startsWith("arrow")) {
    if (state !== "selected" && state !== "drawing") return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = k === "arrowleft" ? -step : k === "arrowright" ? step : 0;
    const dy = k === "arrowup" ? -step : k === "arrowdown" ? step : 0;
    if (selectedObj) {
      moveObj(selectedObj, dx, dy);
      pushUndo({ t: "move", el: selectedObj, dx, dy });
    } else {
      setSel({ ...sel, x: sel.x + dx, y: sel.y + dy });
    }
    return;
  }
  if (k === "d") { e.preventDefault(); output("pin"); return; } // 贴图（D=钉）。曾也绑 F3（同款语义），因常被驻留的 同类产品/同类产品 全局热键抢占、且会误触它们的贴图，用户裁定去除
  if (k === "l") { e.preventDefault(); startLongshot(); return; } // 长截图（L=Long）：滚动采集，业界同款
  if (k === "enter") { e.preventDefault(); if (!e.repeat && (state === "selected" || state === "drawing")) output("copy"); return; } // preventDefault：焦点在工具栏按钮时 Enter 会再触发一次 click；e.repeat：按住/键盘重复会在 ~58ms 内连发（用户实测同秒双输出）
  if (k === "tab") {
    e.preventDefault();
    if (state === "idle") { cycleCandidate(); return; }
    // 标注态：Tab 切换形状槽位（矩形 ↔ 椭圆，同款语义）
    setShapeSlot(shapeSlot === "rect" ? "ellipse" : "rect");
    setTool(shapeSlot);
    return;
  }
  const map = { a: "arrow", r: "rect", o: "ellipse", t: "text", n: "num", h: "marker", m: "mosaic", e: "eraser", p: "pen" };
  if (k === "v" && (state === "selected" || state === "drawing")) { setTool("select"); return; }
  if (k === "c" && (state === "selected" || state === "drawing")) { startCrop(); return; }
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
  // 编辑文字时点击编辑框外：先确认落定再分发。只靠 focusout 会漏——点击 layer/蒙版等
  // 非 focusable 目标时焦点不转移，editing 残留，此后单击/双击全被各处守卫拦
  //（用户报"单击过后再双击进不了编辑"，实况 editing 残留为 true）
  if (editing && !e.target.closest(".txtedit")) finishText(editing);
  // 右键菜单/三键弹窗内的点击不得触发框选分发
  if (e.target.closest("#ctxmenu") || e.target.closest("#escdlg")) return;
  if (state === "selected" || state === "drawing") {
    // 背景面板：板内点击不触发分发；点板外自动收起
    // 弹层面板（A 设置/色板）：板内点击不触发分发；点外自动收起
    for (const pid of ["pr-text-menu", "pr-color-menu"]) {
      const pm = document.getElementById(pid);
      if (!e.target.closest("#" + pid) && !e.target.closest("#pr-chip") && !e.target.closest("#pr-tbgchip") && pm.style.display === "block") pm.style.display = "none";
      if (e.target.closest("#" + pid)) return;
    }
    // 文字编辑态：四角手柄绝对优先（拖角等比缩放字号，复用 objresize 数学）
    const ta = e.target.closest(".t-anc");
    if (ta && editing) {
      const tb0 = objBBox(editing);
      objDrag = { type: "objresize", el: editing, handle: ta.dataset.h, sx: e.clientX, sy: e.clientY, orig: tb0, origSize: parseInt(editing.style.fontSize, 10) || 20, before: tb0 };
      e.preventDefault(); e.stopPropagation();
      return;
    }
    // 对象编辑绝对优先：点中对象锚点/手柄绝不触发重新框选（任何工具状态下）
    const oh = e.target.closest("#objsel .h");
    if (oh && selectedObj) {
      const cls = [...oh.classList].find((c) => ["nw","ne","sw","se","n","s","w","e"].includes(c));
      const b0 = objBBox(selectedObj);
      let sz0 = 0;
      try { sz0 = JSON.parse(selectedObj.dataset.params || "{}").size || 0; } catch (err) {}
      objDrag = { type: "objresize", el: selectedObj, handle: cls, sx: e.clientX, sy: e.clientY, orig: b0, origSize: sz0, before: b0 };
      if (selectedObj.dataset.k === "pen") {
        objDrag.beforeGeom = selectedObj.dataset.geom;
        objDrag.beforePoints = selectedObj.querySelector("polyline").getAttribute("points");
      }
      e.preventDefault(); e.stopPropagation(); // 阻断画图层双重响应（同一次点击既拖对象又画新图）
      return;
    }
    const ed = e.target.closest(".e-dot");
    if (ed && selectedObj && selectedObj.dataset.k === "arrow") {
      objDrag = { type: "objend", el: selectedObj, end: ed.classList.contains("start") ? "start" : "end", before: JSON.parse(selectedObj.dataset.geom) };
      e.preventDefault(); e.stopPropagation();
      return;
    }
    // 旋转锚 ◎：拖动绕对象中心旋转（形状类 / 文字编辑态）
    if (ed === null && e.target.closest("#rotanc") && (selectedObj || editing)) {
      const rel = selectedObj || editing;
      const b = objBBox(rel);
      const cx = sel.x + b.l + b.w / 2, cy = sel.y + b.t + b.h / 2;
      objDrag = { type: "objrot", el: rel, cx, cy, before: objRot(rel) };
      e.preventDefault(); e.stopPropagation();
      return;
    }
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
      const r = layerPt(e); // 本地坐标（0..sel.w）——四角判定必须同坐标系，勿混视口系 sel.x
      const corners = [[0, 0, "nw"], [1, 0, "ne"], [0, 1, "sw"], [1, 1, "se"]];
      for (const [fx, fy, cls] of corners) {
        const cx = sel.w * fx, cy = sel.h * fy;
        if (Math.hypot(r.x - cx, r.y - cy) <= 8) {
          draft = null;
          drag = { type: "resize", handle: cls, sx: e.clientX, sy: e.clientY, orig: { ...sel } };
          setState("dragging");
          e.preventDefault();
          return;
        }
      }
      // 同款语义：保存前标注随时可编辑——点击已有标注 = 选中并可拖动，画新图形从空白处起笔
      if (tool !== "eraser") {
        const hit = pickObj(r.x, r.y);
        if (hit) {
          setHover(null);
          setObjSel(hit);
          objDrag = { type: "objmove", el: hit, lastX: e.clientX, lastY: e.clientY, before: objBBox(hit) };
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
      // 选择模式：对象命中优先（点选已画标注 → 拖动移动）
      const r = layerPt(e);
      const hit = pickObj(r.x, r.y);
      if (hit) {
        setObjSel(hit);
        objDrag = { type: "objmove", el: hit, lastX: e.clientX, lastY: e.clientY, before: objBBox(hit) };
        e.preventDefault(); e.stopPropagation(); // 双重响应根因：不阻断会让画图层同时画新图
        return;
      }
      if (selectedObj) setObjSel(null); // 点空白：清选中
      if (inSel) {
        drag = { type: "move", sx: e.clientX, sy: e.clientY, orig: { ...sel } };
        setState("dragging");
        return;
      }
    }
  }
  // 其余区域：重新框选（实时橡皮筋）。空闲态记录按下点：纯点击（未拖出选区）时
  // mouseup 凭 pressPt 选中识别候选——探测高亮后单击即选中该窗口并弹工具栏
  const idleClick = state === "idle";
  hideDet();
  drag = { type: "new", sx: e.clientX, sy: e.clientY };
  pressPt = idleClick ? { x: e.clientX, y: e.clientY } : null;
  setState("dragging");
  setSel(norm(e.clientX, e.clientY, e.clientX, e.clientY));
}, true);

/* ================= 启动 ================= */
document.getElementById("cancel-x").addEventListener("click", () => {
  stage.style.display = "";
  cancelAll();
});
// 右键：idle=退出；选中态=输出选项菜单（阴影/边框）
const ctxmenuEl = document.getElementById("ctxmenu");
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (ann) return;
  if (editing) { finishText(editing); return; } // 编辑中右键=结束输入（确认落定），而非弹输出菜单
  if (state === "idle" && !cropMode) { cancelAll(); return; }
  if (state === "selected" || state === "drawing") {
    syncCtxUI();
    ctxmenuEl.style.left = Math.min(e.clientX, innerWidth - 216) + "px";
    ctxmenuEl.style.top = Math.min(e.clientY, innerHeight - 260) + "px";
    ctxmenuEl.style.display = "block";
  }
});
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#ctxmenu")) ctxmenuEl.style.display = "none";
}, true);

/* 输出选项面板接线 */
function syncCtxUI() {
  document.getElementById("opt-shadow").checked = outShadow.on;
  document.getElementById("opt-shadow-blur").value = outShadow.blur;
  document.getElementById("opt-shadow-blur-v").textContent = outShadow.blur;
  document.getElementById("opt-shadow-color").style.background = outShadow.color;
  document.getElementById("opt-border").checked = outBorder.on;
  document.getElementById("opt-border-w").value = outBorder.w;
  document.getElementById("opt-border-w-v").textContent = outBorder.w;
  document.getElementById("opt-border-color").style.background = outBorder.color;
}
function wireCtxMenu() {
  document.getElementById("opt-shadow").addEventListener("change", (e) => { outShadow.on = e.target.checked; });
  document.getElementById("opt-shadow-blur").addEventListener("input", (e) => { outShadow.blur = Number(e.target.value); document.getElementById("opt-shadow-blur-v").textContent = e.target.value; });
  document.getElementById("opt-border").addEventListener("change", (e) => { outBorder.on = e.target.checked; });
  document.getElementById("opt-border-w").addEventListener("input", (e) => { outBorder.w = Number(e.target.value); document.getElementById("opt-border-w-v").textContent = e.target.value; });
  // 色块点击在黑白灰间循环（右键菜单内保持极简）
  document.getElementById("opt-shadow-color").addEventListener("click", (e) => {
    const cyc = { "#000000": "#FFFFFF", "#FFFFFF": "#9A9A9A", "#9A9A9A": "#000000" };
    outShadow.color = cyc[(e.target.dataset.c || "#000000").toUpperCase()] || "#000000";
    e.target.dataset.c = outShadow.color; e.target.style.background = outShadow.color;
  });
  document.getElementById("opt-border-color").addEventListener("click", (e) => {
    const cyc = { "#FFFFFF": "#000000", "#000000": "#ED1C24", "#ED1C24": "#FFFFFF" };
    outBorder.color = cyc[(e.target.dataset.c || "#FFFFFF").toUpperCase()] || "#FFFFFF";
    e.target.dataset.c = outBorder.color; e.target.style.background = outBorder.color;
  });
}

/* Esc 三键弹窗按钮 */
function wireEscDlg() {
  const dlg = document.getElementById("escdlg");
  const remember = () => document.getElementById("dlg-remember").checked;
  const saveChoice = (action) => {
    if (!remember()) return;
    escConfirm = { enabled: false, action };
    invoke("set_setting", { key: "esc_exit_confirm", value: escConfirm }).catch(() => {});
  };
  document.getElementById("dlg-cancel").addEventListener("click", () => dlg.classList.remove("open"));
  document.getElementById("dlg-discard").addEventListener("click", () => {
    dlg.classList.remove("open");
    saveChoice("discard");
    layer.innerHTML = ""; objStack = { undo: [], redo: [] };
    closeOverlay();
  });
  document.getElementById("dlg-save").addEventListener("click", () => {
    dlg.classList.remove("open");
    saveChoice("save");
    output("copy"); // 复制+入库+引擎渲染衍生图
  });
}

wireToolbar();
wireCtxMenu();
wireEscDlg();
init();

// ===== 业界同款序号"盖章"光标：num 工具激活时，鼠标位置显示下一个序号的幽灵预览 =====
let numGhostEl = null;
function numGhostHide() {
  if (numGhostEl) numGhostEl.style.display = "none";
}
function numGhostRefresh() {
  if (!numGhostEl) {
    numGhostEl = document.createElement("div");
    numGhostEl.id = "num-ghost";
    numGhostEl.style.cssText = "position:fixed;display:none;pointer-events:none;z-index:9999;transform:translate(-50%,-50%);";
    const sp = document.createElement("span");
    numGhostEl.appendChild(sp);
    document.body.appendChild(numGhostEl);
  }
  const sp = numGhostEl.firstElementChild;
  let css = "display:flex;align-items:center;justify-content:center;width:" + numDiameter + "px;height:" + numDiameter + "px;border-radius:50%;font-size:" + Math.round(numDiameter * 0.52) + "px;font-weight:600;";
  if (numStyle === "solid") css += "background:" + toolColor + ";color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.35)";
  else if (numStyle === "outline") css += "border:" + Math.max(2, numDiameter * 0.07) + "px solid " + toolColor + ";color:" + toolColor + ";background:rgba(255,255,255,.85)";
  else css += "color:" + toolColor + ";";
  sp.style.cssText = css;
  sp.textContent = numNext;
}
window.addEventListener("mousemove", (e) => {
  if (tool !== "num" || editing || ann) { numGhostHide(); return; }
  if (state !== "selected" && state !== "drawing") { numGhostHide(); return; }
  const inLayer = e.target && (e.target === layer ? true : !!(layer && layer.contains(e.target)));
  if (!inLayer) { numGhostHide(); return; }
  numGhostRefresh();
  numGhostEl.style.left = e.clientX + "px";
  numGhostEl.style.top = e.clientY + "px";
  numGhostEl.style.display = "block";
  layer.style.cursor = "none"; // 盖章预览替代系统光标（注册最晚，覆盖 hover 暗示）
});
