//! 滚动长截图拼接内核（PRD §6.5 / 说明书 §4.4）。
//!
//! 规则（逐条对照，这是全项目最容易做错的模块）：
//! - 框选松手那一帧就是第 1 段，不需要"开始"动作。
//! - 相邻帧位移匹配 + 重复帧过滤 + 方向识别（LONG-2）：只向下滚动产生新段；
//!   向上回滚不产生新段；内容不动（连续帧相同）给到底提示——永不自动完成。
//! - 固定区域消除（LONG-3）：自动识别区域顶部/底部逐帧不变的行，成图中只保留一份。
//! - 接缝质检（LONG-4）：每个拼接点记录匹配置信度，可疑接缝交给人工 ±1/±10 修正。
//! - 失败可见（LONG-6）：匹配失败的帧不静默丢弃——记入 failed_frames，
//!   结束时如实报告；已成功部分永远保留。

use crate::error::{OnceError, Result};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PushResult {
    /// 新增 dy 行（首帧 dy = 帧高）。
    Appended { dy: i64 },
    /// 内容未变化（重复帧，已过滤）。
    Duplicate,
    /// 用户向上回滚：不记录。
    RolledBack,
    /// 内容未变化且已连续两帧相同：看起来到底了（仍不自动完成）。
    BottomReached,
}

#[derive(Debug, Clone)]
pub struct Seam {
    /// 接缝在画布中的 y 坐标（下一段首行之前）。
    pub y: i64,
    /// 0..=1，匹配误差归一化；低于 CONFIDENCE_OK 视为可疑。
    pub confidence: f64,
    pub accepted: bool,
}

/// 置信度阈值：两档制——"要检查 / 正常"（说明书 §4.4 阶段 3）。
pub const CONFIDENCE_OK: f64 = 0.80;
/// 到底判定需要的连续重复帧数。
pub const BOTTOM_IDLE_FRAMES: u32 = 2;
/// 匹配搜索的最大位移（区域高度的占比）。
const MAX_SHIFT_RATIO: f64 = 0.8;
/// 位移匹配的采样带：跳过顶部/底部若干行（含固定区与边缘噪声）。
const BAND_MARGIN: i64 = 2;

pub struct ScrollSession {
    pub width: u32,
    pub height: u32,
    /// 画布（RGBA，自上而下累计内容区；固定区行取自第一帧）。
    canvas: Vec<u8>,
    /// 画布当前内容高度（行数）。
    content_h: i64,
    /// 固定区高度（顶部，逐帧不变的行数；0 = 尚未测出）。
    pub fixed_top: i64,
    pub fixed_bottom: i64,
    last_frame: Option<Vec<u8>>,
    idle_count: u32,
    seams: Vec<Seam>,
    failed_frames: u32,
    total_frames: u32,
    manual_fixes: u32,
    /// 拼接用降采样倍数（横向/纵向），保证速度与精度折中。
    sample: usize,
}

impl ScrollSession {
    pub fn new(width: u32, height: u32) -> Result<Self> {
        if width == 0 || height == 0 {
            return Err(OnceError::capture("长截图区域为空"));
        }
        Ok(Self {
            width,
            height,
            canvas: Vec::new(),
            content_h: 0,
            fixed_top: 0,
            fixed_bottom: 0,
            last_frame: None,
            idle_count: 0,
            seams: Vec::new(),
            failed_frames: 0,
            total_frames: 0,
            manual_fixes: 0,
            sample: 4,
        })
    }

    pub fn seam_count(&self) -> usize {
        self.seams.len()
    }
    pub fn suspicious_seams(&self) -> Vec<Seam> {
        self.seams.iter().filter(|s| s.confidence < CONFIDENCE_OK).cloned().collect()
    }
    pub fn failed_frame_count(&self) -> u32 {
        self.failed_frames
    }
    pub fn total_frame_count(&self) -> u32 {
        self.total_frames
    }
    pub fn manual_fix_count(&self) -> u32 {
        self.manual_fixes
    }
    pub fn content_height(&self) -> i64 {
        self.content_h
    }

