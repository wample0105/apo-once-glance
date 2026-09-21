//! 定影 Onceglance · Tauri 桌面壳（GUI 前端）。
//! 内核逻辑在 once-core；本 crate 做窗口、托盘、热键、覆盖层与桥接。

use once_core::capture::{self, CapturedBitmap};
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::Graphics::Gdi::InvalidateRect;
use once_core::settings::{self, Settings};
use once_core::{clipboard, history, ocr};
use serde::Serialize;
use std::os::windows::process::CommandExt;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

mod bridge;
mod detect;
mod pin;
mod deliver;
pub mod scrollcmd;

use deliver::DeliverOutcome;

#[derive(Serialize, Clone)]
struct MonitorDto {
    index: usize,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    dpi_scale: f32,
    primary: bool,
}

#[tauri::command]
fn get_monitors() -> Vec<MonitorDto> {
    capture::monitors()
        .into_iter()
        .map(|m| MonitorDto {
            index: m.index,
            x: m.rect.0,
            y: m.rect.1,
            w: m.rect.2,
            h: m.rect.3,
            dpi_scale: m.dpi_scale,
            primary: m.primary,
        })
        .collect()
}

#[tauri::command]
fn get_cursor_pos() -> (i32, i32) {
    cursor_pos()
}

#[tauri::command]
fn cursor_monitor() -> Option<MonitorDto> {
    let (cx, cy) = cursor_pos();
    capture::monitors()
        .into_iter()
        .find(|m| cx >= m.rect.0 && cx < m.rect.0 + m.rect.2 && cy >= m.rect.1 && cy < m.rect.1 + m.rect.3)
        .map(|m| MonitorDto {
            index: m.index,
            x: m.rect.0,
            y: m.rect.1,
            w: m.rect.2,
            h: m.rect.3,
            dpi_scale: m.dpi_scale,
            primary: m.primary,
        })
}

fn cursor_pos() -> (i32, i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    (p.x, p.y)
}

use std::sync::atomic::{AtomicU64, Ordering};
static OVERLAY_KIND_SEQ: AtomicU64 = AtomicU64::new(0);
static OVERLAY_KIND: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[tauri::command]
fn get_overlay_kind() -> Option<String> {
    OVERLAY_KIND.lock().unwrap().clone()
}

/// 供其它模块复用的覆盖层启动入口（真实逻辑在 start_overlay 命令内）。
pub(crate) async fn launch_overlay(app: AppHandle, kind: String) -> Result<(), String> {
    start_overlay(app, kind).await
}

/// 唤起覆盖层（kind: region|ocr|annotate|scroll）。
#[tauri::command]
async fn start_overlay(app: AppHandle, kind: String) -> Result<(), String> {
    eprintln!("start_overlay called kind={kind}");
    // 截图态再按一次热键 = 退出（同类产品 手感；保证遮罩永远有办法退出）
    if OVERLAY_ACTIVE.swap(false, Ordering::SeqCst) {
        if let Some(w) = app.get_webview_window("overlay") {
            park_overlay_offscreen(&w);
            unsafe { let _ = DwmFlush(); }
        }
        eprintln!("start_overlay: overlay active → toggle close");
        return Ok(());
    }
    let app2 = app.clone();
    let kind2 = kind.clone();
    // 窗口操作放到独立线程，避免主线程事件循环重入死锁
    let r = std::thread::spawn(move || show_overlay(&app2, &kind2)).join();
    match &r {
        Err(e) => eprintln!("start_overlay({kind}) panic: {e:?}"),
        Ok(Err(e)) => eprintln!("start_overlay({kind}) 失败: {e}"),
        _ => {}
    }
    r.map_err(|e| format!("{e:?}"))?.map_err(|e| e.to_string())
}

static OVERLAY_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static OVERLAY_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
// 冷启动竞态兜底：emit 时页面监听可能未挂——存最近一次 payload，JS ready 后主动取走补激活
static OVERLAY_PENDING: std::sync::Mutex<Option<serde_json::Value>> = std::sync::Mutex::new(None);

/// 页面就绪握手：JS init 挂好监听后调用（热键 emit 前等它，杜绝监听未挂事件丢失）
#[tauri::command]
fn overlay_ready() {
    OVERLAY_READY.store(true, Ordering::SeqCst);
}

/// JS 就绪后取走错过的激活 payload（冷启动 emit 早于监听注册的兜底）
#[tauri::command]
fn overlay_take_pending() -> Option<serde_json::Value> {
    OVERLAY_PENDING.lock().unwrap().take()
}

