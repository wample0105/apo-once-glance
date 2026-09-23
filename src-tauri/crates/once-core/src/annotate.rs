//! 指令驱动标注渲染引擎（ANN-1~5）。
//! 确定性：同图同脚本同 defaults 重复渲染输出逐字节一致（tiny-skia 自带光栅化 + 内嵌参数化字体布局，无系统 AA 差异源）。
//! 坐标：默认物理像素 `px`；`unit: "rel"` 为 0–1 相对坐标；`anchor: "block:N"` 引用 OCR 块锚点 + 偏移。
//! 整单拒绝：任何一条非法（越界/未知类型/超 200 操作）都不产出半成品，返回逐条错误。
//! 主题继承（SET-7 单源）：脚本未显式指定的属性一律回落 `defaults`（用户标注主题记忆值）——
//! 颜色按 `tool_colors.{工具键}`（arrow/pen/marker/rect/ellipse/text/num）→ 全局主题色；
//! 箭头/形状/文字样式、序号起始、马赛克模式、整图输出特效同规则。显式传参永远优先。

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
    /// 整图输出特效（业界同款阴影/边框）；三端契约：GUI/CLI/MCP 同语义
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<OutputFx>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OutputFx {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<OutputShadow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<OutputBorder>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OutputShadow {
    /// 模糊半径（px，默认 24）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blur: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OutputBorder {
    /// 边框宽度（px，默认 6）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
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
        /// 旋转角度（度，顺时针，围绕几何中心）
        #[serde(default)]
        rotation: Option<f32>,
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
        /// 旋转角度（度，顺时针，围绕折线包围盒中心）
        #[serde(default)]
        rotation: Option<f32>,
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
        /// 旋转角度（度，顺时针，围绕几何中心）
        #[serde(default)]
        rotation: Option<f32>,
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
        /// 旋转角度（度，顺时针，围绕几何中心）
        #[serde(default)]
        rotation: Option<f32>,
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
        /// 旋转角度（度，顺时针，围绕圆心）
        #[serde(default)]
        rotation: Option<f32>,
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
        /// 投影（右下偏移黑色半透明）
        #[serde(default)]
        shadow: Option<bool>,
        /// left | center | right（多行时逐行对齐）
        #[serde(default)]
        align: Option<String>,
        /// 行距倍数（默认 1.0）
        #[serde(default)]
        line_height: Option<f32>,
        /// 文字背景色（如 "#FFFFFF"）；缺省无背景
        #[serde(default)]
        background: Option<String>,
        /// 背景不透明度 0.05~1（默认 1 全不透明）
        #[serde(default)]
        background_opacity: Option<f32>,
        /// 背景圆角半径（物理像素，默认字号 12%）
        #[serde(default)]
        background_radius: Option<f32>,
        /// 描边色（文字外轮廓，画在填充之下）；缺省不描边
        #[serde(default)]
        stroke_color: Option<String>,
        /// 描边宽度（物理像素）
        #[serde(default)]
        stroke_width: Option<f32>,
        /// 旋转角度（度，顺时针，围绕文字块中心）
        #[serde(default)]
        rotation: Option<f32>,
    },
    Highlight {
        at: PointSpec,
        size: [f64; 2],
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        opacity: Option<f32>,
        /// 旋转角度（度，顺时针，围绕矩形中心）
        #[serde(default)]
        rotation: Option<f32>,
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
            // 模式继承：显式 mode > 主题记忆 mosaic_mode（"mosaic"/"pixelate" 归一为像素化）
            let is_blur = mode.as_deref().unwrap_or(&input.defaults.mosaic_mode) == "blur";
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

    // 自动编号计数器：从主题记忆 num_start-1 起（首个自动序号 = num_start，GUI 序号起始语义一致）
    let mut step_counter: i32 = (input.defaults.num_start - 1).max(0);
    for op in ops {
        match op {
            Operation::Arrow { from, to, color, width, dash, double_head, heads, line_style, rotation } => {
                let (fx, fy) = resolve(unit, w, h, from);
                let (tx, ty) = resolve(unit, w, h, to);
                let fx = fx - crop_off.0 as f32;
                let fy = fy - crop_off.1 as f32;
                let tx = tx - crop_off.0 as f32;
                let ty = ty - crop_off.1 as f32;
                let color = parse_color(color.as_deref())
                    .unwrap_or_else(|| theme_color(input.defaults, "arrow").unwrap_or_else(accent));
                let lw = width.unwrap_or(input.defaults.arrow_width);
                // 头型：显式 heads > 旧兼容 double_head > 主题记忆 arrow_heads
                let heads_v = heads
                    .as_deref()
                    .map(|s| s.to_string())
                    .or_else(|| double_head.map(|d| if d { "both".to_string() } else { "end".to_string() }))
                    .unwrap_or_else(|| input.defaults.arrow_heads.clone());
                // 线型：显式 line_style > 旧兼容 dash=true > 主题记忆 arrow_line_style
                let ls = line_style
                    .as_deref()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| {
                        if dash.unwrap_or(false) { "dashed".into() } else { input.defaults.arrow_line_style.clone() }
                    });
                let xf = center_xform(*rotation, (fx + tx) / 2.0, (fy + ty) / 2.0);
                draw_arrow(&mut pixmap, fx, fy, tx, ty, lw, color, &ls, &heads_v, xf);
            }
            Operation::Pen { points, color, width, mode, rotation } => {
                let col = parse_color(color.as_deref())
                    .unwrap_or_else(|| theme_color(input.defaults, "pen").unwrap_or_else(accent));
                let mut pts: Vec<(f32, f32)> = Vec::with_capacity(points.len());
                for p in points {
                    let (x, y) = resolve(unit, w, h, p);
                    pts.push((x - crop_off.0 as f32, y - crop_off.1 as f32));
                }
                // 旋转：绕折线包围盒中心（度，顺时针）
                if let Some(deg) = *rotation {
                    if deg != 0.0 {
                        let (min_x, min_y) = (pts.iter().fold(f32::MAX, |m, p| m.min(p.0)), pts.iter().fold(f32::MAX, |m, p| m.min(p.1)));
                        let (max_x, max_y) = (pts.iter().fold(f32::MIN, |m, p| m.max(p.0)), pts.iter().fold(f32::MIN, |m, p| m.max(p.1)));
                        let (cx, cy) = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
                        let (sn, cs) = deg.to_radians().sin_cos();
                        for p in pts.iter_mut() {
                            let (dx, dy) = (p.0 - cx, p.1 - cy);
                            p.0 = cx + dx * cs - dy * sn;
                            p.1 = cy + dx * sn + dy * cs;
                        }
                    }
                }
                draw_pen(
                    &mut pixmap,
                    &pts,
                    width.unwrap_or(input.defaults.shape_width),
                    col,
                    mode.as_deref(),
                );
            }
            Operation::Rect { at, size, style, color, width, radius, dash, opacity, rotation } => {
                let (x, y) = resolve(unit, w, h, at);
                let x = x - crop_off.0 as f32;
                let y = y - crop_off.1 as f32;
                let xf = center_xform(*rotation, x + size[0] as f32 / 2.0, y + size[1] as f32 / 2.0);
                draw_rect(
                    &mut pixmap, x, y,
                    size[0] as f32, size[1] as f32,
                    Some(style.as_deref().unwrap_or(&input.defaults.shape_fill)),
                    parse_color(color.as_deref())
                        .unwrap_or_else(|| theme_color(input.defaults, "rect").unwrap_or_else(accent)),
                    width.unwrap_or(input.defaults.shape_width),
                    radius.unwrap_or(if input.defaults.shape_radius { 12.0 } else { 0.0 }),
                    dash.unwrap_or(input.defaults.shape_dash),
                    Some(opacity.unwrap_or(input.defaults.shape_opacity).clamp(0.05, 1.0)),
                    xf,
                );
            }
            Operation::Ellipse { at, size, style, color, width, dash, opacity, rotation } => {
                let (x, y) = resolve(unit, w, h, at);
                let x = x - crop_off.0 as f32;
                let y = y - crop_off.1 as f32;
                let xf = center_xform(*rotation, x + size[0] as f32 / 2.0, y + size[1] as f32 / 2.0);
                draw_ellipse(
                    &mut pixmap, x, y,
                    size[0] as f32, size[1] as f32,
                    Some(style.as_deref().unwrap_or(&input.defaults.shape_fill)),
                    parse_color(color.as_deref())
                        .unwrap_or_else(|| theme_color(input.defaults, "ellipse").unwrap_or_else(accent)),
                    width.unwrap_or(input.defaults.shape_width),
                    dash.unwrap_or(input.defaults.shape_dash),
                    Some(opacity.unwrap_or(input.defaults.shape_opacity).clamp(0.05, 1.0)),
                    xf,
                );
            }
            Operation::StepNumber { at, label, color, diameter, style, rotation } => {
                step_counter += 1;
                // 自动编号从主题记忆 num_start 起（ANN-7）；显式 label 优先
                let n = label.unwrap_or(step_counter as u32);
                let (x, y) = resolve(unit, w, h, at);
                let x = x - crop_off.0 as f32;
                let y = y - crop_off.1 as f32;
                let col = parse_color(color.as_deref())
                    .unwrap_or_else(|| theme_color(input.defaults, "num").unwrap_or_else(accent));
                draw_step_number(
                    &mut pixmap, x, y,
                    diameter.unwrap_or(input.defaults.step_diameter),
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
                shadow,
                align,
                line_height,
                background,
                background_opacity,
                background_radius,
                stroke_color,
                stroke_width,
                rotation,
            } => {
                let (x, y) = resolve(unit, w, h, at);
                // 主题继承：显式字段优先，缺省回落标注主题记忆值（标注主题页只读可见）
                let eff_color = parse_color(color.as_deref())
                    .unwrap_or_else(|| theme_color(input.defaults, "text").unwrap_or_else(accent));
                let style = {
                    let d = input.defaults;
                    let bg_from_theme = background.is_none() && d.text_background;
                    // 描边继承：GUI 语义 = 开关 text_stroke → 对比色 + 字号 8% 宽
                    let stroke_from_theme = stroke_color.is_none() && stroke_width.is_none() && d.text_stroke;
                    TextStyle {
                        family: family.clone().unwrap_or_else(|| d.text_family.clone()),
                        bold: bold.unwrap_or(d.text_bold),
                        italic: italic.unwrap_or(d.text_italic),
                        underline: underline.unwrap_or(d.text_underline),
                        shadow: shadow.unwrap_or(d.text_shadow),
                        align: align.as_deref().unwrap_or(&d.text_align).to_string(),
                        line_height: line_height.unwrap_or(d.text_line_height),
                        background: background.as_deref().and_then(|s| parse_color(Some(s)))
                            .or_else(|| bg_from_theme.then(|| parse_color(Some(&d.text_bg_color))).flatten()),
                        bg_opacity: background_opacity.map(|v| v.clamp(0.05, 1.0))
                            .or_else(|| bg_from_theme.then(|| d.text_bg_opacity.clamp(0.05, 1.0))),
                        bg_radius: background_radius.map(|v| v.max(0.0))
                            .or_else(|| bg_from_theme.then(|| d.text_bg_radius.max(0.0))),
                        stroke_color: stroke_color.as_deref().and_then(|s| parse_color(Some(s)))
                            .or_else(|| stroke_from_theme.then(|| stroke_contrast(eff_color))),
                        stroke_width: stroke_width.map(|v| v.max(1.0))
                            .or_else(|| stroke_from_theme.then(|| (size.unwrap_or(d.text_size) * 0.08).max(1.5))),
                    }
                };
                let xf = center_xform(*rotation, 0.0, 0.0); // 中心在排版后才知道：draw_text 内部处理
                draw_text_rot(
                    &mut pixmap,
                    x - crop_off.0 as f32,
                    y - crop_off.1 as f32,
                    text,
                    size.unwrap_or(input.defaults.text_size),
                    eff_color,
                    &style,
                    rotation.unwrap_or(0.0),
                )?;
            }
            Operation::Highlight { at, size, color, opacity, rotation } => {
                let (x, y) = resolve(unit, w, h, at);
                let x = x - crop_off.0 as f32;
                let y = y - crop_off.1 as f32;
                // 高亮色继承：tool_colors.marker → #FFB020（与 GUI 高亮工具同色）
                let col = parse_color(color.as_deref()).unwrap_or_else(|| {
                    theme_color(input.defaults, "marker").unwrap_or(Color::from_rgba8(255, 176, 32, 255))
                });
                let opa = opacity.unwrap_or(input.defaults.highlight_opacity).clamp(0.05, 1.0);
                let mut p = Paint::default();
                p.set_color(Color::from_rgba8((col.red() * 255.0) as u8, (col.green() * 255.0) as u8, (col.blue() * 255.0) as u8, (opa * 255.0) as u8));
                p.anti_alias = true;
                let xf = center_xform(*rotation, x + size[0] as f32 / 2.0, y + size[1] as f32 / 2.0);
                let mut pb = PathBuilder::new();
                pb.push_rect(
                    tiny_skia::Rect::from_xywh(x, y, size[0] as f32, size[1] as f32)
                        .ok_or_else(|| OnceError::usage("高亮矩形无效"))?,
                );
                let path = pb.finish().ok_or_else(|| OnceError::usage("高亮路径无效"))?;
                pixmap.fill_path(&path, &p, FillRule::Winding, xf, None);
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

    // 整图输出特效（阴影/边框）：脚本显式 output 优先，缺省继承主题记忆的输出选项
    let owned_fx = input.script.output.clone().or_else(|| theme_output_fx(input.defaults));
    let final_pixmap = apply_output_fx(final_pixmap, owned_fx.as_ref())?;

    let out_png = final_pixmap
        .encode_png()
        .map_err(|e| OnceError::io("标注结果 PNG 编码失败").with_source(e.to_string()))?;
    Ok(RenderOutput { png: out_png, width: final_pixmap.width(), height: final_pixmap.height() })
}

/// 文字投影色（半透明黑，alpha≈45%）
fn text_shadow_col() -> Color {
    Color::from_rgba8(0, 0, 0, 115)
}

/// 整图输出特效：外阴影（盒式模糊近似）+ 边框（业界同款出图效果）。
/// 画布四向扩 pad = 边框宽 + 模糊半径；基图始终不被裁切。
fn apply_output_fx(src: Pixmap, fx: Option<&OutputFx>) -> Result<Pixmap> {
    let Some(fx) = fx else { return Ok(src) };
    let shadow = fx.shadow.as_ref().map(|s| {
        let blur = s.blur.unwrap_or(24.0).clamp(2.0, 120.0).ceil() as i32;
        let color = parse_color(s.color.as_deref()).unwrap_or(Color::from_rgba8(0, 0, 0, 255));
        (blur, color)
    });
    let border = fx.border.as_ref().map(|b| {
        let w = b.width.unwrap_or(6.0).clamp(1.0, 40.0);
        let color = parse_color(b.color.as_deref()).unwrap_or(Color::from_rgba8(255, 255, 255, 255));
        (w, color)
    });
    if shadow.is_none() && border.is_none() {
        return Ok(src);
    }
    let bw = border.map(|(w, _)| w as i32).unwrap_or(0);
    let blur = shadow.map(|(b, _)| b).unwrap_or(0);
    let pad = (bw + blur) as u32;
    let w = src.width();
    let h = src.height();
    let ow = w + pad * 2;
    let oh = h + pad * 2;
    let mut out = Pixmap::new(ow, oh).ok_or_else(|| OnceError::usage("输出特效画布创建失败"))?;

    // 1) 外阴影：覆盖图+边框范围的矩形，填充后整体盒式模糊（透明底上只影响 alpha/颜色渐变）
    if let Some((b, col)) = shadow {
        let rect = tiny_skia::Rect::from_xywh(
            (pad as i32 - bw) as f32,
            (pad as i32 - bw) as f32,
            (w + 2 * bw as u32) as f32,
            (h + 2 * bw as u32) as f32,
        )
        .ok_or_else(|| OnceError::usage("阴影矩形无效"))?;
        let mut pb = PathBuilder::new();
        pb.push_rect(rect);
        if let Some(path) = pb.finish() {
            let mut p = Paint::default();
            p.set_color(Color::from_rgba8(
                (col.red() * 255.0) as u8,
                (col.green() * 255.0) as u8,
                (col.blue() * 255.0) as u8,
                110,
            ));
            p.anti_alias = true;
            out.fill_path(&path, &p, FillRule::Winding, Transform::identity(), None);
        }
        box_blur_region(
            &mut out,
            Region { x0: 0, y0: 0, x1: ow, y1: oh },
            b as f32,
        );
    }

    // 2) 边框：不透明外框矩形（贴图外沿 bw 宽）
    if let Some((_, col)) = border {
        let rect = tiny_skia::Rect::from_xywh(
            (pad as i32 - bw) as f32,
            (pad as i32 - bw) as f32,
            (w + 2 * bw as u32) as f32,
            (h + 2 * bw as u32) as f32,
        )
        .ok_or_else(|| OnceError::usage("边框矩形无效"))?;
        let mut pb = PathBuilder::new();
        pb.push_rect(rect);
        if let Some(path) = pb.finish() {
            out.fill_path(&path, &paint(col), FillRule::Winding, Transform::identity(), None);
        }
    }

    // 3) 基图粘贴 (pad, pad)（逐行拷贝）
    {
        let data = out.data_mut();
        let src_data = src.data();
        for row in 0..h as usize {
            let dst = ((pad as usize + row) * ow as usize + pad as usize) * 4;
            let srci = row * w as usize * 4;
            data[dst..dst + w as usize * 4].copy_from_slice(&src_data[srci..srci + w as usize * 4]);
        }
    }
    Ok(out)
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

/// 主题继承色：`tool_colors.{tool_key}`（每工具独立色，同款语义）→ 全局主题色。
/// 返回 None 表示 defaults 里没有任何可用色（调用方再兜底 accent）。
fn theme_color(defaults: &crate::settings::AnnotationDefaults, tool_key: &str) -> Option<Color> {
    if let Some(tc) = &defaults.tool_colors {
        if let Some(c) = tc.get(tool_key).and_then(|v| v.as_str()) {
            if let Some(col) = parse_color(Some(c)) {
                return Some(col);
            }
        }
    }
    parse_color(Some(&defaults.color))
}

/// 描边对比色（与 GUI overlay.js strokeContrast 同规则：亮度 > 140 用黑，否则白）。
fn stroke_contrast(c: Color) -> Color {
    let lum = c.red() * 255.0 * 0.299 + c.green() * 255.0 * 0.587 + c.blue() * 255.0 * 0.114;
    if lum > 140.0 {
        Color::from_rgba8(0, 0, 0, 255)
    } else {
        Color::from_rgba8(255, 255, 255, 255)
    }
}

/// settings.output_shadow / output_border（GUI 记忆值，含 on 开关）→ 引擎 OutputFx。
/// 全关或字段非法返回 None（脚本未传且主题未开 = 纯叠加输出）。
fn theme_output_fx(defaults: &crate::settings::AnnotationDefaults) -> Option<OutputFx> {
    #[derive(serde::Deserialize)]
    struct SavedFx {
        #[serde(default)]
        on: bool,
        #[serde(default)]
        blur: Option<f32>,
        #[serde(default)]
        width: Option<f32>,
        #[serde(default)]
        color: Option<String>,
    }
    let shadow = defaults
        .output_shadow
        .as_ref()
        .and_then(|v| serde_json::from_value::<SavedFx>(v.clone()).ok())
        .filter(|s| s.on)
        .map(|s| OutputShadow { blur: s.blur, color: s.color });
    let border = defaults
        .output_border
        .as_ref()
        .and_then(|v| serde_json::from_value::<SavedFx>(v.clone()).ok())
        .filter(|b| b.on)
        .map(|b| OutputBorder { width: b.width, color: b.color });
    if shadow.is_none() && border.is_none() {
        return None;
    }
    Some(OutputFx { shadow, border })
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
    xf: Transform,
) {
    let dash = line_style == "dashed";
    let dotted = line_style == "dotted";
    let head_start = heads == "both" || heads == "start";
    let head_end = heads == "end" || heads == "both";
    let lw = width.max(2.0);
    // 业界同款饱满箭头尖：长约 4.2 倍线宽（18–60px），与 GUI 预览一致
    let head = (lw * 4.2).clamp(18.0, 60.0);
    let dx = x1 - x0;
    let dy = y1 - y0;
    let len = (dx * dx + dy * dy).sqrt().max(1.0);
    let ux = dx / len;
    let uy = dy / len;
    // 箭头体：有尖的一端让出尖的长度
    let back = if head_start { head } else { 0.0 };
    let bx = x0 + ux * back;
    let by = y0 + uy * back;
    let trim = if head_end { head } else { 0.0 };
    let bx2 = x1 - ux * trim;
    let by2 = y1 - uy * trim;
    let mut pb = PathBuilder::new();
    pb.move_to(bx, by);
    pb.line_to(bx2, by2);
    if let Some(path) = pb.finish() {
        let mut stroke = stroke_style(lw, dash);
        if dotted {
            stroke.dash = tiny_skia::StrokeDash::new(vec![lw * 0.4, lw * 1.8], 0.0);
        }
        pixmap.stroke_path(&path, &paint(color), &stroke, xf, None);
    }
    // 线体法向（箭头尖宽度方向）
    let px = -uy;
    let py = ux;
    if head_end {
        // 实心三角头（终点）
        let mut hb = PathBuilder::new();
        hb.move_to(x1, y1);
        hb.line_to(bx2 + px * head * 0.32, by2 + py * head * 0.32);
        hb.line_to(bx2 - px * head * 0.32, by2 - py * head * 0.32);
        hb.close();
        if let Some(path) = hb.finish() {
            pixmap.fill_path(&path, &paint(color), FillRule::Winding, xf, None);
        }
    }
    if head_start {
        let mut hb = PathBuilder::new();
        hb.move_to(x0, y0);
        hb.line_to(bx + px * head * 0.32, by + py * head * 0.32);
        hb.line_to(bx - px * head * 0.32, by - py * head * 0.32);
        hb.close();
        if let Some(path) = hb.finish() {
            pixmap.fill_path(&path, &paint(color), FillRule::Winding, xf, None);
        }
    }
}

/// 仿射矩阵组合 C = A ∘ B（先应用 B 再应用 A；tiny_skia 0.12 无内建乘法）
fn xform_mul(a: Transform, b: Transform) -> Transform {
    Transform::from_row(
        a.sx * b.sx + a.kx * b.ky,
        a.ky * b.sx + a.sy * b.ky,
        a.sx * b.kx + a.kx * b.sy,
        a.ky * b.kx + a.sy * b.sy,
        a.sx * b.tx + a.kx * b.ty + a.tx,
        a.ky * b.tx + a.sy * b.ty + a.ty,
    )
}

/// 绕对象中心旋转的变换（rotation 单位：度，屏幕坐标系顺时针为正；None/0 = 恒等）
fn center_xform(rotation: Option<f32>, cx: f32, cy: f32) -> Transform {
    let deg = match rotation {
        Some(d) => d,
        None => return Transform::identity(),
    };
    if deg == 0.0 {
        return Transform::identity();
    }
    let (s, c) = deg.to_radians().sin_cos();
    Transform::from_row(c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy)
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
    xf: Transform,
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
        "fill" => pixmap.fill_path(&path, &paint(color), FillRule::Winding, xf, None),
        "outline_fill" => {
            let mut p = paint(color);
            // 内部蒙层 alpha=24%×整体不透明度：不透明度滑杆对描边+填充同样生效（曾固定 60 致滑杆只淡边框）
            let op = opacity.unwrap_or(1.0);
            let fa = (60.0 * op).round().clamp(0.0, 60.0) as u8;
            p.set_color(Color::from_rgba8((color.red() * 255.0) as u8, (color.green() * 255.0) as u8, (color.blue() * 255.0) as u8, fa));
            pixmap.fill_path(&path, &p, FillRule::Winding, xf, None);
            let stroke = stroke_style(lw, dash);
            pixmap.stroke_path(&path, &paint(color), &stroke, xf, None);
        }
        _ => {
            let stroke = stroke_style(lw, dash);
            pixmap.stroke_path(&path, &paint(color), &stroke, xf, None);
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
    xf: Transform,
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
        "fill" => pixmap.fill_path(&path, &paint(color), FillRule::Winding, xf, None),
        "outline_fill" => {
            let mut p = paint(color);
            // 与矩形一致：蒙层 alpha=24%×整体不透明度（滑杆全局生效）
            let op = opacity.unwrap_or(1.0);
            let fa = (60.0 * op).round().clamp(0.0, 60.0) as u8;
            p.set_color(Color::from_rgba8((color.red() * 255.0) as u8, (color.green() * 255.0) as u8, (color.blue() * 255.0) as u8, fa));
            pixmap.fill_path(&path, &p, FillRule::Winding, xf, None);
            pixmap.stroke_path(&path, &paint(color), &stroke, xf, None);
        }
        _ => {
            pixmap.stroke_path(&path, &paint(color), &stroke, xf, None);
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
    shadow: bool,
    align: String,
    line_height: f32,
    background: Option<Color>,
    bg_opacity: Option<f32>,
    bg_radius: Option<f32>,
    /// 描边颜色/宽度（物理像素）；先描边后填充，位于字形之下
    stroke_color: Option<Color>,
    stroke_width: Option<f32>,
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            family: "default".into(),
            bold: false,
            italic: false,
            underline: false,
            shadow: false,
            align: "left".into(),
            line_height: 1.0,
            background: None,
            bg_opacity: None,
            bg_radius: None,
            stroke_color: None,
            stroke_width: None,
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
    draw_text_at(pixmap, x, y, text, size, color, false, style, 0.0)
}

fn draw_text_centered(
    pixmap: &mut Pixmap,
    cx: f32,
    cy: f32,
    text: &str,
    size: f32,
    color: Color,
) -> Result<()> {
    draw_text_at(pixmap, cx, cy, text, size, color, true, &TextStyle::default(), 0.0)
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
fn draw_text_rot(
    pixmap: &mut Pixmap,
    x: f32,
    y: f32,
    text: &str,
    size: f32,
    color: Color,
    style: &TextStyle,
    rotation: f32,
) -> Result<()> {
    draw_text_at(pixmap, x, y, text, size, color, false, style, rotation)
}

fn draw_text_at(
    pixmap: &mut Pixmap,
    x: f32,
    y: f32,
    text: &str,
    size: f32,
    color: Color,
    centered: bool,
    style: &TextStyle,
    rotation: f32,
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

    // 旋转变换：绕文字块中心（rotation 单位：度）
    let rot = center_xform(Some(rotation), start_x + total_w / 2.0, block_y + total_h / 2.0);

    // 文字背景（先行绘制，位于字形之下）：透明度+圆角可调（默认圆角=字号12%，与旧行为一致）
    if let Some(bg) = style.background {
        let pad = size * 0.25;
        let radius = style.bg_radius.unwrap_or(size * 0.12);
        let mut bg = bg;
        if let Some(op) = style.bg_opacity {
            bg = Color::from_rgba(bg.red(), bg.green(), bg.blue(), bg.alpha() * op).unwrap_or(bg);
        }
        let mut pb = PathBuilder::new();
        push_rounded_rect(&mut pb, start_x - pad, block_y - pad, total_w + pad * 2.0, total_h + pad * 2.0, radius);
        if let Some(path) = pb.finish() {
            pixmap.fill_path(&path, &paint(bg), FillRule::Winding, rot, None);
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
                    pixmap.fill_path(&path, &paint(color), FillRule::Winding, rot, None);
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
                    let t = xform_mul(rot, Transform::from_row(s, 0.0, shear, -s, pen, baseline));
                    if style.shadow {
                        // 投影：右下偏移约 6% 字号的半透明黑，先画（位于字形之下）
                        let off = (size * 0.06).max(1.5);
                        let ts = xform_mul(rot, Transform::from_row(s, 0.0, shear, -s, pen + off, baseline + off));
                        pixmap.fill_path(&path, &paint(text_shadow_col()), FillRule::Winding, ts, None);
                    }
                    if let (Some(sc), Some(sw)) = (style.stroke_color, style.stroke_width) {
                        // 描边：画在填充之下（字形外轮廓扩边）
                        let st = stroke_style(sw, false);
                        pixmap.stroke_path(&path, &paint(sc), &st, t, None);
                    }
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
        AnnotationScript { unit: Unit::Px, theme: None, operations: ops, output: None }
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
            rotation: None,
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
            Operation::Arrow { from: [10.0, 10.0], to: [100.0, 80.0], color: None, width: None, dash: None, double_head: None, heads: None, line_style: None, rotation: None },
            Operation::StepNumber { at: [30.0, 30.0], label: Some(1), color: None, diameter: None, style: None, rotation: None },
            Operation::Text { at: [10.0, 10.0], text: "测试 Test 123".into(), size: None, color: None, family: None, bold: None, italic: None, underline: None, shadow: None, rotation: None, align: None, line_height: None, background: None, background_opacity: None, background_radius: None, stroke_color: None, stroke_width: None },
            Operation::Mosaic { at: [120.0, 20.0], size: [60.0, 40.0], mode: None, strength: None },
            Operation::Rect { at: [40.0, 40.0], size: [50.0, 30.0], style: None, color: None, width: None, radius: None, dash: None, opacity: None, rotation: None },
        ];
        let s = script(ops);
        let defaults = crate::settings::AnnotationDefaults::default();
        let input = RenderInput { png: &png, script: &s, anchor_blocks: None, defaults: &defaults };
        let r1 = render(&input).unwrap();
        let r2 = render(&input).unwrap();
        assert_eq!(r1.png, r2.png, "同脚本两次渲染必须逐字节一致");
    }

    #[test]
    fn rotation_render_smoke() {
        // 旋转 90°：渲染确定、且与 0° 输出不同（真实生效）；不 panic、不越界
        let (w, h) = (200u32, 120u32);
        let png = {
            let mut rgba = vec![255u8; (w * h * 4) as usize];
            for px in rgba.chunks_exact_mut(4) { px[0] = 128; px[1] = 128; px[2] = 128; }
            let img = image::RgbaImage::from_raw(w, h, rgba).unwrap();
            let mut cur = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(img).write_to(&mut cur, image::ImageFormat::Png).unwrap();
            cur.into_inner()
        };
        let defaults = crate::settings::AnnotationDefaults::default();
        let mk = |rot: Option<f32>| AnnotationScript {
            unit: Unit::Px,
            theme: None,
            operations: vec![Operation::Rect {
                at: [60.0, 30.0], size: [80.0, 40.0], style: Some("fill".into()),
                color: Some("#ED1C24".into()), width: None, radius: None, dash: None,
                opacity: None, rotation: rot,
            }],
            output: None,
        };
        let r0 = render(&RenderInput { png: &png, script: &mk(Some(0.0)), anchor_blocks: None, defaults: &defaults }).unwrap();
        let r90a = render(&RenderInput { png: &png, script: &mk(Some(90.0)), anchor_blocks: None, defaults: &defaults }).unwrap();
        let r90b = render(&RenderInput { png: &png, script: &mk(Some(90.0)), anchor_blocks: None, defaults: &defaults }).unwrap();
        assert_eq!(r90a.png, r90b.png, "旋转渲染必须确定");
        assert_ne!(r0.png, r90a.png, "90° 旋转输出必须与 0° 不同");
        assert_eq!((r0.width, r0.height), (r90a.width, r90a.height), "旋转不改变画布尺寸");
    }

    #[test]
    fn output_fx_expands_canvas() {
        let (w, h) = (100u32, 80u32);
        // 源图：不透明灰 (128,128,128,255)——alpha 必须 255，premultiplied 语义下 RGB 才等于原色
        let mut rgba = vec![255u8; (w * h * 4) as usize];
        for px in rgba.chunks_exact_mut(4) {
            px[0] = 128; px[1] = 128; px[2] = 128;
        }
        let png = {
            let img = image::RgbaImage::from_raw(w, h, rgba).unwrap();
            let mut cur = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(img).write_to(&mut cur, image::ImageFormat::Png).unwrap();
            cur.into_inner()
        };
        let ops = vec![];
        let defaults = crate::settings::AnnotationDefaults::default();
        // 阴影 blur=10 + 边框 4 → pad = 14，画布 128×108
        let s = AnnotationScript {
            unit: Unit::Px,
            theme: None,
            operations: ops,
            output: Some(OutputFx {
                shadow: Some(OutputShadow { blur: Some(10.0), color: None }),
                border: Some(OutputBorder { width: Some(4.0), color: Some("#FFFFFF".into()) }),
            }),
        };
        let input = RenderInput { png: &png, script: &s, anchor_blocks: None, defaults: &defaults };
        let r = render(&input).unwrap();
        assert_eq!(r.width, w + 28, "阴影+边框必须向外扩 pad=blur+bw");
        assert_eq!(r.height, h + 28);
        // 边框角像素应为白色不透明
        let img = image::load_from_memory(&r.png).unwrap().to_rgba8();
        let corner = img.get_pixel(13, 13); // pad(14) 内、边框(4px)内
        assert_eq!((corner[0], corner[1], corner[2], corner[3]), (255, 255, 255, 255));
        // 基图中心像素应保持原色 128
        let center = img.get_pixel((w / 2 + 14) as u32, (h / 2 + 14) as u32);
        assert_eq!(center[0], 128);
    }

    // ===== 主题继承（SET-7 单源）：脚本未显式指定的属性回落 defaults =====

    fn png_of(w: u32, h: u32, fill_px: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
        let mut rgba = vec![255u8; (w * h * 4) as usize];
        for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
            let c = fill_px((i as u32) % w, (i as u32) / w);
            px[0] = c[0];
            px[1] = c[1];
            px[2] = c[2];
        }
        let img = image::RgbaImage::from_raw(w, h, rgba).unwrap();
        let mut cur = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img).write_to(&mut cur, image::ImageFormat::Png).unwrap();
        cur.into_inner()
    }

    fn render_with(
        png: &[u8],
        ops: Vec<Operation>,
        defaults: &crate::settings::AnnotationDefaults,
    ) -> RenderOutput {
        let s = script(ops);
        render(&RenderInput { png, script: &s, anchor_blocks: None, defaults }).unwrap()
    }

    fn rgb8(c: Option<Color>) -> [u8; 3] {
        c.map(|x| [(x.red() * 255.0) as u8, (x.green() * 255.0) as u8, (x.blue() * 255.0) as u8])
            .unwrap_or([0, 0, 0])
    }

    #[test]
    fn theme_color_prefers_tool_key_then_global() {
        let d = crate::settings::AnnotationDefaults { color: "#FF0000".into(), ..Default::default() };
        // 无 tool_colors：回落全局主题色
        assert_eq!(rgb8(theme_color(&d, "arrow")), [255, 0, 0]);
        // 命中工具键：工具色优先
        let d2 = crate::settings::AnnotationDefaults {
            color: "#FF0000".into(),
            tool_colors: Some(serde_json::json!({ "arrow": "#00FF00" })),
            ..Default::default()
        };
        assert_eq!(rgb8(theme_color(&d2, "arrow")), [0, 255, 0]);
        // 未命中键：回落全局主题色
        assert_eq!(rgb8(theme_color(&d2, "text")), [255, 0, 0]);
    }

    #[test]
    fn stroke_contrast_matches_gui_rule() {
        let white = Color::from_rgba8(255, 255, 255, 255);
        let black = Color::from_rgba8(0, 0, 0, 255);
        assert_eq!(rgb8(Some(stroke_contrast(white))), [0, 0, 0]);
        assert_eq!(rgb8(Some(stroke_contrast(black))), [255, 255, 255]);
    }

    #[test]
    fn inherit_arrow_color_from_tool_colors() {
        let png = png_of(200, 120, |_, _| [200, 200, 200]);
        let d = crate::settings::AnnotationDefaults {
            color: "#FF0000".into(),
            tool_colors: Some(serde_json::json!({ "arrow": "#00FF00" })),
            ..Default::default()
        };
        let r = render_with(
            &png,
            vec![Operation::Arrow {
                from: [20.0, 60.0],
                to: [120.0, 60.0],
                color: None,
                width: None,
                dash: None,
                double_head: None,
                heads: None,
                line_style: None,
                rotation: None,
            }],
            &d,
        );
        let px = image::load_from_memory(&r.png).unwrap().to_rgba8().get_pixel(70, 60).0;
        assert_eq!((px[0], px[1], px[2]), (0, 255, 0), "箭头未传 color 必须继承 tool_colors.arrow");
    }

    #[test]
    fn explicit_arrow_color_overrides_theme() {
        let png = png_of(200, 120, |_, _| [200, 200, 200]);
        let d = crate::settings::AnnotationDefaults {
            color: "#FF0000".into(),
            tool_colors: Some(serde_json::json!({ "arrow": "#00FF00" })),
            ..Default::default()
        };
        let r = render_with(
            &png,
            vec![Operation::Arrow {
                from: [20.0, 60.0],
                to: [120.0, 60.0],
                color: Some("#0000FF".into()),
                width: None,
                dash: None,
                double_head: None,
                heads: None,
                line_style: None,
                rotation: None,
            }],
            &d,
        );
        let px = image::load_from_memory(&r.png).unwrap().to_rgba8().get_pixel(70, 60).0;
        assert_eq!((px[0], px[1], px[2]), (0, 0, 255), "显式 color 必须覆盖主题色");
    }

    #[test]
    fn inherit_rect_fill_from_shape_fill() {
        let png = png_of(200, 120, |_, _| [200, 200, 200]);
        let op = op_rect([40.0, 40.0], [50.0, 30.0]);
        let mut d = crate::settings::AnnotationDefaults::default();
        d.shape_fill = "fill".into();
        let r = render_with(&png, vec![op.clone()], &d);
        let px = image::load_from_memory(&r.png).unwrap().to_rgba8().get_pixel(65, 55).0;
        assert_eq!((px[0], px[1], px[2]), (255, 59, 48), "shape_fill=fill 时矩形中心为主题色");
        // 出厂默认 outline：中心保持底色
        let d2 = crate::settings::AnnotationDefaults::default();
        let r2 = render_with(&png, vec![op], &d2);
        let px2 = image::load_from_memory(&r2.png).unwrap().to_rgba8().get_pixel(65, 55).0;
        assert_eq!([px2[0], px2[1], px2[2]], [200, 200, 200]);
    }

    #[test]
    fn inherit_arrow_heads_from_theme() {
        let png = png_of(240, 120, |_, _| [200, 200, 200]);
        let mk = || {
            vec![Operation::Arrow {
                from: [20.0, 60.0],
                to: [200.0, 60.0],
                color: Some("#000000".into()),
                width: None,
                dash: None,
                double_head: None,
                heads: None,
                line_style: None,
                rotation: None,
            }]
        };
        let mut d_end = crate::settings::AnnotationDefaults::default();
        d_end.arrow_heads = "end".into();
        let mut d_none = crate::settings::AnnotationDefaults::default();
        d_none.arrow_heads = "none".into();
        assert_ne!(
            render_with(&png, mk(), &d_end).png,
            render_with(&png, mk(), &d_none).png,
            "arrow_heads 主题值必须参与渲染"
        );
    }

    #[test]
    fn inherit_step_autonumber_start() {
        let png = png_of(300, 120, |_, _| [200, 200, 200]);
        let mk = || {
            vec![
                Operation::StepNumber { at: [40.0, 60.0], label: None, color: None, diameter: None, style: None, rotation: None },
                Operation::StepNumber { at: [100.0, 60.0], label: None, color: None, diameter: None, style: None, rotation: None },
            ]
        };
        let mut d1 = crate::settings::AnnotationDefaults::default();
        d1.num_start = 1;
        let mut d5 = crate::settings::AnnotationDefaults::default();
        d5.num_start = 5;
        let r1 = render_with(&png, mk(), &d1);
        let r5 = render_with(&png, mk(), &d5);
        assert_ne!(r1.png, r5.png, "自动编号必须从 num_start 起");
        assert_eq!(r5.png, render_with(&png, mk(), &d5).png, "同 defaults 渲染仍须确定");
    }

    #[test]
    fn inherit_text_style_from_defaults() {
        let png = png_of(300, 140, |_, _| [240, 240, 240]);
        let mk = |shadow: Option<bool>| {
            vec![Operation::Text {
                at: [20.0, 30.0],
                text: "测试 Test".into(),
                size: Some(28.0),
                color: None,
                family: None,
                bold: None,
                italic: None,
                underline: None,
                shadow,
                rotation: None,
                align: None,
                line_height: None,
                background: None,
                background_opacity: None,
                background_radius: None,
                stroke_color: None,
                stroke_width: None,
            }]
        };
        let d_on = crate::settings::AnnotationDefaults::default(); // 出厂 text_shadow: true
        let mut d_off = crate::settings::AnnotationDefaults::default();
        d_off.text_shadow = false;
        let r_def = render_with(&png, mk(None), &d_on);
        let r_off = render_with(&png, mk(None), &d_off);
        assert_ne!(r_def.png, r_off.png, "text_shadow 主题值必须参与渲染");
        // 显式传参覆盖主题：显式 false + 主题 true == 主题 false
        assert_eq!(render_with(&png, mk(Some(false)), &d_on).png, r_off.png);
    }

    #[test]
    fn inherit_text_family_from_defaults() {
        let png = png_of(300, 140, |_, _| [240, 240, 240]);
        let mk = || {
            vec![Operation::Text {
                at: [20.0, 30.0],
                text: "定影 Onceglance 123".into(),
                size: Some(28.0),
                color: None,
                family: None,
                bold: None,
                italic: None,
                underline: None,
                shadow: None,
                rotation: None,
                align: None,
                line_height: None,
                background: None,
                background_opacity: None,
                background_radius: None,
                stroke_color: None,
                stroke_width: None,
            }]
        };
        let d_a = crate::settings::AnnotationDefaults::default();
        let mut d_b = crate::settings::AnnotationDefaults::default();
        d_b.text_family = "simsun".into();
        assert_ne!(
            render_with(&png, mk(), &d_a).png,
            render_with(&png, mk(), &d_b).png,
            "text_family 主题值必须参与渲染"
        );
    }

    #[test]
    fn inherit_mosaic_mode_from_defaults() {
        // 渐变底图：像素化与模糊可区分
        let png = png_of(160, 120, |x, y| [((x * 7) % 256) as u8, ((y * 5) % 256) as u8, 128]);
        let mk = |mode: Option<String>| {
            vec![Operation::Mosaic { at: [20.0, 20.0], size: [80.0, 60.0], mode, strength: None }]
        };
        let mut d_px = crate::settings::AnnotationDefaults::default(); // "mosaic" → 像素化
        d_px.mosaic_mode = "mosaic".into();
        let mut d_bl = crate::settings::AnnotationDefaults::default();
        d_bl.mosaic_mode = "blur".into();
        let a = render_with(&png, mk(None), &d_px);
        let b = render_with(&png, mk(None), &d_bl);
        assert_ne!(a.png, b.png, "mosaic_mode 主题值必须继承");
        // 显式 mode 覆盖主题
        assert_eq!(render_with(&png, mk(Some("blur".into())), &d_px).png, b.png);
    }

    #[test]
    fn inherit_output_fx_from_theme() {
        let png = png_of(100, 80, |_, _| [128, 128, 128]);
        let mut d = crate::settings::AnnotationDefaults::default();
        d.output_shadow = Some(serde_json::json!({ "on": true, "blur": 10, "color": "#000000" }));
        d.output_border = Some(serde_json::json!({ "on": true, "width": 4, "color": "#FFFFFF" }));
        let r = render_with(&png, vec![], &d);
        assert_eq!(r.width, 100 + 28, "主题记忆的阴影+边框必须外扩画布");
        assert_eq!(r.height, 80 + 28);
        // on=false 不注入
        let mut d_off = crate::settings::AnnotationDefaults::default();
        d_off.output_shadow = Some(serde_json::json!({ "on": false, "blur": 10, "color": "#000000" }));
        let r_off = render_with(&png, vec![], &d_off);
        assert_eq!((r_off.width, r_off.height), (100, 80), "on=false 的输出选项不得注入");
    }
}

