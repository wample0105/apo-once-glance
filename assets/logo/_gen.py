# -*- coding: utf-8 -*-
# 定影 · 影章(彡) 品牌资产生成器
# 输出: assets/logo-dingying/*.svg (14 个, 与 assets/logo/ 甲骨目套件一一对应)
import io, re, os

OUT = r"D:\wample\coding\me\apo-once-glance\assets\logo-dingying"
OLD = r"D:\wample\coding\me\apo-once-glance\assets\logo"
os.makedirs(OUT, exist_ok=True)

RED = "#FF3B30"
DARK = "#1D1D21"
FONT = "'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans SC',system-ui,sans-serif"

# ---- 彡 glyph (48 viewBox 坐标系) ----
def glyph_std(color, w=4.2):
    return ('<g transform="rotate(35 24 24)" stroke="%s" stroke-width="%s" '
            'stroke-linecap="round" fill="none">'
            '<path d="M13 17.4h22"/><path d="M14.25 24h19.5"/><path d="M15.5 30.6h17"/></g>') % (color, w)

def glyph_small(color):  # 小尺寸加粗: w=5, 间距7
    return ('<g transform="rotate(35 24 24)" stroke="%s" stroke-width="5" '
            'stroke-linecap="round" fill="none">'
            '<path d="M14 17h20"/><path d="M15.25 24h17.5"/><path d="M16.5 31h15"/></g>') % color

GLYPH_W = glyph_std("#FFFFFF")
GLYPH_R = glyph_std(RED)
GLYPH_K = glyph_std("#000000")
GLYPH_S = glyph_small("#FFFFFF")

SEAL = '<rect x="4" y="4" width="40" height="40" rx="10" fill="%s"/>'

def svg(content, vb=48, size=48, label="", title=""):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" '
            'role="img" aria-label="%s">\n<title>%s</title>\n%s\n</svg>') % (vb, vb, size, size, label, title, content)

files = {}

# 1. mark 标准 48
files["onceglance-mark.svg"] = svg(
    SEAL % RED + "\n  " + GLYPH_W, 48, 48, "定影 Onceglance", "定影 Onceglance")

# 2. mark-small 32 (加粗版)
files["onceglance-mark-small.svg"] = svg(
    SEAL % RED + "\n  " + GLYPH_S, 48, 32, "定影 Onceglance（小尺寸）", "定影 Onceglance（小尺寸）")

# 3. mark-line 线描版 (白底红章红纹)
files["onceglance-mark-line.svg"] = svg(
    '<rect x="5.7" y="5.7" width="36.6" height="36.6" rx="8.6" fill="#FFFFFF" stroke="%s" stroke-width="3.4"/>\n  %s'
    % (RED, GLYPH_R.replace('stroke-width="4.2"', 'stroke-width="3.4"')),
    48, 48, "定影 Onceglance 线描版", "定影 Onceglance 线描版")

# 4/5. mono 单色 (mask 镂空)
def mono(fill, mask_id, label):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" '
            'role="img" aria-label="%s">\n<title>%s</title>\n  <defs>\n    <mask id="%s">\n'
            '      <rect width="48" height="48" fill="#fff"/>\n      %s\n    </mask>\n  </defs>\n'
            '  <rect x="4" y="4" width="40" height="40" rx="10" fill="%s" mask="url(#%s)"/>\n</svg>'
            ) % (label, label, mask_id, GLYPH_K, fill, mask_id)

files["onceglance-mono-light.svg"] = mono("#FFFFFF", "cutDY_L", "定影 Onceglance 单色浅")   # 深底用
files["onceglance-mono-dark.svg"]  = mono(DARK,    "cutDY_D", "定影 Onceglance 单色深")   # 浅底用

# 6. favicon 32 (满幅)
files["onceglance-favicon.svg"] = svg(
    '<rect x="2" y="2" width="44" height="44" rx="11" fill="%s"/>\n  %s' % (RED, GLYPH_W),
    48, 32, "定影 Onceglance", "定影 Onceglance")

# 7. tray-windows 20 (加粗)
files["onceglance-tray-windows.svg"] = svg(
    SEAL % RED + "\n  " + GLYPH_S, 48, 20, "定影 Onceglance 托盘图标", "定影 Onceglance 托盘图标")