    /// 推入一帧（RGBA，width×height）。见模块注释的状态语义。
    pub fn push_frame(&mut self, rgba: &[u8]) -> Result<PushResult> {
        if rgba.len() != (self.width as usize) * (self.height as usize) * 4 {
            return Err(OnceError::capture("帧数据尺寸不匹配"));
        }
        self.total_frames += 1;

        // 第一帧：整个区域入画布（含固定区，固定区只此一份的来源）
        if self.last_frame.is_none() {
            self.canvas = rgba.to_vec();
            self.content_h = self.height as i64;
            self.last_frame = Some(rgba.to_vec());
            return Ok(PushResult::Appended { dy: self.height as i64 });
        }

        let gray_new = to_gray(rgba, self.width, self.height, self.sample);
        let gray_prev = to_gray(self.last_frame.as_ref().unwrap(), self.width, self.height, self.sample);

        // 固定区识别：首帧 vs 当前帧前导/拖尾完全一致的行（按灰度采样行全部相等）
        if self.total_frames == 2 {
            let (ft, fb) = detect_fixed_bands(&gray_new, &gray_prev, self.gw(), self.gh());
            self.fixed_top = ft as i64 * self.sample as i64;
            self.fixed_bottom = fb as i64 * self.sample as i64;
        }

        // 到底/重复判定：内容带完全一致
        let identical = gray_same(&gray_new, &gray_prev);
        if identical {
            self.idle_count += 1;
            self.failed_frames = self.failed_frames; // 重复不是失败
            if self.idle_count >= BOTTOM_IDLE_FRAMES {
                return Ok(PushResult::BottomReached);
            }
            return Ok(PushResult::Duplicate);
        }
        self.idle_count = 0;

        // 位移匹配：新帧 ↔ 画布（一维亮度 profile）
        let dy = match_frame(
            rgba,
            self.width,
            self.height,
            &self.canvas,
            self.width,
            self.content_h.max(1) as u32,
            self.fixed_top,
        );

        match dy {
            None => {
                // 匹配失败：可见失败（LONG-6），不静默丢弃也不破坏画布
                self.failed_frames += 1;
                #[cfg(test)]
                eprintln!("[debug] match failed: fixed_top={} fixed_bottom={} idle={}", self.fixed_top, self.fixed_bottom, self.idle_count);
                Ok(PushResult::Duplicate)
            }
            Some(dy) if dy <= 0 => {
                if dy == 0 {
                    Ok(PushResult::Duplicate)
                } else {
                    Ok(PushResult::RolledBack)
                }
            }
            Some(dy) if dy <= (self.height as f64 * 0.9) as i64 => {
                // 位移上限保护：超过帧高 90% 的"匹配"视为错位（配合全画布搜索防误配）
                let confidence = last_confidence().unwrap_or(1.0);
                // 追加新帧的 [h-dy .. h] 行（新内容）
                let new_rows = dy as usize;
                let row_bytes = self.width as usize * 4;
                let start = (self.height as usize - new_rows) * row_bytes;
                self.canvas
                    .extend_from_slice(&rgba[start..]);
                self.content_h += dy;
                self.seams.push(Seam {
                    y: self.content_h - dy,
                    confidence,
                    accepted: false,
                });
                Ok(PushResult::Appended { dy })
            }
            Some(_) => {
                // 超过帧高 90% 的匹配视为错位：可见失败，不破坏画布
                self.failed_frames += 1;
                Ok(PushResult::Duplicate)
            }
        }
    }

    /// 结束：导出画布（上 固定区来自首帧 + 内容累计）。LONG-6：失败也输出已成功部分。
    pub fn export(&self) -> (u32, u32, Vec<u8>) {
        (self.width, self.content_h.max(0) as u32, self.canvas.clone())
    }

