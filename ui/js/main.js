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

// ===== 前端错误可见化：未捕获错误同步到页面顶部红条（排障通道，无错误时不占位）=====
function showFrontendErr(text) {
  const el = document.getElementById("frontend-err");
  if (!el) return;
  el.textContent = String(text).slice(0, 300);
  el.style.display = "block";
}
window.addEventListener("error", (e) =>
  showFrontendErr((e.message || "error") + " @" + String(e.filename || "").split("/").pop() + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) =>
  showFrontendErr("Promise: " + ((e.reason && e.reason.message) || e.reason)));

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

// ===== 品牌章（一处定稿、处处同图：svg 内联 data URL，不依赖 asset 协议 scope）=====
(async () => {
  try {
    const svg = await invoke("get_logo_svg", { name: "onceglance-mark-small.svg" });
    $("#brand-img").src = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  } catch (e) {
    console.error("品牌资产加载失败", e);
  }
})();

// ===== 导航（设置收敛版）：首页=常驻工作台；设置视图=返回+分组 tab =====
// 低频设置（模型配置/接入 Agent/通用/诊断）收敛进齿轮入口，首页只留核心高频功能
let lastSettingPage = "ai"; // 记住上次访问的设置分组，齿轮直达；默认 AI（AI 配置置首的新序）
function gotoPage(page) {
  $$(".page").forEach((p) => p.classList.remove("on"));
  $("#page-" + page).classList.add("on");
  if (page !== "ai") closeAiForm(); // 离开 AI 页收起模型弹窗（弹窗随页隐藏会残留旧编辑态）
  const isSetting = page !== "history";
  $("#settings-tabs").style.display = isSetting ? "flex" : "none";
  $("#btn-settings-open").style.display = isSetting ? "none" : "inline-flex";
  $("#btn-back-home").style.display = isSetting ? "inline-flex" : "none";
  $$(".nav-item[data-page]").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  if (isSetting) lastSettingPage = page;
  if (page === "history") refreshCurrentView();
  if (page === "ai") loadAiPage().catch(reportErr);
  if (page === "general") loadThemeValues().catch(reportErr);
  if (page === "agent") { refreshBridgeStatus(); loadAgentRegistry().catch(reportErr); refreshAudit(); }
  if (page === "doctor") runDoctor();
}
$$(".nav-item[data-page]").forEach((btn) => {
  btn.onclick = () => gotoPage(btn.dataset.page);
});
$("#btn-back-home").onclick = () => gotoPage("history");
$("#btn-settings-open").onclick = () => gotoPage(lastSettingPage);
$("#status-dot").onclick = () => gotoPage("doctor"); // 诊断状态点：异常时点击直达诊断

// ===== 操作条 =====
function reportErr(e) {
  const msg = "ERR: " + (e && e.message ? e.message : e);
  document.title = msg;
  console.error(e);
  showFrontendErr(msg);
}
$("#act-region").onclick = () => invoke("start_overlay", { kind: "region" }).catch(reportErr);
$("#card-agent").onclick = () => document.querySelector('.nav-item[data-page="agent"]').click();
$("#card-ai").onclick = () => document.querySelector('.nav-item[data-page="ai"]').click();
// 核心能力速览行：全部一步直达（点击→框选→松手即得结果；action 经 payload 预绑定）
// 未配 Key 的 AI 能力自然落入取景层引导卡
$("#cap-ocr").onclick = () => invoke("start_overlay", { kind: "region", action: "ocr" }).catch(reportErr);
$("#cap-scroll").onclick = () => invoke("start_overlay", { kind: "scroll" }).catch(reportErr);
$("#cap-pin").onclick = () => invoke("start_overlay", { kind: "region", action: "pin" }).catch(reportErr);
// AI 两卡一步直达：点击框选，松手自动执行（ai_action 经 payload 传给取景层；未配 Key 走取景层引导）
$("#cap-translate").onclick = () => invoke("start_overlay", { kind: "region", action: "translate" }).catch(reportErr);
$("#cap-ask").onclick = () => invoke("start_overlay", { kind: "region", action: "ask" }).catch(reportErr);

// 效率态动作条（与能力卡同款直达语义：点击即框选执行）+ 状态行入口
const STRIP_ACTIONS = [
  ["strip-region", { kind: "region" }],
  ["strip-ocr", { kind: "region", action: "ocr" }],
  ["strip-scroll", { kind: "scroll" }],
  ["strip-pin", { kind: "region", action: "pin" }],
  ["strip-translate", { kind: "region", action: "translate" }],
  ["strip-ask", { kind: "region", action: "ask" }],
];
for (const [id, payload] of STRIP_ACTIONS) {
  const el = document.getElementById(id);
  if (el) el.onclick = () => invoke("start_overlay", payload).catch(reportErr);
}
$("#strip-ai").onclick = () => document.querySelector('.nav-item[data-page="ai"]').click();
$("#strip-agent").onclick = () => document.querySelector('.nav-item[data-page="agent"]').click();

// 首页双态切换：有历史=效率态（动作条+状态行，最近截图为主内容）；无历史=引导态（三卡+能力速览）
function syncHomeMode(hasShots) {
  const g = $("#home-guide"), e = $("#home-eff");
  if (g) g.style.display = hasShots ? "none" : "";
  if (e) e.style.display = hasShots ? "" : "none";
}

// 状态行·Agent chip（权限态轻提示；详情在接入 Agent 页管理）
async function refreshAgentChip() {
  const chip = $("#strip-agent");
  if (!chip) return;
  try {
    const s = await invoke("get_settings");
    $("#strip-agent-text").textContent = s.agent_enabled ? "Agent · 允许调用" : "Agent · 已切断";
    chip.className = "statchip " + (s.agent_enabled ? "ok" : "warn");
  } catch (e) { /* 不阻塞首页 */ }
}

// 注册中心事件委托（轻量补丁会替换按钮节点，委托才不会丢事件）
$("#agent-reg").addEventListener("click", async (e) => {
  const reg = e.target.closest("[data-reg]");
  const unreg = e.target.closest("[data-unreg]");
  const copy = e.target.closest("[data-copy-mcp]");
  if (reg) {
    const id = reg.dataset.reg;
    agentConnecting[id] = Date.now() + 60000;
    loadAgentRegistry(true);
    try {
      await invoke("agent_register", { id });
    } catch (err) {
      delete agentConnecting[id];
      reg.title = String(err && err.message ? err.message : err);
    }
    loadAgentRegistry(true);
  } else if (unreg) {
    delete agentConnecting[unreg.dataset.unreg];
    try {
      await invoke("agent_unregister", { id: unreg.dataset.unreg });
    } catch (err) {
      unreg.title = String(err && err.message ? err.message : err);
    }
    loadAgentRegistry(true);
  } else if (copy) {
    const exe = await invoke("once_exe_path").catch(() => null);
    const old = copy.textContent;
    if (!exe) {
      copy.textContent = "未找到 once.exe";
      setTimeout(() => { copy.textContent = old; }, 2000);
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(
      { mcpServers: { onceglance: { command: exe, args: ["mcp"] } } }, null, 2));
    copy.textContent = "已复制";
    setTimeout(() => { copy.textContent = old; }, 1500);
  }
});
// act-ocr/act-scroll/act-window/act-fullscreen 的卡片已删——顶层绑定必须同链清理，
// 否则 $() 查到 null 赋值抛 TypeError、后半段 main.js 全部不执行（最近截图空白的根因）
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

// 首页视图状态：home=动作卡片+最近 8 张；full=搜索+全量网格
let homeView = "home";

function refreshCurrentView() {
  if (homeView === "home") loadRecent();
  else refreshHistory();
}

