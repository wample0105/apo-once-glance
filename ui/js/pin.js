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
    if (m.kind === "ai") { bootAi(m); return; }
    // 优先用 Rust 注入的 data URL（asset 协议对 Pictures 路径真机不可靠，曾 403 空窗）
    if (window.__PIN_SRC) document.getElementById("img").src = window.__PIN_SRC;
    else document.getElementById("img").src = convertFileSrc(m.path);
    // 四边阴影边距：Rust 侧窗口比图像外扩了 pad 物理像素，body 留出等量 CSS 内边距，
    // img 填充 content box——阴影正好落在边距区不被窗口裁掉
    if (m.pad) document.body.style.padding = (m.pad / (window.devicePixelRatio || 1)) + "px";
    lastPos = [m.x, m.y];
  } catch (e) { /* 元数据缺失：保持空窗 */ }
}

// AI 结果贴图（v0.2 M2）：文本卡片 + 复制/关闭；拖动与普通贴图同一套阈值交互
function bootAi(m) {
  document.getElementById("img").style.display = "none";
  const card = document.getElementById("ai-card");
  card.style.display = "flex";
  const text = window.__PIN_TEXT || m.ai_text || "";
  // 模型输出按 Markdown 富文本渲染（不可信输入：先整体转义，仅渲染器自产标签进 DOM）
  document.getElementById("ai-text").innerHTML = mdRender(text);
  document.getElementById("ai-meta").textContent = m.ai_meta || "";
  document.getElementById("ai-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(window.__PIN_TEXT || m.ai_text || "");
      const b = document.getElementById("ai-copy");
      b.textContent = "已复制";
      setTimeout(() => { b.textContent = "复制文本"; }, 1500);
    } catch (e) {}
  });
  document.getElementById("ai-close").addEventListener("click", () => invoke("pin_close", { id }));
  lastPos = [m.x, m.y];
  // 建窗高度是纯文本字数估算（clamp 150-720），渲染后按实际内容回调一次窗口高
  requestAnimationFrame(async () => {
    try {
      const t = document.getElementById("ai-text");
      const meta = document.getElementById("ai-meta");
      const bar = document.getElementById("ai-bar");
      const need = t.scrollHeight + meta.offsetHeight + bar.offsetHeight;
      await invoke("pin_resize_ai", { id, h: need });
    } catch (e) {}
  });
}

// 轻量 Markdown 渲染器（零依赖）：安全模型=先整体 HTML 转义，再只按白名单语法插入自产标签。
// 支持：围栏代码块/标题/有序无序列表（缩进嵌套）/表格/引用/分隔线/粗斜体/行内代码/链接。
function mdRender(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // 行内语法（输入已转义）
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 1) 围栏代码块先行提取为占位符（内部不做任何语法解析）
  const blocks = [];
  let text = esc(src).replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push("<pre><code>" + code.replace(/\n$/, "") + "</code></pre>");
    return "\u0000" + (blocks.length - 1) + "\u0000";
  });
  const isTableSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes("-");
  const cells = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  const lines = text.split("\n");
  const out = [];
  const listStack = [];   // { type: "ul"|"ol", indent }
  let para = [];
  let table = null;       // { head: [..], rows: [[..]] }
  const flushPara = () => {
    if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; }
  };
  const flushTable = () => {
    if (!table) return;
    let html = "<table><thead><tr>" + table.head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>";
    for (const r of table.rows) html += "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>";
    out.push(html + "</tbody></table>");
    table = null;
  };
  const closeLists = (indent) => {
    while (listStack.length && listStack[listStack.length - 1].indent > indent) {
      out.push("</" + listStack.pop().type + ">");
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = line.match(/^\s*/)[0].length;
    if (!trimmed) { closeLists(0); flushPara(); flushTable(); continue; }
    // 占位符（围栏代码块）
    const ph = trimmed.match(/^\u0000(\d+)\u0000$/);
    if (ph) { closeLists(0); flushPara(); flushTable(); out.push(blocks[Number(ph[1])]); continue; }
    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara(); closeLists(0);
      table = { head: cells(line), rows: [] };
      i++; // 跳过分隔行
      continue;
    }
    if (table) {
      if (line.includes("|")) { table.rows.push(cells(line)); continue; }
      flushTable();
    }
    // 标题
    const h = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeLists(0); flushPara(); out.push(`<h${h[1].length}>` + inline(h[2]) + `</h${h[1].length}>`); continue; }
    // 引用（连续行合并；文本已整体转义，前缀是 &gt;）
    if (trimmed.startsWith("&gt;")) {
      closeLists(0); flushPara();
      const quote = [trimmed.replace(/^&gt;\s?/, "")];
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith("&gt;")) {
        quote.push(lines[++i].trim().replace(/^&gt;\s?/, ""));
      }
      out.push("<blockquote><p>" + inline(quote.join(" ")) + "</p></blockquote>");
      continue;
    }
    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { closeLists(0); flushPara(); out.push("<hr>"); continue; }
    // 列表项（缩进嵌套；2 空格一层）
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara(); flushTable();
      const lv = Math.floor(li[1].length / 2);
      const type = /\d/.test(li[2]) ? "ol" : "ul";
      const top = listStack[listStack.length - 1];
      if (!top || top.indent < lv) { out.push("<" + type + ">"); listStack.push({ type, indent: lv }); }
      else if (top.indent > lv) { closeLists(lv); }
      else if (top.type !== type) { out.push("</" + top.type + "><" + type + ">"); listStack[listStack.length - 1] = { type, indent: lv }; }
      out.push("<li>" + inline(li[3]) + "</li>");
      continue;
    }
    // 普通段落行（单换行以 <br> 连接，贴合贴图阅读习惯）
    closeLists(0); flushTable();
    para.push(trimmed);
  }
  closeLists(0); flushPara(); flushTable();
  return out.join("\n");
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
// AI 结果贴图复用同一套拖动（绑在文本卡上；文字处于选中态时不触发拖动）
let downPos = null;
const pinImg = document.getElementById("img");
const aiCard = document.getElementById("ai-card");
function bindDrag(el) {
  if (!el) return;
  el.addEventListener("mousedown", (e) => {
    if (e.button === 0 && id) {
      if (el === aiCard && window.getSelection && String(window.getSelection())) return;
      e.preventDefault();
      downPos = [e.clientX, e.clientY];
    }
  });
  el.addEventListener("mousemove", (e) => {
    if (!downPos) return;
    if (Math.abs(e.clientX - downPos[0]) > 4 || Math.abs(e.clientY - downPos[1]) > 4) {
      downPos = null;
      window.__TAURI__.window.getCurrentWindow().startDragging();
    }
  });
}
bindDrag(pinImg);
bindDrag(aiCard);
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
