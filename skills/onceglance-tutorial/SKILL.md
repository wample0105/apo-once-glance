# Skill: onceglance-tutorial（定影 · 教程写作工作流）

> 让 Agent 用定影（Onceglance）自主完成「截图 → 取字 → 标注 → 成稿」的教程写作全流程。
> 适用：任何可执行 shell 命令的 Agent（ZCode / Claude Code / Codex CLI 等）。

## 0. 一分钟速查

```bash
once status                                  # 确认安装与落盘目录
once capture window --json                   # 截当前前台窗口 → data.path
once ocr last --json                         # 对最近截图取字 → data.blocks[]（含 bbox）
once annotate last --script s.json --out out.png   # 指令驱动标注 → 衍生图
once history --query "kind:window 设置"      # 检索历史
```

JSON envelope：`{ "ok": bool, "data": {...}, "error": {code, exit_code, message, hint} | null, "meta": {version, elapsed_ms} }`。判断成功只看 `ok` 与退出码，不要解析自然语言。

**退出码（冻结契约）**：`0` 成功 · `1` 参数错误 · `2` 捕获失败 · `3` OCR 失败 · `4` 文件读写失败 · `5` 权限被拒（用户关闭了 Agent 开关）· `6` 隐私黑名单命中。

## 1. 核心约定

- **坐标是第一公民**：OCR 的每个 block 都带 `bbox:[x,y,w,h]`（原图物理像素）。标注时用这些坐标画箭头/序号，无需读图。
- **两种坐标系**：脚本默认 `unit:"px"`（物理像素）；视觉模型可传 `unit:"rel"`（0–1 相对坐标，引擎按图片尺寸换算，推荐没有精确像素时使用）。
- **衍生图永不覆盖原图**：`annotate` 输出 `-ann.png`（已存在则 `-ann2` 递增）。原图是不可变的素材底账。
- **确定性路径**：默认落盘 `%USERPROFILE%\Pictures\Onceglance\<yyyy-MM-dd>\HHmmss-<kind>-<shortid>.png`，同名 `.json` 为 manifest（尺寸、来源窗口、DPI、lineage）。
- **`last` 语义**：当前用户最近一次成功捕获（含 Agent 触发的），跨进程共享。三命令链里用它串联。
- **黑名单**：目标窗口命中用户隐私黑名单时返回退出码 6，**没有"本次放行"**。收到 6 就换目标或告知用户，不要重试。

## 2. 教程写作 SOP（10–30 步图文教程）

1. **准备**：`once status --json` 确认 `agent_enabled=true`、OCR 引擎可用。请用户打开目标软件并停在第 1 步画面。
2. **逐步采集**（每步重复）：
   - 提示用户完成该步操作，然后执行 `once capture window --json`（或用户按 `Alt+Shift+A` 框选，Agent 用 `once ocr last` 读取最近一张）。
   - 记录 `data.path`（绝对路径）与步骤要点。
   - `once ocr <path> --json` 提取界面文字 + bbox——这是步骤文案与后续标注坐标的素材，**无需消耗视觉 token 读图**。
   - 找不到关键控件文字时，先用 `history --query "<控件名>"` 定位更清晰的截图。
3. **生成标注脚本**（每图一份 JSON）：

   ```json
   {
     "unit": "px",
     "operations": [
       { "type": "rect", "at": [520, 24], "size": [330, 40], "style": "outline" },
       { "type": "arrow", "from": [200, 100], "to": [535, 45] },
       { "type": "step_number", "at": [180, 90] },
       { "type": "mosaic", "at": [2200, 20], "size": [150, 50], "mode": "pixelate" }
     ]
   }
   ```

   - 操作类型：`arrow / rect / ellipse / step_number / text / highlight / mosaic(pixelate|blur) / crop`。
   - `step_number` 不写 `label` 会按出现顺序自动编号（1、2、3…）。
   - 敏感信息（邮箱/Token）用 `mosaic` 打码。
   - 坐标从 OCR bbox 推导：例如给「导出报表」按钮画箭头 = 该 block bbox 左侧偏移 20px 处为 `from`，bbox 中心为 `to`。
4. **批量渲染**：`once annotate <path> --script stepN.json --out stepN-ann.png`。同一脚本重复渲染输出一致（可复现）。
5. **组稿**：输出 Markdown，配图用相对路径引用衍生图：`![步骤1](./shots/step1-ann.png)`；正文步骤文字直接取自 OCR 文本。**不要**生成 HTML 或要求用户装编辑器——写作是你的职责，定影只负责感知。

## 3. 错误处理建议

| 退出码 | 含义 | 建议动作 |
|---|---|---|
| 1 | 参数/脚本非法（envelope.error 里有逐条 op 错误） | 修正脚本重试；坐标越界时改用 `unit:"rel"` |
| 2 | 捕获失败（锁屏/驱动/杀软） | 提示用户解锁屏幕后重试一次 |
| 3 | OCR 失败（已自动重试 1 次） | 检查图片是否有效 PNG；告知用户检查系统 OCR 语言包 |
| 4 | 文件读写/剪贴板失败 | envelope.hint 有兜底路径；换 `--out` 目录重试 |
| 5 | 用户切断了 Agent 调用 | 停止截图类操作，指引用户在「Agent 与隐私」页开启 |
| 6 | 隐私黑名单命中 | **不要重试**；告知用户哪个应用被保护 |
| 0 + `empty_reason` | 图片里没有文字 | 正常结果，不要当错误报 |

## 4. 人类裸用（不接 Agent 也完整）

`Alt+Shift+A` 区域截图 · `Alt+Shift+W` 窗口 · `Alt+Shift+F` 全屏 · `Alt+Shift+T` 取字 · `Alt+Shift+L` 长截图 · `Alt+Shift+H` 主面板。框选松手后动作条：复制图片 / 取字 / 标注 / 长截图。