// 首页 AI 卡状态自适应（引导态「3 步开启」/ 部分就绪 / 绿色就绪态）。
// 就绪判定走功能位（两层制）：翻译/问图各自的「连接有 Key + 模型名非空」——
// 只查「有 Key」会误报，功能位缺模型名时调用必报错，与徽章宣称矛盾。
async function refreshAiCard() {
  try {
    const list = (await invoke("ai_list")) || [];
    let s = null;
    try { s = (await invoke("get_settings")).ai; } catch (e) {}
    const fmReady = (fm) => {
      if (!fm || !fm.model) return false;
      const c = list.find((p) => p.id === fm.profile_id);
      return !!(c && c.has_key);
    };
    const textOk = fmReady(s && s.translate), visionOk = fmReady(s && s.ask);
    const defT = s && s.translate && list.find((p) => p.id === s.translate.profile_id);
    const name = $("#ai-card-name"), desc = $("#ai-card-desc"), chip = $("#ai-card-chip");
    if (textOk && visionOk) {
      name.textContent = "AI 能力已就绪";
      desc.textContent = `${defT ? defT.name : ""} · 翻译、问图可用`;
      chip.textContent = "已就绪";
      chip.classList.add("ready");
    } else if (!list.some((p) => p.has_key)) {
      name.textContent = "开启 AI 能力";
      desc.textContent = "选服务商 → 贴 Key → 测试，一分钟接入";
      chip.textContent = "未配置";
      chip.classList.remove("ready");
    } else {
      // 有 Key 但功能位不全：缺哪个如实说（缺省连接 / 缺 Key / 缺模型名都算未就绪）
      name.textContent = "AI 能力部分就绪";
      desc.textContent = `翻译${textOk ? "可用" : "未就绪"} · 问图${visionOk ? "可用" : "未就绪"}，点击到模型配置页补全`;
      chip.textContent = "部分就绪";
      chip.classList.remove("ready");
    }
    // 效率态状态行同步（chip 不存在=引导态 DOM 缺失，跳过）
    const aiChip = $("#strip-ai");
    if (aiChip) {
      const anyKey = list.some((p) => p.has_key);
      $("#strip-ai-text").textContent = textOk && visionOk ? "AI 已就绪" : anyKey ? "AI 部分就绪" : "AI 未配置";
      aiChip.className = "statchip " + (textOk && visionOk ? "ok" : anyKey ? "warn" : "");
    }
  } catch (e) { /* AI 后端异常不阻塞首页 */ }
}

// 首页“最近截图”横排（8 张，业界同款动作导向下的记录速达）
async function loadRecent() {
  refreshAiCard();
  refreshAgentChip();
  try {
    const rows = await invoke("list_history", { query: "", limit: 8 });
    syncHomeMode(rows.length > 0);
    const list = $("#recent-strip");
    if (!rows.length) {
      list.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">还没有截图</div>按 Alt+Shift+A 试一次</div>`;
      return;
    }
    list.innerHTML = rows.map(cardHtml).join("");
    wireCards(list);
  } catch (e) {
    // 错误直出横排区（曾静默吞掉导致“最近截图”空白无诊断线索）
    $("#recent-strip").innerHTML = `<div class="empty" style="grid-column:1/-1">加载失败：${e && e.message ? e.message : e}</div>`;
    reportErr(e);
  }
}

// 抽出单卡 HTML（首页横排与全量网格共用）
// 文件名显示（P1）：路径按正反斜杠统一切分；OCR 行只在有识别文本时渲染——
// 「未识别」是每卡一行零信息噪音（2026-09-25 UI 评审 P1-1/P1-2）
function fileNameOf(p) { return p.split(/[\\/]+/).pop(); }
function ocrLineOf(r) { return r.ocr_preview ? `<div class="cardocr">「${escapeHtml(r.ocr_preview)}」</div>` : ""; }

function cardHtml(r) {
  const name = fileNameOf(r.path);
  return `
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
            ${ocrLineOf(r)}
          </div>
        </div>`;
}

function wireCards(list) {
  list.querySelectorAll("img[data-thumb]").forEach(async (img) => {
    try {
      img.src = await invoke("thumbnail", { path: img.dataset.thumb, maxW: 320 });
    } catch (e) { /* 图片可能被移动 */ }
  });
  list.querySelectorAll(".cardacts button").forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const card = b.closest(".card");
      if (b.dataset.act === "open") {
        await invoke("open_image", { path: card.dataset.path });
      } else if (b.dataset.act === "copypath") {
        await navigator.clipboard.writeText(card.dataset.path);
      }
    };
  });
  // 卡片单击打开详情（§4.6）
  list.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => openDetail(card.dataset.path).catch(console.error));
  });
}

// 全量历史（搜索+日期分组网格）——"查看全部"视图
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
        const name = fileNameOf(r.path);
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
            ${ocrLineOf(r)}
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

