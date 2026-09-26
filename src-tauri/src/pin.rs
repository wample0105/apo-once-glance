//! 贴图（同类产品 招牌功能）：截图钉在桌面置顶显示。
//! 每张贴图 = 一个无边框置顶透明 WebviewWindow；支持拖动/滚轮缩放/不透明度/鼠标穿透/双击关闭。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TRANSPARENT};

static PINS: std::sync::LazyLock<StdMutex<HashMap<u32, PinMeta>>> =
    std::sync::LazyLock::new(|| StdMutex::new(HashMap::new()));
static PIN_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

#[derive(Debug, Clone, Serialize)]
pub struct PinMeta {
    pub id: u32,
    pub path: String,
    /// 窗口位置（物理，含阴影边距外扩）
    pub x: i32,
    pub y: i32,
    /// 图像内容尺寸（物理像素，不含阴影边距）
    pub w: u32,
    pub h: u32,
    /// 阴影边距（物理像素，窗口 = 图像 + 2*pad；0 = 无边距）
    pub pad: u32,
    pub scale: f32,
    pub opacity: f32,
    pub clickthrough: bool,
    /// 贴图形态：capture=普通截图贴图；ai=AI 结果文本卡（v0.2 M2）
    pub kind: String,
    /// AI 结果：原文（复制用）与来源行（服务商 · 模型 · 耗时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_meta: Option<String>,
}

fn pins() -> std::sync::MutexGuard<'static, HashMap<u32, PinMeta>> {
    PINS.lock().unwrap()
}

fn exstyle(hwnd: windows::Win32::Foundation::HWND, on: bool, flag: u32) {
    unsafe {
        let cur = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let next = if on { cur | flag } else { cur & !flag };
        let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);
    }
}

fn pin_window(app: &AppHandle, id: u32) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(&format!("pin-{id}"))
}

/// 创建贴图：把 png 钉在桌面 (x,y)（物理坐标），尺寸=图像像素×scale。
/// pad：四边阴影边距（物理像素）——窗口比图像大一圈，阴影画在边距区（业界同款
/// 贴图即选区原位原大浮出）；pad=0 时窗口=图像（老语义）。
/// max_h：图像内容高度上限（物理像素），超出时整体等比缩小（长截图贴图适配屏高）。
#[tauri::command]
pub async fn pin_create(
    app: AppHandle,
    path: String,
    x: Option<i32>,
    y: Option<i32>,
    scale: Option<f32>,
    pad: Option<u32>,
    max_h: Option<u32>,
) -> Result<u32, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败：{e}"))?;
    let (w, h, _) = once_core::capture::decode_png(&bytes).map_err(|e| e.to_string())?;
    let id = PIN_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut scale = scale.unwrap_or(1.0);
    let pad = pad.unwrap_or(0);
    // 图像内容尺寸（物理）；窗口整体再向外扩 pad 一圈承载阴影
    let mut iw = ((w as f32) * scale).round() as u32;
    let mut ih = ((h as f32) * scale).round() as u32;
    if let Some(mh) = max_h {
        if mh > 0 && ih > mh {
            let k = mh as f32 / ih as f32;
            iw = ((iw as f32) * k).round().max(1.0) as u32;
            ih = mh;
            scale *= k;
        }
    }
    let px = x.unwrap_or(120) - pad as i32;
    let py = y.unwrap_or(120) - pad as i32;
    let pw = iw + 2 * pad;
    let ph = ih + 2 * pad;

    let label = format!("pin-{id}");
    let url = WebviewUrl::App("pin.html".into());
    let win = WebviewWindowBuilder::new(&app, &label, url)
        .title("贴图")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .shadow(false)
        .visible(false)
        .additional_browser_args(crate::DEBUG_BROWSER_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
    let _ = win.set_size(tauri::PhysicalSize::new(pw, ph));
    // Tauri App URL 不支持查询串，id 用 eval 注入（pin.js 会轮询等待）
    let _ = win.eval(&format!("window.__PIN_ID={id};"));
    // 图片内联 data URL：asset 协议 scope 对 Pictures 路径在真机不可靠（曾 403 空窗），
    // base64 一次注入最稳（单截图 1-3MB，WebView2 可承受）
    let data_url = format!("data:image/png;base64,{}", {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    });
    let _ = win.eval(&format!("window.__PIN_SRC={};", serde_json::to_string(&data_url).unwrap_or_default()));
    let _ = win.show();
    let _ = win.set_always_on_top(true);

    pins().insert(
        id,
        PinMeta {
            id,
            path: path.clone(),
            x: px,
            y: py,
            w: iw,
            h: ih,
            pad,
            scale,
            opacity: 1.0,
            clickthrough: false,
            kind: "capture".into(),
            ai_text: None,
            ai_meta: None,
        },
    );
    Ok(id)
}