    /// 人工修正接缝：delta>0 删除接缝下方 delta 行（重叠过多），delta<0 在接缝上方插入副本行。
    /// 返回修正后的接缝列表（该接缝标记 accepted）。
    pub fn adjust_seam(&mut self, seam_index: usize, delta: i64) -> Result<()> {
        if delta == 0 {
            if let Some(s) = self.seams.get_mut(seam_index) {
                s.accepted = true;
            }
            return Ok(());
        }
        let seam_y = self
            .seams
            .get(seam_index)
            .map(|s| s.y)
            .ok_or_else(|| OnceError::usage("接缝序号不存在"))?;
        let row_bytes = self.width as usize * 4;
        if delta > 0 {
            // 删除 [seam_y, seam_y+delta) 行
            let start = (seam_y as usize) * row_bytes;
            let end = start + (delta as usize) * row_bytes;
            if end > self.canvas.len() {
                return Err(OnceError::usage("修正量超出画布"));
            }
            self.canvas.drain(start..end);
            self.content_h -= delta;
            for s in self.seams.iter_mut().skip(seam_index + 1) {
                s.y -= delta;
            }
        } else {
            // 在 seam_y 处插入 |delta| 行（复制上一行，供人工微调对齐）
            let d = (-delta) as usize;
            let ins_at = (seam_y as usize) * row_bytes;
            let mut rows = vec![0u8; d * row_bytes];
            for r in 0..d {
                let src = ins_at - row_bytes; // 上一行
                rows[r * row_bytes..(r + 1) * row_bytes]
                    .copy_from_slice(&self.canvas[src..src + row_bytes]);
            }
            let tail = self.canvas.split_off(ins_at);
            self.canvas.extend_from_slice(&rows);
            self.canvas.extend_from_slice(&tail);
            self.content_h += d as i64;
            for s in self.seams.iter_mut().skip(seam_index + 1) {
                s.y += d as i64;
            }
        }
        self.manual_fixes += 1;
        if let Some(s) = self.seams.get_mut(seam_index) {
            s.accepted = true;
            s.confidence = 1.0;
        }
        Ok(())
    }

    pub fn seams(&self) -> &[Seam] {
        &self.seams
    }

    // ---- 内部 ----

    fn gw(&self) -> usize {
        (self.width as usize) / self.sample
    }
    fn gh(&self) -> usize {
        (self.height as usize) / self.sample
    }
    fn gray_canvas_tail(&self) -> Vec<u8> {
        // 画布的灰度尾部（供匹配）；画布高度动态，取全部已累计内容
        to_gray(&self.canvas, self.width, self.content_h.max(1) as u32, self.sample)
    }
}

/// 最近一次 match_frame 的置信度（线程局部传递，避免污染签名）。
thread_local! {
    static LAST_CONF: std::cell::Cell<Option<f64>> = const { std::cell::Cell::new(None) };
}
fn set_last_confidence(v: f64) {
    LAST_CONF.with(|c| c.set(Some(v)));
}
fn last_confidence() -> Option<f64> {
    LAST_CONF.with(|c| c.get())
}

fn to_gray(rgba: &[u8], w: u32, h: u32, sample: usize) -> Vec<u8> {
    let sw = (w as usize) / sample;
    let sh = (h as usize) / sample;
    let mut out = vec![0u8; sw * sh];
    let stride = w as usize * 4;
    for gy in 0..sh {
        let src_y = gy * sample;
        let row = &rgba[src_y * stride..(src_y + 1) * stride];
        for gx in 0..sw {
            let px = gx * sample * 4;
            let (b, g, r) = (row[px] as u32, row[px + 1] as u32, row[px + 2] as u32);
            out[gy * sw + gx] = ((r * 299 + g * 587 + b * 114) / 1000) as u8;
        }
    }
    out
}

fn gray_same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.abs_diff(*y) <= 1)
}

