// 长截图结束条（独立不穿透窗口：滚轮穿透到下层应用，按钮在此可点）
// 业界同款紧凑单条（2026-09-24 用户裁定）：实时尺寸 + 保存(弹对话框)/贴图/复制/取消；
// 无预览图、无段数、无回滚/到底提示（降低认知负担）；保存/贴图/复制前 Rust 自动采用最优接缝
const invoke = window.__TAURI__.core.invoke;
const S = {
  id: Number(new URLSearchParams(location.search).get("session")) ||
      (window.__SESSION && window.__SESSION.id) || 0,
};
const dim = document.getElementById("dim");

window.__TAURI__.event.listen("scroll-progress", (e) => {
  const r = e.payload;
  if (r.width == null || r.height == null) return; // moving 帧：无尺寸字段
  dim.textContent = r.width + " x " + r.height;
});

// 保存对话框被用户取消：会话已放回，可继续操作
window.__TAURI__.event.listen("scroll-save-cancelled", () => {});

const busy = (b) => { for (const id of ["save", "pin", "copy"]) document.getElementById(id).disabled = b; };

document.getElementById("save").addEventListener("click", async () => {
  busy(true);
  try { await invoke("scroll_finish", { session: S.id }); } catch (e) { /* 会话可能已被键盘钩子完成 */ }
  busy(false);
});
document.getElementById("pin").addEventListener("click", async () => {
  busy(true);
  try { await invoke("scroll_pin", { session: S.id }); } catch (e) { busy(false); }
});
document.getElementById("copy").addEventListener("click", async () => {
  busy(true);
  try { await invoke("scroll_copy", { session: S.id }); } catch (e) { busy(false); }
});
document.getElementById("x").addEventListener("click", async () => {
  try { await invoke("scroll_cancel", { session: S.id }); } catch (e) { /* noop */ }
});
