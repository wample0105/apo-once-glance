// 把 once-cli 构建产物暂存进打包资源（tauri resources 引用 binaries/once.exe）。
// 构建顺序：cargo build --release -p once-cli → 本脚本 → tauri build。
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
const src = "src-tauri/target/release/once.exe";
const dst = "src-tauri/binaries/once.exe";
if (!existsSync(src)) {
  console.error(`[copy-once] 缺少 ${src} —— 先执行: cargo build --release -p once-cli`);
  process.exit(1);
}
mkdirSync("src-tauri/binaries", { recursive: true });
copyFileSync(src, dst);
console.log(`[copy-once] ${src} -> ${dst}`);