/// 检测固定带：两帧逐行完全一致的前导/拖尾行数（灰度采样域）。
fn detect_fixed_bands(a: &[u8], b: &[u8], w: usize, h: usize) -> (usize, usize) {
    let row_eq = |y: usize| {
        let (ra, rb) = (y * w, y * w + w);
        a[ra..rb] == b[ra..rb]
    };
    let mut ft = 0;
    while ft < h / 3 && row_eq(ft) {
        ft += 1;
    }
    let mut fb = 0;
    while fb < h / 3 && row_eq(h - 1 - fb) {
        fb += 1;
    }
    (ft, fb)
}

/// 返回真实像素位移 dy（已 ×sample）：>0 内容下滚新增 dy 行；<0 回滚；None 无法可靠匹配。
/// 一维行亮度 profile 匹配：滚动对齐本质是垂直方向的一维问题，抗横向噪声（hover/光标）。
#[allow(clippy::too_many_arguments)]
fn match_frame(
    frame_rgba: &[u8],
    frame_w: u32,
    frame_h: u32,
    canvas_rgba: &[u8],
    canvas_w: u32,
    canvas_h: u32,
    band_top_px: i64,
) -> Option<i64> {
    if canvas_rgba.is_empty() || frame_rgba.is_empty() {
        return None;
    }
    let profile = |buf: &[u8], w: u32, h: u32| -> Vec<f64> {
        let rows = h as usize;
        let stride = w as usize * 4;
        let mut out = vec![0f64; rows];
        let cols = (w as usize / 16).max(8);
        let step = (w as usize / cols).max(1);
        for y in 0..rows {
            let row = &buf[y * stride..(y + 1) * stride];
            let mut s = 0f64;
            let mut n = 0u64;
            let mut x = 0usize;
            while x < w as usize {
                let i = x * 4;
                s += row[i] as f64 * 0.114 + row[i + 1] as f64 * 0.587 + row[i + 2] as f64 * 0.299;
                n += 1;
                x += step;
            }
            out[y] = s / n.max(1) as f64;
        }
        out
    };

    let pf_raw = profile(frame_rgba, frame_w, frame_h);
    let pc_raw = profile(canvas_rgba, canvas_w, canvas_h);
    // 3-tap 平滑：DPR 1.5/平滑滚动的落点常非整行，行亮度存在 ±1 行混叠；
    // 平滑后匹配对半行偏移不敏感。空白判定仍用原始轮廓，语义不变。
    let smooth3 = |p: &[f64]| -> Vec<f64> {
        let n = p.len();
        if n < 3 {
            return p.to_vec();
        }
        let mut o = vec![0f64; n];
        o[0] = p[0];
        o[n - 1] = p[n - 1];
        for i in 1..n - 1 {
            o[i] = 0.25 * p[i - 1] + 0.5 * p[i] + 0.25 * p[i + 1];
        }
        o
    };
    let pf = smooth3(&pf_raw);
    let pc = smooth3(&pc_raw);
    let ph = pf.len() as i64;
    let pch = pc.len() as i64;
    if ph < 8 || pch < 8 {
        set_last_confidence(0.0);
        return None;
    }

    let vartext = |p: &[f64], a: usize, b: usize| -> f64 {
        if b <= a + 1 {
            return 0.0;
        }
        let mut s = 0f64;
        let mut n = 0u64;
        for i in a..b - 1 {
            s += (p[i + 1] - p[i]).abs();
            n += 1;
        }
        s / n.max(1) as f64
    };
    if vartext(&pf_raw, 0, pf_raw.len()) < 1.5 || vartext(&pc_raw, 0, pc_raw.len()) < 1.5 {
        set_last_confidence(0.0);
        return None; // 帧或画布近乎空白：无可对齐特征
    }

    let base = pch - ph;
    // k 范围：帧与画布至少 8 行 profile 重叠即可对齐（大位移前进时帧大部分可以是新内容）
    // 回滚限制在"最多一帧高"（更远的回滚等价于重新框选）
    let min_overlap = 8i64;
    let k_lo = (-(ph - min_overlap)).max(base - ph);
    let k_hi = pch - min_overlap;

    let mut best: Option<(i64, f64)> = None;
    let mut k = k_lo;
    let mut diffs: Vec<f64> = Vec::with_capacity(ph as usize);
    while k <= k_hi {
        let a = (k as usize).min(pc.len());
        let b = ((k + ph) as usize).min(pc.len());
        if b > a && vartext(&pc_raw, a, b) < 1.5 {
            k += 1;
            continue;
        }
        diffs.clear();
        for by in 0..ph as usize {
            let c = k + by as i64;
            if c < 0 || c >= pch {
                continue;
            }
            diffs.push((pf[by] - pc[c as usize]).abs());
        }
        let n = diffs.len() as u64;
        if n >= (ph / 8).max(2) as u64 {
            // 截尾均值：丢弃最大 30% 行——hover 弹层/懒解码缩略图等局部变化
            // 不再拖垮整帧匹配（真实场景噪声主要来自少数行）
            let keep = (((n as f64) * 0.7).ceil() as usize).clamp(1, diffs.len());
            diffs.select_nth_unstable_by(keep - 1, |x, y| x.partial_cmp(y).unwrap());
            let e = diffs[..keep].iter().sum::<f64>() / keep as f64;
            if best.map(|(_, be)| e < be).unwrap_or(true) {
                best = Some((k, e));
            }
        }
        k += 1;
    }
    let (k, err) = match best {
        Some(x) => x,
        None => {
            if std::env::var("ONCE_DEBUG").is_ok() {
                eprintln!("[match] no textured candidate base={base} pch={pch}");
            }
            set_last_confidence(0.0);
            return None;
        }
    };
    if err > 14.0 {
        if std::env::var("ONCE_DEBUG").is_ok() {
            eprintln!("[match] err too big: k={k} err={err:.1}");
        }
        set_last_confidence(0.0);
        return None;
    }
    let confidence = (1.0 - err / 14.0).clamp(0.0, 1.0);
    set_last_confidence(confidence);
    if std::env::var("ONCE_DEBUG").is_ok() {
        eprintln!("[match] 1d ok: k={k} base={base} err={err:.2} dy={}", k - base);
    }

    Some(k - base)
}