/// AI 结果贴图（v0.2 M2）：文本卡片形态，复用贴图窗口与交互（拖动/置顶/关闭）。
/// 不写截图历史；文本卡片由 pin.html 的 #ai-card 渲染（文字可选中复制，任意缩放不糊）。
/// 宽度固定 460 逻辑像素，高度按内容估算并设上下限；x/y 为物理坐标（选区原位浮出）。
#[tauri::command]
pub async fn pin_create_ai(
    app: AppHandle,
    text: String,
    meta_line: String,
    x: i32,
    y: i32,
    dpr: f32,
) -> Result<u32, String> {
    let dpr = if dpr > 0.1 { dpr } else { 1.0 };
    let w_css = 460.0f32;
    let per_line = ((w_css - 36.0) / 14.5).max(10.0);
    let mut lines = 0.0f32;
    for seg in text.split('\n') {
        let units: f32 = seg.chars().map(|c| if (c as u32) < 0x80 { 0.55 } else { 1.0 }).sum();
        lines += (units / per_line).ceil().max(1.0);
    }
    let lines = lines.max(1.0);
    let h_css = (14.0 + lines * 21.0 + 10.0 + 22.0 + 12.0 + 40.0 + 12.0).min(720.0).max(150.0);
    let id = PIN_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let pw = (w_css * dpr).round() as u32;
    let ph = (h_css * dpr).round() as u32;

    let label = format!("pin-{id}");
    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("pin.html".into()))
        .title("AI 结果")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .shadow(false)
        .visible(false)
        .additional_browser_args(crate::DEBUG_BROWSER_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = win.set_size(tauri::PhysicalSize::new(pw, ph));
    let _ = win.eval(&format!("window.__PIN_ID={id};"));
    let _ = win.eval(&format!(
        "window.__PIN_TEXT={};",
        serde_json::to_string(&text).unwrap_or_default()
    ));
    let _ = win.eval(&format!(
        "window.__PIN_AIMETA={};",
        serde_json::to_string(&meta_line).unwrap_or_default()
    ));
    let _ = win.show();
    let _ = win.set_always_on_top(true);

    pins().insert(
        id,
        PinMeta {
            id,
            path: String::new(),
            x,
            y,
            w: pw,
            h: ph,
            pad: 0,
            scale: 1.0,
            opacity: 1.0,
            clickthrough: false,
            kind: "ai".into(),
            ai_text: Some(text),
            ai_meta: Some(meta_line),
        },
    );
    Ok(id)
}

/// pin.html 启动时取自己的元数据（路径/缩放），一次性注入查询串在 Tauri 不可靠故走命令。
#[tauri::command]
pub fn pin_meta(id: u32) -> Result<PinMeta, String> {
    pins().get(&id).cloned().ok_or_else(|| "贴图不存在".into())
}

/// AI 结果贴图：前端 Markdown 渲染完成后按实际内容高度回调窗口尺寸（h=内容区逻辑像素）。
/// 建窗高是纯文本估算且 clamp 720，渲染后排版会变化；同步更新 PinMeta，
/// 保证后续滚轮缩放仍按正确的内容高度计算。
#[tauri::command]
pub fn pin_resize_ai(app: AppHandle, id: u32, h: f64) -> Result<(), String> {
    let mut m = pins();
    let Some(meta) = m.get_mut(&id) else { return Err("贴图不存在".into()) };
    let Some(win) = pin_window(&app, id) else { return Err("贴图窗口不存在".into()) };
    let scale = win.scale_factor().unwrap_or(1.0);
    let h_css = h.clamp(150.0, 1000.0);
    let ph = (h_css * scale).round() as u32;
    let _ = win.set_size(tauri::PhysicalSize::new(meta.w + 2 * meta.pad, ph + 2 * meta.pad));
    meta.h = ph;
    Ok(())
}

