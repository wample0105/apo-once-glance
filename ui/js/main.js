// 定影主面板逻辑：历史 / 设置 / 隐私 / 接入 / 诊断
const tauri = window.__TAURI__;
const invoke = tauri.core.invoke;
const event = tauri.event;
const convertFileSrc = tauri.core.convertFileSrc;
const getCurrentWindow = () => tauri.window.getCurrentWindow();

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ===== 平台标记（ui-design §7）=====
try {
  const os = navigator.userAgent.includes("Mac") ? "macos" : "windows";
  document.body.dataset.os = os;
} catch (e) {}

// ===== 标题栏 =====
$("#btn-min").onclick = () => getCurrentWindow().minimize();
$("#btn-max").onclick = () => getCurrentWindow().toggleMaximize();
$("#btn-close").onclick = async () => {
  const s = await invoke("get_settings");
  if (s.close_to_tray) {
    getCurrentWindow().hide();
  } else {
    getCurrentWindow().destroy();
  }
};

// ===== 品牌章（一处定稿、处处同图：引用 assets/logo 正本）=====
(async () => {
  try {
    const p = await invoke("get_logo_path", { name: "onceglance-mark-small.svg" });
    $("#brand-img").src = convertFileSrc(p);
  } catch (e) {
    console.error("品牌资产加载失败", e);
  }
})();

// ===== 导航 =====
$$(".nav-item").forEach((btn) => {
  btn.onclick = () => {
    $$(".nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    $$(".page").forEach((p) => p.classList.remove("on"));
    $("#page-" + btn.dataset.page).classList.add("on");
    if (btn.dataset.page === "history") refreshHistory();
    if (btn.dataset.page === "privacy") refreshAudit();
    if (btn.dataset.page === "doctor") runDoctor();
    if (btn.dataset.page === "agent") refreshBridgeStatus();
  };
});

// ===== 操作条 =====
function reportErr(e) {
  document.title = "ERR: " + (e && e.message ? e.message : e);
  console.error(e);
}
$("#act-region").onclick = () => invoke("start_overlay", { kind: "region" }).catch(reportErr);
$("#act-ocr").onclick = () => invoke("start_overlay", { kind: "ocr" }).catch(reportErr);
$("#act-scroll").onclick = () => invoke("start_overlay", { kind: "scroll" }).catch(reportErr);
$("#act-window").onclick = () => invoke("capture_window_now").catch(reportErr);
$("#act-fullscreen").onclick = () => invoke("capture_fullscreen_now").catch(reportErr);
window.addEventListener("error", (ev) => reportErr(ev.error || ev.message));

// ===== 历史工作台 =====
const KIND_LABEL = { region: "区域", window: "窗口", fullscreen: "全屏", scroll: "长截图" };
let searchTimer = null;

$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refreshHistory, 220);
});
$$(".syntaxhint code").forEach((c) => {
  c.onclick = () => {
    $("#search").value = c.textContent;
    refreshHistory();
  };
});

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch (e) { return iso; }
}
function fmtDate(iso) {
  try {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(d, today)) return "今天";
    if (same(d, yesterday)) return "昨天";
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  } catch (e) { return ""; }
}

