import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9334;
const BED = "file:///" + path.resolve("tools/uitest/testbed.html").split(path.sep).join("/");
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + path.resolve("tools/uitest/.p2"), "--window-size=1600,1000", "about:blank"], { stdio: "ignore" });
async function waitDebug() { for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const l = await r.json(); const p = l.find(t => t.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch (e) {} await sleep(200); } throw new Error("no devtools"); }
const ws = new WebSocket(await waitDebug());
await new Promise(r => ws.onopen = r);
let seq = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
async function evl(expr) { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }); if (r.result?.exceptionDetails) return "ERR: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 260); return r.result?.result?.value; }
await send("Page.navigate", { url: BED }); await sleep(1500);
console.log("state:", await evl("typeof state !== 'undefined' ? state : 'n/a'"));
console.log("setup:", await evl(`
  sel = { x:100,y:100,w:800,h:600 }; setState("selected");
  const o = document.createElement("div");
  o.className="obj"; o.dataset.k="text"; o.textContent="X";
  o.dataset.params = JSON.stringify({family:"default",size:20,color:"#FF3B30",bold:false,italic:false,underline:false,shadow:false,stroke:false,align:"left",line_height:1.0,background:null});
  layer.appendChild(o); "ok"
`));
console.log("setObjSel 回填:", await evl("setObjSel(layer.querySelector('.obj')); textSize"));
console.log("obj 数:", await evl("layer.querySelectorAll('.obj').length"));
console.log("T2 IIFE:", await evl(`(()=>{ const o=layer.querySelector('.obj'); if(!o) return "obj null"; const p=JSON.parse(o.dataset.params); p.size=45; o.dataset.params=JSON.stringify(p); o.style.fontSize="45px"; setObjSel(o); return textSize; })()`));
console.log("T2后 obj 数:", await evl("layer.querySelectorAll('.obj').length"));
console.log("fontSize:", await evl("(()=>{const o=layer.querySelector('.obj'); return o?o.style.fontSize:'null';})()"));
chrome.kill(); process.exit(0);
