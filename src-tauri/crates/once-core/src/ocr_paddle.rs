//! PaddleOCR 本地推理（`paddle` feature）：PP-OCRv4 mobile ONNX（det/cls/rec）+ CTC 解码。
//! 模型经 `ocr_pack` 按需下载（默认魔搭 ModelScope 源，HuggingFace 可选）；推理全部本地，零网络。
//! 链路：det（DBNet 文本框）→ 单框裁剪 → cls（方向矫正）→ rec（CRNN+CTC）→ 行聚合复用 ocr::assemble。

use crate::error::{OnceError, Result};
use crate::ocr::{assemble, OcrLineOut, OcrProvider, OcrResult};
use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard, OnceLock};

pub struct PaddleProvider;

impl OcrProvider for PaddleProvider {
    fn name(&self) -> &'static str {
        "paddle_ppocrv4_mobile"
    }

    fn recognize_png(&self, png: &[u8]) -> Result<OcrResult> {
        let eng = engine()?;
        // ort 的 Session::run 需 &mut：整段识别持锁（OCR 调用本就串行，无争用）
        let mut eng = eng
            .lock()
            .map_err(|_| OnceError::ocr("PaddleOCR 引擎锁中毒"))?;
        let (w0, h0, rgba) = crate::capture::decode_png(png)?;
        let img = image::DynamicImage::ImageRgba8(
            image::RgbaImage::from_raw(w0, h0, rgba)
                .ok_or_else(|| OnceError::ocr("图像数据不完整"))?,
        );

        // det：文本框（源图坐标系，按 y 行分组保序）
        let boxes = det_detect(&mut eng, &img)?;
        let mut lines: Vec<OcrLineOut> = Vec::new();
        for (x, y, w, h) in boxes {
            let crop = crop_rgb(&img, x, y, w, h);
            if crop.width() < 2 || crop.height() < 2 {
                continue;
            }
            let crop = maybe_rotate(&mut eng, &crop);
            let (text, conf) = rec_recognize(&mut eng, &crop)?;
            // 业界 drop_score 惯例：低置信行多为图形误检噪声，直接丢弃
            if text.is_empty() || conf < REC_DROP_SCORE {
                continue;
            }
            let mut line = OcrLineOut::new(text, [x, y, w, h]);
            line.confidence = Some(conf.clamp(0.0, 1.0));
            lines.push(line);
        }
        Ok(assemble(lines, w0, h0))
    }
}

// ===== 引擎加载（懒加载 + 会话常驻） =====

struct Engine {
    det: ort::session::Session,
    cls: ort::session::Session,
    rec: ort::session::Session,
    dict: Vec<String>,
}

static ENGINE: OnceLock<Option<Mutex<Engine>>> = OnceLock::new();
static ENGINE_ERR: OnceLock<String> = OnceLock::new();

fn engine() -> Result<&'static Mutex<Engine>> {
    if ENGINE.get().is_none() {
        match Engine::load() {
            Ok(e) => {
                let _ = ENGINE.set(Some(Mutex::new(e)));
            }
            Err(e) => {
                let _ = ENGINE_ERR.set(e);
                let _ = ENGINE.set(None);
            }
        }
    }
    match (ENGINE.get().ok_or_else(|| OnceError::ocr("引擎初始化中"))?, ENGINE_ERR.get()) {
        (Some(e), _) => Ok(e),
        (None, Some(msg)) => Err(OnceError::ocr(format!("PaddleOCR 引擎加载失败：{msg}"))),
        (None, None) => Err(OnceError::ocr("PaddleOCR 引擎不可用")),
    }
}

impl Engine {
    fn load() -> std::result::Result<Engine, String> {
        if !crate::ocr_pack::installed() {
            return Err("本地增强包未安装——到「模型配置 → 文字识别」下载".into());
        }
        let dir = crate::ocr_pack::pack_dir();
        // ort builder 的错误类型非 Send/Sync：逐步拍平成 String
        let session = |name: &str| -> std::result::Result<ort::session::Session, String> {
            let b = ort::session::Session::builder().map_err(|e| e.to_string())?;
            let b = b
                .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
                .map_err(|e| e.to_string())?;
            let mut b = b.with_intra_threads(4).map_err(|e| e.to_string())?;
            b.commit_from_file(dir.join(name)).map_err(|e| e.to_string())
        };
        let dict_raw = std::fs::read_to_string(dir.join("dict.txt")).map_err(|e| e.to_string())?;
        let mut dict: Vec<String> = dict_raw
            .lines()
            .map(|l| l.trim_end_matches('\r').to_string())
            .filter(|l| !l.is_empty())
            .collect();
        // PP-OCR use_space_char=true：类别表末位是空格（0=CTC blank，1..=N=字典，N+1=空格）
        dict.truncate(6623);
        Ok(Engine {
            det: session("det.onnx")?,
            cls: session("cls.onnx")?,
            rec: session("rec.onnx")?,
            dict,
        })
    }
}

