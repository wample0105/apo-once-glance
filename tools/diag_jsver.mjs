const t = (await (await fetch("http://127.0.0.1:9222/json")).json()).find((p) => p.url.includes("overlay"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { returnByValue: true, awaitPromise: true, expression: `fetch('/js/overlay.js').then(r=>r.text()).then(t2=>t2.includes('编辑中右键=结束输入')+'/jslen:'+t2.length)` } }));
const m = await new Promise((r) => ws.addEventListener("message", function h(e) { const d = JSON.parse(e.data); if (d.id === 1) { ws.removeEventListener("message", h); r(d); } }));
console.log(m.result?.result?.value);
ws.close();
