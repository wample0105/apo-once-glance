# 定影 Onceglance

<p align="center">
  <img src="assets/logo/png/appicon-windows-512.png" alt="定影 Onceglance Logo" width="120" height="120" />
</p>

<p align="center">
  <b>让 Agent 看见你的屏幕，替你把操作变成教程。</b><br />
  AI 原生截图工具 · Windows 优先 · 本地优先 · 零 API Key / 零云端上传 / 零遥测
</p>

<p align="center">
  <a href="README_EN.md">English</a> | 中文
</p>

<p align="center">
  <img src="https://img.shields.io/badge/平台-Windows%2010%2F11-lightgrey.svg" alt="Platform" />
  <img src="https://img.shields.io/badge/版本-v0.1.1-green.svg" alt="Version" />
  <img src="https://img.shields.io/badge/语言-Rust%20%2B%20TypeScript-orange.svg" alt="Language" />
  <img src="https://img.shields.io/badge/许可证-MIT-blue.svg" alt="License" />
</p>

---

**定影 Onceglance** 是一款 AI 原生的 Windows 截图工具：任何支持 MCP 或 Shell 的 Agent（Claude、Codex、Cursor 等）都可以通过标准化接口，完成「截屏 → 取字 → 标注 → 落盘」的完整感知链路。对人，它是键盘手感极佳的截图+贴图工具；对 Agent，它是本机视觉能力的标准出口。

- **本地三零**：零 API Key、零云端上传、零遥测，OCR 全程本地运行；
- **三端同源**：GUI、CLI、MCP 共享同一内核，装一次客户端，三种用法；
- **不依赖常驻**：客户端没有打开时，Agent 依然可以独立调用截图、取字与标注。

## ✨ 核心功能

- **📸 智能截图**：区域框选（窗口/控件自动识别高亮）、窗口截图、全屏、多显示器物理像素支持；冻结式取景层预驻留，热键到蒙版 ~44ms。
- **🖍️ 专业标注**：覆盖层直接画——箭头/矩形/椭圆/序号/文字/高亮/马赛克/裁剪，8 个键盘快捷键 + 撤销；保存走确定性渲染引擎，衍生图永不覆盖原图。
- **🔤 本地 OCR**：Windows.Media.Ocr 引擎离线取字，输出文字块 + 坐标框 + 置信度；主面板内 OCR 结果与原图坐标联动。
- **📜 长截图**：框选松手即采、滚轮穿透采集（帧稳定检测消除动画重影）、自动接缝拼接、到底提示、接缝质检页。
- **📌 贴图**：截图原位贴回屏幕，支持拖动、滚轮缩放、透明度调节。
- **🤖 Agent 能力**：CLI `once` 全命令 JSON 输出 + stdio MCP Server；标注属性全量继承客户端主题记忆，Agent 未显式传参即继承。
- **🛡️ 隐私防线**：Agent 总开关 + 无感自动截图开关 + 隐私 App 黑名单（密码管理器/银行类命中即拒，无「本次放行」）+ 元数据审计日志（30 天自动清理）。

## 🚀 安装

### 1. 客户端（GUI）