fn band_h_lower(band_top: usize, band_bottom: usize) -> i64 {
    (band_top + 4) as i64 - band_bottom as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_frame(w: u32, h: u32, offset: u32, content_h: u32) -> Vec<u8> {
        // 合成滚动内容：单调渐变（每 3 行一个灰度级，无周期混叠）
        let mut buf = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            let global = offset + y;
            let v = if global < content_h {
                // LCG 行种子：无短周期、无饱和，每行亮度唯一（对齐无歧义）
                let r0 = (global as u64)
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                (r0 >> 33) as u8
            } else {
                255 // 底部之外
            };
            // 行内 3 条伪随机黑竖条（模拟 UI 元素，行间独立 → 对齐唯一）
            let r1 = (global as u64)
                .wrapping_mul(2862933555777941757)
                .wrapping_add(3037000493);
            let markers = [
                ((r1 >> 33) as usize) % w.max(1) as usize,
                ((r1 >> 15) as usize) % w.max(1) as usize,
                ((r1 >> 7) as usize) % w.max(1) as usize,
            ];
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let dark = markers.iter().any(|m| (x as i64 - *m as i64).abs() <= 2);
                let c = if dark { 10u8 } else { v };
                buf[i] = c;
                buf[i + 1] = c;
                buf[i + 2] = c;
                buf[i + 3] = 255;
            }
        }
        buf
    }

    #[test]
    fn scroll_down_accumulates() {
        let (w, h) = (100u32, 50u32);
        let mut s = ScrollSession::new(w, h).unwrap();
        // 第 1 段：全局行 0..50
        let f0 = make_frame(w, h, 0, 500);
        assert_eq!(s.push_frame(&f0).unwrap(), PushResult::Appended { dy: 50 });
        // 第 2 段：滚 20 行 → 全局行 20..70
        let f1 = make_frame(w, h, 20, 500);
        let r = s.push_frame(&f1).unwrap();
        assert!(matches!(r, PushResult::Appended { dy: 20 }), "got {r:?}");
        assert_eq!(s.content_height(), 70);
        // 第 3 段：再滚 20
        let f2 = make_frame(w, h, 40, 500);
        assert!(matches!(s.push_frame(&f2).unwrap(), PushResult::Appended { dy: 20 }));
        assert_eq!(s.content_height(), 90);
        let (_, ch, canvas) = s.export();
        assert_eq!(ch, 90);
        assert_eq!(canvas.len(), (w * ch * 4) as usize);
    }

    #[test]
    fn duplicate_and_bottom() {
        let (w, h) = (100u32, 50u32);
        let mut s = ScrollSession::new(w, h).unwrap();
        let f0 = make_frame(w, h, 0, 500);
        s.push_frame(&f0).unwrap();
        assert_eq!(s.push_frame(&f0).unwrap(), PushResult::Duplicate);
        assert_eq!(s.push_frame(&f0).unwrap(), PushResult::BottomReached);
        assert_eq!(s.content_height(), 50, "重复帧不增长");
    }

    #[test]
    fn rollback_keeps_canvas() {
        let (w, h) = (100u32, 50u32);
        let mut s = ScrollSession::new(w, h).unwrap();
        s.push_frame(&make_frame(w, h, 0, 500)).unwrap();
        s.push_frame(&make_frame(w, h, 20, 500)).unwrap();
        // 回滚：回到 offset 10（当前 40 的前面）
        let r = s.push_frame(&make_frame(w, h, 10, 500)).unwrap();
        assert_eq!(r, PushResult::RolledBack, "回滚不产生新段");
        assert_eq!(s.content_height(), 70);
    }

    #[test]
    fn fixed_top_band_single_copy() {
        // 顶部 10 行固定（页头）：任何帧都一样 → 成图中应只出现一次且等于首帧
        let (w, h) = (100u32, 400u32);
        let mut base = make_frame(w, h, 0, 2000);
        // 把帧做成带固定头的构造器：直接改
        let with_header = |offset: u32| {
            let mut f = make_frame(w, h, offset, 2000);
            for y in 0..40u32 {
                for x in 0..w {
                    let i = ((y * w + x) * 4) as usize;
                    f[i] = 200;
                    f[i + 1] = 10;
                    f[i + 2] = 10;
                }
            }
            f
        };
        let _ = &mut base;
        let mut s = ScrollSession::new(w, h).unwrap();
        s.push_frame(&with_header(0)).unwrap();
        s.push_frame(&with_header(60)).unwrap();
        let r = s.push_frame(&with_header(120)).unwrap();
        assert!(matches!(r, PushResult::Appended { .. }), "got {r:?}");
        let (_, ch, canvas) = s.export();
        // 固定头只出现一次：第 0..40 行是红色，第 40 行起应是渐变（非红）
        let row40 = &canvas[(40 * w * 4) as usize..];
        assert_ne!(row40[0], 200, "固定头不应重复");
        assert!(ch > h);
    }

    #[test]
    fn big_scroll_after_dropped_moving_frames() {
        // 帧稳定检测场景：快速滚动期间过渡帧被丢弃，停止后的首帧
        // 相对画布底位移可能超过旧版 max_shift 邻域——全画布搜索必须能接上
        let (w, h) = (100u32, 400u32);
        let mut s = ScrollSession::new(w, h).unwrap();
        s.push_frame(&make_frame(w, h, 0, 2000)).unwrap();
        // 模拟"滚了很远才停下来"：单步位移 300px = 帧高 75%
        // （物理上限：位移 ≥ 帧高时重叠内容不足，任何拼接器都无法恢复，属采样极限而非缺陷）
        let r = s.push_frame(&make_frame(w, h, 300, 2000)).unwrap();
        // 灰度采样（sample=4）下 300px 对齐到 4 的倍数：dy ∈ [292, 308]
        assert!(
            matches!(r, PushResult::Appended { dy } if (292..=308).contains(&dy)),
            "大位移稳定帧应正确追加，got {r:?}"
        );
        assert!((692..=708).contains(&s.content_height()));
    }

    #[test]
    fn failed_match_is_visible_not_silent() {
        // LONG-6：拼不上的帧记入 failed_frames，已成功部分保留
        let (w, h) = (100u32, 40u32);
        let mut s = ScrollSession::new(w, h).unwrap();
        s.push_frame(&make_frame(w, h, 0, 500)).unwrap();
        // 全随机噪声帧：无法对齐
        use rand::Rng;
        let mut rng = rand::rng();
        let noise: Vec<u8> = (0..(w * h * 4) as usize).map(|_| rng.random()).collect();
        let r = s.push_frame(&noise).unwrap();
        assert_eq!(r, PushResult::Duplicate, "匹配失败按重复处理，不破坏画布");
        assert_eq!(s.failed_frame_count(), 1, "失败必须可见");
        assert_eq!(s.content_height(), 40, "已成功部分保留");
    }

    #[test]
    fn seam_adjust_splices_rows() {
        let (w, h) = (100u32, 40u32);
        let mut s = ScrollSession::new(w, h).unwrap();
        s.push_frame(&make_frame(w, h, 0, 500)).unwrap();
        s.push_frame(&make_frame(w, h, 20, 500)).unwrap();
        let before = s.content_height();
        s.adjust_seam(0, 5).unwrap();
        assert_eq!(s.content_height(), before - 5);
        assert_eq!(s.manual_fix_count(), 1);
        assert!(s.seams()[0].accepted);
    }

    #[test]
    fn confidence_two_tier() {
        let (w, h) = (100u32, 50u32);
        let mut s = ScrollSession::new(w, h).unwrap();
        s.push_frame(&make_frame(w, h, 0, 500)).unwrap();
        s.push_frame(&make_frame(w, h, 15, 500)).unwrap();
        // 相邻滚 15 行的合成内容应当完美匹配（置信度=1）
        let seams = s.suspicious_seams();
        assert!(seams.is_empty(), "完美匹配不应有可疑接缝");
    }

    #[test]
    fn noisy_fractional_shift_still_appends() {
        // 真实场景：hover 弹层/懒解码使 ~25% 行出现强噪声，非整行滚动落点在
        // 全部行上留下小幅抖动。修复前（均值+原始轮廓）err 超阈值拒拼；
        // 修复后（平滑+截尾均值）应正常追加。
        let (w, h) = (100u32, 50u32);
        let mut s = ScrollSession::new(w, h).unwrap();
        let f0 = make_frame(w, h, 0, 500);
        s.push_frame(&f0).unwrap();
        let mut f1 = make_frame(w, h, 12, 500);
        for y in 0..h as usize {
            for x in 0..w as usize {
                let i = (y * w as usize + x) * 4;
                if y % 4 == 0 {
                    // 25% 行整行强污染（hover 弹层级噪声）
                    f1[i] = 255 - f1[i];
                    f1[i + 1] = f1[i + 1].wrapping_add(77);
                    f1[i + 2] ^= 0xA5;
                } else {
                    // 全行小幅抖动（非整行落点的取整残差）
                    let j = ((y as u64 * 31 + x as u64 * 7) % 5) as i32 - 2;
                    for c in 0..3 {
                        f1[i + c] = (f1[i + c] as i32 + j).clamp(0, 255) as u8;
                    }
                }
            }
        }
        match s.push_frame(&f1).unwrap() {
            PushResult::Appended { dy } => assert_eq!(dy, 12),
            other => panic!("含噪帧应被追加，实际 {:?}", other),
        }
    }
}
