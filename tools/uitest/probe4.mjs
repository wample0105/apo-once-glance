import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9336;
const BED = "file:///" + path.resolve("tools/uitest/testbed.html").split(path.sep).join("/");
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + path.resolve("tools/uitest/.p4"), "--window-size=1600,1000", "about:blank"], { stdio: "ignore" });
async function waitDebug() { for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const l = await r.json(); const p = l.find(t => t.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch (e) {} await sleep(200); } throw new Error("no devtools"); }
const ws = new WebSocket(await waitDebug());
await new Promise(r => ws.onopen = r);
let seq = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
async function evl(expr) { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }); if (r.result?.exceptionDetails) return "ERR: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 300); return r.result?.result?.value; }
await send("Page.navigate", { url: BED }); await sleep(1500);
console.log(await evl(`(() => {
  sel = {x:100,y:100,w:800,h:600}; setState("selected");
  const o = document.createElement("div");
  o.className="obj"; o.dataset.k="rect";
  o.style.cssText="position:absolute;left:300px;top:200px;width:200px;height:150px;";
  o.dataset.params = JSON.stringify({color:"#FF3B30", lw:6, fill:"outline"});
  layer.appendChild(o); setObjSel(o);
  const b = objBBox(o);
  const ob = document.getElementById("objsel");
  const d = document.getElementById("objdel");
  return JSON.stringify({
    bbox: b,
    objsel: { l: ob.style.left, t: ob.style.top, w: ob.style.width, h: ob.style.height },
    objdel: { l: d.style.left, t: d.style.top, disp: d.style.display },
    期望del: { l: sel.x + b.l + b.w + 12 - 8, t: sel.y + b.t - 12 - 8 }
  });
})()`));
chrome.kill(); process.exit(0);