// ===== det：DBNet 文本检测 =====

const DET_LIMIT: f64 = 960.0;
const DET_THRESH: f32 = 0.3;
const DET_BOX_SCORE: f32 = 0.45;
const UNCLIP_RATIO: f64 = 1.6;
/// rec 低置信噪声丢弃阈值（RapidOCR drop_score 同族，0.35 保召回）。
const REC_DROP_SCORE: f64 = 0.35;

fn det_detect(eng: &mut Engine, img: &image::DynamicImage) -> Result<Vec<(i32, i32, i32, i32)>> {
    let (w0, h0) = (img.width() as usize, img.height() as usize);
    // 长边限 960 且对齐 32 倍
    let ratio = ((w0.max(h0)) as f64 / DET_LIMIT).max(1.0);
    let rw = (((w0 as f64 / ratio).round() as usize).div_ceil(32)) * 32;
    let rh = (((h0 as f64 / ratio).round() as usize).div_ceil(32)) * 32;
    let resized = img.resize_exact(rw as u32, rh as u32, image::imageops::FilterType::Triangle);
    let rgb = resized.to_rgb8();

    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STD: [f32; 3] = [0.229, 0.224, 0.225];
    let mut input = vec![0f32; 3 * rw * rh];
    for c in 0..3 {
        for y in 0..rh {
            for x in 0..rw {
                let v = rgb.get_pixel(x as u32, y as u32)[c] as f32 / 255.0;
                input[c * rw * rh + y * rw + x] = (v - MEAN[c]) / STD[c];
            }
        }
    }

    // det 输出 [1,1,H,W] 概率图；还原比例按轴分开（对齐 32 后 x/y 略有差异）
    let prob = run_tensor(&mut eng.det, vec![1usize, 3, rh, rw], input)?;
    det_postprocess(&prob, rw, rh, w0 as f64 / rw as f64, h0 as f64 / rh as f64, w0, h0)
}

fn det_postprocess(
    prob: &[f32],
    w: usize,
    h: usize,
    sx: f64,
    sy: f64,
    src_w: usize,
    src_h: usize,
) -> Result<Vec<(i32, i32, i32, i32)>> {
    // 连通域（8 邻接 BFS）→ AABB → 分数过滤 → unclip 外扩 → 还原到源图坐标
    let mut comp = vec![0u32; w * h];
    let mut boxes = Vec::new();
    let mut queue: VecDeque<usize> = VecDeque::new();
    let mut label = 0u32;
    for start in 0..w * h {
        if prob[start] > DET_THRESH && comp[start] == 0 {
            label += 1;
            comp[start] = label;
            queue.push_back(start);
            let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
            let mut sum = 0f64;
            let mut cnt = 0usize;
            while let Some(idx) = queue.pop_front() {
                let x = idx % w;
                let y = idx / w;
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
                sum += prob[idx] as f64;
                cnt += 1;
                for dy in -1i64..=1 {
                    for dx in -1i64..=1 {
                        let nx = x as i64 + dx;
                        let ny = y as i64 + dy;
                        if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                            continue;
                        }
                        let n = ny as usize * w + nx as usize;
                        if comp[n] == 0 && prob[n] > DET_THRESH {
                            comp[n] = label;
                            queue.push_back(n);
                        }
                    }
                }
            }
            let bw = x1 - x0 + 1;
            let bh = y1 - y0 + 1;
            if bw < 3 || bh < 2 || cnt == 0 {
                continue;
            }
            if (sum / cnt as f64) < DET_BOX_SCORE as f64 {
                continue;
            }
            // DB unclip：d = area * ratio / perimeter，四边外扩（AABB 近似多边形 unclip）
            let d = ((bw * bh) as f64 * UNCLIP_RATIO / (2.0 * (bw + bh) as f64)).ceil();
            let sx0 = ((x0 as f64 - d) * sx).floor().max(0.0) as i32;
            let sy0 = ((y0 as f64 - d) * sy).floor().max(0.0) as i32;
            let sx1 = ((x1 as f64 + 1.0 + d) * sx).ceil().min(src_w as f64) as i32;
            let sy1 = ((y1 as f64 + 1.0 + d) * sy).ceil().min(src_h as f64) as i32;
            if sx1 - sx0 >= 2 && sy1 - sy0 >= 2 {
                boxes.push((sx0, sy0, sx1 - sx0, sy1 - sy0));
            }
        }
    }
    // 阅读顺序：先按行（y 中心 0.5 高度容差聚行）再按 x
    boxes.sort_by(|a, b| {
        let ay = a.1 + a.3 / 2;
        let by = b.1 + b.3 / 2;
        if (ay - by).abs() * 2 > a.3.max(b.3) {
            ay.cmp(&by)
        } else {
            a.0.cmp(&b.0)
        }
    });
    Ok(boxes)
}