fn park_overlay_offscreen(win: &tauri::WebviewWindow) {
    // 屏外驻留：不 hide（WebView2 隐藏窗口渲染挂起，再 show 黑屏/透明），移出屏幕保持可渲染
    // 驻留前让页面清屏：下次移回的瞬间只显示空白，不闪上一轮画面（也避免 freeze 拍到旧内容）
    let _ = win.emit("overlay-cleared", ());
    let _ = win.set_position(PhysicalPosition::new(-20000, -20000));
}

fn show_overlay(app: &AppHandle, kind: &str) -> tauri::Result<()> {
    let t0 = std::time::Instant::now();
    *OVERLAY_KIND.lock().unwrap() = Some(kind.to_string());
    OVERLAY_KIND_SEQ.fetch_add(1, Ordering::SeqCst);
    // 光标所在显示器：一块覆盖层一个窗口（跨屏框选 M2 打通）
    let (cx, cy) = cursor_pos();
    let mons = capture::monitors();
    let monitor = mons
        .iter()
        .find(|m| cx >= m.rect.0 && cx < m.rect.0 + m.rect.2 && cy >= m.rect.1 && cy < m.rect.1 + m.rect.3)
        .or_else(|| mons.first());
    let Some(m) = monitor else {
        eprintln!("show_overlay: no monitor, abort");
        return Ok(());
    };
    let m = m.clone();
    // 预驻留复用：窗口常驻隐藏（setup 预建），热键只定位+显示，无创建/销毁等待
    let win = if let Some(w) = app.get_webview_window("overlay") {
        w
    } else {
        OVERLAY_READY.store(false, Ordering::SeqCst);
        // 兜底：预建缺失（异常退出后）现场重建
        let mut last_err = None;
        let mut built = None;
        for _ in 0..5 {
            match WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
                .title("定影取景")
                .decorations(false)
                .shadow(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .focused(true)
                .visible(false)
                .build()
            {
                Ok(w) => { park_overlay_offscreen(&w); built = Some(w); break; }
                Err(e) => { last_err = Some(e); std::thread::sleep(std::time::Duration::from_millis(120)); }
            }
        }
        match built {
            Some(w) => w,
            None => return Err(last_err.unwrap_or_else(|| tauri::Error::WindowNotFound)),
        }
    };
    // 先冻结再移回：窗口恒可见（屏外驻留），若先移回，屏上立刻显示上一轮旧画面，
    // freeze 会把它拍进新背景，造成逐轮叠加残留。必须趁窗口仍在屏外时截屏。
    let frozen = scrollcmd::freeze_begin_inner_ok();
    win.set_size(PhysicalSize::new(m.rect.2 as u32, m.rect.3 as u32))?;
    win.set_position(PhysicalPosition::new(m.rect.0, m.rect.1))?;
    // 无边框窗口在 Windows 仍有不可见命中测试边框：外框对齐显示器 ≠ 客户区对齐。
    // 用客户区实际原点做一次补偿，保证冻结位图 1:1 贴合真实屏幕（消除重影/偏移）。
    if let Ok(ipos) = win.inner_position() {
        let dx = ipos.x - m.rect.0;
        let dy = ipos.y - m.rect.1;
        if dx != 0 || dy != 0 {
            win.set_position(PhysicalPosition::new(m.rect.0 - dx, m.rect.1 - dy))?;
        }
    }
    // 热键路径：冻结图已在移回前截好（纯净画面），随后推送激活事件（JS 已驻留，收事件即渲染蒙版）
    let mut payload = serde_json::json!({ "kind": kind });
    if let Some(f) = frozen {
        payload["dataUrl"] = serde_json::Value::String(f.0);
        payload["width"] = serde_json::Value::from(f.1);
        payload["height"] = serde_json::Value::from(f.2);
    }
    // 窗口恒可见（屏外驻留），移回即显示；emit 前等页面就绪（监听已挂），杜绝冷启动事件丢失
    for _ in 0..40 {
        if OVERLAY_READY.load(Ordering::SeqCst) { break; }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    OVERLAY_ACTIVE.store(true, Ordering::SeqCst);
    win.set_focus()?;
    // 屏外驻留窗口被 Chromium 判 occluded 停止合成；移回后强制重绘 kick 一帧
    if let Ok(hwnd) = win.hwnd() {
        unsafe { let _ = InvalidateRect(Some(hwnd), None, true); } // 异步失效即触发重绘 kick
    }
    *OVERLAY_PENDING.lock().unwrap() = Some(payload.clone());
    let _ = win.emit("overlay-activate", &payload);
    eprintln!("overlay shown on monitor {} rect {:?} in {:?}", m.index, m.rect, t0.elapsed());
    Ok(())
}

/// 隐藏覆盖层（长截图模式：让出画面但不销毁）。
#[tauri::command]
fn overlay_hide(app: AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }
}

/// 覆盖层点击时收回键盘焦点（否则 Esc/Enter/工具热键全部失效）。
#[tauri::command]
fn overlay_focus(app: AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.set_focus();
    }
}