// 长路径中段省略（补-5）：保头尾可辨识（盘符/目录头 + 文件名），中段以 … 代替
function middleEllipsis(s, max = 56) {
  if (s.length <= max) return s;
  const keep = max - 1;
  return s.slice(0, Math.ceil(keep / 2)) + "…" + s.slice(s.length - Math.floor(keep / 2));
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
  const esc = s.esc_exit_confirm || { enabled: true, action: "" };
  $("#sw-escconfirm").classList.toggle("on", esc.enabled !== false);
  $("#sw-escconfirm").setAttribute("aria-checked", esc.enabled !== false);
  if (esc.enabled === false && esc.action) {
    $("#sw-escconfirm").title = `已记住「${esc.action === "save" ? "保存" : "不保存"}」——关闭本开关恢复每次询问`;
  } else {
    $("#sw-escconfirm").title = "";
  }
  $("#sw-autostart").classList.toggle("on", await invoke("autostart_status"));
  $("#sel-action").value = s.default_action;
  $("#save-dir-chip").textContent = s.save_root;
  $("#save-dir-chip").style.color = s.save_dir_writable ? "" : "var(--error)";

  // 快捷键展示 + 录制（SYS-2/3：点击 chip 录制，Esc 退出不改动，冲突即时反馈）
  const hk = s.hotkeys;
  const rows = [
    ["region", "区域截图", hk.region], ["fullscreen", "全屏截图", hk.fullscreen],
    ["ocr", "自动取字", hk.ocr], ["scroll", "长截图", hk.scroll], ["panel", "打开主面板", hk.panel],
    ["pin", "贴图", hk.pin], ["translate", "截图翻译", hk.translate], ["ask", "AI 问图", hk.ask],
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

  // 标注主题只读值（独立刷新：切页/窗口重新聚焦时也会重拉，保证与编辑器改动实时同步）
  await loadThemeValues();

  // 黑名单
  renderBlacklist(s.blacklist);

  // MCP 配置（once.exe 路径由后端解析：安装目录 → 资源目录 → install.sh 标准位 → 开发构建）
  // 长路径中段省略展示，复制按钮仍带完整配置（此前 textContent 整写还会顺手丢掉静态复制按钮）
  const onceExe = await invoke("once_exe_path").catch(() => null);
  const cmdShown = onceExe ? middleEllipsis(onceExe, 56) : "<安装 OnceGlance 后自动解析>";
  const fullJson = JSON.stringify({ mcpServers: { onceglance: { command: onceExe || "<安装 OnceGlance 后自动解析>", args: ["mcp"] } } }, null, 2);
  const mcpBox = $("#mcp-config");
  mcpBox.textContent = JSON.stringify({ mcpServers: { onceglance: { command: cmdShown, args: ["mcp"] } } }, null, 2);
  const mcpCopy = document.createElement("span");
  mcpCopy.className = "copy";
  mcpCopy.textContent = "复制";
  mcpCopy.dataset.copy = fullJson;
  mcpBox.appendChild(mcpCopy);
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
}

// 标注主题只读值：与 settings.annotation 逐字段对齐的全量镜像（§4.8）。
// Agent（CLI/MCP）标注未显式传参的属性继承以下值——本页即继承契约的可见形态。
// 刷新时机：loadSettingsUI / 切到主题页 / 主面板重新聚焦（截图标注回来即是最新一份）。
async function loadThemeValues() {
  const s = await invoke("get_settings");
  const a = s.annotation || {};
  const rv = (v) => `<span class="ro-value">${v}</span>`;
  const sw = (c) => `<span class="pathchip" style="color:${c}">■ ${c}</span>`;
  const yn = (b) => (b ? "开" : "关");
  const HEADS = { end: "单箭头", both: "双箭头", start: "起点箭头", none: "无箭头" };
  const LINE = { solid: "实线", dashed: "虚线", dotted: "点线" };
  const FILL = { outline: "描边", fill: "填充", outline_fill: "描边+浅填充" };
  const NUMS = { solid: "实心圆", outline: "描边圆", plain: "纯数字" };
  const MOSM = { mosaic: "像素化", pixelate: "像素化", blur: "模糊" };
  const FONTS = { default: "微软雅黑", simsun: "宋体", simhei: "黑体", kaiti: "楷体", segoe: "Segoe UI" };
  const ALIGNS = { left: "左对齐", center: "居中", right: "右对齐" };
  const tc = (a.tool_colors && typeof a.tool_colors === "object") ? a.tool_colors : null;
  const TOOLN = [["arrow", "箭头"], ["pen", "画笔"], ["marker", "高亮"], ["rect", "矩形"], ["ellipse", "椭圆"], ["text", "文字"], ["num", "序号"]];
  const tstyle = [a.text_bold && "粗体", a.text_italic && "斜体", a.text_underline && "下划线", a.text_shadow && "阴影"]
    .filter(Boolean).join(" · ") || "无";
  const tbg = a.text_background
    ? `开 · ${a.text_bg_color} · ${Math.round((a.text_bg_opacity ?? 1) * 100)}% · 圆角 ${a.text_bg_radius ?? 4}px`
    : "关";
  const fxShadow = a.output_shadow && a.output_shadow.on
    ? `开 · 模糊 ${a.output_shadow.blur ?? 24}px · ${a.output_shadow.color ?? "#000000"}` : "关";
  const fxBorder = a.output_border && a.output_border.on
    ? `开 · 宽 ${a.output_border.width ?? 6}px · ${a.output_border.color ?? "#FFFFFF"}` : "关";
  const roRow = (t, v) => `<div class="row disabled"><div class="label"><div class="t">${t}</div></div><div class="ctl">${v}</div></div>`;
  const roGroup = (title, rows) => `<div class="ptitle" style="font-size:13px">${title}</div><div class="group">${rows.join("")}</div>`;
  $("#theme-values").innerHTML =
    roGroup("全局", [roRow("主题色", sw(a.color ?? "#FF3B30"))])
    + (tc ? roGroup("每工具独立色（未单独记忆的工具回落全局主题色）", TOOLN.map(([k, n]) =>
        roRow(n, tc[k] ? sw(tc[k]) : rv("跟随主题色")))) : "")
    + roGroup("箭头", [
        roRow("宽度", rv(`${a.arrow_width ?? 8}px`)),
        roRow("头型", rv(HEADS[a.arrow_heads] ?? a.arrow_heads ?? "单箭头")),
        roRow("线型", rv(LINE[a.arrow_line_style] ?? a.arrow_line_style ?? "实线")),
      ])
    + roGroup("形状（矩形 / 椭圆）", [
        roRow("线宽", rv(`${a.shape_width ?? 6}px`)),
        roRow("填充", rv(FILL[a.shape_fill] ?? a.shape_fill ?? "描边")),
        roRow("圆角", rv(yn(!!a.shape_radius))),
        roRow("不透明度", rv(`${Math.round((a.shape_opacity ?? 1) * 100)}%`)),
        roRow("虚线描边", rv(yn(!!a.shape_dash))),
      ])
    + roGroup("文字", [
        roRow("字号", rv(`${a.text_size ?? 44}px`)),
        roRow("字体", rv(FONTS[a.text_family] ?? a.text_family ?? "微软雅黑")),
        roRow("样式", rv(tstyle)),
        roRow("对齐", rv(ALIGNS[a.text_align] ?? a.text_align ?? "左对齐")),
        roRow("行距", rv(a.text_line_height ?? 1.0)),
        roRow("背景", rv(tbg)),
        roRow("描边", rv(yn(!!a.text_stroke))),
      ])
    + roGroup("序号", [
        roRow("样式", rv(NUMS[a.step_style] ?? a.step_style ?? "实心圆")),
        roRow("直径", rv(`${a.step_diameter ?? 56}px`)),
        roRow("起始编号", rv(a.num_start ?? 1)),
      ])
    + roGroup("高亮 / 马赛克", [
        roRow("高亮不透明度", rv(`${Math.round((a.highlight_opacity ?? 0.4) * 100)}%`)),
        roRow("马赛克强度", rv(`块 ${a.mosaic_strength ?? 12}px`)),
        roRow("马赛克模式", rv(MOSM[a.mosaic_mode] ?? a.mosaic_mode ?? "像素化")),
      ])
    + roGroup("输出选项（整图特效）", [
        roRow("外阴影", rv(fxShadow)),
        roRow("边框", rv(fxBorder)),
      ]);
}

// Agent 一键接入注册中心：按配置文件粒度探测/注册/移除。
// 状态机由真实握手驱动：once mcp 收到 initialize 时记录握手（时间戳+来源父进程），
// 本页 1s 轮询 agent_list 同步三态：未接入 → 连接中…(60s 有界) → 已接入 / 已写入·等待首次连接。
const agentConnecting = {}; // id -> 截止时间(ms)；「连接中」覆盖态
let agentRegTimer = null;

function agentCtlHtml(a) {
  const connecting = Boolean(agentConnecting[a.id]) && agentConnecting[a.id] > Date.now() && a.conn !== "connected";
  if (a.conn === "connected") delete agentConnecting[a.id];
  const chip = a.conn === "connected"
    ? '<span class="tagok">已接入</span>'
    : a.conn === "awaiting"
      ? (connecting
        ? '<span class="pulse">连接中…</span>'
        : '<span style="color:var(--ov-fg-dim)" title="配置已写入；该客户端首次连接 MCP 后自动转为已接入">已写入 · 等待首次连接</span>')
      : (a.client_installed
        ? '<span class="tagdim">未接入</span>'
        : '<span style="color:var(--ov-fg-dim)">未检测到客户端</span>');
  let btn;
  if (connecting) btn = '<button class="btn" disabled>连接中…</button>';
  else if (a.mode === "copy-only") btn = `<button class="btn ghost" data-copy-mcp="${a.id}">复制配置</button>`;
  else if (a.registered) btn = `<button class="btn ghost" data-unreg="${a.id}">移除</button>`;
  else if (a.client_installed) btn = `<button class="btn" data-reg="${a.id}">一键接入</button>`;
  else btn = '<button class="btn" disabled>未安装</button>';
  return chip + ' ' + btn;
}

async function loadAgentRegistry(light = false) {
  const box = $("#agent-reg");
  if (!box) { showFrontendErr("loadAgentRegistry: #agent-reg 容器不存在"); return; }
  const list = await invoke("agent_list").catch((e) => { showFrontendErr("agent_list: " + (e && e.message ? e.message : e)); return null; });
  if (!list) return;
  if (light) {
    // 轻量补丁：只刷状态与按钮，不整表重绘（避免打断悬停/点击）
    for (const a of list) {
      const el = box.querySelector(`[data-ctl="${a.id}"]`);
      if (el) { const html = agentCtlHtml(a); if (el.innerHTML !== html) el.innerHTML = html; }
    }
    return;
  }
  try {
    box.innerHTML = list.map((a) => `
    <div class="row"><div class="label"><div class="t">${a.family} <span style="color:var(--ov-fg-dim)">· ${a.form}</span></div>
    <div class="d">${a.hint || a.config_path}</div></div>
    <div class="ctl"><span data-ctl="${a.id}">${agentCtlHtml(a)}</span></div></div>`).join("");
  } catch (e) {
    showFrontendErr("agent 列表渲染失败: " + (e && e.message ? e.message : e));
  }
}

function startAgentPoll() {
  if (agentRegTimer) return;
  agentRegTimer = setInterval(() => {
    if ($("#page-agent")?.classList.contains("on")) loadAgentRegistry(true).catch(() => {});
  }, 1000);
}
// 顶层调用必须放在 agentRegTimer/agentConnecting 声明之后——放前面会 TDZ 中断整个脚本后半区
startAgentPoll();

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
$("#sw-escconfirm").onclick = async () => {
  const s = await invoke("get_settings");
  const esc = s.esc_exit_confirm || { enabled: true, action: "" };
  // 关掉=恢复每次询问（清空记住的动作）；打开=仅启用弹窗，不改变已记住的选择
  await invoke("set_setting", { key: "esc_exit_confirm", value: { enabled: esc.enabled === false, action: esc.enabled === false ? "" : (esc.action || "") } });
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

// ===== AI 设置（v0.2 两层制：模型服务=纯连接；截图翻译/文字识别/AI 问图各选「服务+模型」互不绑定）=====
let aiPresets = [];
let aiEditingId = null; // null=新建，否则为编辑中的 profile id
let aiEditingHasKey = false; // 编辑态且已存 Key：换服务商时提醒 Key 归属
let aiSettings = null; // settings.ai 缓存（translate/ask 功能位 + ocr 引擎）
let aiConnList = [];   // 连接列表缓存（ai_list）
let aiFetchedModels = {}; // profile id → 已拉取的模型列表（datalist 增强）
let aiSub = "profiles"; // 当前子页（模型服务置首）

function aiPreset(id) { return aiPresets.find((p) => p.id === id); }
function aiConn(id) { return aiConnList.find((p) => p.id === id); }

async function loadAiPage() {
  if (!aiPresets.length) {
    try { aiPresets = await invoke("ai_presets"); } catch (e) { reportErr(e); }
  }
  try { const s = await invoke("get_settings"); aiSettings = s.ai || {}; } catch (e) { aiSettings = {}; }
  try { aiConnList = await invoke("ai_list"); } catch (e) { aiConnList = []; }
  renderAiFunc("translate");
  renderAiFunc("ask");
  renderAiOcr();
  await renderAiProfiles();
  await renderAiTemplates();
  const lang = $("#ai-trans-lang");
  if (lang) lang.value = (aiSettings && aiSettings.translate_lang) || "简体中文";
}

// 子导航切换（分段控件：截图翻译/文字识别/AI 问图/模型服务）
function aiShowSub(sub) {
  aiSub = sub;
  document.querySelectorAll("#ai-subnav [data-aisub]").forEach((b) => b.classList.toggle("on", b.dataset.aisub === sub));
  document.querySelectorAll("#page-ai .aisub").forEach((el) => el.classList.remove("on"));
  const target = document.getElementById(`ai-sub-${sub}`);
  if (target) target.classList.add("on");
}
$("#ai-subnav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-aisub]");
  if (b) aiShowSub(b.dataset.aisub);
});

