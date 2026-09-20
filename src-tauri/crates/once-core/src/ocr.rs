//! 本地离线 OCR（OCR-1~5）：Windows.Media.Ocr 为 v1 默认引擎（Provider 抽象见 P1）。
//! 输出 blocks[]（text|code|table|ui + text + bbox + confidence + lines[]）+ full_text + 语言。
//! 坐标为原图物理像素 bbox。全部本地，零网络。

use crate::capture::decode_png;
use crate::error::{OnceError, Result};
use serde::Serialize;
use windows::core::HSTRING;
use windows::Foundation::Rect;
use windows::Globalization::Language;
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

#[derive(Debug, Clone, Serialize)]
pub struct OcrLineOut {
    pub text: String,
    /// 物理像素 [x, y, w, h]。
    pub bbox: [i32; 4],
}

#[derive(Debug, Clone, Serialize)]
pub struct OcrBlock {
    /// text | code | table | ui（启发式粗分类，OCR-2）。
    pub r#type: String,
    pub text: String,
    pub bbox: [i32; 4],
    /// Windows.Media.Ocr 不输出置信度：恒为 1.0 且 low_confidence 恒 false。
    /// P1 ONNX 引擎（RapidOCR）接入后为真实值（OCR-4 的引擎限制已在 handoff 记录）。
    pub confidence: f64,
    pub low_confidence: bool,
    pub lines: Vec<OcrLineOut>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OcrResult {
    pub blocks: Vec<OcrBlock>,
    pub full_text: String,
    /// zh | en | zh+en（启发式）。
    pub language: String,
    /// 无文字时给原因，不报错（OCR 验收）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub empty_reason: Option<String>,
    pub width: u32,
    pub height: u32,
}

/// OCR Provider 抽象（P1 本地增强包留位）。
pub trait OcrProvider: Send + Sync {
    fn name(&self) -> &'static str;
    fn recognize_png(&self, png: &[u8]) -> Result<OcrResult>;
}

struct WindowsMediaOcr;

pub fn provider() -> &'static dyn OcrProvider {
    &WindowsMediaOcr
}

/// 引擎可用性（doctor 用）。
pub fn engine_available() -> bool {
    init_mta();
    if let Ok(langs) = OcrEngine::AvailableRecognizerLanguages() {
        if langs.Size().map(|n| n > 0).unwrap_or(false) {
            return OcrEngine::TryCreateFromUserProfileLanguages().is_ok();
        }
    }
    false
}

pub fn engine_language() -> String {
    init_mta();
    if let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
        if let Ok(lang) = engine.RecognizerLanguage() {
            return lang.LanguageTag().unwrap_or_default().to_string();
        }
    }
    "unavailable".into()
}

fn init_mta() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        use windows::Win32::System::Com::CoIncrementMTAUsage;
        let _ = unsafe { CoIncrementMTAUsage() };
    });
}

