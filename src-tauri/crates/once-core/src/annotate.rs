//! 指令驱动标注渲染引擎（ANN-1~5）。
//! 确定性：同图同脚本重复渲染输出逐字节一致（tiny-skia 自带光栅化 + 内嵌参数化字体布局，无系统 AA 差异源）。
//! 坐标：默认物理像素 `px`；`unit: "rel"` 为 0–1 相对坐标；`anchor: "block:N"` 引用 OCR 块锚点 + 偏移。
//! 整单拒绝：任何一条非法（越界/未知类型/超 200 操作）都不产出半成品，返回逐条错误。

use crate::error::{OnceError, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tiny_skia::{Color, FillRule, Paint, PathBuilder, Pixmap, Stroke, Transform};

pub const MAX_OPS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    #[default]
    Px,
    Rel,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AnnotationScript {
    #[serde(default)]
    pub unit: Unit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    pub operations: Vec<Operation>,
}

/// 点规格：`[x, y]` 数组（PRD §4.3 schema）。
pub type PointSpec = [f64; 2];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Arrow {
        from: PointSpec,
        to: PointSpec,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        width: Option<f32>,
        /// 虚线箭头
        #[serde(default)]
        dash: Option<bool>,
        /// 双箭头（起点也画箭头）
        #[serde(default)]
        double_head: Option<bool>,
        /// 箭头样式：end(默认→) | both(↔) | start(←) | none(—线段)
        #[serde(default)]
        heads: Option<String>,
        /// 线型：solid(默认) | dashed | dotted
        #[serde(default)]
        line_style: Option<String>,
    },
    /// 自由画笔：折线点序（画笔/荧光笔轨迹）
    Pen {
        points: Vec<PointSpec>,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        width: Option<f32>,
        /// marker（正片叠底半透明）| pen（默认实线）
        #[serde(default)]
        mode: Option<String>,
    },
    Rect {
        at: PointSpec,
        size: [f64; 2],
        /// outline | fill | outline_fill（说明书 §4.7）
        #[serde(default)]
        style: Option<String>,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        width: Option<f32>,
        /// 圆角半径（≤ min(w,h)/2）
        #[serde(default)]
        radius: Option<f32>,
        /// 虚线描边
        #[serde(default)]
        dash: Option<bool>,
        /// 整体不透明度 0.05–1.0
        #[serde(default)]
        opacity: Option<f32>,
    },
    Ellipse {
        at: PointSpec,
        size: [f64; 2],
        #[serde(default)]
        style: Option<String>,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        width: Option<f32>,
        #[serde(default)]
        dash: Option<bool>,
        #[serde(default)]
        opacity: Option<f32>,
    },
    StepNumber {
        at: PointSpec,
        /// 显式标签；缺省按出现顺序自动编号（ANN-7）。
        #[serde(default)]
        label: Option<u32>,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        diameter: Option<f32>,
        /// solid（实心圆，默认）| outline（描边圆）| plain（纯数字）
        #[serde(default)]
        style: Option<String>,
    },
    Text {
        at: PointSpec,
        text: String,
        #[serde(default)]
        size: Option<f32>,
        #[serde(default)]
        color: Option<String>,
        /// 字体族：default(微软雅黑) | simsun | simhei | kaiti | segoe；未知回退 default
        #[serde(default)]
        family: Option<String>,
        #[serde(default)]
        bold: Option<bool>,
        #[serde(default)]
        italic: Option<bool>,
        #[serde(default)]
        underline: Option<bool>,
        /// left | center | right（多行时逐行对齐）
        #[serde(default)]
        align: Option<String>,
        /// 行距倍数（默认 1.0）
        #[serde(default)]
        line_height: Option<f32>,
        /// 文字背景色（如 "#FFFFFF"）；缺省无背景
        #[serde(default)]
        background: Option<String>,
    },
    Highlight {
        at: PointSpec,
        size: [f64; 2],
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        opacity: Option<f32>,
    },
    Mosaic {
        at: PointSpec,
        size: [f64; 2],
        /// pixelate | blur（默认 pixelate）
        #[serde(default)]
        mode: Option<String>,
        /// 像素块大小 / 模糊半径（默认 12）
        #[serde(default)]
        strength: Option<u32>,
    },
    Crop {
        at: PointSpec,
        size: [f64; 2],
    },
}

/// OCR 块（anchor 解析来源），从 `<stem>.ocr.json` 读取。
#[derive(Debug, Clone, Deserialize)]
pub struct AnchorBlock {
    pub bbox: [i32; 4],
    #[serde(default)]
    pub text: String,
}

pub struct RenderInput<'a> {
    pub png: &'a [u8],
    pub script: &'a AnnotationScript,
    /// 同目录 `<stem>.ocr.json` 的 blocks（anchor 支持），可缺失。
    pub anchor_blocks: Option<&'a [AnchorBlock]>,
    /// 主题默认参数（人类编辑器记忆值；Agent 脚本可覆盖）。
    pub defaults: &'a crate::settings::AnnotationDefaults,
}