// ===== 模型服务（纯连接）列表 =====
async function renderAiProfiles() {
  const box = $("#ai-profiles");
  try {
    aiConnList = await invoke("ai_list");
  } catch (e) {
    box.innerHTML = `<div class="row"><div class="label"><div class="d">加载失败：${e && e.message ? e.message : e}</div></div></div>`;
    return;
  }
  if (!aiConnList.length) {
    box.innerHTML = `<div class="row"><div class="label"><div class="d">暂无服务——添加后各功能即可引用</div></div></div>`;
  } else {
    box.innerHTML = aiConnList.map((p) => `
      <div class="row">
        <div class="label"><div class="t">${escapeHtml(p.name)} <span style="color:var(--text-tertiary)">· ${escapeHtml(p.provider_name)}</span></div>
          <div class="d">${escapeHtml(p.base_url)} · <span style="color:${p.has_key ? "var(--success)" : "var(--error)"}">${p.has_key ? "Key 已保存" : "未配 Key"}</span></div>
          <div class="d" data-ai-test="${p.id}" style="min-height:14px"></div>
        </div>
        <div class="ctl">
          <button class="btn" data-ai-test-btn="${p.id}">测试 Key</button>
          <button class="btn ghost" data-ai-edit="${p.id}">编辑</button>
          <button class="btn ghost danger" data-ai-del="${p.id}">删除</button>
        </div>
      </div>`).join("");
  }
  // 连接列表变化会影响功能位下拉与状态行，全部重刷
  renderAiFunc("translate");
  renderAiFunc("ask");
  renderAiOcr();
  refreshAiCard(); // 配置变化后同步首页 AI 卡状态
}

// ===== 弹窗：只管连接（名称/服务商/接口地址/Key），模型名在各功能页选择 =====
function openAiForm(profile = null) {
  aiEditingId = profile ? profile.id : null;
  aiEditingHasKey = !!(profile && profile.has_key);
  $("#ai-modal-title").textContent = profile ? "编辑模型服务" : "添加模型服务";
  $("#ai-modal").style.display = "flex";
  const keyhint = $("#ai-f-keyhint");
  keyhint.textContent = "仅存本机系统凭据管理器，不出现在设置文件，也不回显";
  keyhint.style.color = "";
  $("#ai-f-name").value = profile ? profile.name : "";
  const sel = $("#ai-f-provider");
  sel.innerHTML = aiPresets.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  sel.value = profile ? profile.provider : "zhipu";
  $("#ai-f-url").value = profile ? profile.base_url : (aiPreset(sel.value) || {}).base_url || "";
  $("#ai-f-key").value = "";
  $("#ai-f-key").placeholder = profile && profile.has_key ? "已保存——留空表示不修改" : "";
  aiSyncKeyLink(sel.value);
  const stat = $("#ai-f-stat");
  stat.textContent = "";
  stat.style.color = "";
  $("#ai-f-name").focus();
}

// 「获取 Key →」链接：按所选服务商跳转对应控制台
function aiSyncKeyLink(providerId) {
  const p = aiPreset(providerId);
  const a = $("#ai-f-keyurl");
  if (p && p.key_url) {
    a.href = p.key_url;
    a.style.display = "";
  } else {
    a.style.display = "none";
  }
}

// ===== 功能位（截图翻译 / AI 问图）：各选「服务+模型」，即时生效 =====
const AI_FUNCS = {
  translate: { profile: "#ai-tr-profile", model: "#ai-tr-model", drop: "#ai-tr-drop", list: "#ai-tr-list", fetch: "#ai-tr-fetch", test: "#ai-tr-test", stat: "#ai-tr-stat", kind: "text", modelsKey: "text_models", label: "截图翻译" },
  ask: { profile: "#ai-ask-profile", model: "#ai-ask-model", drop: "#ai-ask-drop", list: "#ai-ask-list", fetch: "#ai-ask-fetch", test: "#ai-ask-test", stat: "#ai-ask-stat", kind: "vision", modelsKey: "vision_models", label: "AI 问图" },
};

function aiFuncFm(key) {
  return (aiSettings && aiSettings[key]) || { profile_id: "", model: "" };
}

function renderAiFunc(key) {
  const def = AI_FUNCS[key];
  const fm = aiFuncFm(key);
  const sel = $(def.profile);
  sel.innerHTML = `<option value="">未设置</option>` + aiConnList.map((p) =>
    `<option value="${p.id}">${escapeHtml(p.name)}（${escapeHtml(p.provider_name)}）</option>`).join("");
  sel.value = fm.profile_id || "";
  $(def.model).value = fm.model || "";
  aiSyncFuncModels(key);
  aiRenderFuncStat(key);
}

// 服务选定后：收起下拉与拉取按钮状态（模型列表统一走 ▼ 下拉，预设建议+已拉取合并）
function aiSyncFuncModels(key) {
  const def = AI_FUNCS[key];
  const conn = aiConn($(def.profile).value);
  aiCloseLists();
  const fetchBtn = $(def.fetch);
  if (conn && conn.has_key) {
    fetchBtn.style.display = "";
    fetchBtn.disabled = false;
    fetchBtn.textContent = "拉取模型列表";
  } else {
    fetchBtn.style.display = "none";
  }
}