async function refreshHistory() {
  const q = $("#search").value.trim();
  try {
    const rows = await invoke("list_history", { query: q, limit: 100 });
    const list = $("#history-list");
    if (!rows.length) {
      list.innerHTML = q
        ? `<div class="empty"><div class="big">没有匹配「${q}」</div><button class="btn" id="clear-q">清除筛选</button></div>`
        : `<div class="empty"><div class="big">还没有截图</div>按 Alt+Shift+A 试一次</div>`;
      const cq = $("#clear-q");
      if (cq) cq.onclick = () => { $("#search").value = ""; refreshHistory(); };
      $("#pathmeta").textContent = "";
      return;
    }
    // 日期分组（吸顶）
    const groups = {};
    for (const r of rows) {
      const g = fmtDate(r.created_at);
      (groups[g] = groups[g] || []).push(r);
    }
    let html = "";
    for (const [g, items] of Object.entries(groups)) {
      html += `<div class="datehead">${g}</div><div class="grid">`;
      for (const r of items) {
        const name = r.path.split(/[\\\\/]/).pop();
        html += `
        <div class="card" data-path="${r.path}" data-name="${name}">
          <div class="thumb">
            <img data-thumb="${r.path}" alt="">
            <span class="kindbadge">${KIND_LABEL[r.kind] || r.kind}</span>
            <div class="cardacts">
              <button data-act="open">打开</button>
              <button data-act="copypath">复制路径</button>
            </div>
          </div>
          <div class="cardinfo">
            <div class="cardname" title="${name}">${name}</div>
            <div class="cardmeta">${fmtTime(r.created_at)} · ${r.width}×${r.height}</div>
            <div class="cardocr">${r.ocr_status === "none" ? "未识别" : r.ocr_status === "empty" ? "未发现文字" : "「" + escapeHtml(r.ocr_preview) + "」"}</div>
          </div>
        </div>`;
      }
      html += `</div>`;
    }
    list.innerHTML = html;
    // 卡片单击打开详情（§4.6）
    list.querySelectorAll(".card").forEach((card) => {
      card.addEventListener("click", () => openDetail(card.dataset.path).catch(console.error));
    });
    $("#pathmeta").textContent = `共 ${rows.length} 张`;
    // 缩略图
    list.querySelectorAll("img[data-thumb]").forEach(async (img) => {
      try {
        img.src = await invoke("thumbnail", { path: img.dataset.thumb, maxW: 320 });
      } catch (e) { /* 图片可能被移动 */ }
    });
    // 卡片操作
    list.querySelectorAll(".cardacts button").forEach((b) => {
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const card = b.closest(".card");
        if (b.dataset.act === "open") {
          await invoke("open_in_explorer", { path: card.dataset.path });
        } else if (b.dataset.act === "copypath") {
          await navigator.clipboard.writeText(card.dataset.path);
        }
      };
    });
  } catch (e) {
    console.error(e);
  }
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ===== 设置加载 =====
async function loadSettingsUI() {
  const s = await invoke("get_settings");
  // Agent 状态
  const dot = $("#agent-dot");
  dot.classList.toggle("off", !s.agent_enabled);
  const stat = $("#agent-stat");
  if (s.agent_enabled) {
    stat.textContent = "当前状态：允许（Agent 可调用截图、OCR、标注）";
    stat.className = "statline ok";
  } else {
    stat.textContent = "当前状态：已切断（截图类调用返回退出码 5，历史与状态查询不受影响）";
    stat.className = "statline cut";
  }
  $("#sw-agent").classList.toggle("on", s.agent_enabled);
  $("#sw-agent").setAttribute("aria-checked", s.agent_enabled);
  $("#sw-autocap").classList.toggle("on", s.auto_capture_enabled);
  $("#row-autocap").classList.toggle("disabled", !s.agent_enabled);
  $("#sw-autocap").disabled = !s.agent_enabled;
  $("#sw-remember").classList.toggle("on", s.remember_annotation);
  $("#sw-closetray").classList.toggle("on", s.close_to_tray);
  $("#sw-autostart").classList.toggle("on", await invoke("autostart_status"));
  $("#sel-action").value = s.default_action;
  $("#save-dir-chip").textContent = s.save_root;
  $("#save-dir-chip").style.color = s.save_dir_writable ? "" : "var(--error)";

  // 快捷键展示 + 录制（SYS-2/3：点击 chip 录制，Esc 退出不改动，冲突即时反馈）
  const hk = s.hotkeys;
  const rows = [
    ["region", "区域截图", hk.region], ["window", "窗口截图", hk.window], ["fullscreen", "全屏截图", hk.fullscreen],
    ["ocr", "自动取字", hk.ocr], ["scroll", "长截图", hk.scroll], ["panel", "打开主面板", hk.panel],
  ];
  $("#hotkey-rows").innerHTML = rows.map(([id, n, k]) =>
    `<div class="row hotkeyrow"><div class="label"><div class="t">${n}</div></div>
     <span class="hotkeychip" data-hk="${id}" title="点击改键">${k}</span></div>`
  ).join("")
  + `<div style="padding:8px 0"><button class="btn ghost" id="hk-reset">全部恢复默认</button></div>`;
  $("#hk-reset").onclick = async () => {
    const r = await invoke("reset_hotkeys");
    showHotkeyConflicts(r.conflicts);
    loadSettingsUI();
  };
  document.querySelectorAll("[data-hk]").forEach((chip) => {
    chip.style.cursor = "pointer";
    chip.addEventListener("click", () => startHotkeyCapture(chip));
  });

  // 标注主题只读值
  const a = s.annotation;
  $("#theme-values").innerHTML = [
    ["主题色", `<span class="pathchip" style="color:${a.color}">■ ${a.color}</span>`],
    ["箭头宽度", `<span class="ro-value">${a.arrow_width}px</span>`],
    ["文字字号", `<span class="ro-value">${a.text_size}px</span>`],
    ["序号样式", `<span class="ro-value">${a.step_style === "solid" ? "实心圆" : a.step_style} · 直径 ${a.step_diameter}px</span>`],
    ["马赛克默认强度", `<span class="ro-value">块 ${a.mosaic_strength}px</span>`],
    ["高亮不透明度", `<span class="ro-value">${Math.round(a.highlight_opacity * 100)}%</span>`],
  ].map(([t, v]) => `<div class="row disabled"><div class="label"><div class="t">${t}</div></div><div class="ctl">${v}</div></div>`).join("");

  // 黑名单
  renderBlacklist(s.blacklist);

  // MCP 配置
  try {
    const logo = await invoke("get_logo_path", { name: "onceglance-favicon.svg" });
    const onceExe = (await invoke("get_logo_path", { name: "@once-exe" })) || "";
  } catch (e) {}
  // 接入页复制按钮（事件委托）
  document.querySelectorAll(".codebox .copy").forEach((c) => {
    if (c.dataset.wired) return;
    c.dataset.wired = "1";
    c.addEventListener("click", async () => {
      const text = c.dataset.copy || c.parentElement.textContent.replace(/^复制/, "").trim();
      await navigator.clipboard.writeText(text);
      const old = c.textContent;
      c.textContent = "已复制";
      setTimeout(() => { c.textContent = old; }, 2000);
    });
  });
  $("#mcp-config").textContent = JSON.stringify({
    mcpServers: {
      onceglance: {
        command: "C:\\\\…\\\\once.exe",
        args: ["mcp"],
        description: "实际路径以发行版安装位置为准（M3 install.sh 会写入 PATH）",
      },
    },
  }, null, 2);
}

