// 连接运行中的生产 exe（WebView2 --remote-debugging-port=9700），
// 读取 overlay 窗口真实 DOM，判断加载的 UI 是新版还是旧版。
// 用法: node tools/uitest/cdp-live.mjs
const base = "http://127.0.0.1:9700";
const list = await (await fetch(base + "/json")).json();
const t = list.find((p) => p.url.includes("overlay"));
if (!t) {
  console.log("未找到 overlay 页面。现有 targets:", list.map((p) => p.url));
  process.exit(1);
}
console.log("overlay target:", t.url);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
function call(id, method, params) {
  return new Promise((r) => {
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === id) r(m); };
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const r = await call(1, "Runtime.evaluate", {
  returnByValue: true,
  expression: `(function(){
    return {
      flymenu: !!document.querySelector('.flymenu'),
      pr_text_menu: !!document.getElementById('pr-text-menu'),
      pr_color_menu: !!document.getElementById('pr-color-menu'),
      OLD_pr_font: !!document.getElementById('pr-font'),
      OLD_pr_tsize: !!document.getElementById('pr-tsize'),
      OLD_pr_tlh: !!document.getElementById('pr-tlh'),
      OLD_objdel: !!document.getElementById('objdel'),
      sw_size: (document.querySelector('.flymenu .sw')||{}).outerHTML ? getComputedStyle(document.querySelector('.flymenu .sw')).width : null,
      html_len: document.documentElement.outerHTML.length
    };
  })()`,
});
console.log(JSON.stringify(r.result.result.value, null, 2));
ws.close();