function aiRenderFuncStat(key) {
  const def = AI_FUNCS[key];
  const stat = $(def.stat);
  if (!stat) return;
  const fm = aiFuncFm(key);
  const conn = fm.profile_id ? aiConn(fm.profile_id) : null;
  if (!conn) {
    stat.textContent = aiConnList.length ? "未设置" : "未设置——先到「模型服务」添加一套连接";
    stat.style.color = "var(--text-tertiary)";
    return;
  }
  const ready = conn.has_key && !!fm.model;
  stat.textContent = `${conn.name} · ${fm.model || "（未填模型名）"} · ${conn.has_key ? "Key ✓" : "未配 Key"}`;
  stat.style.color = ready ? "var(--success)" : "var(--warn)";
}

// 即时生效（业界设置页惯例：改即存，无需保存按钮）
async function aiSaveFunc(key) {
  const def = AI_FUNCS[key];
  try {
    aiSettings = await invoke("ai_set_func", { func: key, profileId: $(def.profile).value, model: $(def.model).value.trim() });
    aiRenderFuncStat(key);
    refreshAiCard();
  } catch (e) { reportErr(e); }
}

async function aiTestFunc(key) {
  const def = AI_FUNCS[key];
  const stat = $(def.stat);
  const id = $(def.profile).value;
  const model = $(def.model).value.trim();
  if (!id || !model) {
    stat.textContent = "先选服务并填写模型名";
    stat.style.color = "var(--error)";
    return;
  }
  const conn = aiConn(id);
  if (conn && !conn.has_key) {
    stat.textContent = "未配 Key——到「模型服务」编辑并填入 API Key";
    stat.style.color = "var(--error)";
    return;
  }
  const btn = $(def.test);
  btn.disabled = true;
  stat.style.color = "";
  stat.textContent = "测试中…";
  try {
    const r = await invoke("ai_test", { id, model, kind: def.kind });
    stat.textContent = r.ok ? `✓ 连接成功 ${r.latency_ms}ms · ${model}` : `✕ ${r.message}`;
    stat.style.color = r.ok ? "var(--success)" : "var(--error)";
  } catch (e) {
    stat.textContent = "✕ " + (e && e.message ? e.message : e);
    stat.style.color = "var(--error)";
  }
  btn.disabled = false;
}

async function aiFetchFuncModels(key) {
  const def = AI_FUNCS[key];
  const id = $(def.profile).value;
  if (!id) return;
  const btn = $(def.fetch);
  btn.disabled = true;
  btn.textContent = "拉取中…";
  try {
    const r = await invoke("ai_fetch_models", { profileId: id });
    const models = (r && r.models) || [];
    aiFetchedModels[id] = models;
    btn.textContent = `已拉取 ${models.length} 个`;
  } catch (e) {
    btn.textContent = "拉取失败，点重试";
    reportErr(e);
    return;
  }
  btn.disabled = false;
  // 拉取完成自动弹列表（列表 = 已拉取 ∪ 预设建议）
  aiOpenList(def.list, aiModelsFor(key), new Set(aiFetchedModels[id] || []), $(def.model).value.trim(),
    (m) => { $(def.model).value = m; aiSaveFunc(key); });
}

// ===== 模型下拉列表（可编辑组合框：输入自由填写 + ▼ 出列表选择）=====
function aiCloseLists() {
  document.querySelectorAll("#page-ai .mlist").forEach((el) => (el.style.display = "none"));
}
function aiModelsFor(key) {
  const def = AI_FUNCS[key];
  const conn = aiConn($(def.profile).value);
  const preset = aiPreset(conn ? conn.provider : "");
  const suggestions = (preset && preset[def.modelsKey]) || [];
  const fetched = aiFetchedModels[$(def.profile).value] || [];
  return Array.from(new Set(fetched.concat(suggestions)));
}
function aiOpenList(listSel, models, fetchedSet, current, onPick) {
  aiCloseLists();
  const listEl = $(listSel);
  listEl.innerHTML = "";
  if (!models.length) {
    const empty = document.createElement("div");
    empty.className = "mi";
    empty.style.cssText = "cursor:default;color:var(--text-tertiary)";
    empty.textContent = "暂无模型，先拉取列表";
    listEl.appendChild(empty);
  } else {
    models.forEach((m) => {
      const div = document.createElement("div");
      div.className = "mi" + (m === current ? " cur" : "");
      const name = document.createElement("span");
      name.textContent = m;
      const tag = document.createElement("span");
      tag.className = "mtag";
      tag.textContent = fetchedSet && fetchedSet.has(m) ? "接口" : "预设";
      div.append(name, tag);
      div.addEventListener("click", () => { aiCloseLists(); onPick(m); });
      listEl.appendChild(div);
    });
  }
  listEl.style.display = "block";
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".combo")) aiCloseLists();
});

// ===== 文字识别子页：引擎三选（builtin / paddle / online） =====
function renderAiOcr() {
  const ocr = (aiSettings && aiSettings.ocr) || {};
  const engine = ocr.engine || "builtin";
  document.querySelectorAll("#ai-ocr-cards .engcard").forEach((c) => {
    c.classList.toggle("on", c.dataset.engine === engine);
  });
  const fm = ocr.online || { profile_id: "", model: "" };
  const sel = $("#ai-ocr-profile");
  sel.innerHTML = `<option value="">未设置</option>` + aiConnList.map((p) =>
    `<option value="${p.id}">${escapeHtml(p.name)}（${escapeHtml(p.provider_name)}）</option>`).join("");
  sel.value = fm.profile_id || "";
  $("#ai-ocr-model").value = fm.model || "";
  aiSyncOcrModels();
  refreshPaddleUI();
}

function aiSyncOcrModels() {
  const conn = aiConn($("#ai-ocr-profile").value);
  aiCloseLists();
  // 获取 Key 链接跟随所选连接的服务商
  const a = $("#ai-ocr-keyurl");
  const p = aiPreset(conn ? conn.provider : "");
  if (p && p.key_url) {
    a.href = p.key_url;
    a.style.display = "";
  } else {
    a.style.display = "none";
  }
}

function aiOcrModels() {
  const conn = aiConn($("#ai-ocr-profile").value);
  const preset = aiPreset(conn ? conn.provider : "");
  const suggestions = (preset && preset.vision_models) || [];
  // 识别建议：服务商视觉模型 + 常见在线 OCR 名（DeepSeek-OCR 等）
  const extras = ["deepseek-ai/DeepSeek-OCR"];
  const fetched = aiFetchedModels[$("#ai-ocr-profile").value] || [];
  return Array.from(new Set(fetched.concat(suggestions, extras)));
}

async function aiSaveOcrOnline() {
  try {
    aiSettings = await invoke("ai_set_func", { func: "ocr_online", profileId: $("#ai-ocr-profile").value, model: $("#ai-ocr-model").value.trim() });
    refreshAiCard();
  } catch (e) { reportErr(e); }
}

async function setOcrEngine(engine) {
  try {
    aiSettings = await invoke("ai_set_ocr_engine", { engine });
    renderAiOcr();
    refreshAiCard();
  } catch (e) { reportErr(e); }
}

// 引擎卡片单选：点卡片即选中；卡内控件操作不触发重选
document.querySelector("#ai-ocr-cards").addEventListener("click", (e) => {
  if (e.target.closest(".ecbody")) return;
  const card = e.target.closest(".engcard");
  if (card && !card.classList.contains("on")) setOcrEngine(card.dataset.engine);
});