function renderBlacklist(list) {
  const box = $("#blacklist-rows");
  box.innerHTML = list.map((b, i) => `
    <div class="row">
      <div class="label"><div class="t">${escapeHtml(b.pattern)} ${b.builtin ? '<span class="tagok">内置</span>' : ""}</div></div>
      <div class="ctl">
        <button class="switch ${b.enabled ? "on" : ""}" data-bl-toggle="${i}" role="switch" aria-checked="${b.enabled}"></button>
        ${b.builtin ? "" : `<button class="btn ghost" data-bl-del="${i}">删除</button>`}
      </div>
    </div>`).join("");
  box.querySelectorAll("[data-bl-toggle]").forEach((el) => {
    el.onclick = async () => {
      const i = +el.dataset.blToggle;
      const s = await invoke("get_settings");
      s.blacklist[i].enabled = !s.blacklist[i].enabled;
      await invoke("set_setting", { key: "blacklist", value: s.blacklist });
      renderBlacklist(s.blacklist);
    };
  });
  box.querySelectorAll("[data-bl-del]").forEach((el) => {
    el.onclick = async () => {
      const i = +el.dataset.blDel;
      const s = await invoke("get_settings");
      s.blacklist.splice(i, 1);
      await invoke("set_setting", { key: "blacklist", value: s.blacklist });
      renderBlacklist(s.blacklist);
    };
  });
}

