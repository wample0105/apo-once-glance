import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9337;
const BED = "file:///" + path.resolve("tools/uitest/testbed.html").split(path.sep).join("/");
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + path.resolve("tools/uitest/.p5"), "--window-size=1600,1000", "about:blank"], { stdio: "ignore" });
async function waitDebug() { for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const l = await r.json(); const p = l.find(t => t.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch (e) {} await sleep(200); } throw new Error("no devtools"); }
const ws = new WebSocket(await waitDebug());
await new Promise(r => ws.onopen = r);
let seq = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
async function evl(expr) { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }); if (r.result?.exceptionDetails) return "ERR: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 200); return r.result?.result?.value; }
// DPR=1.5 模拟（物理 2400x1500 / css 1600x1000）
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1.5, mobile: false });
await send("Page.navigate", { url: BED }); await sleep(1500);
console.log("dpr:", await evl("window.devicePixelRatio"));
const r = await evl(`(() => {
  sel = {x:200,y:200,w:1333,h:733}; setState("selected");
  const o = document.createElement("span");
  o.className="obj"; o.dataset.k="rect";
  o.style.cssText="position:absolute;left:433px;top:133px;width:133px;height:67px;";
  o.dataset.params = JSON.stringify({color:"#FF3B30", lw:6, fill:"outline"});
  layer.appendChild(o); setObjSel(o);
  const d = document.getElementById("objdel");
  const ob = document.getElementById("objsel");
  const b = objBBox(o);
  return JSON.stringify({ b, del: { l: d.style.left, t: d.style.top, disp: d.style.display }, objsel: { l: ob.style.left, t: ob.style.top } });
})()`);
console.log(r);
const shotRes = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync("uitest_dpr15.png", Buffer.from(shotRes.result.data, "base64"));
console.log("shot saved");
chrome.kill(); process.exit(0);
