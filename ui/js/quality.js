// 接缝质检页（说明书 §4.4 阶段 3）：只列可疑接缝，±1/±10 修正，全部接受为主操作
const invoke = window.__TAURI__.core.invoke;

let S = null; // {id, width, height, seams:[...]}
let current = 0;

window.__QC_INIT = init;
init();

async function init() {
  try {
    const r = await invoke("scroll_get_review_session");
    S = { id: r.id, width: r.width, height: r.height, seams: r.seams };
  } catch (e) {
    document.getElementById("title").textContent = "没有待质检的会话";
    return;
  }
  document.getElementById("title").textContent = `${S.seams.length} 处需要看一眼`;
  document.getElementById("sub").textContent = `· 高 ${S.height} px`;
  document.getElementById("list-title").textContent = `其余接缝正常 · 已折叠`;

  // 预览：向 Rust 请求整图缩略
  renderPreview();
  renderList();
}

async function renderPreview() {
  try {
    const r = await invoke("scroll_preview", { session: S.id, maxW: 560 });
    window.__SEAMYS = r.seam_ys;
    const box = document.getElementById("preview");
    box.innerHTML = "";
    const img = document.createElement("img");
    img.src = r.url;
    box.appendChild(img);
    // 可疑接缝黄虚线
    for (const idx of S.seams) {
      const line = document.createElement("div");
      line.className = "seamline";
      line.dataset.idx = idx;
      box.appendChild(line);
    }
    positionLines();
  } catch (e) {
    document.getElementById("preview").textContent = "预览加载失败：" + e;
  }
}

let previewScale = 1;
function positionLines() {
  const img = document.querySelector("#preview img");
  if (!img) return;
  const scale = img.clientWidth / S.width;
  document.querySelectorAll(".seamline").forEach((line) => {
    const idx = +line.dataset.idx;
    line.style.marginTop = "0";
    // 按 seam y 值绝对定位（相对图片顶部）
    line.style.top = seamY(idx) * scale + "px";
    line.style.position = "absolute";
  });
  document.getElementById("preview").style.position = "relative";
}

function seamY(idx) {
  // 从 Rust 侧查询（adjust 后 y 会变）；首次由 scroll_finish 提供的是可疑列表，这里简化为查询全部接缝
  return (window.__SEAMYS && window.__SEAMYS[idx]) || 0;
}

function renderList() {
  const list = document.getElementById("seam-list");
  list.innerHTML = "";
  S.seams.forEach((idx, i) => {
    const div = document.createElement("div");
    div.className = "seamitem" + (i === current ? " on" : "");
    div.innerHTML = `
      <div class="tt"><span>接缝 ${i + 1}</span><span style="color:var(--text-tertiary)">#${idx}</span></div>
      <div class="ctrls">
        <button data-d="-10">−10</button><button data-d="-1">−1</button>
        <button data-d="1">+1</button><button data-d="10">+10</button>
        <button class="acc" data-acc="1">接受</button>
      </div>`;
    div.addEventListener("click", () => { current = i; renderList(); highlight(); });
    div.querySelectorAll("button[data-d]").forEach((b) => {
      b.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const r = await invoke("scroll_adjust", { session: S.id, seamIndex: idx, delta: +b.dataset.d });
        refreshPreview(r);
      });
    });
    div.querySelector("button[data-acc]").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await invoke("scroll_adjust", { session: S.id, seamIndex: idx, delta: 0 });
      div.style.opacity = "0.5";
    });
    list.appendChild(div);
  });
}

async function refreshPreview(_r) {
  await renderPreview();
  renderList();
}

function highlight() {
  renderList();
  const line = document.querySelector(`.seamline[data-idx="${S.seams[current]}"]`);
  if (line) line.scrollIntoView({ block: "center" });
}

document.getElementById("accept-all").onclick = async () => {
  await invoke("scroll_accept_all", { session: S.id });
  doSave();
};
document.getElementById("save").onclick = doSave;
async function doSave() {
  const r = await invoke("scroll_save", { session: S.id });
  window.close();
}

// 键盘（§4.4：↑↓ 切换接缝，J/K 微调，Ctrl+Enter 保存）
window.addEventListener("keydown", async (e) => {
  if (e.key === "ArrowDown") { current = Math.min(current + 1, S.seams.length - 1); highlight(); }
  else if (e.key === "ArrowUp") { current = Math.max(current - 1, 0); highlight(); }
  else if (e.key === "j" || e.key === "J") {
    await invoke("scroll_adjust", { session: S.id, seamIndex: S.seams[current], delta: -1 });
    refreshPreview();
  } else if (e.key === "k" || e.key === "K") {
    await invoke("scroll_adjust", { session: S.id, seamIndex: S.seams[current], delta: 1 });
    refreshPreview();
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    doSave();
  }
});