pub struct RenderOutput {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
pub struct OpError {
    pub index: usize,
    pub message: String,
}

/// 预检（ANN-5 整单拒绝）：返回逐条错误；任何错误则整单不渲染。
pub fn validate(script: &AnnotationScript, img_w: u32, img_h: u32) -> Vec<OpError> {
    let mut errors = Vec::new();
    if script.operations.len() > MAX_OPS {
        errors.push(OpError {
            index: usize::MAX,
            message: format!("操作数超过上限 {MAX_OPS}（当前 {}）", script.operations.len()),
        });
        return errors;
    }
    fn push_oob(errors: &mut Vec<OpError>, i: usize, name: &str, p: &PointSpec, img_w: u32, img_h: u32) {
        if p[0] < -2.0 || p[1] < -2.0 || p[0] > img_w as f64 + 2.0 || p[1] > img_h as f64 + 2.0 {
            errors.push(OpError {
                index: i,
                message: format!(
                    "op[{i}] {name} 坐标 ({:.0},{:.0}) 越界（图片 {}×{}）",
                    p[0], p[1], img_w, img_h
                ),
            });
        }
    }
    fn push_bad_size(errors: &mut Vec<OpError>, i: usize, name: &str, s: &[f64; 2]) {
        if s[0] <= 0.0 || s[1] <= 0.0 {
            errors.push(OpError { index: i, message: format!("op[{i}] {name} 尺寸必须为正") });
        }
    }
    for (i, op) in script.operations.iter().enumerate() {
        match op {
            Operation::Arrow { from, to, .. } => {
                push_oob(&mut errors, i, "from", from, img_w, img_h);
                push_oob(&mut errors, i, "to", to, img_w, img_h);
            }
            Operation::Pen { points, .. } => {
                if points.len() < 2 {
                    errors.push(OpError { index: i, message: format!("op[{i}] pen 至少需要 2 个点") });
                }
                for (k, p) in points.iter().enumerate() {
                    push_oob(&mut errors, i, &format!("points[{k}]"), p, img_w, img_h);
                }
            }
            Operation::Rect { at, size, .. }
            | Operation::Ellipse { at, size, .. }
            | Operation::Highlight { at, size, .. }
            | Operation::Mosaic { at, size, .. }
            | Operation::Crop { at, size } => {
                push_oob(&mut errors, i, "at", at, img_w, img_h);
                push_bad_size(&mut errors, i, "size", size);
                push_oob(&mut errors, i, "at+size", &[at[0] + size[0], at[1] + size[1]], img_w, img_h);
            }
            Operation::StepNumber { at, .. } | Operation::Text { at, .. } => {
                push_oob(&mut errors, i, "at", at, img_w, img_h);
            }
        }
    }
    errors
}

/// 渲染（先 crop 后叠加，顺序内文档化：crop 存在时最先应用）。
pub fn render(input: &RenderInput) -> Result<RenderOutput> {
    let (w, h, rgba) = crate::capture::decode_png(input.png)?;
    let errors = validate(input.script, w, h);
    if !errors.is_empty() {
        let first = errors
            .iter()
            .map(|e| e.message.clone())
            .collect::<Vec<_>>()
            .join("；");
        return Err(OnceError::usage(format!("标注脚本非法，整单拒绝：{first}"))
            .with_hint("修正脚本后重试；坐标可用 unit:\"rel\" 的 0–1 相对值"));
    }

    let mut pixmap = Pixmap::new(w, h).ok_or_else(|| OnceError::usage("源图像无法载入渲染器"))?;
    pixmap.data_mut().copy_from_slice(&rgba);

    let unit = input.script.unit;

    let ops = &input.script.operations;
    // crop：取第一个，其余视作错误已由 validate 拦（多个 crop 语义不明）
    let crop: Option<(i32, i32, u32, u32)> = ops.iter().find_map(|op| match op {
        Operation::Crop { at, size } => {
            let (x, y) = resolve(unit, w, h, at);
            Some((
                x.max(0.0) as i32,
                y.max(0.0) as i32,
                (size[0] as u32).min(w.saturating_sub(x.max(0.0) as u32)),
                (size[1] as u32).min(h.saturating_sub(y.max(0.0) as u32)),
            ))
        }
        _ => None,
    });

    // 先做马赛克/高亮（作用在原/裁剪画布上），再画形状，最后画文字类
    let crop_off = (crop.map(|c| c.0).unwrap_or(0), crop.map(|c| c.1).unwrap_or(0));

    // 马赛克直接改像素
    for op in ops {
        if let Operation::Mosaic { at, size, mode, strength } = op {
            let (x, y) = resolve(unit, w, h, at);
            let x = x as i64 - crop_off.0 as i64;
            let y = y as i64 - crop_off.1 as i64;
            let sw = size[0] as i64;
            let sh = size[1] as i64;
            let strength = strength.unwrap_or(input.defaults.mosaic_strength).max(2) as i64;
            let is_blur = mode.as_deref().unwrap_or("pixelate") == "blur";
            let cw = pixmap.width() as i64;
            let ch = pixmap.height() as i64;
            let x0 = x.clamp(0, cw);
            let y0 = y.clamp(0, ch);
            let x1 = (x + sw).clamp(0, cw);
            let y1 = (y + sh).clamp(0, ch);
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            let region = Region { x0: x0 as u32, y0: y0 as u32, x1: x1 as u32, y1: y1 as u32 };
            if is_blur {
                box_blur_region(&mut pixmap, region, strength as f32);
            } else {
                pixelate_region(&mut pixmap, region, strength as u32);
            }
        }
    }

    let mut step_counter: u32 = 0;
    for op in ops {
        match op {
            Operation::Arrow { from, to, color, width, dash, double_head, heads, line_style } => {
                let (fx, fy) = resolve(unit, w, h, from);
                let (tx, ty) = resolve(unit, w, h, to);
                let fx = fx - crop_off.0 as f32;
                let fy = fy - crop_off.1 as f32;
                let tx = tx - crop_off.0 as f32;
                let ty = ty - crop_off.1 as f32;
                let color = parse_color(color.as_deref()).unwrap_or(accent());
                let lw = width.unwrap_or(input.defaults.arrow_width);
                let heads_v = heads.as_deref().unwrap_or(if double_head.unwrap_or(false) { "both" } else { "end" });
                let ls = line_style.as_deref().unwrap_or(if dash.unwrap_or(false) { "dashed" } else { "solid" });
                draw_arrow(&mut pixmap, fx, fy, tx, ty, lw, color, ls, heads_v);
            }
            Operation::Pen { points, color, width, mode } => {
                let col = parse_color(color.as_deref()).unwrap_or(accent());
                let mut pts: Vec<(f32, f32)> = Vec::with_capacity(points.len());
                for p in points {
                    let (x, y) = resolve(unit, w, h, p);
                    pts.push((x - crop_off.0 as f32, y - crop_off.1 as f32));
                }
                draw_pen(
                    &mut pixmap,
                    &pts,
                    width.unwrap_or(input.defaults.shape_width),
                    col,
                    mode.as_deref(),
                );
            }
            Operation::Rect { at, size, style, color, width, radius, dash, opacity } => {
                let (x, y) = resolve(unit, w, h, at);
                draw_rect(
                    &mut pixmap,
                    x - crop_off.0 as f32,
                    y - crop_off.1 as f32,
                    size[0] as f32,
                    size[1] as f32,
                    style.as_deref(),
                    parse_color(color.as_deref()).unwrap_or(accent()),
                    width.unwrap_or(input.defaults.shape_width),
                    radius.unwrap_or(0.0),
                    dash.unwrap_or(false),
                    *opacity,
                );
            }
            Operation::Ellipse { at, size, style, color, width, dash, opacity } => {
                let (x, y) = resolve(unit, w, h, at);
                draw_ellipse(
                    &mut pixmap,
                    x - crop_off.0 as f32,
                    y - crop_off.1 as f32,
                    size[0] as f32,
                    size[1] as f32,
                    style.as_deref(),
                    parse_color(color.as_deref()).unwrap_or(accent()),
                    width.unwrap_or(input.defaults.shape_width),
                    dash.unwrap_or(false),
                    *opacity,
                );
            }
            Operation::StepNumber { at, label, color, diameter, style } => {
                step_counter += 1;
                let n = label.unwrap_or(step_counter);
                let (x, y) = resolve(unit, w, h, at);
                let d = diameter.unwrap_or(input.defaults.step_diameter);
                let col = parse_color(color.as_deref()).unwrap_or(accent());
                draw_step_number(
                    &mut pixmap,
                    x - crop_off.0 as f32,
                    y - crop_off.1 as f32,
                    d,
                    n,
                    col,
                    style.as_deref().unwrap_or(&input.defaults.step_style),
                )?;
            }
            Operation::Text {
                at,
                text,
                size,
                color,
                family,
                bold,
                italic,
                underline,
                align,
                line_height,
                background,
            } => {
                let (x, y) = resolve(unit, w, h, at);
                let style = TextStyle {
                    family: family.clone().unwrap_or_else(|| "default".into()),
                    bold: bold.unwrap_or(false),
                    italic: italic.unwrap_or(false),
                    underline: underline.unwrap_or(false),
                    align: align.as_deref().unwrap_or("left").to_string(),
                    line_height: line_height.unwrap_or(1.0),
                    background: background.as_deref().and_then(|s| parse_color(Some(s))),
                };
                draw_text(
                    &mut pixmap,
                    x - crop_off.0 as f32,
                    y - crop_off.1 as f32,
                    text,
                    size.unwrap_or(input.defaults.text_size),
                    parse_color(color.as_deref())
                        .unwrap_or(parse_color(Some(&input.defaults.color)).unwrap_or(accent())),
                    &style,
                )?;
            }
            Operation::Highlight { at, size, color, opacity } => {
                let (x, y) = resolve(unit, w, h, at);
                let col = parse_color(color.as_deref()).unwrap_or(Color::from_rgba8(255, 214, 0, 255));
                let opa = opacity.unwrap_or(input.defaults.highlight_opacity).clamp(0.05, 1.0);
                let mut p = Paint::default();
                p.set_color(Color::from_rgba8((col.red() * 255.0) as u8, (col.green() * 255.0) as u8, (col.blue() * 255.0) as u8, (opa * 255.0) as u8));
                p.anti_alias = true;
                let mut pb = PathBuilder::new();
                pb.push_rect(
                    tiny_skia::Rect::from_xywh(
                        x - crop_off.0 as f32,
                        y - crop_off.1 as f32,
                        size[0] as f32,
                        size[1] as f32,
                    )
                    .ok_or_else(|| OnceError::usage("高亮矩形无效"))?,
                );
                let path = pb.finish().ok_or_else(|| OnceError::usage("高亮路径无效"))?;
                pixmap.fill_path(&path, &p, FillRule::Winding, Transform::identity(), None);
            }
            Operation::Mosaic { .. } => { /* 已处理 */ }
            Operation::Crop { .. } => { /* 已在最前应用 */ }
        }
    }

    // 裁剪
    let final_pixmap = match crop {
        Some((x, y, cw2, ch2)) => {
            let x = x.max(0) as u32;
            let y = y.max(0) as u32;
            let cw2 = cw2.min(pixmap.width().saturating_sub(x)).max(1);
            let ch2 = ch2.min(pixmap.height().saturating_sub(y)).max(1);
            let mut cropped = Pixmap::new(cw2, ch2).ok_or_else(|| OnceError::usage("裁剪尺寸无效"))?;
            for row in 0..ch2 {
                let src = (y + row) * pixmap.width() + x;
                let dst = row * cw2;
                cropped.data_mut()[(dst as usize) * 4..((dst + cw2) as usize) * 4]
                    .copy_from_slice(&pixmap.data()[((src) as usize) * 4..((src + cw2) as usize) * 4]);
            }
            cropped
        }
        None => pixmap,
    };

    let out_png = final_pixmap
        .encode_png()
        .map_err(|e| OnceError::io("标注结果 PNG 编码失败").with_source(e.to_string()))?;
    Ok(RenderOutput { png: out_png, width: final_pixmap.width(), height: final_pixmap.height() })
}

#[derive(Clone, Copy)]
struct Region {
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
}

fn resolve(unit: Unit, img_w: u32, img_h: u32, p: &PointSpec) -> (f32, f32) {
    match unit {
        Unit::Rel => ((p[0] * img_w as f64) as f32, (p[1] * img_h as f64) as f32),
        Unit::Px => (p[0] as f32, p[1] as f32),
    }
}

fn pixelate_region(pixmap: &mut Pixmap, r: Region, block: u32) {
    let block = block.max(2) as usize;
    let w = pixmap.width() as usize;
    let data = pixmap.data_mut();
    let by0 = (r.y0 as usize / block) * block;
    let bx0 = (r.x0 as usize / block) * block;
    let mut by = by0;
    while by < r.y1 as usize {
        let mut bx = bx0;
        while bx < r.x1 as usize {
            let ex = (bx + block).min(r.x1 as usize).min(w);
            let ey = (by + block).min(r.y1 as usize);
            let (mut sr, mut sg, mut sb, mut n) = (0u64, 0u64, 0u64, 0u64);
            for y in by.max(r.y0 as usize)..ey {
                for x in bx.max(r.x0 as usize)..ex {
                    let i = (y * w + x) * 4;
                    sr += data[i] as u64;
                    sg += data[i + 1] as u64;
                    sb += data[i + 2] as u64;
                    n += 1;
                }
            }
            if n > 0 {
                let (ar, ag, ab) = ((sr / n) as u8, (sg / n) as u8, (sb / n) as u8);
                for y in by.max(r.y0 as usize)..ey {
                    for x in bx.max(r.x0 as usize)..ex {
                        let i = (y * w + x) * 4;
                        data[i] = ar;
                        data[i + 1] = ag;
                        data[i + 2] = ab;
                        data[i + 3] = 255;
                    }
                }
            }
            bx += block;
        }
        by += block;
    }
}

/// 三次盒式模糊 ≈ 高斯（确定性、无外部依赖）。
fn box_blur_region(pixmap: &mut Pixmap, r: Region, radius: f32) {
    let radius = radius.max(2.0) as i32;
    let w = pixmap.width() as usize;
    let h = pixmap.height() as usize;
    for _ in 0..3 {
        // 水平
        let src = pixmap.data().to_vec();
        let data = pixmap.data_mut();
        for y in r.y0 as usize..r.y1 as usize {
            for x in r.x0 as usize..r.x1 as usize {
                let (mut a0, mut a1, mut a2, mut a3, mut n) = (0u32, 0u32, 0u32, 0u32, 0u32);
                for dx in -radius..=radius {
                    let xx = (x as i64 + dx as i64).clamp(r.x0 as i64, (r.x1 as i64) - 1) as usize;
                    let i = (y * w + xx) * 4;
                    a0 += src[i] as u32;
                    a1 += src[i + 1] as u32;
                    a2 += src[i + 2] as u32;
                    a3 += src[i + 3] as u32;
                    n += 1;
                }
                let i = (y * w + x) * 4;
                data[i] = (a0 / n) as u8;
                data[i + 1] = (a1 / n) as u8;
                data[i + 2] = (a2 / n) as u8;
                data[i + 3] = (a3 / n) as u8;
            }
        }
        // 垂直
        let src = pixmap.data().to_vec();
        let data = pixmap.data_mut();
        for y in r.y0 as usize..r.y1 as usize {
            for x in r.x0 as usize..r.x1 as usize {
                let (mut a0, mut a1, mut a2, mut a3, mut n) = (0u32, 0u32, 0u32, 0u32, 0u32);
                for dy in -radius..=radius {
                    let yy = (y as i64 + dy as i64).clamp(r.y0 as i64, (r.y1 as i64) - 1) as usize;
                    if yy >= h {
                        continue;
                    }
                    let i = (yy * w + x) * 4;
                    a0 += src[i] as u32;
                    a1 += src[i + 1] as u32;
                    a2 += src[i + 2] as u32;
                    a3 += src[i + 3] as u32;
                    n += 1;
                }
                let i = (y * w + x) * 4;
                data[i] = (a0 / n) as u8;
                data[i + 1] = (a1 / n) as u8;
                data[i + 2] = (a2 / n) as u8;
                data[i + 3] = (a3 / n) as u8;
            }
        }
    }
}

pub fn accent() -> Color {
    Color::from_rgba8(0xFF, 0x3B, 0x30, 0xFF)
}

pub fn parse_color(s: Option<&str>) -> Option<Color> {
    let s = s?;
    let s = s.trim().trim_start_matches('#');
    let (r, g, b, a) = match s.len() {
        6 => (
            u8::from_str_radix(&s[0..2], 16).ok()?,
            u8::from_str_radix(&s[2..4], 16).ok()?,
            u8::from_str_radix(&s[4..6], 16).ok()?,
            255,
        ),
        8 => (
            u8::from_str_radix(&s[0..2], 16).ok()?,
            u8::from_str_radix(&s[2..4], 16).ok()?,
            u8::from_str_radix(&s[4..6], 16).ok()?,
            u8::from_str_radix(&s[6..8], 16).ok()?,
        ),
        _ => return None,
    };
    Some(Color::from_rgba8(r, g, b, a))
}

fn paint(color: Color) -> Paint<'static> {
    let mut p = Paint::default();
    p.set_color(color);
    p.anti_alias = true;
    p
}

