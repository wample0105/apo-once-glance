# MCP 服务化:业界对标与 Onceglance 路线图

> 2026-09-23 · 定位:回答"既给人操作、又给 Agent 操作的产品,MCP 该怎么对外提供"。
> 已定案的前提:**本机 stdio 形态;一键注册+深链接入;暂不做公开目录分发。**
> 本文 = 业界对标 → 目标架构 → 分阶段路线图。只做规划,不含代码改动。

---

## 一、结论(TL;DR)

1. **形态**:本机 stdio 是本地桌面产品的业界主流(Playwright、Chrome DevTools、Figma 桌面 MCP 同款),Onceglance 现有实现方向正确,不改;
2. **分发**:业界一律把 MCP 二进制随主程序分发(安装包内置/随包下载),**没有让用户单独找二进制的先例**——当前安装包不含 once.exe 是必须先补的缺口;
3. **注册**:主流是"应用内一键接入"——由产品写入各客户端配置文件(先备份+确认),能深链的客户端给一键安装链接;手动粘贴只是文档兜底;
4. **公开目录**:官方 MCP Registry / Smithery 是发布期动作,0.1.x 不做,正确。

## 二、业界对标表

| 参照物 | 关键做法 | 对 Onceglance 的启示 |
|---|---|---|
| **Claude Desktop** | 手动 `claude_desktop_config.json`;远端 Connectors 走 OAuth;**桌面扩展(.dxt)实现本地 MCP 的一键安装打包** | 一键安装是 Anthropic 官方方向;本地产品也可以把"接入"做成产品能力而非文档 |
| **Cursor** | 全局/项目 `mcp.json`;**深链一键安装**(`cursor://…/mcp/install?name=…&config=<base64>`)——网页上点个按钮完成注册 | 支持 MCP 安装深链的客户端,应生成深链按钮而非让用户抄 JSON |
| **Docker MCP Toolkit** | **中心化 hub**:Docker Desktop 常驻一个本地网关,目录里的 MCP 以容器运行,所有客户端共连网关;"连接"按钮自动写 Claude/Cursor/VS Code 等配置 | 中心化能做但成本高一档(生命周期/端口/令牌管理);我们 Agent 数量少、隐私敏感,**stdio 每客户端一份更简单可控** |
| **VS Code** | 内置 MCP 支持(`mcp.json` + "MCP: Add Server"命令);**可复用 Claude Desktop 已注册的服务**(发现机制);支持 MCP 安装链接 | "反向发现"值得抄:扫描本机已注册的 Agent 配置,接入页显示"已接入 ✓ / 可接入";避免重复注册 |
| **Smithery / 官方 Registry** | `server.json` 描述符 + Registry API + 安装链接;Smithery 还提供托管代理 | 发布期(M4)动作:登记后获得公网可发现性;0.1.x 不做 |
| **MCP 规范本体** | 传输只认 stdio 与 Streamable HTTP;HTTP 才需要 OAuth 2.1;本地服务绑 127.0.0.1;工具注解与用户确认 | 我们走 stdio = 规范内最简合规路径;"仅本机、不开放端口"与规范的安全建议一致 |

**三条主流路线**(注册方式):① 配置文件写入(所有客户端通用,工具自动化);② MCP 安装深链(体验最好,仅部分客户端支持);③ 中心化 hub(多客户端共享一份,运维成本最高)。业界成熟产品通常是 ①+② 组合,③ 只在需要多客户端强共享时上。

## 三、Onceglance 目标架构(定案)

```
┌─ 安装包(NSIS)────────────────┐
│  onceglance.exe(主程序/GUI)   │
│  once.exe(CLI/MCP sidecar)   │  ← Phase 0 补齐:安装即有,路径固定
└──────────────┬────────────────┘
               │
   GUI「Agent 接入」页 = 注册中心(Phase 1)
   ├─ 扫描本机已知客户端(Claude/Cursor/Codex/WorkBuddy/VS Code/ZCode…)
   ├─ 每客户端一个"接入"按钮:备份→写入→确认(①路线)
   ├─ 支持 MCP 深链的客户端:生成一键安装链接(②路线)
   └─ 状态显示:已接入 ✓ / 可接入 / 未检测到

各 Agent ──各自拉起──> once.exe mcp(本机 stdio 子进程)
                        └─ 共享:settings.json / 历史 / 黑名单 / 审计
```

**安全边界不变**:本机 stdio、不开放网络端口、黑名单命中即拒(退出码 6)、总开关(退出码 5)、审计只记元数据。

## 四、分阶段路线图

