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
    document.getElementById("img").src = convertFileSrc(m.path);
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

// 滚轮缩放 / Ctrl+滚轮 透明度
window.addEventListener("wheel", (e) => {
  if (!id) return;
  if (e.ctrlKey) {
    invoke("pin_opacity", { id, opacity: Math.min(1, Math.max(0.1, 1 + (e.deltaY > 0 ? -0.05 : 0.05))) });
  } else {
    invoke("pin_scale", { id, factor: e.deltaY > 0 ? 0.9 : 1.111 });
  }
}, { passive: true });

// 双击关闭
window.addEventListener("dblclick", () => { if (id) invoke("pin_close", { id }); });

// 右键：切换鼠标穿透
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (id) invoke("pin_clickthrough", { id, on: true });
});

// 不透明度事件（来自 pin_opacity 命令）
window.__TAURI__.event.listen("pin-opacity", (e) => {
  document.getElementById("img").style.opacity = e.payload;
});