impl OcrProvider for WindowsMediaOcr {
    fn name(&self) -> &'static str {
        "windows_media_ocr"
    }

    fn recognize_png(&self, png: &[u8]) -> Result<OcrResult> {
        init_mta();
        let (w0, h0, _rgba) = decode_png(png)?;


            let engine = create_engine().ok_or_else(|| {
                OnceError::ocr("OCR 引擎不可用（系统未安装中文/英文识别语言包）")
                    .with_hint("在系统设置 → 时间和语言 → 语言中添加中文或英文后重试")
            })?;

            let stream = InMemoryRandomAccessStream::new()
                .map_err(|e| OnceError::ocr("创建内存流失败").with_source(e.to_string()))?;
            let writer = DataWriter::CreateDataWriter(&stream)
                .map_err(|e| OnceError::ocr("创建 DataWriter 失败").with_source(e.to_string()))?;
            writer
                .WriteBytes(png)
                .map_err(|e| OnceError::ocr("写入图像数据失败").with_source(e.to_string()))?;
            writer
                .StoreAsync()
                .map_err(|e| OnceError::ocr("StoreAsync 失败").with_source(e.to_string()))?
                .get()
                .map_err(|e| OnceError::ocr("图像缓冲提交失败").with_source(e.to_string()))?;
            writer
                .FlushAsync()
                .map_err(|e| OnceError::ocr("FlushAsync 失败").with_source(e.to_string()))?
                .get()
                .map_err(|e| OnceError::ocr("图像缓冲刷新失败").with_source(e.to_string()))?;
            stream
                .Seek(0)
                .map_err(|e| OnceError::ocr("流回卷失败").with_source(e.to_string()))?;

            let decoder = BitmapDecoder::CreateAsync(&stream)
                .map_err(|e| OnceError::ocr("图像解码器创建失败").with_source(e.to_string()))?
                .get()
                .map_err(|e| OnceError::ocr("图像解码失败").with_source(e.to_string()))?;
            let bitmap = decoder
                .GetSoftwareBitmapAsync()
                .map_err(|e| OnceError::ocr("SoftwareBitmap 转换失败").with_source(e.to_string()))?
                .get()
                .map_err(|e| OnceError::ocr("SoftwareBitmap 转换失败").with_source(e.to_string()))?;

            // 引擎尺寸上限：超限时缩放识别，bbox 按比例还原
            let max_dim = OcrEngine::MaxImageDimension().unwrap_or(u32::MAX) as f64;
            let scale_back: f64 = {
                let m = max_dim as f64;
                let dim = (w0.max(h0)) as f64;
                if dim > m && m > 0.0 { dim / m } else { 1.0 }
            };
            let engine_result = engine
                .RecognizeAsync(&bitmap)
                .map_err(|e| OnceError::ocr("OCR 识别失败").with_source(e.to_string()))?
                .get()
                .map_err(|e| OnceError::ocr("OCR 识别失败").with_source(e.to_string()))?;

            let mut lines: Vec<OcrLineOut> = Vec::new();
            let ok_lines = engine_result
                .Lines()
                .map_err(|e| OnceError::ocr("读取 OCR 行失败").with_source(e.to_string()))?;
            for i in 0..ok_lines.Size().unwrap_or(0) {
                let line = match ok_lines.GetAt(i) {
                    Ok(l) => l,
                    Err(_) => continue,
                };
                let mut line_bbox: Option<(f64, f64, f64, f64)> = None;
                let mut line_text = String::new();
                let words = match line.Words() {
                    Ok(ws) => ws,
                    Err(_) => continue,
                };
                for j in 0..words.Size().unwrap_or(0) {
                    let word = match words.GetAt(j) {
                        Ok(w) => w,
                        Err(_) => continue,
                    };
                    let t = word.Text().unwrap_or_default().to_string();
                    if t.is_empty() {
                        continue;
                    }
                    if !line_text.is_empty() {
                        // 中英混排：中文之间不补空格
                        let prev_cjk = line_text.chars().next_back().is_some_and(is_cjk);
                        let next_cjk = t.chars().next().is_some_and(is_cjk);
                        if !(prev_cjk && next_cjk) {
                            line_text.push(' ');
                        }
                    }
                    line_text.push_str(&t);
                    let r: Rect = word.BoundingRect().unwrap_or_default();
                    let nb = (
                        r.X as f64 * scale_back,
                        r.Y as f64 * scale_back,
                        r.Width as f64 * scale_back,
                        r.Height as f64 * scale_back,
                    );
                    line_bbox = Some(match line_bbox {
                        None => nb,
                        Some((x, y, w, h)) => {
                            let x2 = nb.0 + nb.2;
                            let y2 = nb.1 + nb.3;
                            (
                                x.min(nb.0),
                                y.min(nb.1),
                                (x + w).max(x2) - x.min(nb.0),
                                (y + h).max(y2) - y.min(nb.1),
                            )
                        }
                    });
                }
                if !line_text.is_empty() {
                    if let Some((x, y, w, h)) = line_bbox {
                        lines.push(OcrLineOut {
                            text: line_text,
                            bbox: [x as i32, y as i32, w as i32, h as i32],
                        });
                    }
                }
            }

            Ok(assemble(lines, w0, h0))
    }
}

