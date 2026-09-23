// 长截图结束条（独立不穿透窗口：滚轮穿透到下层应用，按钮在此可点）
// 业界同款工具条（2026-09-24 用户裁定）：实时预览+尺寸+保存(弹对话框)/贴图/复制/取消；
// 到底提示保留"看起来到底了"；质检页废弃→保存/贴图/复制前由 Rust 侧自动采用最优接缝
const invoke = window.__TAURI__.core.invoke;
// session id 优先取 URL 参数（eval 注入在页面加载完成前执行会丢失）
const S = {
  id: Number(new URLSearchParams(location.search).get("session")) ||
      (window.__SESSION && window.__SESSION.id) || 0,
};
const stat = document.getElementById("stat");
const rollback = document.getElementById("rollback");
const pv = document.getElementById("pv");
const empty = document.querySelector("#preview .empty");

window.__TAURI__.event.listen("scroll-progress", (e) => {
  const r = e.payload;
  if (r.status === "moving") return; // 动画帧：无 segments/height，不更新文本
  if (r.status === "appended") {
    rollback.style.display = "none";
  } else if (r.status === "rolledback") {
    rollback.style.display = "inline";
    setTimeout(() => { rollback.style.display = "none"; }, 900);
  } else if (r.status === "bottom") {
    stat.innerHTML = "看起来到底了 · 已 <b>" + r.segments + "</b> 段 · " + r.height + " px";
    return;
  }
  if (r.segments == null || r.height == null) return; // 字段缺失时保持原文案
  stat.innerHTML = "已 <b>" + r.segments + "</b> 段 · " + r.height + " px";
});

// 实时预览：Rust 每拼入一段推送全图尾部缩略（JPEG data URL）
window.__TAURI__.event.listen("scroll-preview", (e) => {
  const r = e.payload;
  if (!r || !r.dataUrl) return;
  pv.src = r.dataUrl;
  pv.style.display = "block";
  if (empty) empty.style.display = "none";
});

// 保存对话框被用户取消：会话已放回，轻提示后可继续操作
window.__TAURI__.event.listen("scroll-save-cancelled", () => {
  stat.textContent = "已取消保存 · 可继续选择贴图 / 复制";
});

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