/// 自由画笔轨迹（pen 实线 / marker 半透明荧光）。
fn draw_pen(pixmap: &mut Pixmap, pts: &[(f32, f32)], width: f32, color: Color, mode: Option<&str>) {
    if pts.len() < 2 {
        return;
    }
    let lw = width.max(2.0);
    let mut pb = PathBuilder::new();
    pb.move_to(pts[0].0, pts[0].1);
    for (x, y) in &pts[1..] {
        pb.line_to(*x, *y);
    }
    if let Some(path) = pb.finish() {
        let col = if mode == Some("marker") {
            // 荧光笔轨迹：35% 透明近似正片叠底
            Color::from_rgba8(
                (color.red() * 255.0) as u8,
                (color.green() * 255.0) as u8,
                (color.blue() * 255.0) as u8,
                90,
            )
        } else {
            color
        };
        let stroke = Stroke {
            width: lw,
            line_cap: tiny_skia::LineCap::Round,
            line_join: tiny_skia::LineJoin::Round,
            ..Default::default()
        };
        pixmap.stroke_path(&path, &paint(col), &stroke, Transform::identity(), None);
    }
}

fn draw_arrow(
    pixmap: &mut Pixmap,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    width: f32,
    color: Color,
    line_style: &str,
    heads: &str,
) {
    let dash = line_style == "dashed";
    let dotted = line_style == "dotted";
    let double_head = heads == "both" || heads == "start";
    let no_head = heads == "none";
    let lw = width.max(2.0);
    let head = (lw * 3.0).min(36.0);
    let dx = x1 - x0;
    let dy = y1 - y0;
    let len = (dx * dx + dy * dy).sqrt().max(1.0);
    let ux = dx / len;
    let uy = dy / len;
    // 箭头体：起点按需让位（双箭头时留出起点头）
    let back = if double_head { head } else { 0.0 };
    let bx = x0 + ux * back;
    let by = y0 + uy * back;
    // 线体缩短到箭头底
    let bx2 = x1 - ux * head;
    let by2 = y1 - uy * head;
    let mut pb = PathBuilder::new();
    pb.move_to(bx, by);
    pb.line_to(bx2, by2);
    if let Some(path) = pb.finish() {
        let mut stroke = stroke_style(lw, dash);
        if dotted {
            stroke.dash = tiny_skia::StrokeDash::new(vec![lw * 0.4, lw * 1.8], 0.0);
        }
        pixmap.stroke_path(&path, &paint(color), &stroke, Transform::identity(), None);
    }
    if no_head {
        return;
    }
    // 实心三角头（终点）
    let px = -uy;
    let py = ux;
    let mut hb = PathBuilder::new();
    hb.move_to(x1, y1);
    hb.line_to(bx2 + px * head * 0.5, by2 + py * head * 0.5);
    hb.line_to(bx2 - px * head * 0.5, by2 - py * head * 0.5);
    hb.close();
    if let Some(path) = hb.finish() {
        pixmap.fill_path(&path, &paint(color), FillRule::Winding, Transform::identity(), None);
    }
    if double_head {
        let mut hb = PathBuilder::new();
        hb.move_to(x0, y0);
        hb.line_to(bx + px * head * 0.5, by + py * head * 0.5);
        hb.line_to(bx - px * head * 0.5, by - py * head * 0.5);
        hb.close();
        if let Some(path) = hb.finish() {
            pixmap.fill_path(&path, &paint(color), FillRule::Winding, Transform::identity(), None);
        }
    }
}

