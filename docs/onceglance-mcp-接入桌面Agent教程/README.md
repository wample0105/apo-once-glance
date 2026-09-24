# 定影 Onceglance MCP 接入桌面 Agent 教程(小白版)

> 目标:让 Codex、WorkBuddy、Claude Desktop 等桌面 Agent 学会"帮你截屏、取字、标注"。
> 全程 10 分钟,只需要复制粘贴。

---

## 〇、先分清三个东西(30 秒)

| 名字 | 是什么 | 你在哪见它 |
|---|---|---|
| **onceglance.exe** | 定影主程序:托盘、热键、主面板 | 你已经装好并打开过 |
| **once.exe** | 定影的命令行 + **MCP 服务**(同一个程序的不同用法) | 本教程的主角 |
| **桌面 Agent** | Codex / WorkBuddy / Claude Desktop 等 AI 助手 | 你要把定影"接"给它们 |

关键认知:**MCP 服务不是启动出来的常驻程序,而是被 Agent 按需拉起的子进程**。
主程序开不开都不影响 MCP;Agent 那边配置好,它就自动被拉起。

## 一、拿到 once.exe 的完整路径

MCP 配置里要填 once.exe 的位置。两种情况:

- **开发机**(本项目仓库):`D:\wample\coding\me\apo-once-glance\src-tauri\target\release\once.exe`
- **安装版**(0.1.x):安装包暂未内置 once.exe,随发行版另行提供;拿到后放到一个固定目录(如 `C:\Onceglance\once.exe`)即可。

**验证它好用**:按 `Win+R` 输入 `cmd` 回车,粘贴(把路径换成你的):

```cmd
"D:\wample\coding\me\apo-once-glance\src-tauri\target\release\once.exe" status --json
```

看到 `"ok": true` 且 `agent_enabled: true` 就说明命令行通了。记下这个完整路径,下面反复用到。

## 二、确认 Agent 总开关是开的

主面板 →「Agent 与隐私」→ **「允许本机 Agent 调用定影」保持开启**。
(关着的话,Agent 一切调用都会被拒,退出码 5。)

## 三、接入 Codex

1. 打开文件(没有就新建):`C:\Users\你的用户名\.codex\config.toml`
2. 文末追加(路径换成你自己的,注意**双反斜杠**):

```toml
[mcp_servers.onceglance]
command = "D:\\wample\\coding\\me\\apo-once-glance\\src-tauri\\target\\release\\once.exe"
args = ["mcp"]
```

3. 保存,重启 Codex,完成。

## 四、接入 WorkBuddy

WorkBuddy 的 MCP 是"粘贴 JSON"式:

1. 打开 WorkBuddy → 设置/连接器里找到 **「添加 MCP」**;
2. 在配置输入框粘贴(路径换成你自己的):

```json
{
  "mcpServers": {
    "onceglance": {
      "command": "D:\\wample\\coding\\me\\apo-once-glance\\src-tauri\\target\\release\\once.exe",
      "args": ["mcp"]
    }
  }
}
```

3. 保存后状态显示"已连接"即成功。

## 五、接入其他 Agent(Claude Desktop / Cursor / ZCode…)

都是同一份 JSON,只是放的文件不同:

| Agent | 配置位置 |
|---|---|
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | 项目或全局 `mcp.json` |
| ZCode | `/mcp` 设置入口,或 `mcpServers` 配置段 |

内容全部是上面第四节那段 `mcpServers` JSON。**配一次,到处能用**。

## 六、验证:让 Agent 替你截个图

重启 Agent 后,直接对它说:

> 用 onceglance 截一张当前窗口的图,告诉我图片保存在哪。

它会调用 `capture_screen`,返回类似 `C:\Users\你\Pictures\Onceglance\2026-09-23\HHmmss-window-xxxx.png` 的路径。
更进一步,还可以说"把这张图里左上角的按钮标出来"——它会用 OCR 定位坐标再画标注。

## 七、两个常见"失败"其实是保护

| 现象 | 原因 | 处理 |
|---|---|---|
| Agent 报退出码 **5**(permission_denied) | 「允许本机 Agent 调用」总开关被关了 | 去「Agent 与隐私」页打开 |
| Agent 报退出码 **6**(黑名单命中) | 目标窗口在隐私黑名单里(银行/密码管理器等) | 这是设计行为,**没有"本次放行"** |

另外记住:截不到"正在输入密码的瞬间"不是 bug,是隐私保护在干活。

---

*适用版本:Onceglance 0.1.x(Windows)。MCP 工具清单:capture_screen / ocr_image / annotate_image / list_history / doctor;标注样式自动继承你在「标注主题」页调好的默认值。*
