// 贴图窗口：加载图像、拖动移动、滚轮缩放、Ctrl+滚轮透明度、双击关闭、右键菜单（穿透）
const { invoke, convertFileSrc } = window.__TAURI__.core;
// id 由 Rust eval 注入（Tauri App URL 无查询串），轮询等待
let id = 0;
(function waitId(tries) {
  if (window.__PIN_ID) { id = Number(window.__PIN_ID); boot(); }
  else if (tries > 0) setTimeout(() => waitId(tries - 1), 50);
})(40);
let lastPos = null;

async function boot() {
  if (!id) { document.title = "贴图?"; return; }
  try {
    const m = await invoke("pin_meta", { id });
    // 优先用 Rust 注入的 data URL（asset 协议对 Pictures 路径真机不可靠，曾 403 空窗）
    if (window.__PIN_SRC) document.getElementById("img").src = window.__PIN_SRC;
    else document.getElementById("img").src = convertFileSrc(m.path);
    // 四边阴影边距：Rust 侧窗口比图像外扩了 pad 物理像素，body 留出等量 CSS 内边距，
    // img 填充 content box——阴影正好落在边距区不被窗口裁掉
    if (m.pad) document.body.style.padding = (m.pad / (window.devicePixelRatio || 1)) + "px";
    lastPos = [m.x, m.y];
  } catch (e) { /* 元数据缺失：保持空窗 */ }
}
boot();

// 移动：把物理位置回写（拖动结束时）
setInterval(async () => {
  if (!id) return;
  try {
    const w = window.__TAURI__.window.getCurrentWindow();
    const pos = await w.outerPosition();
    if (!lastPos || pos.x !== lastPos[0] || pos.y !== lastPos[1]) {
      lastPos = [pos.x, pos.y];
      await invoke("pin_move", { id, x: pos.x, y: pos.y });
    }
  } catch (e) {}
}, 800);

// 滚轮缩放 / Ctrl+滚轮 透明度（10 档步进，同类产品 同款：10%→100%）
// 透明度走 Rust 相对步进（以当前值为基准）——前端绝对式"1±x"曾致连续滚动只到 0.95
window.addEventListener("wheel", (e) => {
  if (!id) return;
  if (e.ctrlKey) {
    invoke("pin_opacity_step", { id, delta: e.deltaY > 0 ? -0.1 : 0.1 });
  } else {
    invoke("pin_scale", { id, factor: e.deltaY > 0 ? 0.9 : 1.111 });
  }
}, { passive: true });

// 左键按住拖动（同类产品 核心交互）：位移超阈值才 startDragging——
// mousedown 立即拖会进系统拖动模态吞掉第二次 mousedown（滚轮缩放后双击关闭失效的根因），
// 阈值判定让原地单击/双击与拖动自然共存（图片查看器业界标准做法）
let downPos = null;
const pinImg = document.getElementById("img");
pinImg.addEventListener("mousedown", (e) => {
  if (e.button === 0 && id) { e.preventDefault(); downPos = [e.clientX, e.clientY]; }
});
pinImg.addEventListener("mousemove", (e) => {
  if (!downPos) return;
  if (Math.abs(e.clientX - downPos[0]) > 4 || Math.abs(e.clientY - downPos[1]) > 4) {
    downPos = null;
    window.__TAURI__.window.getCurrentWindow().startDragging();
  }
});
window.addEventListener("mouseup", () => { downPos = null; });

// 双击关闭
window.addEventListener("dblclick", () => { if (id) invoke("pin_close", { id }); });

// 右键：切换鼠标穿透
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (id) invoke("pin_clickthrough", { id, on: true });
});

// 不透明度事件（来自 pin_opacity 命令）：应用透明度 + 中央 HUD 显示当前档位（1s 后淡出）
let hudTimer = null;
window.__TAURI__.event.listen("pin-opacity", (e) => {
  document.getElementById("img").style.opacity = e.payload;
  const hud = document.getElementById("ophud");
  hud.textContent = Math.round(e.payload * 100) + "%";
  hud.style.display = "block";
  hud.style.opacity = "1";
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => { hud.style.opacity = "0"; }, 900);
});