fn close_overlay(app: &AppHandle) {
    OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window("overlay") {
        // 屏外驻留（不 hide：WebView2 隐藏渲染挂起）；DwmFlush 确保画面从屏幕消失再截下一次
        park_overlay_offscreen(&win);
        unsafe { let _ = DwmFlush(); }
    }
}

/// 覆盖层自我关闭（标注保存/放弃后由 JS 调用；window.close() 在 WebView2 可能被拦截）。
#[tauri::command]
fn overlay_close(app: AppHandle) {
    close_overlay(&app);
}

/// 按 label 关闭辅助窗口（引导页等；WebView2 拦截 JS window.close() 时的兜底）。
#[tauri::command]
fn close_window(app: AppHandle, label: String) {
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.destroy();
    }
}

/// 自检桥接：回环连接本机命名管道并取回 status envelope（管道服务线程应答）。
#[tauri::command]
fn bridge_ping() -> Result<serde_json::Value, String> {
    use std::io::{BufRead, BufReader, Write};
    let mut f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(r"\\.\pipe\once-bridge")
        .map_err(|e| format!("桥接未就绪：{e}"))?;
    f.write_all(b"{\"cmd\":\"status\"}\n").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(f).read_line(&mut line).map_err(|e| e.to_string())?;
    serde_json::from_str(&line).map_err(|e| e.to_string())
}