// 本地增强包状态（后端 ocr_pack_*；未就绪时保底显示未安装）
let paddleDownloading = false;
async function refreshPaddleUI() {
  const badge = $("#ai-paddle-badge");
  const stat = $("#ai-paddle-stat");
  const dlBtn = $("#ai-paddle-dl");
  const delBtn = $("#ai-paddle-del");
  let st = null;
  try { st = await invoke("ocr_pack_status"); } catch (e) { st = null; }
  if (!st) {
    badge.textContent = "未安装";
    badge.className = "engbadge dim";
    dlBtn.style.display = "";
    delBtn.style.display = "none";
    if (!paddleDownloading) stat.textContent = "";
    return;
  }
  if (st.installed) {
    badge.textContent = "已安装";
    badge.className = "engbadge";
    dlBtn.style.display = "none";
    delBtn.style.display = "";
    if (!paddleDownloading) stat.textContent = "";
  } else {
    badge.textContent = "未安装";
    badge.className = "engbadge dim";
    dlBtn.style.display = "";
    delBtn.style.display = "none";
  }
}

// 本地增强包：下载 / 删除 / 进度（后端经事件推送进度，魔搭默认源）
async function ocrPackDownload() {
  if (paddleDownloading) return;
  paddleDownloading = true;
  const stat = $("#ai-paddle-stat");
  const dlBtn = $("#ai-paddle-dl");
  dlBtn.disabled = true;
  stat.style.color = "";
  stat.textContent = "准备下载…";
  try {
    await invoke("ocr_pack_download", { source: $("#ai-paddle-src").value });
    stat.textContent = "已下载——点本卡片启用为识别引擎";
    stat.style.color = "var(--success)";
  } catch (e) {
    stat.textContent = "下载失败：" + (e && e.message ? e.message : e);
    stat.style.color = "var(--error)";
  }
  paddleDownloading = false;
  dlBtn.disabled = false;
  refreshPaddleUI();
}
async function ocrPackDelete() {
  const btn = $("#ai-paddle-del");
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "确认删除？";
    setTimeout(() => { if (!document.body.contains(btn)) return; btn.dataset.armed = ""; btn.textContent = "删除"; }, 3000);
    return;
  }
  btn.dataset.armed = "";
  btn.textContent = "删除";
  try { await invoke("ocr_pack_delete"); } catch (e) { reportErr(e); }
  refreshPaddleUI();
}
event.listen("ocr-pack-progress", (e) => {
  const { received, total } = e.payload || {};
  const stat = $("#ai-paddle-stat");
  if (!stat) return;
  const mb = (n) => (n / 1048576).toFixed(1);
  const pct = total ? Math.round((received / total) * 100) : 0;
  stat.style.color = "";
  stat.textContent = `下载中 ${pct}%（${mb(received)} / ${mb(total)} MB）`;
});

function closeAiForm() {
  $("#ai-modal").style.display = "none";
  aiEditingId = null;
}

$("#ai-add").onclick = () => { if (aiPresets.length) openAiForm(); else loadAiPage().catch(reportErr); };
$("#ai-f-cancel").onclick = closeAiForm;
$("#ai-modal-close").onclick = closeAiForm;
$("#ai-f-provider").onchange = () => {
  const p = aiPreset($("#ai-f-provider").value);
  if (p && p.base_url) $("#ai-f-url").value = p.base_url;
  $("#ai-f-hint").textContent = p ? p.hint : "";
  aiSyncKeyLink($("#ai-f-provider").value);
  // 编辑态换服务商：已保存的 Key 属于原服务商——不换 Key 连接必失败，明确提醒
  if (aiEditingHasKey) {
    const keyhint = $("#ai-f-keyhint");
    keyhint.textContent = "已保存的 Key 属于原服务商——切换服务商后请粘贴新服务商的 Key，否则连接会失败";
    keyhint.style.color = "var(--error)";
  }
};
$("#ai-f-save").onclick = async () => {
  const keyVal = $("#ai-f-key").value.trim();
  const payload = {
    id: aiEditingId || "",
    name: $("#ai-f-name").value,
    provider: $("#ai-f-provider").value,
    base_url: $("#ai-f-url").value,
  };
  try {
    await invoke("ai_save_profile", { profile: payload, apiKey: keyVal || null });
    closeAiForm();
    await renderAiProfiles();
  } catch (e) {
    const stat = $("#ai-f-stat");
    stat.textContent = "保存失败：" + (e && e.message ? e.message : e);
    stat.style.color = "var(--error)";
  }
};

// 功能位事件（即时生效）：服务切换 / 模型名改定 / 拉取 / 测试 / ▼ 下拉列表
for (const key of Object.keys(AI_FUNCS)) {
  const def = AI_FUNCS[key];
  $(def.profile).addEventListener("change", () => { aiSyncFuncModels(key); aiSaveFunc(key); });
  $(def.model).addEventListener("change", () => aiSaveFunc(key));
  $(def.fetch).addEventListener("click", () => aiFetchFuncModels(key));
  $(def.test).addEventListener("click", () => aiTestFunc(key));
  $(def.drop).addEventListener("click", () => {
    const listEl = $(def.list);
    const wasOpen = listEl.style.display !== "none";
    aiCloseLists();
    if (wasOpen) return;
    aiOpenList(def.list, aiModelsFor(key), new Set(aiFetchedModels[$(def.profile).value] || []),
      $(def.model).value.trim(), (m) => { $(def.model).value = m; aiSaveFunc(key); });
  });
}
$("#ai-ocr-profile").addEventListener("change", () => { aiSyncOcrModels(); aiSaveOcrOnline(); });
$("#ai-ocr-model").addEventListener("change", () => aiSaveOcrOnline());
$("#ai-ocr-drop").addEventListener("click", () => {
  const listEl = $("#ai-ocr-list");
  const wasOpen = listEl.style.display !== "none";
  aiCloseLists();
  if (wasOpen) return;
  aiOpenList("#ai-ocr-list", aiOcrModels(), new Set(aiFetchedModels[$("#ai-ocr-profile").value] || []),
    $("#ai-ocr-model").value.trim(), (m) => { $("#ai-ocr-model").value = m; aiSaveOcrOnline(); });
});
$("#ai-ocr-test").addEventListener("click", async () => {
  const stat = $("#ai-ocr-stat");
  const id = $("#ai-ocr-profile").value;
  const model = $("#ai-ocr-model").value.trim();
  if (!id || !model) {
    stat.textContent = "先选服务并填写识别模型名";
    stat.style.color = "var(--error)";
    return;
  }
  const conn = aiConn(id);
  if (conn && !conn.has_key) {
    stat.textContent = "未配 Key——到「模型服务」编辑并填入 API Key";
    stat.style.color = "var(--error)";
    return;
  }
  const btn = $("#ai-ocr-test");
  btn.disabled = true;
  stat.style.color = "";
  stat.textContent = "测试中…";
  try {
    const r = await invoke("ai_test", { id, model, kind: "vision" });
    stat.textContent = r.ok ? `✓ 可用 ${r.latency_ms}ms · ${model}` : `✕ ${r.message}`;
    stat.style.color = r.ok ? "var(--success)" : "var(--error)";
  } catch (e) {
    stat.textContent = "✕ " + (e && e.message ? e.message : e);
    stat.style.color = "var(--error)";
  }
  btn.disabled = false;
});
$("#ai-paddle-dl").addEventListener("click", () => ocrPackDownload());
$("#ai-paddle-del").addEventListener("click", () => ocrPackDelete());

