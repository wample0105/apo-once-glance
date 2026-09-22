//! 捕获结果的统一交付：落盘 → 历史 → 剪贴板 → toast。
//! GUI 与 CLI 走同一内核语义（一套引擎两个入口）。

use crate::CapturedBitmap;
use once_core::{capture, clipboard, history, ocr, settings, storage};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, Serialize)]
pub struct DeliverOutcome {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub action: String,
    pub width: u32,
    pub height: u32,
    /// 取字结果的字符数（action=ocr 时）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr_chars: Option<usize>,
}

pub fn deliver_capture(
    app: &AppHandle,
    kind: &str,
    action: &str,
    bmp: &CapturedBitmap,
    screen: Option<usize>,
    src_window: Option<capture::WindowInfo>,
) -> once_core::Result<DeliverOutcome> {
    let s = settings::load();
    let root = s.save_root();
    let png = capture::encode_png(bmp)?;

    let mut manifest = storage::Manifest {
        id: String::new(),
        file: String::new(),
        kind: kind.into(),
        created_at: storage::now_iso(),
        width: bmp.width,
        height: bmp.height,
        screen,
        dpi_scale: capture::monitors().first().map(|m| m.dpi_scale).unwrap_or(1.0),
        screen_layout: Some(capture::screen_layout()),
        source_window: src_window.as_ref().map(|w| storage::SourceWindow {
            title: w.title.clone(),
            pid: w.pid,
            process_name: w.process_name.clone(),
        }),
        parent_id: None,
        script_sha256: None,
        ops_count: None,
        segments: None,
        manual_fixes: None,
    };
    let (id, paths) = storage::save_capture(&root, kind, &png, &mut manifest)?;

    let row = history::HistoryRow {
        id: id.clone(),
        path: paths.png.to_string_lossy().into_owned(),
        kind: kind.into(),
        created_at: storage::now_iso(),
        width: bmp.width,
        height: bmp.height,
        ocr_status: "none".into(),
        ocr_text: String::new(),
        ocr_preview: String::new(),
        annotated: false,
        parent_id: None,
    };
    history::upsert_capture(&row)?;

    // 剪贴板（CLP-1）：PNG + DIB + 文件路径。
    // 业界语义：save=只落盘不占剪贴板（同类产品「保存」不覆盖用户剪贴板），copy 才写。
    let skip_clip = action == "save";
    let clip = clipboard::ClipboardPayload {
        png: Some(&png),
        rgba: Some((&bmp.pixels, bmp.width, bmp.height)),
        files: vec![paths.png.clone()],
        text: None,
    };
    let clip_result = if skip_clip { Ok(()) } else { clipboard::write(&clip) };

    let mut outcome = DeliverOutcome {
        id,
        path: paths.png.to_string_lossy().into_owned(),
        kind: kind.into(),
        action: action.into(),
        width: bmp.width,
        height: bmp.height,
        ocr_chars: None,
    };

    match action {
        "ocr" => {
            // §9：引擎异常重试 1 次 → 降级为仅复制图片（toast 已由错误路径处理）
            let ocr_result = ocr::provider().recognize_png(&png).or_else(|_| ocr::provider().recognize_png(&png));
            match ocr_result {
                Ok(r) => {
                    let chars = r.full_text.chars().count();
                    let empty = r.blocks.is_empty();
                    // 写 .ocr.json + 历史
                    let stem = paths.png.with_extension("");
                    let ocr_json = stem.with_file_name(format!(
                        "{}.ocr.json",
                        stem.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()
                    ));
                    let doc = serde_json::json!({
                        "source": paths.png.to_string_lossy(),
                        "engine": ocr::provider().name(),
                        "language": r.language,
                        "blocks": r.blocks,
                        "full_text": r.full_text,
                        "empty_reason": r.empty_reason,
                        "created_at": storage::now_iso(),
                    });
                    storage::write_atomic(&ocr_json, &serde_json::to_vec_pretty(&doc).unwrap_or_default()).ok();
                    let status = if empty { "empty" } else { "done" };
                    history::update_ocr(&outcome.id, status, &r.full_text).ok();
                    if !empty {
                        // CLP-2：不覆盖识别期间用户新写入的剪贴板
                        let seq_before = clipboard::sequence_number();
                        let text_clip = clipboard::ClipboardPayload {
                            png: None,
                            rgba: None,
                            files: vec![],
                            text: Some(r.full_text.clone()),
                        };
                        if clipboard::write(&text_clip).is_ok() {
                            let _ = seq_before;
                            toast(app, "success", &format!("已复制 {chars} 字 · 本地完成"));
                        } else {
                            toast(
                                app,
                                "warn",
                                &format!(
                                    "剪贴板已有新内容，文字已保存至 {}",
                                    ocr_json.display()
                                ),
                            );
                        }
                        outcome.ocr_chars = Some(chars);
                    } else {
                        toast(app, "success", "未发现文字 · 已复制图片");
                    }
                }
                Err(e) => {
                    toast_error(app, &e);
                }
            }
        }
        _ => {
            if skip_clip {
                toast(app, "success", &format!("已保存 · {}", paths.png.display()));
            } else {
                match clip_result {
                    Ok(()) => {
                        let msg = match kind {
                            "scroll" => "长截图已保存 · 本地完成",
                            _ => "已复制 · 本地完成",
                        };
                        toast(app, "success", msg);
                    }
                    Err(e) => {
                        // 保存成功但剪贴板失败：警告 + 路径兜底（退出码 4）
                        toast_error(app, &e);
                    }
                }
            }
        }
    }
    Ok(outcome)
}

pub fn toast(app: &AppHandle, level: &str, text: &str) {
    let (cx, cy) = crate::cursor_pos();
    let monitors = capture::monitors();
    let m = monitors
        .iter()
        .find(|m| cx >= m.rect.0 && cx < m.rect.0 + m.rect.2 && cy >= m.rect.1 && cy < m.rect.1 + m.rect.3)
        .or_else(|| monitors.first());
    let Some(m) = m else { return };
    // Windows 右下角：贴任务栏上方 12px（说明书 §3-11）
    let w = 420i32;
    let h = 56i32;
    let x = m.rect.0 + m.rect.2 - w - 16;
    let y = m.rect.1 + m.rect.3 - h - 12;

    if let Some(old) = app.get_webview_window("toast") {
        let _ = old.destroy();
    }
    let text_enc = urlencoding_light(text);
    let level_enc = urlencoding_light(level);
    let win = WebviewWindowBuilder::new(
        app,
        "toast",
        WebviewUrl::App(format!("toast.html?text={text_enc}&level={level_enc}").into()),
    )
    .title("定影通知")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .additional_browser_args(crate::DEBUG_BROWSER_ARGS)
    .build();
    let Ok(win) = win else { return };
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    let _ = win.show();
    // 自动消失 3s（错误级由 toast_error 挂 6s）
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        if let Some(t) = app2.get_webview_window("toast") {
            let _ = t.destroy();
        }
    });
    let _ = app.emit("toast-shown", text);
}

pub fn toast_error(app: &AppHandle, e: &once_core::OnceError) {
    let text = if e.hint.is_empty() {
        format!("{}（退出码 {}）", e.message, e.exit as i32)
    } else {
        format!("{}（退出码 {}）· {}", e.message, e.exit as i32, e.hint)
    };
    toast(app, "error", &text);
    // 错误级 6s
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(6));
        if let Some(t) = app2.get_webview_window("toast") {
            let _ = t.destroy();
        }
    });
}

/// 极简 URL 编码（仅 toast 查询参数用）。
pub fn urlencoding_light(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
