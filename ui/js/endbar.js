// 长截图结束条（独立不穿透窗口：滚轮穿透到下层应用，按钮在此可点）
// 说明书 §4.4：滚动中隐藏数字增长由 Rust 轮询事件驱动；到底提示"看起来到底了"且永不自动完成。
const invoke = window.__TAURI__.core.invoke;
// session id 优先取 URL 参数（eval 注入在页面加载完成前执行会丢失）
const S = {
  id: Number(new URLSearchParams(location.search).get("session")) ||
      (window.__SESSION && window.__SESSION.id) || 0,
};
function report(e) {
  stat.textContent = "错误：" + (e && e.message ? e.message : e);
}

const stat = document.getElementById("stat");
const rollback = document.getElementById("rollback");
const done = document.getElementById("done");

let lastAppend = 0;

window.__TAURI__.event.listen("scroll-progress", (e) => {
  const r = e.payload;
  if (r.status === "moving") return; // 动画帧：无 segments/height，不更新文本
  if (r.status === "appended") {
    lastAppend = Date.now();
    rollback.style.display = "none";
  } else if (r.status === "rolledback") {
    rollback.style.display = "inline";
    setTimeout(() => { rollback.style.display = "none"; }, 900);
  } else if (r.status === "bottom") {
    stat.innerHTML = "看起来到底了 · 已 <b>" + r.segments + "</b> 段 · " + r.height + " px（不会自动完成）";
    done.classList.remove("bottom");
    void done.offsetWidth; // 重启动画
    done.classList.add("bottom");
    return;
  }
  if (r.segments == null || r.height == null) return; // 字段缺失时保持原文案
  stat.innerHTML = "已 <b>" + r.segments + "</b> 段 · " + r.height + " px";
});

done.addEventListener("click", async () => {
  done.disabled = true;
  try {
    await invoke("scroll_finish", { session: S.id });
  } catch (e) { /* 会话可能已被键盘钩子完成 */ }
});
document.getElementById("x").addEventListener("click", async () => {
  try {
    await invoke("scroll_cancel", { session: S.id });
  } catch (e) { /* noop */ }
});