// ===== 设置交互 =====
$("#sw-agent").onclick = async () => {
  const s = await invoke("get_settings");
  await invoke("set_setting", { key: "agent_enabled", value: !s.agent_enabled });
  loadSettingsUI();
};
$("#sw-autocap").onclick = async () => {
  const s = await invoke("get_settings");
  await invoke("set_setting", { key: "auto_capture_enabled", value: !s.auto_capture_enabled });
  loadSettingsUI();
};
$("#sw-remember").onclick = async () => {
  const s = await invoke("get_settings");
  await invoke("set_setting", { key: "remember_annotation", value: !s.remember_annotation });
  loadSettingsUI();
};
$("#sw-closetray").onclick = async () => {
  const s = await invoke("get_settings");
  await invoke("set_setting", { key: "close_to_tray", value: !s.close_to_tray });
  loadSettingsUI();
};
$("#sw-autostart").onclick = async () => {
  const cur = $("#sw-autostart").classList.contains("on");
  try {
    const now = await invoke("autostart_set", { enable: !cur });
    $("#sw-autostart").classList.toggle("on", now);
    $("#sw-autostart").setAttribute("aria-checked", now);
  } catch (e) { alert("设置失败：" + e); }
};
$("#sel-action").onchange = async () => {
  const v = $("#sel-action").value;
  if (!v) return; // 空值不落盘（防御自动化/异常选择把默认动作写坏）
  await invoke("set_setting", { key: "default_action", value: v });
};
$("#btn-theme-reset").onclick = async () => {
  const s = await invoke("get_settings");
  await invoke("set_setting", { key: "annotation", value: {
    color: "#FF3B30", arrow_width: 8, shape_width: 6, text_size: 44,
    text_bold: false, text_italic: false, text_underline: false, text_shadow: true,
    text_align: "left", step_diameter: 56, step_style: "solid",
    mosaic_strength: 12, highlight_opacity: 0.4,
  } });
  loadSettingsUI();
};
$("#btn-dir-open").onclick = async () => {
  const s = await invoke("get_settings");
  invoke("open_in_explorer", { path: s.save_root });
};
$("#btn-dir-change").onclick = async () => {
  // M1：直接输入路径（目录选择器 M2 换 dialog 插件）
  const cur = await invoke("get_settings");
  const v = prompt("输入新的落盘目录：", cur.save_root);
  if (v && v.trim()) {
    await invoke("set_setting", { key: "save_dir", value: v.trim() });
    loadSettingsUI();
  }
};
$("#bl-add").onclick = async () => {
  const v = $("#bl-input").value.trim();
  if (!v) return;
  const s = await invoke("get_settings");
  s.blacklist.push({ pattern: v, builtin: false, enabled: true });
  await invoke("set_setting", { key: "blacklist", value: s.blacklist });
  $("#bl-input").value = "";
  renderBlacklist(s.blacklist);
};

// ===== 审计 =====
let auditCache = [];
async function refreshAudit() {
  auditCache = await invoke("read_audit", { limit: 200 });
  renderAudit();
}
function renderAudit() {
  const f = $("#audit-filter").value;
  const rows = auditCache.filter((a) => (f === "all" ? true : a.status !== 0));
  $("#audit-list").innerHTML = rows.length
    ? rows.map((a) => {
        const cls = a.status === 0 ? "l-ok" : "l-err";
        return `<div class="${cls}">${a.time.slice(11, 19)} · ${escapeHtml(a.command)} · ${a.elapsed_ms}ms · 退出码 ${a.status}${a.target_process ? " · " + escapeHtml(a.target_process) : ""}</div>`;
      }).join("")
    : "暂无调用记录 · Agent 还没有调用过定影";
}
$("#audit-filter").onchange = renderAudit;
$("#audit-clear").onclick = async () => {
  if (confirm("清空审计日志？仅删除记录，不影响已保存的截图。")) {
    await invoke("clear_audit");
    refreshAudit();
  }
};