# 8. tray-macos-template 18 (纯黑无底, 交系统反色)
tpl = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" '
       'role="img" aria-label="定影 Onceglance 菜单栏模板图标">\n<title>定影 Onceglance 菜单栏模板图标</title>\n'
       '  <g transform="rotate(35 9 9)" stroke="#000" stroke-width="1.6" stroke-linecap="round" fill="none">'
       '<path d="M4.88 6.53h8.25"/><path d="M5.34 9h7.31"/><path d="M5.81 11.48h6.38"/></g>\n</svg>')
files["onceglance-tray-macos-template.svg"] = tpl

# 9. badge-success 24 圆形
files["onceglance-badge-success.svg"] = svg(
    '<circle cx="12" cy="12" r="11" fill="%s"/>\n  '
    '<g transform="rotate(35 12 12)" stroke="#FFFFFF" stroke-width="2.1" stroke-linecap="round" fill="none">'
    '<path d="M6.5 8.7h11"/><path d="M7.13 12h9.75"/><path d="M7.75 15.3h8.5"/></g>' % RED,
    24, 24, "定影 已保存", "定影 已保存")

# 10. appicon-windows 512
files["onceglance-appicon-windows.svg"] = svg(
    '<rect x="0" y="0" width="512" height="512" rx="40" fill="%s"/>\n  '
    '<g transform="translate(256 256) scale(9.6) translate(-24 -24)">\n    %s\n  </g>' % (RED, GLYPH_W),
    512, 512, "定影 Onceglance 应用图标（Windows）", "定影 Onceglance 应用图标（Windows）")

# 11. appicon-macos 512 — 复用原 squircle 路径, 只换 glyph
old_macos = io.open(os.path.join(OLD, "onceglance-appicon-macos.svg"), encoding="utf-8").read()
m = re.search(r'<path d="M504[^"]+" fill="#FF3B30"/>', old_macos)
squircle = m.group(0) if m else '<rect x="8" y="8" width="496" height="496" rx="112" fill="#FF3B30"/>'
files["onceglance-appicon-macos.svg"] = svg(
    squircle + '\n  <g transform="translate(256 256) scale(9.6) translate(-24 -24)">\n    %s\n  </g>' % GLYPH_W,
    512, 512, "定影 Onceglance 应用图标", "定影 Onceglance 应用图标")

# 12-14. lockups (定影 + Onceglance)
def mark_g():
    return ('  <g transform="translate(8 8)">\n    <rect x="4" y="4" width="40" height="40" rx="10" fill="%s"/>\n    %s\n  </g>' % (RED, GLYPH_W))

files["onceglance-lockup-horizontal.svg"] = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 208 64" width="208" height="64" role="img" aria-label="定影 Onceglance">\n'
    '<title>定影 Onceglance</title>\n%s\n'
    '  <text x="67.2" y="33" font-family="%s" font-size="27" font-weight="500" letter-spacing="1.6" fill="%s">定影</text>\n'
    '  <text x="68" y="48" font-family="%s" font-size="11" font-weight="400" letter-spacing="2.6" fill="%s" opacity="0.62">Onceglance</text>\n</svg>'
    ) % (mark_g(), FONT, DARK, FONT, DARK)

files["onceglance-lockup-vertical.svg"] = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 104 108" width="104" height="108" role="img" aria-label="定影 Onceglance">\n'
    '<title>定影 Onceglance</title>\n'
    '  <g transform="translate(28 4)">\n    <rect x="4" y="4" width="40" height="40" rx="10" fill="%s"/>\n    %s\n  </g>\n'
    '  <text x="51.3" y="82" font-family="%s" font-size="25" font-weight="500" letter-spacing="1.5" text-anchor="middle" fill="%s">定影</text>\n'
    '  <text x="50.8" y="98" font-family="%s" font-size="10" font-weight="400" letter-spacing="2.4" text-anchor="middle" fill="%s" opacity="0.62">Onceglance</text>\n</svg>'
    ) % (RED, GLYPH_W, FONT, DARK, FONT, DARK)

files["onceglance-lockup-compact.svg"] = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 132 64" width="132" height="64" role="img" aria-label="定影 Onceglance 精简字标">\n'
    '<title>定影 Onceglance 精简字标</title>\n%s\n'
    '  <text x="67.2" y="44" font-family="%s" font-size="27" font-weight="500" letter-spacing="1.6" fill="%s">定影</text>\n</svg>'
    ) % (mark_g(), FONT, DARK)

for name, content in files.items():
    io.open(os.path.join(OUT, name), "w", encoding="utf-8").write(content)
    print("wrote", name)
print("total:", len(files))
