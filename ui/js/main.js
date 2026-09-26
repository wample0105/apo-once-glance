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
// 低频设置（AI/通用/AI 助手/诊断）收敛进齿轮入口，首页只留核心高频功能
let lastSettingPage = "general"; // 记住上次访问的设置分组，齿轮直达
function gotoPage(page) {
  $$(".page").forEach((p) => p.classList.remove("on"));
  $("#page-" + page).classList.add("on");
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
// 未配 Key 的 AI 能力自然落入取景层引导卡；窗口截图=点选窗口即复制
$("#cap-window").onclick = () => invoke("start_overlay", { kind: "window" }).catch(reportErr);
$("#cap-ocr").onclick = () => invoke("start_overlay", { kind: "region", action: "ocr" }).catch(reportErr);
$("#cap-scroll").onclick = () => invoke("start_overlay", { kind: "scroll" }).catch(reportErr);
$("#cap-pin").onclick = () => invoke("start_overlay", { kind: "region", action: "pin" }).catch(reportErr);
// AI 两卡一步直达：点击框选，松手自动执行（ai_action 经 payload 传给取景层；未配 Key 走取景层引导）
$("#cap-translate").onclick = () => invoke("start_overlay", { kind: "region", action: "translate" }).catch(reportErr);
$("#cap-ask").onclick = () => invoke("start_overlay", { kind: "region", action: "ask" }).catch(reportErr);

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

// 首页 AI 卡状态自适应（业界同款：未配置=引导态「3 步开启」；已配置=绿色就绪态）
async function refreshAiCard() {
  try {
    const profiles = await invoke("ai_list");
    const ready = (profiles || []).some((p) => p.has_key);
    const name = $("#ai-card-name"), desc = $("#ai-card-desc"), chip = $("#ai-card-chip");
    if (ready) {
      const def = profiles.find((p) => p.is_default_text || p.is_default_vision) || profiles[0];
      name.textContent = "AI 能力已就绪";
      desc.textContent = `${def.name} · 云端识别可用`;
      chip.textContent = "已就绪";
      chip.classList.add("ready");
    } else {
      name.textContent = "开启 AI 能力";
      desc.textContent = "选服务商 → 贴 Key → 测试，一分钟接入";
      chip.textContent = "未配置";
      chip.classList.remove("ready");
    }
  } catch (e) { /* AI 后端异常不阻塞首页 */ }
}

// 首页“最近截图”横排（8 张，业界同款动作导向下的记录速达）
async function loadRecent() {
  refreshAiCard();
  try {
    const rows = await invoke("list_history", { query: "", limit: 8 });
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

// ===== 设置加载 =====
async function loadSettingsUI() {
  const s = await invoke("get_settings");
  // Agent 状态
  const dot = $("#agent-dot");
  dot.classList.toggle("off", !s.agent_enabled);
  const stat = $("#agent-stat");
  if (s.agent_enabled) {
    stat.textContent = "当前状态：允许（AI 助手可调用截图、OCR、标注）";
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

  // 标注主题只读值（独立刷新：切页/窗口重新聚焦时也会重拉，保证与编辑器改动实时同步）
  await loadThemeValues();

  // 黑名单
  renderBlacklist(s.blacklist);

  // MCP 配置（once.exe 路径由后端解析：安装目录 → 资源目录 → install.sh 标准位 → 开发构建）
  const onceExe = await invoke("once_exe_path").catch(() => null);
  $("#mcp-config").textContent = JSON.stringify({
    mcpServers: {
      onceglance: {
        command: onceExe || "<安装 OnceGlance 后自动解析>",
        args: ["mcp"],
      },
    },
  }, null, 2);
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
        ? '<span class="tagok" style="color:var(--error)">未接入</span>'
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

// ===== AI 配置中心（v0.2 M1：BYOK 模型配置，Key 只进系统凭据管理器）=====
let aiPresets = [];
let aiEditingId = null; // null=新建，否则为编辑中的 profile id

async function loadAiPage() {
  if (!aiPresets.length) {
    try { aiPresets = await invoke("ai_presets"); } catch (e) { reportErr(e); }
  }
  await renderAiProfiles();
  await renderAiTemplates();
  try {
    const s = await invoke("get_settings");
    const lang = $("#ai-trans-lang");
    if (lang) lang.value = (s.ai && s.ai.translate_lang) || "简体中文";
  } catch (e) {}
}

function aiPreset(id) { return aiPresets.find((p) => p.id === id); }

async function renderAiProfiles() {
  const box = $("#ai-profiles");
  let list = [];
  try {
    list = await invoke("ai_list");
  } catch (e) {
    box.innerHTML = `<div class="row"><div class="label"><div class="d">加载失败：${e && e.message ? e.message : e}</div></div></div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="row"><div class="label"><div class="d">还没有模型配置——添加一套即可开启 AI 增强（截图翻译、问图等）</div></div></div>`;
  } else {
    box.innerHTML = list.map((p) => {
      const badges = [
        p.is_default_text ? '<span class="tagok">默认文字</span>' : "",
        p.is_default_vision ? '<span class="tagok">默认视觉</span>' : "",
      ].filter(Boolean).join(" ");
      const models = [p.text_model ? `文字 ${escapeHtml(p.text_model)}` : "", p.vision_model ? `视觉 ${escapeHtml(p.vision_model)}` : ""]
        .filter(Boolean).join(" · ") || "未配置模型";
      return `
      <div class="row">
        <div class="label"><div class="t">${escapeHtml(p.name)} <span style="color:var(--text-tertiary)">· ${p.provider_name}</span> ${badges}</div>
          <div class="d">${models} · <span style="color:${p.has_key ? "var(--success)" : "var(--error)"}">${p.has_key ? "Key 已保存" : "未配 Key"}</span></div>
          <div class="d" data-ai-test="${p.id}" style="min-height:14px"></div>
        </div>
        <div class="ctl">
          <button class="btn" data-ai-test-btn="${p.id}">测试连接</button>
          <button class="btn ghost" data-ai-edit="${p.id}">编辑</button>
          <button class="btn ghost danger" data-ai-del="${p.id}">删除</button>
        </div>
      </div>`;
    }).join("");
  }
  const mkDefaults = (sel, role) => {
    const el = $(sel);
    el.innerHTML = `<option value="">未指定</option>` + list.map((p) =>
      `<option value="${p.id}" ${(role === "text" ? p.is_default_text : p.is_default_vision) ? "selected" : ""}>${escapeHtml(p.name)}（${p.provider_name}）</option>`).join("");
  };
  mkDefaults("#ai-default-text", "text");
  mkDefaults("#ai-default-vision", "vision");
  const cloud = $("#ai-cloud-state");
  if (cloud) cloud.textContent = list.some((p) => p.vision_model && p.has_key) ? "可用（主动触发时才发送截图）" : "未配置";
  refreshAiCard(); // 配置变化后同步首页 AI 卡状态
}

function openAiForm(profile = null) {
  aiEditingId = profile ? profile.id : null;
  $("#ai-form").style.display = "";
  $("#ai-f-name").value = profile ? profile.name : "";
  const sel = $("#ai-f-provider");
  sel.innerHTML = aiPresets.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  sel.value = profile ? profile.provider : "zhipu";
  $("#ai-f-url").value = profile ? profile.base_url : (aiPreset(sel.value) || {}).base_url || "";
  $("#ai-f-key").value = "";
  $("#ai-f-key").placeholder = profile && profile.has_key ? "已保存——留空表示不修改" : "";
  $("#ai-f-text").value = profile ? profile.text_model : "";
  $("#ai-f-vision").value = profile ? profile.vision_model : "";
  aiSyncKeyLink(sel.value);
  // 拉取模型按钮：仅已保存且 Key 就绪的配置可用（凭据库才有 Key 可调 /models）
  const fetchBtn = $("#ai-f-fetch");
  fetchBtn.style.display = profile && profile.has_key ? "" : "none";
  fetchBtn.disabled = false;
  fetchBtn.textContent = "拉取模型列表";
  const stat = $("#ai-f-stat");
  stat.textContent = "";
  stat.style.color = "";
  aiFillDatalist(sel.value);
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

// 一键拉取该配置的可用模型（OpenAI 兼容 /models），填充文字/视觉两个 datalist
async function aiFetchModels() {
  const id = aiEditingId;
  if (!id) return;
  const btn = $("#ai-f-fetch");
  btn.disabled = true;
  btn.textContent = "拉取中…";
  try {
    const models = await invoke("ai_fetch_models", { profileId: id });
    const opts = (models || []).map((m) => `<option value="${m}">`).join("");
    $("#ai-dl-text").innerHTML = opts;
    $("#ai-dl-vision").innerHTML = opts;
    btn.textContent = `已拉取 ${(models || []).length} 个模型`;
  } catch (e) {
    btn.textContent = "拉取失败，点重试";
    reportErr(e);
    return;
  }
  btn.disabled = false;
}

function aiFillDatalist(providerId) {
  const p = aiPreset(providerId);
  $("#ai-f-hint").textContent = p ? p.hint : "";
  $("#ai-dl-text").innerHTML = ((p && p.text_models) || []).map((m) => `<option value="${m}">`).join("");
  $("#ai-dl-vision").innerHTML = ((p && p.vision_models) || []).map((m) => `<option value="${m}">`).join("");
}

function closeAiForm() {
  $("#ai-form").style.display = "none";
  aiEditingId = null;
}

$("#ai-add").onclick = () => { if (aiPresets.length) openAiForm(); else loadAiPage().catch(reportErr); };
$("#ai-f-cancel").onclick = closeAiForm;
$("#ai-f-provider").onchange = () => {
  const p = aiPreset($("#ai-f-provider").value);
  if (p && p.base_url) $("#ai-f-url").value = p.base_url;
  aiFillDatalist($("#ai-f-provider").value);
  aiSyncKeyLink($("#ai-f-provider").value);
};
$("#ai-f-fetch").onclick = () => aiFetchModels();
$("#ai-f-save").onclick = async () => {
  const keyVal = $("#ai-f-key").value.trim();
  const payload = {
    id: aiEditingId || "",
    name: $("#ai-f-name").value,
    provider: $("#ai-f-provider").value,
    base_url: $("#ai-f-url").value,
    text_model: $("#ai-f-text").value,
    vision_model: $("#ai-f-vision").value,
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

// 配置行操作（事件委托：行内容会整体重绘）
$("#ai-profiles").addEventListener("click", async (e) => {
  const testBtn = e.target.closest("[data-ai-test-btn]");
  const editBtn = e.target.closest("[data-ai-edit]");
  const delBtn = e.target.closest("[data-ai-del]");
  if (testBtn) {
    const id = testBtn.dataset.aiTestBtn;
    const out = document.querySelector(`[data-ai-test="${id}"]`);
    if (!out) return;
    const list = await invoke("ai_list").catch(() => []);
    const v = list.find((x) => x.id === id);
    const kinds = [];
    if (v && v.text_model) kinds.push("text");
    if (v && v.vision_model) kinds.push("vision");
    if (!kinds.length) {
      out.textContent = "未配置模型——先「编辑」填写文字或视觉模型";
      out.style.color = "var(--error)";
      return;
    }
    if (!v.has_key) {
      out.textContent = "未配 Key——点「编辑」填写 API Key";
      out.style.color = "var(--error)";
      return;
    }
    testBtn.disabled = true;
    out.style.color = "";
    out.textContent = "测试中…";
    const lines = [];
    const label = (k) => (k === "text" ? "文字" : "视觉");
    for (const k of kinds) {
      try {
        const r = await invoke("ai_test", { id, kind: k });
        lines.push(`${label(k)} ${r.ok ? "✓ " + r.latency_ms + "ms" : "✕ " + r.message}`);
      } catch (err) {
        lines.push(`${label(k)} ✕ ${err && err.message ? err.message : err}`);
      }
    }
    testBtn.disabled = false;
    out.textContent = lines.join("  ");
    out.style.color = lines.every((l) => l.includes("✓")) ? "var(--success)" : "var(--error)";
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

$("#ai-default-text").onchange = async () => {
  try { await invoke("ai_set_default", { role: "text", id: $("#ai-default-text").value || null }); } catch (e) { reportErr(e); }
  renderAiProfiles().catch(() => {});
};
$("#ai-default-vision").onchange = async () => {
  try { await invoke("ai_set_default", { role: "vision", id: $("#ai-default-vision").value || null }); } catch (e) { reportErr(e); }
  renderAiProfiles().catch(() => {});
};

// ===== AI 页·截图翻译目标语言 + 指令模板 =====
async function renderAiTemplates() {
  const box = $("#ai-tpl-rows");
  let tpls = [];
  try {
    const s = await invoke("get_settings");
    tpls = (s.ai && s.ai.templates) || [];
  } catch (e) { box.innerHTML = `<div class="row"><div class="label"><div class="d">加载失败</div></div></div>`; return; }
  if (!tpls.length) {
    box.innerHTML = `<div class="row"><div class="label"><div class="d">还没有自定义模板——添加后会在问图指令中出现</div></div></div>`;
    return;
  }
  box.innerHTML = tpls.map((t, i) => `
    <div class="row" data-tpl-id="${escapeHtml(t.id)}">
      <div class="label" style="display:flex;flex-direction:column;gap:6px">
        <input type="text" class="formin" data-tpl-name="${i}" value="${escapeHtml(t.name)}" placeholder="名称（问图指令上显示的文字）" style="width:100%">
        <input type="text" class="formin" data-tpl-prompt="${i}" value="${escapeHtml(t.prompt)}" placeholder="指令内容（如 把图中内容整理成周报格式）" style="width:100%">
      </div>
      <div class="ctl"><button class="btn ghost danger" data-tpl-del="${escapeHtml(t.id)}">删除</button></div>
    </div>`).join("");
  box.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", aiSaveTemplates));
  box.querySelectorAll("[data-tpl-del]").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.armed === "1") {
      const s = await invoke("get_settings");
      const tpls = ((s.ai && s.ai.templates) || []).filter((t) => t.id !== b.dataset.tplDel);
      await invoke("ai_templates_set", { templates: tpls });
      renderAiTemplates().catch(reportErr);
    } else {
      b.dataset.armed = "1";
      b.textContent = "确认删除？";
      setTimeout(() => { b.dataset.armed = ""; b.textContent = "删除"; }, 3000);
    }
  }));
}
async function aiSaveTemplates() {
  const tpls = [];
  document.querySelectorAll("#ai-tpl-rows .row[data-tpl-id]").forEach((row) => {
    tpls.push({
      id: row.dataset.tplId || "",
      name: (row.querySelector("[data-tpl-name]") || {}).value || "",
      prompt: (row.querySelector("[data-tpl-prompt]") || {}).value || "",
    });
  });
  const cfg = await invoke("ai_templates_set", { templates: tpls });
  // 回写后端分配的 id，避免继续编辑时重复建档
  document.querySelectorAll("#ai-tpl-rows .row[data-tpl-id]").forEach((row, i) => {
    const t = (cfg.templates || [])[i];
    if (t) row.dataset.tplId = t.id;
  });
}
$("#ai-tpl-add").onclick = async () => {
  const s = await invoke("get_settings");
  const tpls = ((s.ai && s.ai.templates) || []).concat([{ id: "", name: "", prompt: "" }]);
  await invoke("ai_templates_set", { templates: tpls });
  renderAiTemplates().catch(reportErr);
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
  save_dir: "保存目录",
  ocr_engine: "OCR 引擎",
  runtime: "运行时",
  mcp: "MCP 连接",
  ai_model: "AI 模型",
};
async function runDoctor() {
  const btn = $("#btn-doctor");
  if (btn) { btn.disabled = true; btn.textContent = "自检中…"; }
  try {
    const r = await invoke("doctor_run");
    $("#doctor-list").innerHTML = r.items.map((it) => `
    <div class="doctor-item">
      <span class="${it.ok ? "d-ok" : "d-bad"}">${it.ok ? "✓" : "✕"}</span>
      <span style="width:90px">${DOCTOR_LABEL[it.check] || it.check}</span>
      <span style="color:var(--text-secondary)">${it.detail || ""}</span>
    </div>`).join("");
    const dot = $("#status-dot");
    dot.className = "statusdot " + (r.ok_all ? "" : "warn");
    dot.title = r.ok_all ? "全部正常" : "有可修复项，点击直达诊断";
  } catch (e) {
    reportErr(e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "重新自检"; }
    const at = $("#doctor-ran-at");
    if (at) at.textContent = "上次自检 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }
}
$("#btn-doctor").onclick = runDoctor;

// ===== 事件 =====
event.listen("nav-to", (e) => {
  const page = e.payload;
  const btn = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (btn) btn.click();
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
  $("#recent-all").textContent = homeView === "home" ? "查看全部 ↓" : "↑ 收起";
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
function showHomeView() {
  homeView = "home";
  $("#home-view").style.display = "";
  $("#history-full").style.display = "none";
  $("#recent-all").textContent = "查看全部 ↓";
  loadRecent();
}
function showFullView() {
  homeView = "full";
  $("#home-view").style.display = "none";
  $("#history-full").style.display = "";
  $("#recent-all").textContent = "↑ 收起";
  refreshHistory();
}
$("#recent-all").onclick = () => (homeView === "home" ? showFullView() : showHomeView());
$("#back-home").onclick = showHomeView;

// 初始化
refreshBridgeStatus();
showHomeView();
loadSettingsUI();
runDoctor();
