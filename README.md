# 定影 Onceglance

> 让 Agent 看见你的屏幕，替你把操作变成教程。
> Windows 优先 · 本地优先 · 零 API Key / 零云端上传 / 零遥测

AI 原生截图工具（Agent 视觉层）：任何支持 MCP 或 shell 的 Agent 都可以通过标准化接口完成「截屏 → 取字（带坐标）→ 标注 → 落盘」的完整感知链路。

## 仓库结构

```text
apo-once-glance/
├─ docs/                      # 只读规格（PRD v1.1 / UI 设计规范 v1.2 / 交互说明书 v1.1 / 原型 v2）
│  └─ 04-备份区/               # 历史档案，不要读也不要动
├─ assets/logo/               # 品牌资产（一处定稿、处处同图，禁止改色/拉伸/自画）
├─ ui/                        # Web 前端（无构建步骤，Tauri 直接内嵌）
│  ├─ index.html              # 主面板（6 页导航：历史/标注主题/Agent 与隐私/Agent 接入/通用/诊断）
│  ├─ overlay.html + js/overlay.js   # 捕获覆盖层（区域/取字/长截图三种模式）
│  ├─ toast.html              # 通知浮层（右下角，成功 3s / 错误 6s）
│  ├─ quality.html            # 长截图接缝质检页
│  └─ css/tokens.css          # 设计令牌（ui-design.md §3 的唯一实现）
└─ src-tauri/                 # Cargo 工作区
   ├─ src/                    # onceglance 桌面壳（Tauri 2）
   │  ├─ lib.rs               # 窗口/托盘/热键/覆盖层调度
   │  ├─ deliver.rs           # 捕获交付：落盘→历史→剪贴板→toast
   │  └─ scrollcmd.rs         # 长截图会话 + 低级键盘钩子 + 质检窗口
   ├─ crates/once-core/       # 内核（GUI 与 CLI 共享）
   │  ├─ capture.rs           # GDI 捕获（BitBlt/PrintWindow）+ 显示器枚举（物理像素）
   │  ├─ ocr.rs               # Windows.Media.Ocr，blocks+bbox，Provider trait 留 P1
   │  ├─ annotate.rs          # 标注渲染引擎（tiny-skia + ttf-parser，确定性输出）
   │  ├─ longshot.rs          # 长截图拼接内核（位移匹配/固定区消除/接缝质检）
   │  ├─ history.rs           # SQLite + FTS5（搜索语法 kind:/after:/has:/ocr:）
   │  ├─ storage.rs           # 落盘：Pictures\Onceglance\<日期>\HHmmss-<kind>-<shortid>.png + manifest
   │  ├─ clipboard.rs         # DIB+PNG+CF_HDROP+文本，退避重试，写回校验，回收站删除
   │  ├─ settings.rs          # %APPDATA%\Onceglance\settings.json
   │  ├─ blacklist.rs         # 隐私黑名单（命中即拒，无"本次放行"）
   │  └─ audit.rs             # 审计日志 JSONL（仅元数据，30 天清理）
   └─ crates/once-cli/        # once 命令（PRD §6.7）+ MCP Server（once mcp）
```

## 构建

依赖：Rust 1.77+（MSVC）、Node 18+、WebView2 Runtime（Win11 自带）。

```bash
npm install
npm run build        # 产物在 src-tauri/target/release/
npm run dev          # 开发模式
cargo test -p once-core   # 内核单元测试（15 个）
```

## Agent 接入

```bash
once status                  # 实例/落盘/OCR/热键状态
once capture window --json   # 截前台窗口
once ocr last --json         # 取字：blocks[] 带 bbox（物理像素）
once annotate last --script s.json --out r.png
once mcp                     # stdio MCP Server（capture_screen/ocr_image/annotate_image/list_history/doctor）
```

JSON envelope：`{ok, data, error, meta:{version, elapsed_ms}}`。
退出码（冻结）：`0` 成功 / `1` 参数 / `2` 捕获 / `3` OCR / `4` 读写 / `5` 权限被拒 / `6` 黑名单。

## 硬约束（违反即返工）

1. 退出码契约冻结。
2. 本地三零：零 API Key、零云端上传、零遥测；OCR 本地跑。
3. 命名 `HHmmss-<kind>-<shortid>.png` + 同名 manifest，按日期落 `Pictures\Onceglance`。
4. 衍生图永不覆盖原图。
5. 删除只进系统回收站；黑名单无"本次放行"。
6. 错误提示必须带文字 + 退出码。
7. 一处定稿、处处同图：界面引用 `assets/logo/` 同一份资产。
8. `docs/` 与 `assets/` 只读。
9. 验收标准不许静默跳过；做不到就写进 `handoff.md`。

## 功能清单（v0.1.0，Windows 11 / Win10 19045+）

- **捕获**：区域框选（30%/55% 两档遮罩、物理像素尺寸提示、动作条）、窗口（PrintWindow+回退）、全屏、多显示器（物理像素坐标、逐屏 DPI）、捕获前自动隐藏自身
- **标注**：覆盖层直接画（箭头/矩形/椭圆/序号/文字/高亮/马赛克/裁剪 + 8 键盘快捷键 + 撤销），保存走确定性渲染引擎生成衍生图（-ann 命名、lineage manifest、永不覆盖原图）
- **OCR**：本地 Windows.Media.Ocr，blocks[]（type/text/bbox/confidence/lines）+ full_text + 语言，无文字返回 empty_reason 不报错
- **长截图**：框选松手即采、滚轮穿透采集（帧稳定检测消除动画重影）、固定区消除、到底提示且永不自动完成、接缝质检页（±1/±10 修正、全部接受、分段导出）
- **CLI `once`**：status / capture / ocr / annotate / history / open / config / doctor / mcp，全命令 --json envelope，退出码 0~6 冻结
- **MCP**：capture_screen / scroll_capture / ocr_image / annotate_image / list_history / doctor，stdio
- **GUI 主面板**：历史工作台（缩略图、OCR 预览、FTS 搜索、卡片→详情页：大图缩放 + OCR bbox 联动 + 版本时间线）、标注主题（只读管理视图）、Agent 与隐私（总开关/无感开关/黑名单/审计）、Agent 接入（SKL-4 双卡 + MCP 配置 + 速查表）、通用（热键录制/默认动作/落盘目录/开机自启）、诊断
- **隐私**：Agent 总开关 + 无感自动截图开关 + 隐私黑名单（命中退出码 6，无"本次放行"）+ 元数据审计日志（JSONL，30 天清理）
- **托盘**：常驻、左键主面板、右键全功能菜单；热键冲突检测与降级
- **首次引导**：环境自检 → 试一次 → 接 Agent（三步，可跳过）

## 发布（M4）

```bash
npm run build                                  # 产出 src-tauri/target/release/
cd src-tauri && cargo build --release -p once-cli    # once.exe CLI
# 发布物打包时生成 SHA-256 清单（checksums.txt，install.sh 自动校验）
```

## 当前状态

见 `handoff.md`（每个里程碑一行的交接日志）。M0–M3 完成，M4 构建产物就绪后发布。
