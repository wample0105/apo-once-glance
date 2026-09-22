// T24 诊断：mousedown 异常捕获 + 事件探针 + 守卫值
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const ROOT = resolve(import.meta.dirname, "../..");
const BED = "file:///" + resolve(ROOT, "tools/uitest/testbed.html").replace(/\\/g, "/");
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--remote-debugging-port=9344",
  "--user-data-dir=" + resolve(ROOT, "tools/uitest/.p12"), "about:blank",
], { stdio: "ignore" });
await sleep(1800);
function c(ws) {
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
}
const list = await (await fetch("http://127.0.0.1:9344/json")).json();
const ws = new WebSocket(list.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const call = c(ws);
await call("Runtime.enable");
await call("Page.navigate", { url: BED });
await sleep(1200);
const evl = async (e) => (await call("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const out = await evl(`(function(){
  const R = {};
  try {
    resetOverlayState();
    setSel({ x: 100, y: 100, w: 600, h: 400 }); setState("selected");
    setTool("mosaic");
    const lay = document.getElementById("layer");
    window.__md = 0; window.__mm = 0;
    lay.addEventListener("mousedown", () => { window.__md++; }, true);
    window.addEventListener("mousemove", () => { window.__mm++; }, true);
    window.__ld = lay.style.display + "|rect:" + Math.round(lay.getBoundingClientRect().left) + "," + Math.round(lay.getBoundingClientRect().top) + " " + Math.round(lay.getBoundingClientRect().width) + "x" + Math.round(lay.getBoundingClientRect().height);
    try { lay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 200, clientY: 200, button: 0 })); }
    catch (err) { R.downErr = String(err); }
    R.draftAfterDown = draft ? draft.k : null;
    window.addEventListener("mousemove", (ev) => {
      R.inside = { cx: ev.clientX, rectL: Math.round(layer.getBoundingClientRect().left), draftAlive: draft ? "yes" : "no", draftW: draft ? draft.el.style.width : null, dx: draft ? draft.x : null };
    });
    try { window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 350, clientY: 300 })); }
    catch (err) { R.moveErr = String(err); }
    R.afterMove = draft ? (draft.el.style.left + "/" + draft.el.style.width + "/" + draft.el.style.top + "/" + draft.el.style.height) : "draft-gone";
    try { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); }
    catch (err) { R.upErr = String(err); }
    R.mdHits = window.__md;
    R.mmHits = window.__mm;
    R.layerDispAtDispatch = window.__ld;
    R.objs = document.querySelectorAll("#layer .obj").length;
    R.state = state; R.tool = tool; R.editing = editing ? "YES" : "null"; R.objDrag = objDrag ? "YES" : "null";
  } catch (err) { R.outerErr = String(err); }
  return R;
})()`);
console.log(JSON.stringify(out));
chrome.kill();