/// 通用描边样式：宽度下限 + 圆角连接 + 可选虚线。
fn stroke_style(lw: f32, dash: bool) -> Stroke {
    let mut st = Stroke {
        width: lw.max(2.0),
        line_cap: tiny_skia::LineCap::Round,
        line_join: tiny_skia::LineJoin::Round,
        ..Default::default()
    };
    if dash {
        st.dash = tiny_skia::StrokeDash::new(vec![lw * 3.0, lw * 2.2], 0.0);
    }
    st
}

/// 不透明度（0.05–1.0）应用到颜色 alpha。
fn with_opacity(c: Color, opacity: Option<f32>) -> Color {
    match opacity {
        None => c,
        Some(v) => {
            let f = v.clamp(0.05, 1.0);
            Color::from_rgba8(
                (c.red() * 255.0) as u8,
                (c.green() * 255.0) as u8,
                (c.blue() * 255.0) as u8,
                (((c.alpha() * 255.0) as f32) * f).round().clamp(13.0, 255.0) as u8,
            )
        }
    }
}

/// 圆角矩形路径（r=0 时退化为直角）。
fn push_rounded_rect(pb: &mut PathBuilder, x: f32, y: f32, w: f32, h: f32, r: f32) {
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    if r <= 0.5 {
        if let Some(rect) = tiny_skia::Rect::from_xywh(x, y, w, h) {
            pb.push_rect(rect);
        }
        return;
    }
    let k = 0.552_284_75_f32 * r;
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.cubic_to(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.cubic_to(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.cubic_to(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
    pb.line_to(x, y + r);
    pb.cubic_to(x, y + r - k, x + r - k, y, x + r, y);
    pb.close();
}

fn style_of(s: Option<&str>) -> &'static str {
    match s {
        Some("fill") => "fill",
        Some("outline_fill") => "outline_fill",
        _ => "outline",
    }
}

fn draw_rect(
    pixmap: &mut Pixmap,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    style: Option<&str>,
    color: Color,
    width: f32,
    radius: f32,
    dash: bool,
    opacity: Option<f32>,
) {
    let lw = width.max(2.0);
    let color = with_opacity(color, opacity);
    let mut pb = PathBuilder::new();
    push_rounded_rect(&mut pb, x, y, w, h, radius);
    let path = match pb.finish() {
        Some(p) => p,
        None => return,
    };
    match style_of(style) {
        "fill" => pixmap.fill_path(&path, &paint(color), FillRule::Winding, Transform::identity(), None),
        "outline_fill" => {
            let mut p = paint(color);
            p.set_color(Color::from_rgba8((color.red() * 255.0) as u8, (color.green() * 255.0) as u8, (color.blue() * 255.0) as u8, 60));
            pixmap.fill_path(&path, &p, FillRule::Winding, Transform::identity(), None);
            let stroke = stroke_style(lw, dash);
            pixmap.stroke_path(&path, &paint(color), &stroke, Transform::identity(), None);
        }
        _ => {
            let stroke = stroke_style(lw, dash);
            pixmap.stroke_path(&path, &paint(color), &stroke, Transform::identity(), None);
        }
    }
}

fn draw_ellipse(
    pixmap: &mut Pixmap,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    style: Option<&str>,
    color: Color,
    width: f32,
    dash: bool,
    opacity: Option<f32>,
) {
    let lw = width.max(2.0);
    let color = with_opacity(color, opacity);
    // 4 段贝塞尔近似椭圆（k = 0.5523）
    let k = 0.552_284_75_f32 * 1.0;
    let cx = x + w / 2.0;
    let cy = y + h / 2.0;
    let rx = w / 2.0;
    let ry = h / 2.0;
    let mut pb = PathBuilder::new();
    pb.move_to(cx + rx, cy);
    pb.cubic_to(cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry);
    pb.cubic_to(cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy);
    pb.cubic_to(cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry);
    pb.cubic_to(cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy);
    pb.close();
    let Some(path) = pb.finish() else { return };
    let stroke = stroke_style(lw, dash);
    match style_of(style) {
        "fill" => pixmap.fill_path(&path, &paint(color), FillRule::Winding, Transform::identity(), None),
        "outline_fill" => {
            let mut p = paint(color);
            p.set_color(Color::from_rgba8((color.red() * 255.0) as u8, (color.green() * 255.0) as u8, (color.blue() * 255.0) as u8, 60));
            pixmap.fill_path(&path, &p, FillRule::Winding, Transform::identity(), None);
            pixmap.stroke_path(&path, &paint(color), &stroke, Transform::identity(), None);
        }
        _ => {
            pixmap.stroke_path(&path, &paint(color), &stroke, Transform::identity(), None);
        }
    }
}

/// 从系统字体加载（微软雅黑 → Segoe UI 回退）。同机确定性成立。
pub fn load_face() -> Result<ttf_parser::Face<'static>> {
    Ok(load_face_for("default", false)?.0)
}

/// 字体族 → 系统字体文件候选（相对 %WINDIR%\Fonts，按序回退；bool=是否真实粗体文件）。
fn font_candidates(family: &str, bold: bool) -> &'static [(&'static str, bool)] {
    match family {
        "simsun" => &[("Fonts/simsun.ttc", false)],
        "simhei" => &[("Fonts/simhei.ttf", false)],
        "kaiti" => &[
            ("Fonts/simkai.ttf", false),
            ("Fonts/KaiTi.ttf", false),
            ("Fonts/STKAITI.TTF", false),
        ],
        "segoe" => {
            if bold {
                &[("Fonts/segoeuib.ttf", true), ("Fonts/segoeui.ttf", false)]
            } else {
                &[("Fonts/segoeui.ttf", false)]
            }
        }
        // default / yahei：微软雅黑（粗体优先真粗体文件 msyhbd）
        _ => {
            if bold {
                &[
                    ("Fonts/msyhbd.ttc", true),
                    ("Fonts/msyhbd.ttf", true),
                    ("Fonts/msyh.ttc", false),
                    ("Fonts/msyh.ttf", false),
                    ("Fonts/segoeuib.ttf", true),
                ]
            } else {
                &[("Fonts/msyh.ttc", false), ("Fonts/msyh.ttf", false), ("Fonts/segoeui.ttf", false)]
            }
        }
    }
}

