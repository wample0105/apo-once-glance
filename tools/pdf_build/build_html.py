# 教程 md → 单文件 HTML（A4 打印样式），供 html2pdf-next.js 渲染 PDF
import re, subprocess, os
from pathlib import Path

MANUAL = Path(r"D:\wample\coding\me\apo-once-glance\docs\manual")
OUT_HTML = MANUAL / "定影官方使用教程.html"

CHAPTERS = [
    "README.md",
    "01-认识定影.md",
    "02-第一张截图.md",
    "03-给截图加标注.md",
    "04-长截图.md",
    "05-贴图.md",
    "06-历史与取字.md",
    "07-主面板与设置.md",
    "08-接入AI-Agent.md",
    "09-让AI替你写教程.md",
    "附录.md",
]

parts = []
for name in CHAPTERS:
    text = (MANUAL / name).read_text(encoding="utf-8")
    # 章间互链在 PDF 中无意义：去链接保留文字（含附录锚点）
    text = re.sub(r"\[([^\]]+)\]\(\./[^)]+\.md[^)]*\)", r"\1", text)
    # 图片路径统一相对 docs/manual（合并后 HTML 也在此目录，相对路径不变）
    parts.append(text)
merged = "\n\n".join(parts)

tmp_md = MANUAL / "_merged.md"
tmp_md.write_text(merged, encoding="utf-8")

body = subprocess.run(
    ["pandoc", "-f", "gfm", "-t", "html5", str(tmp_md)],
    capture_output=True, text=True, encoding="utf-8", check=True,
).stdout
tmp_md.unlink()

CSS = """
:root { --ink:#1f2733; --muted:#5c6773; --accent:#B3261E; --line:#e3e7ec; --bg:#ffffff; }
@page { size: A4; margin: 17mm 16mm; }
html, body { margin:0; padding:0; background:#ffffff; }
body {
  font-family:"Microsoft YaHei","微软雅黑","Segoe UI",sans-serif;
  color:var(--ink); font-size:10.5pt; line-height:1.75;
  line-break:strict; overflow-wrap:break-word;
}
/* 封面 */
.cover { height:255mm; display:flex; flex-direction:column; justify-content:center; break-after:page; }
.cover .kicker { font-size:11pt; letter-spacing:.35em; color:var(--accent); font-weight:bold; margin-bottom:10mm; }
.cover h1.title { font-size:34pt; line-height:1.3; margin:0 0 6mm; border:none; padding:0; }
.cover .subtitle { font-size:13pt; color:var(--muted); margin-bottom:16mm; }
.cover .points { font-size:11pt; color:var(--ink); border-left:3px solid var(--accent); padding-left:6mm; line-height:2.1; }
.cover .meta { margin-top:22mm; font-size:10pt; color:var(--muted); }
/* 目录 */
.toc { break-after:page; }
.toc h2 { font-size:16pt; }
.toc table { width:100%; }
.toc td { padding:2.2mm 2mm; border-bottom:1px solid var(--line); font-size:10.5pt; }
.toc td:first-child { width:34%; font-weight:bold; }
/* 正文标题 */
h1 { font-size:20pt; line-height:1.4; border-bottom:2px solid var(--ink); padding-bottom:3mm; margin:0 0 6mm; }
h1:not(:first-of-type) { break-before:page; }
h2 { font-size:14.5pt; margin:9mm 0 3.5mm; break-after:avoid; }
h3 { font-size:12pt; margin:6mm 0 2.5mm; break-after:avoid; }
p { margin:0 0 3mm; }
li { margin-bottom:1.2mm; }
strong { color:#111827; }
blockquote { margin:3mm 0; padding:2.5mm 5mm; border-left:3px solid var(--accent); background:#faf7f6; color:var(--muted); break-inside:avoid; }
blockquote p { margin:0; }
/* 图片 */
img { display:block; max-width:100%; max-height:110mm; width:auto; height:auto; margin:3mm auto 1.5mm; border:1px solid var(--line); border-radius:2px; }
p:has(> img:only-child) { break-inside:avoid; text-align:center; }
/* 表格 */
table { width:100%; border-collapse:collapse; margin:3.5mm auto 4.5mm; break-inside:avoid; }
thead { display:table-header-group; }
th { background:#f4f6f8; font-weight:bold; }
th, td { border:1px solid var(--line); padding:2mm 2.6mm; font-size:9.5pt; text-align:left; vertical-align:top; overflow-wrap:anywhere; }
td code, th code { white-space:normal; overflow-wrap:anywhere; }
/* 代码 */
code { font-family:Consolas,"Courier New",monospace; font-size:9pt; background:#f4f6f8; padding:.4mm 1.4mm; border-radius:2px; }
pre { background:#f7f8fa; border:1px solid var(--line); border-radius:3px; padding:3.5mm 4mm; break-inside:avoid; margin:3mm 0 4mm; }
pre code { background:none; padding:0; font-size:8.5pt; line-height:1.55; white-space:pre-wrap; overflow-wrap:break-word; }
hr { border:none; border-top:1px solid var(--line); margin:6mm 0; }
"""

COVER = """
<div class="cover">
  <div class="kicker">OFFICIAL USER GUIDE</div>
  <h1 class="title">定影 Onceglance<br />官方使用教程</h1>
  <div class="subtitle">会截图，更能帮你看屏、取字、做图的 AI 截图工具</div>
  <div class="points">
    截图标注 · 长截图 · 贴图 · 离线取字<br />
    全程本地处理：零 API Key · 零云端上传 · 零遥测<br />
    接入 AI Agent：WorkBuddy / Claude / Cursor 一句话替你截屏
  </div>
  <div class="meta">
    本教程由 AI Agent 通过定影全自动完成——文字、截图与标注均为真实产出，<br />
    它本身就是定影「让 AI 看懂屏幕」能力的效果展示（详见第 08–09 章）。<br /><br />
    适用版本 v0.1.1 · Windows 10/11 · 2026 年 9 月
  </div>
</div>
"""

TOC_ROWS = [
    ("快速开始", "三分钟上手：安装 → Alt+Shift+A → Enter"),
    ("01 认识定影", "定影是什么、六大热键、主面板导览"),
    ("02 第一张截图", "取景层、窗口自动识别、放大镜、动作条"),
    ("03 给截图加标注", "箭头/序号/马赛克/文字四任务，随时改"),
    ("04 长截图", "滚动采集、自动拼接、两条注意"),
    ("05 贴图", "按 D 钉在屏幕上，缩放与透明度"),
    ("06 历史与取字", "自动入库、搜索语法、OCR 取字"),
    ("07 主面板与设置", "五页导览、Agent 权限、标注主题"),
    ("08 接入 AI Agent", "WorkBuddy 三步主线、一键接入、CLI"),
    ("09 让 AI 替你写教程", "Skill 产线：一句话出图文教程"),
    ("附录", "快捷键总表 / CLI·MCP 速查 / 主题参数 / FAQ"),
]
toc = '<div class="toc"><h2>目录</h2><table>'
for a, b in TOC_ROWS:
    toc += f"<tr><td>{a}</td><td>{b}</td></tr>"
toc += "</table></div>"

html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>定影 Onceglance 官方使用教程</title>
<style>{CSS}</style></head>
<body>
{COVER}
{toc}
{body}
</body></html>"""

OUT_HTML.write_text(html, encoding="utf-8")
print("HTML OK:", OUT_HTML, len(html), "chars")