// ===== 诊断 =====
async function runDoctor() {
  const r = await invoke("doctor_run");
  $("#doctor-list").innerHTML = r.items.map((it) => `
    <div class="doctor-item">
      <span class="${it.ok ? "d-ok" : "d-bad"}">${it.ok ? "✓" : "✕"}</span>
      <span style="width:90px">${it.check}</span>
      <span style="color:var(--text-secondary)">${it.detail || ""}</span>
    </div>`).join("");
  const dot = $("#status-dot");
  dot.className = "statusdot " + (r.ok_all ? "" : "warn");
  dot.title = r.ok_all ? "全部正常" : "有可修复项，点击直达诊断";
}
$("#btn-doctor").onclick = runDoctor;

// ===== 事件 =====
event.listen("nav-to", (e) => {
  const page = e.payload;
  const btn = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (btn) btn.click();
});
event.listen("toast-shown", () => refreshHistory());


// ===== 资产详情（§4.6：文字块与图片联动、版本时间线）=====
let detailState = null; // { basePath, scale, data }

function escapeSel(s) { return s.replace(/"/g, "&quot;"); }

async function openDetail(path) {
  const data = await invoke("detail_data", { path });
  const m = data.manifest || {};
  detailState = { basePath: path, scale: 1, data };
  $$(".page").forEach((p) => p.classList.remove("on"));
  $("#page-detail").classList.add("on");
  // 详情页：窗口放大到 1024×680（D-3）；命名空间异常不阻断
  try {
    const LS = (tauri.window && tauri.window.LogicalSize) || (tauri.dpi && tauri.dpi.LogicalSize);
    if (LS) getCurrentWindow().setSize(new LS(1024, 680));
  } catch (e) { console.error(e); }
  $("#detail-name").textContent = path.split(/[\/]/).pop();
  const kind = m.kind || "?";
  const kl = $("#detail-kind");
  kl.textContent = kind;
  kl.style.display = "inline-flex";
  $("#detail-meta1").textContent = `${m.width || "?"}×${m.height || "?"} · DPI ${Math.round((m.dpi_scale || 1) * 100)}%`;
  $("#detail-meta2").textContent = (m.created_at || "").replace("T", " ").slice(0, 19);
  // 主图
  const img = $("#detail-img");
  img.src = await invoke("thumbnail", { path, maxW: 1400 });
  img.style.width = "100%";
  detailState.scale = 1;
  // 文字块
  const blocks = (data.ocr && data.ocr.blocks) || [];
  $("#detail-bcount").textContent = blocks.length;
  const bw = $("#detail-imgwrap");
  bw.querySelectorAll(".bboxhl").forEach((e) => e.remove());
  const blist = $("#detail-blocks");
  blist.innerHTML = blocks.length ? "" : '<div style="font-size:11px;color:var(--text-tertiary)">未发现文字</div>';
  blocks.forEach((b, i) => {
    const item = document.createElement("div");
    item.className = "dblock";
    item.dataset.i = i;
    item.style.cssText = "padding:5px 8px;border-radius:6px;cursor:pointer;font-size:11px;color:var(--text-secondary);display:flex;gap:6px;align-items:center";
    item.innerHTML = `<span class="tagok">${b.type}</span><span style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escapeHtml(b.text)}</span><span style="color:var(--text-tertiary)">${Math.round((b.confidence ?? 1) * 100)}%</span>`;
    item.addEventListener("mouseenter", () => highlightBlock(i, true));
    item.addEventListener("mouseleave", () => highlightBlock(i, false));
    item.addEventListener("click", () => {
      const im = $("#detail-img");
      im.scrollIntoView({ block: "nearest" });
      highlightBlock(i, true, true);
    });
    blist.appendChild(item);
    // 图上 bbox 轮廓（淡描边）
    const hl = document.createElement("div");
    hl.className = "bboxhl";
    hl.dataset.i = i;
    hl.style.cssText = "position:absolute;border:1px solid rgba(255,59,48,0.35);pointer-events:none;display:none";
    bw.appendChild(hl);
  });
  // bbox 定位需要图片加载完成（缩略图宽 = 显示宽）
  img.addEventListener("load", () => positionBboxes(), { once: true });
  if (img.complete) positionBboxes();
  // 版本时间线（原图置顶）
  const vers = $("#detail-versions");
  vers.innerHTML = "";
  const v0 = document.createElement("div");
  v0.className = "dver on";
  v0.style.cssText = "padding:6px 8px;border-radius:6px;cursor:pointer;font-size:11px;background:var(--accent-bg);color:var(--accent-text)";
  v0.textContent = "● 原图";
  v0.addEventListener("click", () => switchVersion(path));
  vers.appendChild(v0);
  (data.derivatives || []).forEach((d) => {
    const el = document.createElement("div");
    el.className = "dver";
    el.style.cssText = "padding:6px 8px;border-radius:6px;cursor:pointer;font-size:11px;color:var(--text-secondary)";
    el.textContent = `● 标注 · ${d.ops_count} 个操作 · ${d.script_sha256.slice(0, 8)}`;
    el.addEventListener("click", () => {
      switchVersion(d.path);
      vers.querySelectorAll(".dver").forEach((x) => { x.style.background = ""; x.style.color = "var(--text-secondary)"; });
      el.style.background = "var(--accent-bg)"; el.style.color = "var(--accent-text)";
    });
    vers.appendChild(el);
  });
}

function switchVersion(p) {
  detailState.basePath = p;
  invoke("thumbnail", { path: p, maxW: 1400 }).then((url) => {
    const bw = $("#detail-imgwrap");
    bw.querySelectorAll(".bboxhl").forEach((e) => e.remove());
    $("#detail-img").src = url;
    $("#detail-name").textContent = p.split(/[\/]/).pop();
  });
}

function positionBboxes() {
  const img = $("#detail-img");
  const shown = img.clientWidth;
  const natW = detailState && detailState.data && detailState.data.ocr && detailState.data.ocr.width;
  if (!natW || !shown) return;
  const k = shown / natW;
  document.querySelectorAll("#detail-imgwrap .bboxhl").forEach((hl) => {
    const b = detailState.data.ocr.blocks[+hl.dataset.i];
    if (!b) return;
    hl.style.left = b.bbox[0] * k + "px";
    hl.style.top = b.bbox[1] * k + "px";
    hl.style.width = b.bbox[2] * k + "px";
    hl.style.height = b.bbox[3] * k + "px";
    hl.style.display = "block";
  });
}

function highlightBlock(i, on, lock = false) {
  const hl = document.querySelector(`#detail-imgwrap .bboxhl[data-i="${i}"]`);
  if (hl) {
    hl.style.border = on ? "2px solid var(--accent)" : "1px solid rgba(255,59,48,0.35)";
    hl.style.boxShadow = on ? "0 0 0 3px rgba(255,59,48,0.25)" : "none";
  }
}

function closeDetail() {
  try {
    const LS = (tauri.window && tauri.window.LogicalSize) || (tauri.dpi && tauri.dpi.LogicalSize);
    if (LS) getCurrentWindow().setSize(new LS(780, 560));
  } catch (e) { console.error(e); }
  $$(".page").forEach((p) => p.classList.remove("on"));
  $("#page-history").classList.add("on");
  refreshHistory();
}

// 详情页事件
$("#detail-back").onclick = closeDetail;
$("#detail-edit").onclick = async () => {
  if (!detailState) return;
  try {
    // 打开覆盖层标注编辑器（以该图为底图；衍生图会显示 lineage 横幅）
    await invoke("annotate_open_file", { path: detailState.basePath });
  } catch (e) {
    alert("无法打开编辑器：" + e);
  }
};
$("#detail-open").onclick = () => detailState && invoke("open_in_explorer", { path: detailState.basePath });
$("#detail-copyimg").onclick = async () => {
  if (!detailState) return;
  await invoke("copy_image_bytes", { path: detailState.basePath });
};
$("#detail-delete").onclick = async () => {
  if (!detailState) return;
  if (confirm("删除这张截图（进系统回收站，可还原）？")) {
    await invoke("delete_to_recycle_bin", { paths: [detailState.basePath] });
    closeDetail();
  }
};
$("#detail-img").addEventListener("wheel", (e) => {
  e.preventDefault();
  if (!detailState) return;
  detailState.scale = Math.min(4, Math.max(0.2, detailState.scale * (e.deltaY < 0 ? 1.15 : 0.87)));
  $("#detail-img").style.width = (detailState.scale * 100) + "%";
  setTimeout(positionBboxes, 60);
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#page-detail").classList.contains("on")) closeDetail();
});


// ===== 热键录制（SYS-2/3）=====
let hkRecording = null;

function startHotkeyCapture(chip) {
  if (hkRecording) return;
  hkRecording = chip;
  const old = chip.textContent;
  chip.textContent = "按下组合键…（Esc 取消）";
  chip.style.borderColor = "var(--accent)";
  chip.style.color = "var(--accent-text)";
  // 点击 chip 之外任意处 = 取消（当前这次点击结束后再挂监听，避免自触发）
  const outside = (ev) => {
    if (chip.contains(ev.target)) return;
    cleanup();
    chip.textContent = old;
  };
  setTimeout(() => document.addEventListener("click", outside, true), 0);
  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      cleanup();
      chip.textContent = old;
      return;
    }
    const main = e.key;
    const isModifier = ["Control", "Alt", "Shift", "Meta"].includes(main);
    if (isModifier) return; // 等主键
    const valid =
      main.length === 1 ||
      /^F\d{1,2}$/.test(main);
    if (!valid) return;
    let combo = "";
    if (e.ctrlKey) combo += "Ctrl+";
    if (e.altKey) combo += "Alt+";
    if (e.shiftKey) combo += "Shift+";
    if (e.metaKey) combo += "Super+";
    combo += main.length === 1 ? main.toUpperCase() : main;
    cleanup();
    finishHotkey(chip, combo);
  };
  const cleanup = () => {
    window.removeEventListener("keydown", handler, true);
    document.removeEventListener("click", outside, true);
    chip.style.borderColor = "";
    chip.style.color = "";
    hkRecording = null;
  };
  window.addEventListener("keydown", handler, true);
}

