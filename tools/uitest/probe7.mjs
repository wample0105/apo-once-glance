import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9339;
const BED = "file:///" + path.resolve("tools/uitest/testbed.html").split(path.sep).join("/");
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + path.resolve("tools/uitest/.p7"), "--window-size=1600,1000", "about:blank"], { stdio: "ignore" });
async function waitDebug() { for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const l = await r.json(); const p = l.find(t => t.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch (e) {} await sleep(200); } throw new Error("no devtools"); }
const ws = new WebSocket(await waitDebug());
await new Promise(r => ws.onopen = r);
let seq = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
async function evl(expr) { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }); if (r.result?.exceptionDetails) return "ERR: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 300); return r.result?.result?.value; }
await send("Page.navigate", { url: BED }); await sleep(1500);
console.log("pr-aset exists:", await evl(`!!document.getElementById("pr-aset")`));
console.log("pr-text-menu children:", await evl(`document.getElementById("pr-text-menu").children.length`));

console.log("sel:", await evl(`(() => {
  sel = {x:100,y:100,w:800,h:600}; setState("selected");
  const o = document.createElement("div");
  o.className="obj"; o.dataset.k="text"; o.textContent="X";
  o.style.cssText="position:absolute;left:300px;top:280px;font-size:20px;";
  o.dataset.params = JSON.stringify({family:"default",size:20,color:"#FF3B30",bold:false,italic:false,underline:false,shadow:false,stroke:false,align:"left",line_height:1.0,background:"#FFF7D6",bg_opacity:1,bg_radius:4});
  layer.appendChild(o); setObjSel(o); return "ok";
})()`));
console.log("open:", await evl(`(() => { document.getElementById("pr-aset").click(); return document.getElementById("pr-text-menu").style.display; })()`));
console.log("clickblue:", await evl(`(() => { const sws = [...document.querySelectorAll("#pr-text-menu .sw[data-c]")]; const b = sws.find(s => s.dataset.c === "#E0F0FF"); if (!b) return "not-found: " + sws.map(x=>x.dataset.c).join(","); b.click(); return { bgNow: textBgColor, objBg: layer.querySelector(".obj").style.background }; })()`));
chrome.kill(); process.exit(0);