/// 覆盖层完成事件：rect 为所选显示器内的物理像素。
#[derive(Debug, Clone, serde::Deserialize)]
struct OverlayFinish {
    kind: String,
    action: String, // copy | ocr | annotate | scroll | cancel
    /// 显示器 index
    screen: usize,
    /// 相对显示器原点的物理像素
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

#[tauri::command]
async fn overlay_finish(app: AppHandle, payload: OverlayFinish) -> Result<serde_json::Value, String> {
    let monitor = capture::monitors()
        .into_iter()
        .find(|m| m.index == payload.screen);
    close_overlay(&app);
    if payload.action == "cancel" || payload.w == 0 || payload.h == 0 {
        return Ok(serde_json::json!({ "cancelled": true }));
    }
    let Some(m) = monitor else {
        return Err("显示器不存在".into());
    };
    let abs_x = m.rect.0 + payload.x;
    let abs_y = m.rect.1 + payload.y;
    // 捕获前先隐藏自身（CAP-6）：覆盖层已 destroy；等 1 帧让 DWM 合成完成
    std::thread::sleep(std::time::Duration::from_millis(120));

    let result = (|| -> once_core::Result<DeliverOutcome> {
        let bmp = capture::capture_region_px(abs_x, abs_y, payload.w, payload.h)?;
        deliver::deliver_capture(&app, &payload.kind, &payload.action, &bmp, Some(m.index), None)
    })();
    match result {
        Ok(outcome) => Ok(serde_json::to_value(outcome).unwrap_or_default()),
        Err(e) => {
            deliver::toast_error(&app, &e);
            Err(e.message)
        }
    }
}

/// 直接窗口捕获（托盘菜单 / 主面板按钮）。
#[tauri::command]
fn capture_window_now(app: AppHandle) -> Result<serde_json::Value, String> {
    run_capture_blocking(&app, "window", "copy")
}

#[tauri::command]
fn capture_fullscreen_now(app: AppHandle) -> Result<serde_json::Value, String> {
    run_capture_blocking(&app, "fullscreen", "copy")
}

fn run_capture_blocking(
    app: &AppHandle,
    kind: &str,
    action: &str,
) -> Result<serde_json::Value, String> {
    let result = (|| -> once_core::Result<DeliverOutcome> {
        // 黑名单前置（CAP-7）
        let s = settings::load();
        if let Some(fg) = capture::foreground_window() {
            if let Some(hit) = once_core::blacklist::check(&s, &fg.process_name, &fg.title) {
                return Err(once_core::OnceError::blacklist(format!(
                    "已拦截：{} · 隐私黑名单",
                    hit.pattern
                )));
            }
        }
        match kind {
            "window" => {
                let fg = capture::foreground_window()
                    .ok_or_else(|| once_core::OnceError::capture("无法确定前台窗口"))?;
                let bmp = capture::capture_window_hwnd(fg.hwnd)?;
                deliver::deliver_capture(app, kind, action, &bmp, Some(fg.monitor_index), Some(fg))
            }
            "fullscreen" => {
                let (cx, cy) = cursor_pos();
                let m = capture::monitors()
                    .into_iter()
                    .find(|m| cx >= m.rect.0 && cx < m.rect.0 + m.rect.2 && cy >= m.rect.1 && cy < m.rect.1 + m.rect.3)
                    .ok_or_else(|| once_core::OnceError::capture("未找到光标所在屏幕"))?;
                let bmp = capture::capture_monitor(m.index)?;
                deliver::deliver_capture(app, kind, action, &bmp, Some(m.index), None)
            }
            _ => Err(once_core::OnceError::usage("未知捕获类型")),
        }
    })();
    match result {
        Ok(o) => Ok(serde_json::to_value(o).unwrap_or_default()),
        Err(e) => {
            deliver::toast_error(app, &e);
            Err(e.message)
        }
    }
}

#[tauri::command]
fn list_history(query: String, limit: usize) -> Result<serde_json::Value, String> {
    let rows = history::search(&query, limit).map_err(|e| e.to_string())?;
    serde_json::to_value(rows).map_err(|e| e.to_string())
}

#[tauri::command]
fn thumbnail(path: String, max_w: u32) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let img = DynamicImageExt::thumbnail_limited(img, max_w);
    let mut cur = std::io::Cursor::new(Vec::new());
    img.write_to(&mut cur, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", base64_encode(&cur.into_inner())))
}

struct DynamicImageExt;

impl DynamicImageExt {
    fn thumbnail_limited(img: image::DynamicImage, max_w: u32) -> image::DynamicImage {
        let (w, h) = (img.width(), img.height());
        if w <= max_w {
            return img;
        }
        let nh = (h as f64 * max_w as f64 / w as f64).round() as u32;
        img.resize_exact(max_w, nh, image::imageops::FilterType::Triangle)
    }
}

fn base64_encode(data: &[u8]) -> String {
    const TBL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TBL[(n >> 18) as usize & 63] as char);
        out.push(TBL[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TBL[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TBL[n as usize & 63] as char } else { '=' });
    }
    out
}

#[tauri::command]
fn get_settings() -> Settings {
    settings::load()
}