前往 [Releases](https://github.com/wample0105/apo-once-glance/releases) 下载最新的 `onceglance` 客户端安装包，解压即用。

- **系统要求**：Windows 10 (19045+) / Windows 11，WebView2 Runtime（Win11 自带）。

### 2. CLI 与 Agent Skill（一条命令）

```bash
curl -fsSL --retry 3 https://github.com/wample0105/apo-once-glance/releases/latest/download/install.sh | bash
```

自动按平台下载 `once` CLI 并校验 SHA-256，安装到 `~/.onceglance/bin`，同时把 `onceglance-tutorial` Skill 装入通用 Agent Skills 目录。安装后运行 `once status --json` 验证。

### 3. MCP 接入（推荐在客户端内一键完成）

打开客户端「Agent」页 → 对 Claude Desktop / Claude Code / Cursor / Codex / ZCode 等点击「一键接入」，自动写入 MCP 配置（写入前自动备份原配置）。也可以手动把 `once mcp` 加进你的 MCP 配置。

## 📝 使用方法

### 键盘（给人用）

| 快捷键 | 功能 |
|--------|------|
| `Alt+Shift+A` | 区域截图 |
| `Alt+Shift+W` | 窗口截图 |
| `Alt+Shift+F` | 全屏截图 |
| `Alt+Shift+T` | 自动取字 |
| `Alt+Shift+L` | 长截图 |
| `Alt+Shift+H` | 打开主面板 |

### 命令行（给 Agent 用）

```bash
once status                  # 实例/落盘/OCR/热键状态
once capture window --json   # 截前台窗口
once ocr last --json         # 取字：文字块 + 坐标
once annotate last --script s.json --out r.png   # 指令驱动标注
once history --query "kind:window after:昨天"     # 历史检索
once mcp                     # stdio MCP Server
```

全部命令输出统一 JSON envelope（`{ok, data, error, meta}`），退出码冻结：`0` 成功 / `1` 参数 / `2` 捕获 / `3` OCR / `4` 读写 / `5` 权限 / `6` 黑名单。

MCP 工具：`capture_screen` / `ocr_image` / `annotate_image` / `list_history` / `doctor`。

## ❓ 常见问题

- **截图整体发白、像曝光过度？**
  系统开启了 HDR。HDR 下 Windows 桌面以高亮度范围合成，传统截图接口拿到的是亮度映射后的降维帧。解决：设置 → 系统 → 屏幕 → HDR → 关闭「使用 HDR」。
- **客户端没打开，Agent 能调用吗？**
  能。CLI/MCP 与 GUI 是同一内核的独立入口，截图/取字/标注/历史检索均不依赖客户端运行；仅交互式框选与长截图需要 GUI。
- **隐私黑名单拦不住手动框选？**
  黑名单针对 Agent 自动截图与热键直采（你不在场的场景）；手动框选是你本人在场的主动行为，与其他工具行为一致。
- **衍生图会覆盖原图吗？**
  永远不会。所有标注/裁剪产物按 `-ann` 命名并记录 lineage manifest；删除只进系统回收站。

## 🗑️ 卸载

1. 客户端：退出托盘程序，删除程序目录；落盘图片在 `图片\Onceglance`，按需保留。
2. CLI：删除 `~/.onceglance` 目录。
3. MCP 配置：在客户端「Agent」页对已接入的客户端点击「移除」。

## ☕ 关注与交流

如果定影对你有帮助，欢迎关注更新、加入交流群，或者请作者喝杯咖啡。

<table align="center">
  <tr>
    <td align="center"><b>关注公众号</b></td>
    <td align="center"><b>加我微信</b></td>
    <td align="center"><b>随喜支持</b></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/cta/apo-rpa-qrcode.png" alt="阿坡RPA 公众号二维码" width="180" /></td>
    <td align="center"><img src="assets/cta/apo-wechat-qrcode.png" alt="阿坡个人微信二维码" width="180" /></td>
    <td align="center"><img src="assets/cta/apo-donate-qrcode.png" alt="支持作者二维码" width="180" /></td>
  </tr>
  <tr>
    <td align="center"><b>阿坡RPA</b><br />获取定影最新版本与实用工具</td>
    <td align="center"><b>阿坡</b><br />发送暗号「OnceGlance」，加入专属交流群</td>
    <td align="center"><b>请作者喝杯咖啡</b><br />自愿打赏，感谢支持</td>
  </tr>
</table>

<p align="center">点击图片可查看原图，长按或右键可保存。</p>

## 🛠 开发与构建

```bash
npm install
npm run build        # 产物在 src-tauri/target/release/
npm run dev          # 开发模式
cargo test -p once-core   # 内核单元测试
```

```text
src-tauri/
├─ src/                # 桌面壳：窗口/托盘/热键/取景层/交付/长截图/贴图
└─ crates/
   ├─ once-core/       # 内核：捕获/OCR/标注/长截图/历史/落盘/剪贴板/黑名单/审计
   └─ once-cli/        # once 命令 + MCP Server
ui/                    # Web 前端（主面板 / 取景层 / toast / 质检页），无构建步骤
docs/                  # 只读规格（PRD / UI 设计规范 / 交互说明书）
handoff.md             # 交接日志：每个开发段落的需求、决策与验证记录
```

欢迎 Issue 与 PR；开发约定与项目状态见 `handoff.md`。

## 📄 许可证

[MIT](LICENSE) © 阿坡

---

<p align="center">
  由 <a href="https://github.com/wample0105">阿坡</a> 用 ❤️ 制作
</p>