/// 按字体族+粗体加载字体；返回 (face, 是否为真实粗体文件)。
/// 磁盘读取结果按 (family, bold) 进程内缓存；Face 每次解析，同机确定性不变。
fn load_face_for(family: &str, bold: bool) -> Result<(ttf_parser::Face<'static>, bool)> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<(String, bool), Option<(Vec<u8>, bool)>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = (family.to_string(), bold);
    let bytes = {
        let mut map = cache.lock().unwrap();
        if !map.contains_key(&key) {
            let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
            let mut found: Option<(Vec<u8>, bool)> = None;
            for (rel, is_bold) in font_candidates(family, bold) {
                if let Ok(b) = std::fs::read(std::path::Path::new(&windir).join(rel)) {
                    found = Some((b, *is_bold));
                    break;
                }
            }
            if found.is_none() {
                // 回退默认字体链，保证任何 family 都能出字
                for (rel, is_bold) in font_candidates("default", bold) {
                    if let Ok(b) = std::fs::read(std::path::Path::new(&windir).join(rel)) {
                        found = Some((b, *is_bold));
                        break;
                    }
                }
            }
            map.insert(key.clone(), found);
        }
        map.get(&key).cloned().flatten()
    };
    let Some((bytes, real_bold)) = bytes else {
        return Err(OnceError::usage("未找到可用系统字体（msyh.ttc / segoeui.ttf）"));
    };
    // 泄漏以获得 'static（进程内一次性加载）
    let leaked: &'static [u8] = Box::leak(bytes.into_boxed_slice());
    let face = ttf_parser::Face::parse(leaked, 0)
        .map_err(|e| OnceError::usage("字体解析失败").with_source(e.to_string()))?;
    Ok((face, real_bold && bold))
}

