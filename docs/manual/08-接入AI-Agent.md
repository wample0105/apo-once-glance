# 08 接入 AI Agent

你每天对 AI 说「看一下这个报错」「帮我把这个界面整理成文档」——可 AI 看不见你的屏幕。这一章解决这个问题：**让 AI 通过定影截屏、取字、标注**，从此「看图办事」一句话的事。

以 WorkBuddy 为主线（用户最多、接入最简单），其他 Agent 一张速查表带过。

## 先吃三颗定心丸

1. **全程本地**：截图和取字都发生在你的电脑上，没有任何图片和文字上传；
2. **不占你的键盘鼠标**：Agent 调用走后台接口，不弹窗、不抢焦点、不模拟键鼠（这是「无感自动截图」开关控制的，默认允许，介意可关）；
3. **你随时能拉闸**：主面板 Agent 页的权限总开关一关，所有 AI 调用立即被拒；黑名单里的应用（密码管理器、银行类）任何 AI 都截不了。

另外，**客户端没开 AI 也能干活**——CLI 与 GUI 共享同一内核，截图、取字、标注、历史检索都不依赖客户端运行，只有交互式框选和长截图需要你在场。

## 主线：WorkBuddy 三步接入

WorkBuddy 走的是「复制 → 粘贴 → 验证」的最简路径：

**第一步：复制接入配置**

打开定影主面板（`Alt+Shift+H`）→ Agent 页 → 在「一键接入 MCP」区域找到 WorkBuddy（或在接口速查里复制通用 MCP 配置），点复制。

**第二步：到 WorkBuddy 里粘贴**

打开 WorkBuddy 的设置 → MCP / 工具接入界面 → 把配置粘贴进去，保存。

![WorkBuddy 配置粘贴位置](./images/08-workbuddy.png)

**第三步：验证**

在 WorkBuddy 的对话里说一句：

```text
帮我截一张当前屏幕的图
```

WorkBuddy 会调用定影完成截图并把图片路径告诉你——能看到返回的图片文件，就是接通了。

## 其他 Agent：一键接入

主面板 Agent 页的「一键接入 MCP」列表覆盖常见客户端：**Claude Desktop、Claude Code、Cursor、Codex、ZCode** 等——对号点「一键接入」，自动写入配置（写入前自动备份你的原配置，随时可回退；不想要了点「移除」干净卸载）。

## 命令行党：一条命令装 CLI

不依赖 MCP 的 Agent（或脚本）直接用命令行：

```bash
curl -fsSL --retry 3 https://github.com/wample0105/apo-once-glance/releases/latest/download/install.sh | bash
```

装完验证：

```bash
once status --json
```

![once status 验证输出](./images/08-status.png)

`"ok": true`、`gui_online`、`agent_enabled` 都是 true，就绪。之后 Agent 就可以执行完整链路：

```bash
once capture window --json                          # 截前台窗口
once ocr last --json                                # 对刚才的截图取字
once annotate last --script ops.json --out out.png  # 按指令标注
```

全部命令与退出码见 [附录 B](./附录.md#b-cli-速查)。

## 已支持客户端速查

| 客户端 | 接入方式 | 在哪操作 |
|--------|---------|---------|
| WorkBuddy | 复制配置粘贴 | 定影 Agent 页复制 → WorkBuddy 设置粘贴 |
| Claude Desktop | 一键接入 | 定影 Agent 页 → 点「一键接入」 |
| Claude Code | 一键接入 | 同上（优先官方 `claude mcp add`） |
| Cursor | 一键接入 | 同上 |
| Codex | 一键接入 | 同上 |
| ZCode | 一键接入 | 同上 |
| 其他 MCP 客户端 | 手动配置 | 把 `once mcp` 命令加进你的 MCP 配置 |

## 接入后的小问题

- **Agent 说调用被拒？** 主面板 Agent 页看权限总开关是否被关；审计日志里能看到每次被拒的记录；
- **截了但内容空白/被拒并提示黑名单？** 目标应用在保护名单里——这是设计行为，没有「本次放行」；
- **一键接入后客户端没反应？** 重启一次该客户端让它重读 MCP 配置；
- **同一家族的桌面端和 CLI 端是两个配置**（如 Claude Desktop 与 Claude Code）——各接各的，别只接一个就以为全家都通了。

## 下一步

AI 已经能替你截图取字了，最后一章让它替你**写教程**：[09 让 AI 替你写教程](./09-让AI替你写教程.md)。