// 配置行操作（事件委托：行内容会整体重绘）
$("#ai-profiles").addEventListener("click", async (e) => {
  const testBtn = e.target.closest("[data-ai-test-btn]");
  const editBtn = e.target.closest("[data-ai-edit]");
  const delBtn = e.target.closest("[data-ai-del]");
  if (testBtn) {
    // 连接级测试：OpenAI 兼容 /models 验证接口地址 + Key（不带模型名）
    const id = testBtn.dataset.aiTestBtn;
    const out = document.querySelector(`[data-ai-test="${id}"]`);
    if (!out) return;
    const v = aiConn(id);
    if (!v.has_key) {
      out.textContent = "未配 Key——点「编辑」填写 API Key";
      out.style.color = "var(--error)";
      return;
    }
    testBtn.disabled = true;
    out.style.color = "";
    out.textContent = "测试中…";
    try {
      const r = await invoke("ai_fetch_models", { profileId: id });
      out.textContent = `✓ Key 有效 · ${r.latency_ms}ms · 可用 ${r.models.length} 个模型`;
      out.style.color = "var(--success)";
    } catch (err) {
      out.textContent = "✕ " + (err && err.message ? err.message : err);
      out.style.color = "var(--error)";
    }
    testBtn.disabled = false;
  } else if (editBtn) {
    const list = await invoke("ai_list").catch(() => []);
    const v = list.find((x) => x.id === editBtn.dataset.aiEdit);
    if (v) openAiForm(v);
  } else if (delBtn) {
    // 内联二次确认（P3-8）：首击变「确认删除？」，3 秒不点回落；替代突兀的原生 confirm 弹窗
    const id = delBtn.dataset.aiDel;
    if (delBtn.dataset.armed === "1") {
      await invoke("ai_delete_profile", { id });
      if (aiEditingId === id) closeAiForm();
      renderAiProfiles().catch(reportErr);
    } else {
      delBtn.dataset.armed = "1";
      delBtn.classList.add("armed");
      delBtn.textContent = "确认删除？";
      setTimeout(() => {
        if (!document.body.contains(delBtn)) return; // 行已被重绘
        delBtn.dataset.armed = "";
        delBtn.classList.remove("armed");
        delBtn.textContent = "删除";
      }, 3000);
    }
  }
});

// 删除连接后全量重刷（renderAiProfiles 内部已连带刷新功能位）