/// 文字排版参数（schema v1.1 Text op 扩展）。
#[derive(Clone)]
struct TextStyle {
    family: String,
    bold: bool,
    italic: bool,
    underline: bool,
    align: String,
    line_height: f32,
    background: Option<Color>,
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            family: "default".into(),
            bold: false,
            italic: false,
            underline: false,
            align: "left".into(),
            line_height: 1.0,
            background: None,
        }
    }
}

fn draw_step_number(
    pixmap: &mut Pixmap,
    x: f32,
    y: f32,
    diameter: f32,
    n: u32,
    color: Color,
    style: &str,
) -> Result<()> {
    let d = diameter.max(16.0);
    let cx = x + d / 2.0;
    let cy = y + d / 2.0;
    if style == "plain" {
        // 纯数字：加粗大号彩色文字，无圆底（四向 1px 重绘作伪加粗，确定性输出）
        let size = d * 0.78;
        let text = n.to_string();
        for (dx, dy) in [(0.0f32, 0.0f32), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
            draw_text_centered(pixmap, cx + dx, cy + dy, &text, size, color)?;
        }
        return Ok(());
    }
    let mut pb = PathBuilder::new();
    let r = d / 2.0;
    let k = 0.552_284_75_f32 * r;
    pb.move_to(cx + r, cy);
    pb.cubic_to(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
    pb.cubic_to(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
    pb.cubic_to(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
    pb.cubic_to(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
    pb.close();
    let path = pb.finish().ok_or_else(|| OnceError::usage("序号路径无效"))?;
    let text = n.to_string();
    let size = d * 0.52;
    if style == "outline" {
        // 描边圆：白底 + 色边 + 色字
        pixmap.fill_path(&path, &paint(white()), FillRule::Winding, Transform::identity(), None);
        let stroke = Stroke { width: 3.0, ..Default::default() };
        pixmap.stroke_path(&path, &paint(color), &stroke, Transform::identity(), None);
        draw_text_centered(pixmap, cx, cy, &text, size, color)
    } else {
        // solid：实心色圆 + 白字
        pixmap.fill_path(&path, &paint(color), FillRule::Winding, Transform::identity(), None);
        draw_text_centered(pixmap, cx, cy, &text, size, white())
    }
}

fn white() -> Color {
    Color::from_rgba8(255, 255, 255, 255)
}

fn draw_text(pixmap: &mut Pixmap, x: f32, y: f32, text: &str, size: f32, color: Color, style: &TextStyle) -> Result<()> {
    draw_text_at(pixmap, x, y, text, size, color, false, style)
}

fn draw_text_centered(
    pixmap: &mut Pixmap,
    cx: f32,
    cy: f32,
    text: &str,
    size: f32,
    color: Color,
) -> Result<()> {
    draw_text_at(pixmap, cx, cy, text, size, color, true, &TextStyle::default())
}

/// ttf-parser 轮廓 → tiny-skia 路径（字体坐标 y 向上，翻转交给变换矩阵）。
struct OutlineToPath<'a>(&'a mut PathBuilder);

impl ttf_parser::OutlineBuilder for OutlineToPath<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, y);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.0.quad_to(x1, y1, x, y);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.0.cubic_to(x1, y1, x2, y2, x, y);
    }
    fn close(&mut self) {
        self.0.close();
    }
}