fn create_engine() -> Option<OcrEngine> {
    // 优先中文，其次英文，再回退用户语言
    for tag in ["zh-Hans-CN", "zh-Hans", "en-US"] {
        if let Ok(lang) = Language::CreateLanguage(&HSTRING::from(tag)) {
            if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
                return Some(engine);
            }
        }
    }
    OcrEngine::TryCreateFromUserProfileLanguages().ok()
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x3000..=0x303F | 0xFF00..=0xFFEF)
}

/// 行 → 块聚合：垂直间距 < 0.6×行高的相邻行合并为一段；
/// 含代码符号密集的段标记 code；很短且像控件的标记 ui。
fn assemble(lines: Vec<OcrLineOut>, w: u32, h: u32) -> OcrResult {
    let mut sorted = lines;
    sorted.sort_by_key(|l| (l.bbox[1], l.bbox[0]));
    let mut blocks: Vec<OcrBlock> = Vec::new();
    let mut cur: Vec<OcrLineOut> = Vec::new();

    let avg_h = if sorted.is_empty() {
        0.0
    } else {
        sorted.iter().map(|l| l.bbox[3]).sum::<i32>() as f64 / sorted.len() as f64
    };

    for line in sorted {
        if let Some(prev) = cur.last() {
            let gap = line.bbox[1] - (prev.bbox[1] + prev.bbox[3]);
            let x_overlap = !(line.bbox[0] > prev.bbox[0] + prev.bbox[2]
                || line.bbox[0] + line.bbox[2] < prev.bbox[0]);
            if (gap as f64) < avg_h * 0.6 && x_overlap {
                cur.push(line);
                continue;
            }
        }
        if !cur.is_empty() {
            blocks.push(finish_block(std::mem::take(&mut cur)));
        }
        cur.push(line);
    }
    if !cur.is_empty() {
        blocks.push(finish_block(cur));
    }

    let full_text = blocks
        .iter()
        .map(|b| b.text.clone())
        .collect::<Vec<_>>()
        .join("\n");

    let cjk = full_text.chars().filter(|c| is_cjk(*c)).count();
    let latin = full_text.chars().filter(|c| c.is_ascii_alphabetic()).count();
    let language = if cjk > 0 && latin > 0 {
        "zh+en".into()
    } else if cjk > 0 {
        "zh".into()
    } else if latin > 0 {
        "en".into()
    } else {
        "none".into()
    };

    let empty_reason = if blocks.is_empty() { Some("图片中未发现文字".into()) } else { None };

    OcrResult { blocks, full_text, language, empty_reason, width: w, height: h }
}

fn finish_block(lines: Vec<OcrLineOut>) -> OcrBlock {
    let x0 = lines.iter().map(|l| l.bbox[0]).min().unwrap_or(0);
    let y0 = lines.iter().map(|l| l.bbox[1]).min().unwrap_or(0);
    let x1 = lines.iter().map(|l| l.bbox[0] + l.bbox[2]).max().unwrap_or(0);
    let y1 = lines.iter().map(|l| l.bbox[1] + l.bbox[3]).max().unwrap_or(0);
    let text = lines.iter().map(|l| l.text.clone()).collect::<Vec<_>>().join("\n");
    let r#type = classify(&text);
    OcrBlock {
        r#type: r#type.into(),
        text,
        bbox: [x0, y0, x1 - x0, y1 - y0],
        confidence: 1.0,
        low_confidence: false,
        lines,
    }
}

fn classify(text: &str) -> &'static str {
    let code_marks = ['{', '}', ';', '=', '<', '>', '(', ')', '[', ']', '$', '#'];
    let marks = text.chars().filter(|c| code_marks.contains(c)).count();
    let total = text.chars().count().max(1);
    let has_newline_multi = text.lines().count() > 1;
    if marks * 3 > total && has_newline_multi {
        "code"
    } else if text.chars().count() <= 4 && !text.contains(' ') {
        "ui"
    } else if text.lines().count() >= 3 && text.matches('|').count() >= 2 {
        "table"
    } else {
        "text"
    }
}