async function finishHotkey(chip, combo) {
  const name = chip.dataset.hk;
  try {
    const r = await invoke("set_hotkey", { name, combo });
    showHotkeyConflicts(r.conflicts);
    if (r.conflicts.some((c) => c.name === name)) {
      chip.textContent = combo + "（被占用）";
      chip.title = "冲突：按 Del 恢复默认或换键";
    }
  } catch (e) {
    alert("改键失败：" + e);
  }
  loadSettingsUI();
}

function showHotkeyConflicts(conflicts) {
  const box = $("#hotkey-conflicts");
  if (!box) return;
  box.textContent = conflicts.length
    ? `${conflicts.length} 个热键未生效（被其他程序占用）：` + conflicts.map((c) => `${c.name}=${c.combo}`).join("、")
    : "";
}

// ===== 桥接状态（接入页横幅）=====
async function refreshBridgeStatus() {
  const el = $("#bridge-status");
  if (!el) return;
  try {
    const r = await invoke("bridge_ping");
    if (r && r.ok && r.data) {
      const d = r.data;
      el.textContent = `桥接在线 · v${d.version} · 本机命名管道（仅当前用户） · OCR 引擎 ${d.ocr_engine} · 历史 ${d.history_count} 张 · Agent ${d.agent_enabled ? "允许" : "已切断"}`;
      el.style.color = "var(--success)";
    } else {
      throw new Error(r && r.error ? r.error.message || "未知" : "空响应");
    }
  } catch (e) {
    el.textContent = "桥接离线（CLI/MCP 仍直接驱动内核，功能不受影响）：" + (e && e.message ? e.message : e);
    el.style.color = "var(--text-tertiary)";
  }
}

// 初始化
refreshBridgeStatus();
refreshHistory();
loadSettingsUI();
runDoctor();