/// 贴图缩放（滚轮 / 管理面板）——按图像内容尺寸缩放，窗口同步补上阴影边距
#[tauri::command]
pub fn pin_scale(app: AppHandle, id: u32, factor: f32) -> Result<(), String> {
    let mut m = pins();
    let Some(meta) = m.get_mut(&id) else { return Err("贴图不存在".into()) };
    if let Some(win) = pin_window(&app, id) {
        let nw = ((meta.w as f32) * factor).round() as u32;
        let nh = ((meta.h as f32) * factor).round() as u32;
        if (32..=8000).contains(&nw) && (32..=8000).contains(&nh) {
            let _ = win.set_size(tauri::PhysicalSize::new(nw + 2 * meta.pad, nh + 2 * meta.pad));
            meta.w = nw;
            meta.h = nh;
            meta.scale *= factor;
        }
    }
    Ok(())
}

/// 不透明度 0.1–1.0（通过事件让 pin 页面调整 CSS 透明度）
#[tauri::command]
pub fn pin_opacity(app: AppHandle, id: u32, opacity: f32) -> Result<(), String> {
    use tauri::Emitter;
    let mut m = pins();
    let Some(meta) = m.get_mut(&id) else { return Err("贴图不存在".into()) };
    meta.opacity = opacity.clamp(0.1, 1.0);
    let _ = app.emit_to(format!("pin-{id}"), "pin-opacity", meta.opacity);
    Ok(())
}

/// 不透明度相对步进（Ctrl+滚轮）：以当前值为基准 ±delta（10 档语义）——
/// 曾用前端"1±0.05"绝对式，基准恒为 1，连续滚动只到 0.95（用户报"变化不明显"的真根因）
#[tauri::command]
pub fn pin_opacity_step(app: AppHandle, id: u32, delta: f32) -> Result<(), String> {
    use tauri::Emitter;
    let mut m = pins();
    let Some(meta) = m.get_mut(&id) else { return Err("贴图不存在".into()) };
    meta.opacity = (meta.opacity + delta).clamp(0.1, 1.0);
    let v = meta.opacity;
    drop(m);
    let _ = app.emit_to(format!("pin-{id}"), "pin-opacity", v);
    Ok(())
}

/// 鼠标穿透开关
#[tauri::command]
pub fn pin_clickthrough(app: AppHandle, id: u32, on: bool) -> Result<(), String> {
    let mut m = pins();
    let Some(meta) = m.get_mut(&id) else { return Err("贴图不存在".into()) };
    meta.clickthrough = on;
    if let Some(win) = pin_window(&app, id) {
        if let Ok(h) = win.hwnd() {
            exstyle(h, on, WS_EX_TRANSPARENT.0);
        }
    }
    Ok(())
}

/// 关闭单张贴图
#[tauri::command]
pub fn pin_close(app: AppHandle, id: u32) -> Result<(), String> {
    pins().remove(&id);
    if let Some(win) = pin_window(&app, id) {
        let _ = win.destroy();
    }
    Ok(())
}

/// 贴图列表（管理面板）
#[tauri::command]
pub fn pin_list() -> Vec<PinMeta> {
    pins().values().cloned().collect()
}

/// 全部关闭
#[tauri::command]
pub fn pin_close_all(app: AppHandle) -> Result<(), String> {
    let ids: Vec<u32> = pins().keys().cloned().collect();
    for id in ids {
        pins().remove(&id);
        if let Some(win) = pin_window(&app, id) {
            let _ = win.destroy();
        }
    }
    Ok(())
}

/// 贴图位置回写（拖动结束时由前端调用）
#[tauri::command]
pub fn pin_move(id: u32, x: i32, y: i32) -> Result<(), String> {
    if let Some(meta) = pins().get_mut(&id) {
        meta.x = x;
        meta.y = y;
    }
    Ok(())
}