#[tauri::command]
fn set_setting(key: String, value: serde_json::Value) -> Result<Settings, String> {
    settings::update(|s| {
        match key.as_str() {
            "agent_enabled" => s.agent_enabled = value.as_bool().unwrap_or(s.agent_enabled),
            "auto_capture_enabled" => {
                s.auto_capture_enabled = value.as_bool().unwrap_or(s.auto_capture_enabled)
            }
            "save_dir" => {
                s.save_dir = value.as_str().map(|x| x.to_string()).filter(|x| !x.is_empty())
            }
            "default_action" => {
                // 只接受冻结的三值，其余（含空串）静默忽略
                if let Some(v) = value.as_str() {
                    if matches!(v, "copy_image" | "ocr_copy" | "save_only") {
                        s.default_action = v.into();
                    }
                }
            }
            "remember_annotation" => {
                s.remember_annotation = value.as_bool().unwrap_or(s.remember_annotation)
            }
            "show_text_boxes" => s.show_text_boxes = value.as_bool().unwrap_or(s.show_text_boxes),
            "close_to_tray" => s.close_to_tray = value.as_bool().unwrap_or(s.close_to_tray),
            "annotation" => {
                if let Ok(a) = serde_json::from_value(value.clone()) {
                    s.annotation = a;
                }
            }
            "blacklist" => {
                if let Ok(list) = serde_json::from_value(value.clone()) {
                    s.blacklist = list;
                }
            }
            "onboarding_done" => s.onboarding_done = value.as_bool().unwrap_or(s.onboarding_done),
            "esc_exit_confirm" => {
                if let Ok(v) = serde_json::from_value(value.clone()) {
                    s.esc_exit_confirm = v;
                }
            }
            _ => {}
        };
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", p.display()))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_to_recycle_bin(paths: Vec<String>) -> Result<(), String> {
    let p: Vec<std::path::PathBuf> = paths.iter().map(std::path::PathBuf::from).collect();
    clipboard::delete_to_recycle_bin(&p).map_err(|e| e.to_string())
}

fn logo_candidates(app: &AppHandle, name: &str) -> Vec<std::path::PathBuf> {
    vec![
        app.path().resource_dir().ok().map(|d| d.join("assets/logo").join(name)),
        Some(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../assets/logo").join(name)),
    ]
    .into_iter()
    .flatten()
    .collect()
}

#[tauri::command]
fn get_logo_path(app: AppHandle, name: String) -> Result<String, String> {
    // 一处定稿、处处同图：解析 assets/logo 下的唯一正本
    for c in logo_candidates(&app, &name) {
        if c.exists() {
            return Ok(c.to_string_lossy().into_owned());
        }
    }
    Err(format!("品牌资产不存在：{name}"))
}

/// 品牌图片内联：返回 svg 文本，JS 拼 data URL 显示——绕开 asset.localhost 的 scope 校验
/// （2026-09-22 用户报主窗口左上角 logo 消失：裸 exe 的 resource_dir 缺 assets 时，
/// 源码目录回退路径拿到的绝对路径过不了 assetProtocol scope，图片 403 空白）
#[tauri::command]
fn get_logo_svg(app: AppHandle, name: String) -> Result<String, String> {
    for c in logo_candidates(&app, &name) {
        if c.exists() {
            return std::fs::read_to_string(&c).map_err(|e| format!("品牌资产读取失败：{e}"));
        }
    }
    Err(format!("品牌资产不存在：{name}"))
}

#[tauri::command]
fn doctor_run() -> serde_json::Value {
    let s = settings::load();
    let mut items = Vec::new();
    let capture_ok = (|| -> bool {
        let vd = capture::virtual_desktop();
        capture::capture_region_px(vd.0 + vd.2 - 64, vd.1 + vd.3 - 64, 64, 64)
            .map(|b| !b.pixels.chunks_exact(4).all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0))
            .unwrap_or(false)
    })();
    let dir_ok = s.save_dir_writable();
    let ocr_ok = ocr::engine_available();
    let runtime_ok = webview2_present();
    items.push(serde_json::json!({ "check": "capture", "ok": capture_ok, "detail": "角落捕获自检" }));
    items.push(serde_json::json!({ "check": "save_dir", "ok": dir_ok, "detail": s.save_root().display().to_string() }));
    items.push(serde_json::json!({ "check": "ocr_engine", "ok": ocr_ok, "detail": ocr::engine_language() }));
    items.push(serde_json::json!({ "check": "runtime", "ok": runtime_ok, "detail": "WebView2 运行时" }));
    serde_json::json!({ "ok_all": capture_ok && dir_ok && ocr_ok && runtime_ok, "items": items })
}

/// 审计日志读取（Agent 与隐私页）。
#[tauri::command]
fn read_audit(limit: usize) -> Vec<once_core::audit::AuditEntry> {
    once_core::audit::read_recent(limit)
}

#[tauri::command]
fn clear_audit() -> Result<(), String> {
    once_core::audit::clear().map_err(|e| e.to_string())
}

fn webview2_present() -> bool {
    [r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application", r"C:\Program Files\Microsoft\EdgeWebView\Application"]
        .iter()
        .any(|p| {
            std::fs::read_dir(p)
                .map(|entries| {
                    entries.filter_map(|e| e.ok()).any(|e| {
                        e.file_name().to_string_lossy().chars().next().is_some_and(|c| c.is_ascii_digit())
                    })
                })
                .unwrap_or(false)
        })
}

fn register_hotkeys(app: &AppHandle) -> Vec<(String, String)> {
    // 返回注册失败的 (功能, 键位)。可重入：先注销全部再按当前设置注册。
    let g = app.global_shortcut();
    let _ = g.unregister_all();
    let s = settings::load();
    let mut failures = Vec::new();
    let bindings: Vec<(&str, &str, Box<dyn Fn(&AppHandle) + Send + Sync>)> = vec![
        (
            "region",
            &s.hotkeys.region,
            Box::new(|app: &AppHandle| {
                let _ = show_overlay(app, "region");
            }),
        ),
        (
            "window",
            &s.hotkeys.window,
            Box::new(|app: &AppHandle| {
                let _ = run_capture_blocking(app, "window", "copy");
            }),
        ),
        (
            "fullscreen",
            &s.hotkeys.fullscreen,
            Box::new(|app: &AppHandle| {
                let _ = run_capture_blocking(app, "fullscreen", "copy");
            }),
        ),
        (
            "ocr",
            &s.hotkeys.ocr,
            Box::new(|app: &AppHandle| {
                let _ = show_overlay(app, "ocr");
            }),
        ),
        (
            "scroll",
            &s.hotkeys.scroll,
            Box::new(|app: &AppHandle| {
                let _ = show_overlay(app, "scroll");
            }),
        ),
        (
            "panel",
            &s.hotkeys.panel,
            Box::new(|app: &AppHandle| {
                show_main(app);
            }),
        ),
    ];
    for (name, hk, handler) in bindings {
        let hk = hk.to_string();
        let res = g.on_shortcut(hk.as_str(), move |app, _sc, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                handler(app);
            }
        });
        if let Err(e) = res {
            failures.push((name.to_string(), hk.clone()));
            eprintln!("热键注册失败 {name} {hk}: {e}");
        }
    }
    failures
}

pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn tray_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::*;
    let region = MenuItem::with_id(app, "region", "区域截图", true, Some("Alt+Shift+A"))?;
    let window = MenuItem::with_id(app, "window", "窗口截图", true, Some("Alt+Shift+W"))?;
    let fullscreen = MenuItem::with_id(app, "fullscreen", "全屏截图", true, Some("Alt+Shift+F"))?;
    let ocr = MenuItem::with_id(app, "ocr", "自动取字", true, Some("Alt+Shift+T"))?;
    let scroll = MenuItem::with_id(app, "scroll", "长截图", true, Some("Alt+Shift+L"))?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let panel = MenuItem::with_id(app, "panel", "打开主面板", true, Some("Alt+Shift+H"))?;
    let agent = CheckMenuItem::with_id(app, "agent", "Agent 调用：允许", true, settings::load().agent_enabled, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let diag = MenuItem::with_id(app, "doctor", "诊断", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[&region, &window, &fullscreen, &ocr, &scroll, &sep1, &panel, &agent, &sep2, &settings_item, &diag, &quit],
    )
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::tray::TrayIconBuilder;
    let png = include_bytes!("../../assets/logo/png/tray-windows-24.png");
    let img = tauri::image::Image::from_bytes(png)?;
    let menu = tray_menu(app)?;
    let _ = TrayIconBuilder::with_id("main-tray")
        .icon(img)
        .tooltip("定影 Onceglance")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "region" | "ocr" | "scroll" => {
                let _ = show_overlay(app, event.id().as_ref());
            }
            "window" => {
                let _ = run_capture_blocking(app, "window", "copy");
            }
            "fullscreen" => {
                let _ = run_capture_blocking(app, "fullscreen", "copy");
            }
            "panel" | "settings" => show_main(app),
            "agent" => {
                let cur = settings::load().agent_enabled;
                let _ = settings::update(|s| s.agent_enabled = !cur);
            }
            "doctor" => {
                show_main(app);
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("nav-to", "doctor");
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    once_core::dpi::ensure_per_monitor_dpi_aware();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 多实例：激活既有实例（§9）
            show_main(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_overlay_kind,
            get_monitors,
            scrollcmd::scroll_start,
            scrollcmd::scroll_grab,
            scrollcmd::scroll_finish,
            scrollcmd::scroll_cancel,
            scrollcmd::scroll_adjust,
            scrollcmd::scroll_accept_all,
            scrollcmd::scroll_save,
            scrollcmd::scroll_export_segments,
            scrollcmd::open_quality_window,
            scrollcmd::scroll_preview,
            scrollcmd::scroll_get_review_session,
            detect::detect_candidates,
            scrollcmd::freeze_begin,
            scrollcmd::freeze_pixel,
            scrollcmd::freeze_take_region,
            scrollcmd::freeze_deliver,
            pin::pin_create,
            pin::pin_meta,
            pin::pin_scale,
            pin::pin_opacity,
            pin::pin_clickthrough,
            pin::pin_close,
            pin::pin_list,
            pin::pin_close_all,
            pin::pin_move,
            scrollcmd::annotate_begin,
            scrollcmd::annotate_open_file,
            scrollcmd::annotate_file_payload,
            scrollcmd::annotate_save,
            scrollcmd::save_as_dialog,
            detail_data,
            copy_image_bytes,
            set_hotkey,
            reset_hotkeys,
            hotkey_conflicts,
            autostart_status,
            autostart_set,
            open_onboarding,
            overlay_close,
            overlay_ready,
            overlay_take_pending,
            overlay_hide,
            overlay_focus,
            bridge_ping,
            close_window,
            get_cursor_pos,
            cursor_monitor,
            start_overlay,
            overlay_finish,
            capture_window_now,
            capture_fullscreen_now,
            list_history,
            thumbnail,
            get_settings,
            set_setting,
            open_in_explorer,
            delete_to_recycle_bin,
            get_logo_path,
            get_logo_svg,
            doctor_run,
            read_audit,
            clear_audit
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            bridge::start(handle.clone());
            setup_tray(&handle)?;
            // 预驻留覆盖层：启动即建隐藏窗口+预载页面，热键只做定位+冻结+显示（秒开）
            {
                let h = handle.clone();
                std::thread::spawn(move || {
                    OVERLAY_READY.store(false, Ordering::SeqCst);
                    for _ in 0..20 {
                        if h.get_webview_window("overlay").is_some() {
                            return;
                        }
                        match WebviewWindowBuilder::new(&h, "overlay", WebviewUrl::App("overlay.html".into()))
                            .title("定影取景")
                            .decorations(false)
                            .shadow(false)
                            .transparent(true)
                            .always_on_top(true)
                            .skip_taskbar(true)
                            .resizable(false)
                            .maximizable(false)
                            .minimizable(false)
                            .focused(false)
                            .visible(true)
                            .build()
                        {
                            Ok(w) => {
                                park_overlay_offscreen(&w);
                                eprintln!("overlay prewarmed (offscreen)");
                                return;
                            }
                            Err(_) => std::thread::sleep(std::time::Duration::from_millis(250)),
                        }
                    }
                });
            }
            let failures = register_hotkeys(&handle);
            if !failures.is_empty() {
                // 热键注册失败：降级为托盘触发（§9）；记录到设置供设置页展示
                let names = failures.iter().map(|(n, k)| format!("{n}={k}")).collect::<Vec<_>>().join(",");
                eprintln!("热键冲突：{names}");
                // 旧进程刚退出时系统热键句柄释放有延迟（双进程竞态），失败后延迟重试，
                // 否则本进程永远没有截图热键——用户按热键毫无反应且无从自愈
                let h2 = handle.clone();
                std::thread::spawn(move || {
                    for wait in [3000u64, 8000, 15000] {
                        std::thread::sleep(std::time::Duration::from_millis(wait));
                        if register_hotkeys(&h2).is_empty() {
                            eprintln!("热键延迟重试成功");
                            break;
                        }
                    }
                });
            }
            // 首次启动引导（§4.1；onboarding_done=false 时出现一次）
            {
                let h2 = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    if !once_core::settings::load().onboarding_done {
                        let _ = open_onboarding(h2);
                    }
                });
            }
            // 主窗口关闭 → 隐藏到托盘（D-2 默认）
            if let Some(win) = app.get_webview_window("main") {
                let h = handle.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let close_quits = !once_core::settings::load().close_to_tray;
                        if !close_quits {
                            api.prevent_close();
                            if let Some(w) = h.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .on_page_load(|_win, _payload| {})
        .run(tauri::generate_context!())
        .expect("定影启动失败");
}

/// 热键改键（SYS-2/3）：更新设置并整体重注册，返回冲突列表。
#[tauri::command]
fn set_hotkey(app: AppHandle, name: String, combo: String) -> Result<serde_json::Value, String> {
    const VALID: &[&str] = &["region", "window", "fullscreen", "ocr", "scroll", "panel"];
    if !VALID.contains(&name.as_str()) {
        return Err(format!("未知热键功能：{name}"));
    }
    // 组合格式校验：必须含一个主键（字母/数字/F1-F12）
    let has_main = combo
        .split('+')
        .last()
        .map(|k| {
            let k = k.trim();
            k.len() == 1 || (k.starts_with('F') && k[1..].chars().all(|c| c.is_ascii_digit()))
        })
        .unwrap_or(false);
    if !has_main {
        return Err(format!("组合键无效：{combo}（需包含字母、数字或 F1-F12）"));
    }
    settings::update(|s| match name.as_str() {
        "region" => s.hotkeys.region = combo.clone(),
        "window" => s.hotkeys.window = combo.clone(),
        "fullscreen" => s.hotkeys.fullscreen = combo.clone(),
        "ocr" => s.hotkeys.ocr = combo.clone(),
        "scroll" => s.hotkeys.scroll = combo.clone(),
        "panel" => s.hotkeys.panel = combo.clone(),
        _ => {}
    })
    .map_err(|e| e.to_string())?;
    let failures = register_hotkeys(&app);
    let s = settings::load();
    Ok(serde_json::json!({
        "ok": true,
        "hotkeys": s.hotkeys,
        "conflicts": failures.iter().map(|(n, k)| serde_json::json!({ "name": n, "combo": k })).collect::<Vec<_>>(),
    }))
}

/// 全部恢复默认热键并重注册。
#[tauri::command]
fn reset_hotkeys(app: AppHandle) -> Result<serde_json::Value, String> {
    settings::update(|s| s.hotkeys = once_core::settings::Hotkeys::default()).map_err(|e| e.to_string())?;
    let failures = register_hotkeys(&app);
    let s = settings::load();
    Ok(serde_json::json!({
        "ok": true,
        "hotkeys": s.hotkeys,
        "conflicts": failures.iter().map(|(n, k)| serde_json::json!({ "name": n, "combo": k })).collect::<Vec<_>>(),
    }))
}

/// 热键冲突列表（诊断页/设置页用）。
#[tauri::command]
fn hotkey_conflicts(app: AppHandle) -> serde_json::Value {
    let failures = register_hotkeys(&app);
    serde_json::json!({
        "conflicts": failures.iter().map(|(n, k)| serde_json::json!({ "name": n, "combo": k })).collect::<Vec<_>>(),
    })
}

/// 详情页数据（说明书 §4.6）：manifest + OCR 块 + 版本时间线（原图置顶 + 衍生图）。
#[tauri::command]
fn detail_data(path: String) -> Result<serde_json::Value, String> {
    let p = std::path::PathBuf::from(&path);
    let manifest: serde_json::Value = std::fs::read(p.with_extension("json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(serde_json::Value::Null);
    // OCR 块（<stem>.ocr.json）
    let stem = p.with_extension("");
    let ocr_json = stem.with_file_name(format!(
        "{}.ocr.json",
        stem.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    let ocr: serde_json::Value = std::fs::read(&ocr_json)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(serde_json::Value::Null);
    // 历史 row（拿 id）
    let row = history::get_by_id_or_path(&path);
    let derivatives = row
        .as_ref()
        .map(|r| history::derivatives_of(&r.id).unwrap_or_default())
        .unwrap_or_default();
    Ok(serde_json::json!({
        "manifest": manifest,
        "ocr": ocr,
        "id": row.as_ref().map(|r| r.id.clone()),
        "derivatives": derivatives,
    }))
}

/// 详情页复制图片：读文件 → 剪贴板（PNG+DIB+路径）。
#[tauri::command]
fn copy_image_bytes(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    let bytes = std::fs::read(&p).map_err(|e| format!("读取失败：{e}"))?;
    let (w, h, rgba) = once_core::capture::decode_png(&bytes).map_err(|e| e.to_string())?;
    let clip = clipboard::ClipboardPayload {
        png: Some(&bytes),
        rgba: Some((&rgba, w, h)),
        files: vec![p],
        text: None,
    };
    clipboard::write(&clip).map_err(|e| e.to_string())
}

/// 开机自启（SYS-4）：任务计划程序方式（说明书 §3-20）。
const TASK_NAME: &str = "OnceglanceAutostart";

#[tauri::command]
fn autostart_status() -> bool {
    std::process::Command::new("schtasks")
        .args(["/Query", "/TN", TASK_NAME])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
fn autostart_set(enable: bool) -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if enable {
        let out = std::process::Command::new("schtasks")
            .args([
                "/Create", "/TN", TASK_NAME,
                "/TR", &format!("\"{}\"", exe.display()),
                "/SC", "ONLOGON", "/RL", "LIMITED", "/F",
            ])
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("创建任务失败：{}", String::from_utf8_lossy(&out.stderr)));
        }
    } else {
        let _ = std::process::Command::new("schtasks")
            .args(["/Delete", "/TN", TASK_NAME, "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    Ok(autostart_status())
}

/// 打开首次启动引导（§4.1：自检 + 试一次 + 接 Agent，可跳过）。
#[tauri::command]
fn open_onboarding(app: AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(old) = app.get_webview_window("onboarding") {
        let _ = old.destroy();
    }
    let win = WebviewWindowBuilder::new(&app, "onboarding", WebviewUrl::App("onboarding.html".into()))
        .title("欢迎使用定影")
        .decorations(false)
        .resizable(false)
        .inner_size(640.0, 460.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(())
}