### Phase 0 —— 补分发缺口(0.1.x,立即)
- NSIS 打包内置 `once.exe`(tauri externalBin/sidecar 或 resources),安装路径固定并可被 GUI 解析(现有 `@once-exe` 机制承接);
- `once doctor` 增加"MCP 就绪"自检项(二进制存在、版本、配置可写);
- 验收:全新机器装完客户端,不下载任何东西即可完成一次 MCP 接入。

### Phase 1 —— 一键注册(0.2)
- 「Agent 接入」页重构为注册中心:检测已知客户端配置文件 → 单客户端"接入/移除"按钮;
- **首批支持清单(T0,按 Agent 家族组织;每家桌面端与 CLI 端分别覆盖)**:

| 家族 | 形态 | 配置位置(Windows) | 格式 | 共用配置? | 注册机制 |
|---|---|---|---|---|---|
| Claude | Desktop(GUI) | `%APPDATA%\Claude\claude_desktop_config.json` | JSON | ❌ 与 Code 独立 | 写文件(备份+确认) |
| Claude | Code(CLI) | `~\.claude.json`(用户级) | JSON | ❌ 与 Desktop 独立 | **优先调官方命令** `claude mcp add onceglance --scope user -- <once.exe> mcp`,无 CLI 时降级写文件 |
| Codex | CLI | `~\.codex\config.toml` | TOML | ✅ 与 IDE 扩展共用 | 写文件 |
| Codex | IDE 扩展/桌面形态 | 与 CLI 共用 `~\.codex\config.toml`(实现前核对) | TOML | ✅ 共用 | 覆盖 CLI 即双端生效;若不共享则按独立条目递补 |
| Cursor | 桌面 IDE | `~\.cursor\mcp.json` | JSON | 单一形态 | 写文件 + 官方安装深链 |
| VS Code | 桌面 | `.vscode\mcp.json` / 用户级 | JSON | 单一形态(用户级全窗口生效) | 写文件 + MCP 安装链接 |
| WorkBuddy | 桌面 | 应用内"添加 MCP" | JSON | 单一形态 | GUI 打开注册页 + 预填 JSON 一键复制 |
| Trae / Trae CN | 桌面 | 应用内 mcp.json | JSON | 单一形态 | 写文件或引导 |
| ZCode | 桌面/CLI | `mcpServers` 配置段 | JSON | ✅ 桌面/CLI 通用 | 写文件 |

> **接入单位是"配置文件",不是"家族"**:共用同一配置文件的形态,注册一次双端生效(Codex 的 IDE 扩展与 CLI 共用 config.toml、ZCode 桌面与 CLI 通用);独立配置的形态必须各接一次(Claude 的 Desktop 与 Code 互不相通)。接入状态一律按配置文件粒度显示。

- T1 递补(配置同构,顺手支持):Windsurf、Gemini CLI、Cline、Antigravity、CodeBuddy CN、Cherry Studio;
- 写入三原则:**先备份原配置 → 展示将写入的 diff → 用户点确认**;失败可一键回滚;
- 为 Cursor/VS Code 等支持安装深链的客户端生成深链按钮(具体链接格式实现前以各客户端当前文档核对);
- GUI 按配置文件粒度显示接入状态(如"Claude Desktop ✓ 已接入 / Claude Code ○ 可接入"分列两行,不按家族合并);扫描本机已知客户端做**反向发现**(借鉴 VS Code 复用 Claude Desktop 注册的思路),已接入的不重复写入;
- 验收:小白在 3 分钟内完成任意两个 Agent 的接入(对照现在的 10 分钟+找路径)。

### Phase 2 —— 公开分发(发布期 M4)
- 编写 `server.json`,登记官方 MCP Registry 与 Smithery;
- 文档站收敛为"安装即接入"说明,手动粘贴降级为兜底附录;
- 验收:外部用户从目录一键安装到 Claude/Cursor 并完成一次截图标注。

## 五、风险与开放问题

- **深链格式易变**:各客户端的安装链接语法不保证稳定,Phase 1 实现前需逐一核对当时文档,并保留"复制 JSON"兜底;
- **客户端配置文件属第三方私有格式**:写入必须防御性处理(备份/回滚/失败不覆盖),WorkBuddy 的 JSON 配置形态以其版本实现为准;
- **多 Agent 并发**:多个客户端各自拉起 once.exe 子进程,底层 SQLite/设置的并发访问已有单实例桥接约束,Phase 1 需回归验证并发调用;
- **开放问题**:中心化 hub(所有 Agent 共连一份)是否在远期值得做——若未来出现"工具审批/统一 OAuth"需求再评估,当前不预支复杂度。

---

*参考资料:modelcontextprotocol.io(传输与授权规范、Registry)、Cursor MCP Install Links 文档、Docker MCP Toolkit 公告、VS Code MCP 文档、Claude Desktop Connectors/桌面扩展公告。*