// ===== AI 页·截图翻译目标语言 + 指令模板 =====
// Template row: built locally with a stable client id; persisted on change. Rows with an empty prompt stay local (kept for editing).
function tplRowEl(t) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.tplId = t.id || "local-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  row.innerHTML = `
    <div class="label" style="display:flex;flex-direction:column;gap:6px">
      <input type="text" class="formin" data-tpl-name value="${escapeHtml(t.name || "")}" placeholder="名称（问图指令上显示的文字）" style="width:100%">
      <input type="text" class="formin" data-tpl-prompt value="${escapeHtml(t.prompt || "")}" placeholder="指令内容（如 把图中内容整理成周报格式）" style="width:100%">
    </div>
    <div class="ctl"><button class="btn ghost danger" data-tpl-del>删除</button></div>`;
  row.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", aiSaveTemplates));
  const del = row.querySelector("[data-tpl-del]");
  del.addEventListener("click", () => {
    if (del.dataset.armed === "1") {
      row.remove();
      aiSaveTemplates().catch(reportErr);
    } else {
      del.dataset.armed = "1";
      del.textContent = "确认删除？";
      setTimeout(() => { del.dataset.armed = ""; del.textContent = "删除"; }, 3000);
    }
  });
  return row;
}
async function renderAiTemplates() {
  const box = $("#ai-tpl-rows");
  let tpls = [];
  try {
    const s = await invoke("get_settings");
    tpls = (s.ai && s.ai.templates) || [];
  } catch (e) { box.innerHTML = `<div class="row"><div class="label"><div class="d">加载失败</div></div></div>`; return; }
  box.innerHTML = "";
  if (!tpls.length) {
    const empty = document.createElement("div");
    empty.className = "row";
    empty.innerHTML = `<div class="label"><div class="d">暂无模板</div></div>`;
    box.appendChild(empty);
    return;
  }
  tpls.forEach((t) => box.appendChild(tplRowEl(t)));
}
async function aiSaveTemplates() {
  const tpls = [];
  document.querySelectorAll("#ai-tpl-rows .row[data-tpl-id]").forEach((row) => {
    const prompt = (row.querySelector("[data-tpl-prompt]") || {}).value || "";
    if (!prompt.trim()) return; // empty prompt is not persisted (row stays local until filled)
    tpls.push({
      id: row.dataset.tplId || "",
      name: (row.querySelector("[data-tpl-name]") || {}).value || "",
      prompt,
    });
  });
  await invoke("ai_templates_set", { templates: tpls }); // row ids are generated locally and stable; no write-back needed
}
$("#ai-tpl-add").onclick = () => {
  const box = $("#ai-tpl-rows");
  const emptyRow = box.querySelector(".row:not([data-tpl-id]) .d");
  if (emptyRow && emptyRow.textContent === "暂无模板") emptyRow.closest(".row").remove();
  // insert an editable row locally; sending a blank row to the backend gets it dropped (root cause of the dead button)
  box.appendChild(tplRowEl({ name: "", prompt: "" }));
  box.querySelector("[data-tpl-name]:last-of-type")?.focus();
};
$("#ai-trans-lang").onchange = async () => {
  try { await invoke("set_setting", { key: "translate_lang", value: $("#ai-trans-lang").value }); } catch (e) { reportErr(e); }
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
        const ai = (a.provider ? " · " + escapeHtml(a.provider) + (a.model ? "/" + escapeHtml(a.model) : "") : "")
          + (a.sent_image ? " · 已发送图像" : "");
        return `<div class="${cls}">${a.time.slice(11, 19)} · ${escapeHtml(a.command)} · ${a.elapsed_ms}ms · 退出码 ${a.status}${ai}${a.target_process ? " · " + escapeHtml(a.target_process) : ""}</div>`;
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
// 检查项中文化（P1-3）：Rust 侧 check 键是冻结的机器标识，仅 GUI 层做标签映射
const DOCTOR_LABEL = {
  capture: "捕获",
  hotkeys: "热键",
  config_dir: "配置目录",
  save_dir: "保存目录",
  ocr_engine: "OCR 引擎",
  runtime: "运行时",
  mcp: "MCP 连接",
  ai_model: "AI 模型",
};
let doctorRunSeq = 0; // 自检代次：进页自动跑与手动点击并发时，旧恢复定时器不得覆盖新轮文案
async function runDoctor() {
  const btn = $("#btn-doctor");
  const myRun = ++doctorRunSeq;
  if (btn) { btn.disabled = true; btn.textContent = "自检中…"; }
  const t0 = performance.now();
  try {
    const r = await invoke("doctor_run");
    const ms = Math.round(performance.now() - t0);
    // 总结态置顶（补-6）：一眼见全局，下方列表降为明细；附项数与用时（新鲜度可视化）
    const bad = r.items.filter((it) => !it.ok).length;
    const sum = bad
      ? `<div class="doctor-sum bad"><span class="d-bad">✕</span><span>${bad} 项异常</span><span style="font-weight:400;font-size:11.5px;color:var(--text-tertiary)">${r.items.length} 项检查 · ${ms}ms</span></div>`
      : `<div class="doctor-sum ok"><span class="d-ok">✓</span><span>一切正常</span><span style="font-weight:400;font-size:11.5px;color:var(--text-tertiary)">${r.items.length} 项检查 · ${ms}ms</span></div>`;
    $("#doctor-list").innerHTML = sum + r.items.map((it) => `
    <div class="doctor-item">
      <span class="${it.ok ? "d-ok" : "d-bad"}">${it.ok ? "✓" : "✕"}</span>
      <span style="width:90px">${DOCTOR_LABEL[it.check] || it.check}</span>
      <span style="color:var(--text-secondary)">${it.detail || ""}</span>
    </div>`).join("");
    const dot = $("#status-dot");
    dot.className = "statusdot " + (r.ok_all ? "" : "warn");
    // tooltip 带当前状态文字（补-7）：「绿=正常」对色弱/新用户不自明
    dot.title = r.ok_all ? "诊断状态：一切正常，点击查看" : "诊断状态：有可修复项，点击直达诊断";
    // 完成信号（业界：重跑必须有可见反馈——检查快时"自检中"一闪而过像没反应）
    if (btn) {
      btn.textContent = bad ? `✕ ${bad} 项异常` : `✓ 已复核 ${r.items.length} 项`;
      setTimeout(() => { if (btn.disabled || doctorRunSeq !== myRun) return; btn.textContent = "重新自检"; }, 1500);
    }
  } catch (e) {
    reportErr(e);
  } finally {
    if (btn) { btn.disabled = false; }
    const at = $("#doctor-ran-at");
    if (at) at.textContent = "上次自检 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }
}
$("#btn-doctor").onclick = runDoctor;

// ===== 事件 =====
event.listen("nav-to", (e) => {
  let page = e.payload;
  let sub = null;
  // 支持 "ai-translate"/"ai-ocr"/"ai-ask"/"ai-profiles"：直达 AI 页对应功能区
  if (page && page.startsWith("ai-")) { sub = page.slice(3); page = "ai"; }
  const btn = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (btn) btn.click();
  if (sub) aiShowSub(sub);
});
// 托盘「Agent 调用」勾选变化：设置页开关/状态行与首页状态 chip 即时回填
// （此前只在落盘、页面不刷新，显示旧态误导用户）
event.listen("agent-permission-changed", () => {
  loadSettingsUI().catch(() => {});
  refreshAgentChip().catch(() => {});
});
event.listen("toast-shown", () => refreshHistory());
// 主面板从托盘/后台回到前台：标注默认值重拉一次（截图时改了工具属性，回来即见最新值）
event.listen("tauri://focus", () => {
  if ($("#page-general") && $("#page-general").classList.contains("on")) loadThemeValues().catch(reportErr);
});


// ===== 窗口尺寸记忆（P3-9）：详情页会临时改窗口尺寸，那些变化不计入记忆 =====
let mainWindowSize = null;
let winSizeTimer = null;
invoke("get_settings").then((s) => {
  if (Array.isArray(s.win_size) && s.win_size.length === 2) mainWindowSize = s.win_size;
}).catch(() => {});
window.addEventListener("resize", () => {
  if (detailState) return;
  clearTimeout(winSizeTimer);
  winSizeTimer = setTimeout(() => {
    const sz = [window.innerWidth, window.innerHeight];
    mainWindowSize = sz;
    invoke("set_setting", { key: "win_size", value: sz }).catch(() => {});
  }, 800);
});

// ===== 资产详情（§4.6：文字块与图片联动、版本时间线）=====
let detailState = null; // { basePath, scale, fit, data }——fit=适应窗口；free 时 scale=显示宽/原图宽

function escapeSel(s) { return s.replace(/"/g, "&quot;"); }

// 像素保真：1:1 指「物理像素 1:1」——CSS 显示宽须除以 devicePixelRatio（DPI≠100% 时
// HTML 的 CSS px 与屏幕物理 px 不等尺），插值只发生在用户主动缩放时
function applyDetailZoom() {
  const img = $("#detail-img");
  const vp = $("#detail-viewport");
  if (!img.naturalWidth || !vp) return;
  const natW = img.naturalWidth, natH = img.naturalHeight;
  const dpr = window.devicePixelRatio || 1;
  if (detailState.fit) {
    const k = Math.min((vp.clientWidth - 24) * dpr / natW, (520 - 24) * dpr / natH);
    detailState.scale = k;
    img.style.width = Math.max(40, Math.round(natW * k / dpr)) + "px";
  } else {
    img.style.width = Math.max(40, Math.round(natW * detailState.scale / dpr)) + "px";
  }
  $("#detail-zoom-pct").textContent = Math.round(detailState.scale * 100) + "%";
  setTimeout(positionBboxes, 60);
}

async function openDetail(path) {
  const data = await invoke("detail_data", { path });
  const m = data.manifest || {};
  detailState = { basePath: path, scale: 1, fit: false, data };
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
  // 主图：默认 1:1 原图直出（与屏幕原始画面逐像素一致，插值只发生在用户主动缩放时）
  const img = $("#detail-img");
  img.src = await invoke("thumbnail", { path, maxW: 99999 });
  detailState.scale = 1;
  detailState.fit = false;
  img.onload = () => setTimeout(() => { if (detailState) applyDetailZoom(); }, 30);
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
  detailState.fit = false;
  detailState.scale = 1;
  invoke("thumbnail", { path: p, maxW: 99999 }).then((url) => {
    const bw = $("#detail-imgwrap");
    bw.querySelectorAll(".bboxhl").forEach((e) => e.remove());
    const img = $("#detail-img");
    img.src = url;
    img.onload = () => setTimeout(() => { if (detailState) applyDetailZoom(); }, 30);
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
    // 回到主面板记忆尺寸（P3-9）；无记忆值时回落默认
    const sz = mainWindowSize || [780, 560];
    if (LS) getCurrentWindow().setSize(new LS(sz[0], sz[1]));
  } catch (e) { console.error(e); }
  $$(".page").forEach((p) => p.classList.remove("on"));
  $("#page-history").classList.add("on");
  // 顶行同步回首页视图（详情只能从首页进入，直接套用 gotoPage 的顶行状态）
  $("#settings-tabs").style.display = "none";
  $("#btn-settings-open").style.display = "inline-flex";
  $("#btn-back-home").style.display = "none";
  $$(".nav-item[data-page]").forEach((b) => b.classList.remove("active"));
  refreshCurrentView();
  // 详情页可能改过视图显示状态，按 homeView 恢复
  $("#home-view").style.display = homeView === "home" ? "" : "none";
  $("#history-full").style.display = homeView === "home" ? "none" : "";
  syncRecentAllBtn();
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
  const img = $("#detail-img");
  const cur = detailState.fit ? img.clientWidth / (img.naturalWidth || 1) : detailState.scale;
  setDetailZoom(cur * (e.deltaY < 0 ? 1.15 : 0.87), false);
});
$("#detail-zoom-100").onclick = () => detailState && setDetailZoom(1, false);
$("#detail-zoom-fit").onclick = () => detailState && setDetailZoom(0, true);
function setDetailZoom(scale, fit) {
  detailState.fit = fit;
  detailState.scale = fit ? detailState.scale : Math.min(8, Math.max(0.05, scale));
  applyDetailZoom();
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if ($("#ai-modal").style.display === "flex") { closeAiForm(); return; } // 弹窗最上层：先关弹窗
    if ($("#page-detail").classList.contains("on")) closeDetail();
  }
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

// ===== 桥接状态（异常才显示：在线不占版面，离线出警示条）=====
async function refreshBridgeStatus() {
  const el = $("#bridge-status");
  if (!el) return;
  try {
    const r = await invoke("bridge_ping");
    if (!(r && r.ok && r.data)) throw new Error(r && r.error ? r.error.message || "未知" : "空响应");
    el.style.display = "none";
  } catch (e) {
    el.textContent = "桥接离线（CLI/MCP 仍直接驱动内核，功能不受影响）：" + (e && e.message ? e.message : e);
    el.style.display = "block";
  }
}

// ===== 首页/全量历史视图切换 =====
// 箭头用 chevron 图标旋转（P2-1：↓ 字符小字号形似数字 1，曾被误读成「查看全部 1」）
function syncRecentAllBtn() {
  $("#recent-all-label").textContent = homeView === "home" ? "查看全部" : "收起";
  const chev = $("#recent-all-chev");
  if (chev) chev.classList.toggle("up", homeView !== "home");
}
function showHomeView() {
  homeView = "home";
  $("#home-view").style.display = "";
  $("#history-full").style.display = "none";
  syncRecentAllBtn();
  loadRecent();
}
function showFullView() {
  homeView = "full";
  $("#home-view").style.display = "none";
  $("#history-full").style.display = "";
  syncRecentAllBtn();
  refreshHistory();
}
$("#recent-all").onclick = () => (homeView === "home" ? showFullView() : showHomeView());
$("#back-home").onclick = showHomeView;

// 初始化
refreshBridgeStatus();
showHomeView();
loadSettingsUI();
runDoctor();
