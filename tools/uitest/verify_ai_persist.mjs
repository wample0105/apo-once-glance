// M1 持久化复检：重启后 ai_list 仍含配置且 has_key=true，随后清理测试数据。
// 用法: node tools/uitest/verify_ai_persist.mjs <profileId>
import fs from "node:fs";

const pid = process.argv[2] || fs.readFileSync("tools/out/ai-test-pid.txt", "utf8").trim();
if (!pid) { console.log("FAIL 缺少 profile id"); process.exit(2); }

const base = "http://127.0.0.1:9700";
const list = await (await fetch(base + "/json")).json();
const t = list.find((p) => p.type === "page" && /tauri\.localhost\/?$/.test(p.url));
if (!t) { console.log("FAIL 未找到主面板 target"); process.exit(2); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const call = (method, params) => { const id = ++seq; return new Promise((r) => { pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); }); };
async function ev(expr) {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("页面异常: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 300));
  return r.result?.result?.value;
}

const listView = await ev(`window.__TAURI__.core.invoke("ai_list")`);
const v = (listView || []).find((x) => x.id === pid);
const persistOk = Boolean(v && v.has_key === true && v.name === "自测智谱");
console.log(`${persistOk ? "PASS" : "FAIL"} 重启后配置与凭据持久`, JSON.stringify(v || null));

// 清理：删除测试配置（连带清凭据库 Key）
const after = await ev(`window.__TAURI__.core.invoke("ai_delete_profile", { id: "${pid}" })`);
const empty = Array.isArray(after.profiles) && after.profiles.length === 0;
console.log(`${empty ? "PASS" : "FAIL"} 测试配置清理`, `剩余 ${after.profiles?.length ?? "?"} 套`);
process.exit(persistOk && empty ? 0 : 2);
