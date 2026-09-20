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
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub scale: f32,
    pub opacity: f32,
    pub clickthrough: bool,
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
#[tauri::command]
pub async fn pin_create(
    app: AppHandle,
    path: String,
    x: Option<i32>,
    y: Option<i32>,
    scale: Option<f32>,
) -> Result<u32, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败：{e}"))?;
    let (w, h, _) = once_core::capture::decode_png(&bytes).map_err(|e| e.to_string())?;
    let id = PIN_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let scale = scale.unwrap_or(1.0);
    let px = x.unwrap_or(120);
    let py = y.unwrap_or(120);
    let pw = ((w as f32) * scale).round() as u32;
    let ph = ((h as f32) * scale).round() as u32;

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
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
    let _ = win.set_size(tauri::PhysicalSize::new(pw, ph));
    // Tauri App URL 不支持查询串，id 用 eval 注入（pin.js 会轮询等待）
    let _ = win.eval(&format!("window.__PIN_ID={id};"));
    let _ = win.show();
    let _ = win.set_always_on_top(true);

    pins().insert(
        id,
        PinMeta {
            id,
            path: path.clone(),
            x: px,
            y: py,
            w: pw,
            h: ph,
            scale,
            opacity: 1.0,
            clickthrough: false,
        },
    );
    Ok(id)
}

/// pin.html 启动时取自己的元数据（路径/缩放），一次性注入查询串在 Tauri 不可靠故走命令。
#[tauri::command]
pub fn pin_meta(id: u32) -> Result<PinMeta, String> {
    pins().get(&id).cloned().ok_or_else(|| "贴图不存在".into())
}

/// 贴图缩放（滚轮 / 管理面板）
#[tauri::command]
pub fn pin_scale(app: AppHandle, id: u32, factor: f32) -> Result<(), String> {
    let mut m = pins();
    let Some(meta) = m.get_mut(&id) else { return Err("贴图不存在".into()) };
    if let Some(win) = pin_window(&app, id) {
        let nw = ((meta.w as f32) * factor).round() as u32;
        let nh = ((meta.h as f32) * factor).round() as u32;
        if (32..=8000).contains(&nw) && (32..=8000).contains(&nh) {
            let _ = win.set_size(tauri::PhysicalSize::new(nw, nh));
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