// ===== cls：方向分类（180° 矫正） =====

fn maybe_rotate(eng: &mut Engine, crop: &image::DynamicImage) -> image::DynamicImage {
    match cls_is_rotated(eng, crop) {
        Ok(true) => image::DynamicImage::ImageRgba8(image::imageops::rotate180(&crop.to_rgba8())),
        _ => crop.clone(),
    }
}

fn cls_input(crop: &image::DynamicImage) -> Vec<f32> {
    const CW: usize = 192;
    const CH: usize = 48;
    let scale = CH as f64 / crop.height() as f64;
    let rw = ((crop.width() as f64 * scale).round() as usize).clamp(1, CW);
    let resized = crop.resize_exact(rw as u32, CH as u32, image::imageops::FilterType::Triangle);
    let mut data = vec![0.5f32; 3 * CH * CW]; // 右侧白垫 (0.5 归一后)
    fill_chw(&resized, &mut data, CW);
    data
}

fn cls_is_rotated(eng: &mut Engine, crop: &image::DynamicImage) -> Result<bool> {
    let input = cls_input(crop);
    let out = run_tensor(&mut eng.cls, vec![1usize, 3, 48, 192], input)?;
    // 输出 [1,2]：softmax 后第 1 类（倒置）> 0.9 判为 180°
    let (a, b) = (out[0] as f64, out[1] as f64);
    let m = a.max(b);
    let p1 = (b - m).exp() / ((a - m).exp() + (b - m).exp());
    Ok(p1 > 0.9)
}

// ===== rec：CRNN + CTC 解码 =====

fn rec_recognize(eng: &mut Engine, crop: &image::DynamicImage) -> Result<(String, f64)> {
    const RH: usize = 48;
    let rw = ((crop.width() as f64 * RH as f64 / crop.height() as f64).round() as usize)
        .clamp(16, 960);
    let resized = crop.resize_exact(rw as u32, RH as u32, image::imageops::FilterType::Triangle);
    let mut input = vec![0f32; 3 * RH * rw];
    fill_chw_norm(&resized, &mut input, rw);
    let out = run_tensor(&mut eng.rec, vec![1usize, 3, RH, rw], input)?;
    let classes = 6625usize; // blank + 6623 字典 + 空格
    let t = out.len() / classes;
    if t == 0 {
        return Ok((String::new(), 0.0));
    }
    // 贪心 CTC（压重、去 blank）。模型输出已是 softmax 概率（实测整帧和≈1、max≈0.99），
    // argmax 值即置信度；若再做 softmax，6624 个小概率项的 exp 和会把值压成 ~0。
    let mut text = String::new();
    let mut confs: Vec<f32> = Vec::new();
    let mut last = 0usize;
    for i in 0..t {
        let frame = &out[i * classes..(i + 1) * classes];
        let mut best = 0usize;
        let mut bv = f32::NEG_INFINITY;
        for (ci, &v) in frame.iter().enumerate() {
            if v > bv {
                bv = v;
                best = ci;
            }
        }
        if best != 0 && best != last {
            if best == eng.dict.len() + 1 {
                text.push(' ');
            } else if let Some(c) = eng.dict.get(best - 1) {
                text.push_str(c);
            }
            confs.push(bv.clamp(0.0, 1.0));
        }
        last = best;
    }
    let conf = if confs.is_empty() {
        0.0
    } else {
        confs.iter().sum::<f32>() as f64 / confs.len() as f64
    };
    Ok((text, conf))
}