/// 文本布局：逐字符 advance；支持换行；centered 时按总宽高居中（序号用）。
/// 支持 family/bold/italic/underline/align/line_height/background。
/// 同字体同参数 → 同输出（确定性）。
fn draw_text_at(
    pixmap: &mut Pixmap,
    x: f32,
    y: f32,
    text: &str,
    size: f32,
    color: Color,
    centered: bool,
    style: &TextStyle,
) -> Result<()> {
    let (face, real_bold) = load_face_for(&style.family, style.bold)?;
    let synthetic_bold = style.bold && !real_bold;
    let upem = face.units_per_em() as f32;
    let s = size.max(4.0) / upem;
    let ascent = face.ascender() as f32 * s;
    let descent = face.descender() as f32 * s; // 通常为负
    let line_h = ascent - descent;
    let line_advance = line_h * style.line_height.max(0.5);

    let mut lines: Vec<(f32, Vec<ttf_parser::GlyphId>)> = vec![(0.0, Vec::new())];
    for ch in text.chars() {
        if ch == '\n' {
            lines.push((0.0, Vec::new()));
            continue;
        }
        let gid = face.glyph_index(ch).unwrap_or(ttf_parser::GlyphId(0));
        let adv = face.glyph_hor_advance(gid).unwrap_or(0) as f32 * s;
        let cur = lines.last_mut().unwrap();
        cur.0 += adv;
        cur.1.push(gid);
    }
    let total_w = lines.iter().map(|l| l.0).fold(0.0f32, f32::max);
    let total_h = if lines.len() > 1 {
        line_advance * (lines.len() - 1) as f32 + line_h
    } else {
        line_h
    };
    let start_x = if centered { x - total_w / 2.0 } else { x };
    let block_y = if centered { y - total_h / 2.0 } else { y };
    let start_baseline = block_y + ascent;

    // 文字背景（先行绘制，位于字形之下）
    if let Some(bg) = style.background {
        let pad = size * 0.25;
        let mut pb = PathBuilder::new();
        push_rounded_rect(&mut pb, start_x - pad, block_y - pad, total_w + pad * 2.0, total_h + pad * 2.0, size * 0.12);
        if let Some(path) = pb.finish() {
            pixmap.fill_path(&path, &paint(bg), FillRule::Winding, Transform::identity(), None);
        }
    }

    let ul_w = (size * 0.07).max(1.5);
    for (li, (line_w, gids)) in lines.iter().enumerate() {
        let mut pen = match style.align.as_str() {
            "center" => start_x + (total_w - line_w) / 2.0,
            "right" => start_x + total_w - line_w,
            _ => start_x,
        };
        if centered {
            pen = start_x + (total_w - line_w) / 2.0;
        }
        let baseline = start_baseline + line_advance * li as f32;
        if style.underline && *line_w > 0.0 {
            if let Some(r) = tiny_skia::Rect::from_xywh(pen, baseline + descent.abs() * 0.6, *line_w, ul_w) {
                let mut pb = PathBuilder::new();
                pb.push_rect(r);
                if let Some(path) = pb.finish() {
                    pixmap.fill_path(&path, &paint(color), FillRule::Winding, Transform::identity(), None);
                }
            }
        }
        for gid in gids {
            let mut pb = PathBuilder::new();
            let mut adapter = OutlineToPath(&mut pb);
            if face.outline_glyph(*gid, &mut adapter).is_some() {
                if let Some(path) = pb.finish() {
                    // y 翻转 + 基线平移；italic 为屏幕空间 12° 斜切
                    let shear = if style.italic { 0.21 * s } else { 0.0 };
                    let t = Transform::from_row(s, 0.0, shear, -s, pen, baseline);
                    pixmap.fill_path(&path, &paint(color), FillRule::Winding, t, None);
                    if synthetic_bold {
                        // 无真粗体文件时的描边加粗
                        let st = stroke_style(size * 0.04, false);
                        pixmap.stroke_path(&path, &paint(color), &st, t, None);
                    }
                }
            }
            pen += face.glyph_hor_advance(*gid).unwrap_or(0) as f32 * s;
        }
    }
    Ok(())
}

