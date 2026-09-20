// 首次启动引导（说明书 §4.1）：自检 → 试一次 → 接 Agent（可跳过）
const invoke = window.__TAURI__.core.invoke;
const { convertFileSrc } = window.__TAURI__.core;
let step = 1;
const MAX = 4;

async function runChecks() {
  const box = document.getElementById("checks");
  const items = [
    ["capture", "屏幕捕获自检"],
    ["save_dir", "落盘目录可写"],
    ["ocr_engine", "OCR 引擎（本地）"],
    ["runtime", "WebView2 运行时"],
  ];
  box.innerHTML = items.map(([id, name]) =>
    `<div class="check" id="chk-${id}"><span class="dot"></span>${name}<span style="flex:1"></span><span style="color:var(--text-tertiary);font-size:11px" id="chkd-${id}">检查中…</span></div>`
  ).join("");
  const r = await invoke("doctor_run");
  let okCount = 0;
  for (const it of r.items) {
    const row = document.getElementById("chk-" + it.check);
    if (!row) continue;
    row.classList.add(it.ok ? "ok" : "bad");
    document.getElementById("chkd-" + it.check).textContent = it.ok ? "通过" : "需处理";
    if (it.ok) okCount++;
  }
  // 汇总
  const sum = document.createElement("div");
  sum.style.cssText = "margin-top:10px;font-size:12px;color:" + (okCount === r.items.length ? "var(--success)" : "var(--warn)");
  sum.textContent = okCount === r.items.length
    ? `${okCount} 项全部通过`
    : `${okCount} 项通过 / ${r.items.length - okCount} 项需处理（不影响先试用）`;
  box.appendChild(sum);
  document.getElementById("next").textContent = "试一次 →";
}

// 第 2 步：监听历史新增（用户完成一次截图 → 打勾）
let baseCount = null;
async function watchFirstShot() {
  if (step !== 2) return;
  try {
    const rows = await invoke("list_history", { query: "", limit: 1 });
    if (baseCount === null) { baseCount = rows.length; setTimeout(watchFirstShot, 800); return; }
    if (rows.length > baseCount) {
      // 用户截了第一张
      const res = document.getElementById("s2-result");
      res.style.display = "block";
      try {
        document.getElementById("s2-thumb").src = await invoke("thumbnail", { path: rows[0].path, maxW: 480 });
      } catch (e) {}
      document.getElementById("next").textContent = "下一步 →";
      return; // 停止轮询
    }
    setTimeout(watchFirstShot, 800);
  } catch (e) { setTimeout(watchFirstShot, 1500); }
}

function goto(n) {
  step = n;
  document.querySelectorAll(".step").forEach((s) => s.classList.remove("on"));
  document.querySelectorAll(".steps i").forEach((i) => i.classList.toggle("on", +i.dataset.s <= Math.min(n, 3)));
  const el = document.getElementById("s" + n);
  if (el) el.classList.add("on");
  document.getElementById("prev").style.visibility = n === 1 ? "hidden" : "visible";
  const next = document.getElementById("next");
  if (n === 1) { next.textContent = "试一次 →"; runChecks(); }
  if (n === 2) { next.textContent = "下一步 →"; watchFirstShot(); }
  if (n === 3) next.textContent = "完成 →";
  if (n === 4) {
    next.textContent = "开始使用";
    invoke("set_setting", { key: "onboarding_done", value: true });
  }
}

document.getElementById("next").addEventListener("click", async () => {
  if (step < MAX) {
    goto(step + 1);
  } else {
    // WebView2 会拦截 JS window.close()，走 Rust 侧销毁
    invoke("close_window", { label: "onboarding" }).catch(() => window.close());
  }
});
document.getElementById("prev").addEventListener("click", () => { if (step > 1) goto(step - 1); });
document.getElementById("s2-skip").addEventListener("click", () => goto(3));
document.getElementById("s3-skip").addEventListener("click", () => goto(4));
document.getElementById("s3-agentpage").addEventListener("click", async () => {
  await invoke("set_setting", { key: "onboarding_done", value: true });
  invoke("close_window", { label: "onboarding" }).catch(() => window.close());
  // 打开主面板并跳到接入页
  const w = window.__TAURI__.window.WebviewWindow.fromLabel("main");
  if (w) { await w.show(); await w.emit("nav-to", "agent"); }
});
document.getElementById("s3-install").addEventListener("click", async () => {
  // 复制安装命令并提示交给 Agent / 终端执行（SKL-4）
  const cmd = "curl -fsSL --retry 3 --retry-all-errors --retry-delay 1 https://github.com/wample/OnceGlance/releases/latest/download/install.sh | bash";
  await navigator.clipboard.writeText(cmd);
  const btn = document.getElementById("s3-install");
  btn.textContent = "安装命令已复制 · 粘贴到终端，或直接交给你的 Agent 执行";
  setTimeout(() => goto(4), 2200);
});

// 品牌章（一处定稿、处处同图）
invoke("get_logo_path", { name: "onceglance-mark-small.svg" })
  .then((p) => { document.getElementById("brand").src = convertFileSrc(p); })
  .catch(() => {});

runChecks();