// ===== 图像与张量辅助 =====

/// CHW 归一化 (x/255-0.5)/0.5，右侧补白到 width。
fn fill_chw_norm(img: &image::DynamicImage, data: &mut [f32], width: usize) {
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    const CH: usize = 48;
    for c in 0..3 {
        for y in 0..CH {
            for x in 0..width {
                let v = if x < w && y < h {
                    rgb.get_pixel(x as u32, y as u32)[c] as f32 / 255.0
                } else {
                    1.0
                };
                data[c * CH * width + y * width + x] = (v - 0.5) / 0.5;
            }
        }
    }
}

/// cls 专用：右垫 0.5（已归一化的灰值），不做归一化比例差异（cls 精度不敏感）。
fn fill_chw(img: &image::DynamicImage, data: &mut [f32], width: usize) {
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    const CH: usize = 48;
    for c in 0..3 {
        for y in 0..CH {
            for x in 0..width {
                let v = if x < w && y < h {
                    rgb.get_pixel(x as u32, y as u32)[c] as f32 / 255.0 - 0.5
                } else {
                    0.0
                };
                data[c * CH * width + y * width + x] = v;
            }
        }
    }
}

fn crop_rgb(img: &image::DynamicImage, x: i32, y: i32, w: i32, h: i32) -> image::DynamicImage {
    let (iw, ih) = (img.width() as i32, img.height() as i32);
    let x0 = x.clamp(0, iw) as u32;
    let y0 = y.clamp(0, ih) as u32;
    let x1 = (x + w).clamp(0, iw) as u32;
    let y1 = (y + h).clamp(0, ih) as u32;
    image::DynamicImage::ImageRgba8(image::imageops::crop(
        &mut img.to_rgba8(),
        x0,
        y0,
        (x1 - x0).max(1),
        (y1 - y0).max(1),
    )
    .to_image())
}

fn run_tensor(
    session: &mut ort::session::Session,
    shape: Vec<usize>,
    input: Vec<f32>,
) -> Result<Vec<f32>> {
    let tensor = ort::value::Tensor::from_array((shape, input))
        .map_err(|e| OnceError::ocr(format!("推理输入构造失败：{e}")))?;
    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|e| OnceError::ocr(format!("推理失败：{e}")))?;
    // rc.13：try_extract_tensor 返回 (&Shape, &[f32])
    let (_shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| OnceError::ocr(format!("推理输出解析失败：{e}")))?;
    Ok(data.to_vec())
}

#[cfg(all(test, feature = "paddle"))]
mod paddle_tests {
    use super::*;

    /// 真机验收：本地包已装后对真实截图跑全链路（det→cls→rec）。
    /// 先执行 `once ocr-engine download` 再 `cargo test -p once-core --features paddle -- --ignored`。
    #[test]
    #[ignore = "实机验收：需先下载本地增强包"]
    fn recognize_real_screenshot() {
        if !crate::ocr_pack::installed() {
            panic!("本地增强包未安装——先 once ocr-engine download");
        }
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../uitest_panel.png");
        let png = std::fs::read(path).expect("测试图缺失");
        let t0 = std::time::Instant::now();
        let r = PaddleProvider
            .recognize_png(&png)
            .expect("识别失败");
        eprintln!("耗时 {:?} · 块数 {} · 语言 {}", t0.elapsed(), r.blocks.len(), r.language);
        eprintln!("识别文本：\n{}", r.full_text);
        assert!(!r.blocks.is_empty(), "真实截图应有文字块");
        assert!(r.full_text.chars().any(|c| c.is_ascii_alphanumeric() || {
            let u = c as u32;
            (0x4E00..=0x9FFF).contains(&u)
        }), "识别文本应为中英文");
        for b in &r.blocks {
            let one_line = b.text.replace('\n', " / ");
            eprintln!("block conf={:.2} type={} :: {}", b.confidence, b.r#type, one_line);
        }
        let mean: f64 = r.blocks.iter().map(|b| b.confidence).sum::<f64>() / r.blocks.len() as f64;
        assert!(mean > 0.5, "平均置信度应合理（实际 {mean:.2}）");
    }
}