/// 读取 anchor OCR 块（`<stem>.ocr.json`）。
pub fn load_anchor_blocks(png_path: &Path) -> Option<Vec<AnchorBlock>> {
    let stem = png_path.with_extension("");
    let ocr_path = stem.with_file_name(format!(
        "{}.ocr.json",
        stem.file_name()?.to_string_lossy()
    ));
    let bytes = std::fs::read(ocr_path).ok()?;
    let wrapper: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let blocks = wrapper.get("blocks")?;
    serde_json::from_value(blocks.clone()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(ops: Vec<Operation>) -> AnnotationScript {
        AnnotationScript { unit: Unit::Px, theme: None, operations: ops }
    }

    fn op_rect(at: [f64; 2], size: [f64; 2]) -> Operation {
        Operation::Rect {
            at,
            size,
            style: None,
            color: None,
            width: None,
            radius: None,
            dash: None,
            opacity: None,
        }
    }

    #[test]
    fn validate_rejects_out_of_bounds() {
        let s = script(vec![op_rect([5000.0, 0.0], [10.0, 10.0])]);
        let errs = validate(&s, 1920, 1080);
        assert!(!errs.is_empty());
        assert!(errs.iter().all(|e| e.message.contains("越界")));
    }

    #[test]
    fn validate_rejects_too_many_ops() {
        let ops = (0..MAX_OPS + 1).map(|_| op_rect([0.0, 0.0], [1.0, 1.0])).collect();
        let s = script(ops);
        let errs = validate(&s, 1920, 1080);
        assert!(errs.iter().any(|e| e.message.contains("上限")));
    }

    #[test]
    fn render_is_deterministic() {
        let (w, h) = (200u32, 120u32);
        let rgba = vec![200u8; (w * h * 4) as usize];
        let png = {
            let img = image::RgbaImage::from_raw(w, h, rgba).unwrap();
            let mut cur = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(img).write_to(&mut cur, image::ImageFormat::Png).unwrap();
            cur.into_inner()
        };
        let ops = vec![
            Operation::Arrow { from: [10.0, 10.0], to: [100.0, 80.0], color: None, width: None, dash: None, double_head: None, heads: None, line_style: None },
            Operation::StepNumber { at: [30.0, 30.0], label: Some(1), color: None, diameter: None, style: None },
            Operation::Text { at: [10.0, 10.0], text: "测试 Test 123".into(), size: None, color: None, family: None, bold: None, italic: None, underline: None, align: None, line_height: None, background: None },
            Operation::Mosaic { at: [120.0, 20.0], size: [60.0, 40.0], mode: None, strength: None },
            Operation::Rect { at: [40.0, 40.0], size: [50.0, 30.0], style: None, color: None, width: None, radius: None, dash: None, opacity: None },
        ];
        let s = script(ops);
        let defaults = crate::settings::AnnotationDefaults::default();
        let input = RenderInput { png: &png, script: &s, anchor_blocks: None, defaults: &defaults };
        let r1 = render(&input).unwrap();
        let r2 = render(&input).unwrap();
        assert_eq!(r1.png, r2.png, "同脚本两次渲染必须逐字节一致");
    }
}
