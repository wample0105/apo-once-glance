//! 全屏截图拍摄反馈（2026-09-26 用户方案：闪光+缩略图，macOS 标杆组合）。
//! ①快门闪光：捕获屏白色一闪 ~200ms 淡出——原生 layered 窗，点击穿透、不抢焦点、即闪即毁；
//! ②缩略图卡：捕获屏右下角浮出（图+尺寸+已复制），5s 自动销毁，点击进标注编辑器。
//! 成功路径的角落 toast 对 fullscreen 已抑制（deliver.rs），错误仍走 toast_error。

use once_core::capture::MonitorInfo;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

unsafe extern "system" fn flash_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wp: windows::Win32::Foundation::WPARAM,
    lp: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(hwnd, msg, wp, lp)
}

/// 快门闪光：白色全屏 layered 窗 alpha 88→0 分 8 步 ~200ms 淡出后跨线程自毁。
/// WS_EX_TRANSPARENT=点击穿透；NOACTIVATE+TOOLWINDOW=不抢焦点不进任务栏；短命窗口无需成对恢复样式。
pub fn flash_monitor(m: &MonitorInfo) {
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, WPARAM};
    use windows::Win32::Graphics::Gdi::CreateSolidBrush;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, PostMessageW, RegisterClassW, SetLayeredWindowAttributes, ShowWindow,
        CS_HREDRAW, CS_VREDRAW, LWA_ALPHA, SW_SHOWNOACTIVATE, WM_CLOSE, WNDCLASSW,
        WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
        WS_POPUP,
    };
    use windows::core::w;
    unsafe {
        static REGISTERED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        REGISTERED.get_or_init(|| {
            let wc = WNDCLASSW {
                lpfnWndProc: Some(flash_proc),
                hInstance: GetModuleHandleW(None).unwrap().into(),
                lpszClassName: w!("ONCE_FLASH_WND"),
                hbrBackground: CreateSolidBrush(COLORREF(0x00FF_FFFF)), // 白（COLORREF=BBGGRR）
                style: CS_HREDRAW | CS_VREDRAW,
                ..Default::default()
            };
            RegisterClassW(&wc);
        });
        let (x, y, w, h) = m.rect;
        let ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        if let Ok(hwnd) = CreateWindowExW(
            ex, w!("ONCE_FLASH_WND"), w!(""), WS_POPUP, x, y, w, h,
            None, None, Some(windows::Win32::Foundation::HINSTANCE(GetModuleHandleW(None).unwrap().0)), None,
        ) {
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 88, LWA_ALPHA);
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let hraw = hwnd.0 as isize;
            std::thread::spawn(move || unsafe {
                for a in [76u8, 64, 52, 40, 28, 18, 8, 0] {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                    let _ = SetLayeredWindowAttributes(HWND(hraw as *mut _), COLORREF(0), a, LWA_ALPHA);
                }
                let _ = PostMessageW(Some(HWND(hraw as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
            });
        }
    }
}

/// 全屏内容收缩动画（S1，Loom 式收敛，400ms ease-out，用户拍板）：
/// 以捕获画面为内容创建捕获屏全屏窗，逐帧 StretchDIBits 缩放绘制、窗口矩形
/// 从捕获屏全屏插值收缩到缩略图卡落点；点击穿透/不抢焦点/即闪即毁。
/// 动画落定后弹出缩略图卡（5s 计时从落定起算）。
pub fn shrink_and_peek(
    app: &AppHandle,
    m: &MonitorInfo,
    bmp: &once_core::capture::CapturedBitmap,
    outcome: &crate::deliver::DeliverOutcome,
) {
    let app2 = app.clone();
    let dpi = m.dpi_scale;
    let rect = m.rect;
    let (sw, sh) = (bmp.width, bmp.height);
    // 末态 = 缩略图卡物理矩形（与 show_capture_peek 同式，动画必须精确落进卡位）
    let w_phys = (240.0 * dpi) as i32;
    let h_phys = (168.0 * dpi) as i32;
    let (rx, ry, rw, rh) = rect;
    let end = (
        rx + rw - w_phys - 16,
        ry + rh - h_phys - 12,
        w_phys,
        h_phys,
    );
    // 像素预转 BGRA top-down（DIB 语义；RGBA 内存换 R/B，~16MB 逐像素 swap 数毫秒）
    let mut pixels = bmp.pixels.clone();
    for px in pixels.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let mi = m.clone();
    let oc = outcome.clone();
    // 缩略图编码与动画并行：直接从内存 RGBA 出图（免读盘解码），动画期间必然就绪
    let (tx, thumb_rx) = std::sync::mpsc::channel::<Option<String>>();
    {
        let src = bmp.pixels.clone();
        let (tw, th) = (bmp.width, bmp.height);
        std::thread::spawn(move || {
            let _ = tx.send(encode_thumbnail_rgba(&src, tw, th));
        });
    }
    std::thread::spawn(move || unsafe {
        use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, WPARAM};
        use windows::Win32::Graphics::Gdi::{
            CreateSolidBrush, GetDC, ReleaseDC, StretchDIBits, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
        };
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, PostMessageW, RegisterClassW, SetWindowPos, ShowWindow, CS_HREDRAW,
            CS_VREDRAW, SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE,
            WM_CLOSE, WNDCLASSW, HWND_TOPMOST, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
            WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
        };
        use windows::core::w;

        unsafe extern "system" fn shrink_proc(
            hwnd: HWND,
            msg: u32,
            wp: WPARAM,
            lp: LPARAM,
        ) -> windows::Win32::Foundation::LRESULT {
            windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(hwnd, msg, wp, lp)
        }

        // BITMAPINFO：32bpp BI_RGB、负高=top-down（与 RGBA 行序一致）
        let mut bmi = windows::Win32::Graphics::Gdi::BITMAPINFO::default();
        bmi.bmiHeader.biSize = std::mem::size_of::<windows::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = sw as i32;
        bmi.bmiHeader.biHeight = -(sh as i32);
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;

        static REGISTERED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        REGISTERED.get_or_init(|| {
            let wc = WNDCLASSW {
                lpfnWndProc: Some(shrink_proc),
                hInstance: GetModuleHandleW(None).unwrap().into(),
                lpszClassName: w!("ONCE_SHRINK_WND"),
                hbrBackground: CreateSolidBrush(COLORREF(0x00FF_FFFF)),
                style: CS_HREDRAW | CS_VREDRAW,
                ..Default::default()
            };
            RegisterClassW(&wc);
        });
        let ex =
            WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW; // 无 LAYERED：内容不透明直绘
        let hwnd = CreateWindowExW(
            ex, w!("ONCE_SHRINK_WND"), w!(""), WS_POPUP, rx, ry, rw as i32, rh as i32,
            None, None, Some(windows::Win32::Foundation::HINSTANCE(GetModuleHandleW(None).unwrap().0)), None,
        );
        let Ok(hwnd) = hwnd else { return };
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

        // 帧循环：20 帧 × 20ms ≈ 400ms，ease-out cubic（先快后慢）
        let steps = 20u32;
        for i in 1..=steps {
            let t = i as f32 / steps as f32;
            let te = 1.0 - (1.0 - t).powi(3);
            let cx = rx as f32 + (end.0 - rx) as f32 * te;
            let cy = ry as f32 + (end.1 - ry) as f32 * te;
            let cw = rw as f32 + (end.2 as f32 - rw as f32) * te;
            let ch = rh as f32 + (end.3 as f32 - rh as f32) * te;
            let (cw, ch) = (cw.max(1.0) as i32, ch.max(1.0) as i32);
            let _ = SetWindowPos(
                hwnd, Some(HWND_TOPMOST), cx as i32, cy as i32, cw, ch,
                SWP_NOACTIVATE | SWP_NOCOPYBITS,
            );
            let hdc = GetDC(Some(hwnd));
            let _ = StretchDIBits(
                hdc, 0, 0, cw, ch, 0, 0, sw as i32, sh as i32,
                Some(pixels.as_ptr().cast()), &bmi, DIB_RGB_COLORS, SRCCOPY,
            );
            ReleaseDC(Some(hwnd), hdc);
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // 收缩落定：等缩略图编码（与动画并行，通常已就绪）——先弹卡、后销毁动画窗，
        // 动画末帧驻留卡位直到交接完成（零空档）
        let data_url = thumb_rx.recv().unwrap_or(None);
        let hwnd_raw = hwnd.0 as isize;
        show_peek_handoff(&app2, &mi, &oc, data_url, move || unsafe {
            let _ = PostMessageW(
                Some(HWND(hwnd_raw as *mut _)),
                WM_CLOSE,
                WPARAM(0),
                LPARAM(0),
            );
        });
    });
}

/// 缩略图编码：内存 RGBA 直出 320 宽 PNG base64（免读盘解码，与动画并行通常先于动画完成）。
fn encode_thumbnail_rgba(rgba: &[u8], w: u32, h: u32) -> Option<String> {
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec())?;
    let t = if w > 320 {
        let nh = (h as f64 * 320.0 / w as f64).round() as u32;
        image::DynamicImage::ImageRgba8(img).resize_exact(320, nh, image::imageops::FilterType::Triangle)
    } else {
        image::DynamicImage::ImageRgba8(img)
    };
    let mut cur = std::io::Cursor::new(Vec::new());
    t.write_to(&mut cur, image::ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", crate::base64_encode(&cur.into_inner())))
}

/// 缩略图编码（文件版，show_capture_peek 兜底路径用）。
fn encode_thumbnail(path: &str) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let img = image::load_from_memory(&bytes).ok()?;
    let (iw, ih) = (img.width(), img.height());
    let t = if iw > 320 {
        let nh = (ih as f64 * 320.0 / iw as f64).round() as u32;
        img.resize_exact(320, nh, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut cur = std::io::Cursor::new(Vec::new());
    t.write_to(&mut cur, image::ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", crate::base64_encode(&cur.into_inner())))
}

/// 缩略图卡：读已落盘全屏图 → 缩到 320 宽 PNG base64（eval 注入，pin 同款）→
/// 捕获屏右下角浮出，5s 自动销毁；卡片点击 → annotate_open_file 进标注编辑器。
/// 尺寸按捕获屏 DPI 换算（CSS 240×168 设计，endbar 同策：物理值=CSS×dpi）。
pub fn show_capture_peek(app: &AppHandle, m: &MonitorInfo, outcome: &crate::deliver::DeliverOutcome) {
    let app2 = app.clone();
    let path = outcome.path.clone();
    let (w, h) = (outcome.width, outcome.height);
    let dpi = m.dpi_scale;
    let rect = m.rect;
    std::thread::spawn(move || {
        let Some(data_url) = encode_thumbnail(&path) else { return }; // 图读不到：反馈静默降级（剪贴板已是结果）

        let w_phys = (240.0 * dpi) as i32;
        let h_phys = (168.0 * dpi) as i32;
        let (rx, ry, rw, rh) = rect;
        let x = rx + rw - w_phys - 16;
        let y = ry + rh - h_phys - 12;

        if let Some(old) = app2.get_webview_window("peek") {
            let _ = old.destroy();
        }
        let win = WebviewWindowBuilder::new(
            &app2,
            "peek",
            WebviewUrl::App("peek.html".into()),
        )
        .title("定影截图")
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
        let _ = win.set_size(PhysicalSize::new(w_phys as u32, h_phys as u32));
        let payload = serde_json::json!({ "img": data_url, "w": w, "h": h, "path": path });
        let _ = win.eval(&format!("window.__PEEK__={};", payload));
        let _ = win.show();
        let app3 = app2.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            if let Some(t) = app3.get_webview_window("peek") {
                let _ = t.destroy();
            }
        });
    });
}

/// 缩略图卡数据（peek.html 主动 invoke 拉取——eval 注入与页面加载存在竞态，
/// 注入丢失时卡片看得见点不动；静态载荷模式是 annotate_file_payload 的既有范式）
#[derive(Clone, serde::Serialize)]
pub struct PeekData {
    img: String,
    w: u32,
    h: u32,
    path: String,
}

/// 会话代次：每次显示 +1；到期驻留线程只在代次未变时收窗（新截图取消旧到期）
static PEEK_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// peek 页面就绪握手（页面 script 末尾回执；eval 直灌前等待，防未加载完成注入丢失）
static PEEK_PAGE_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// peek.html 加载完成回执。
#[tauri::command]
pub fn peek_page_ready() {
    PEEK_PAGE_READY.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// 卡片点击后主动退场（预驻留窗不销毁，回屏外待命）。
#[tauri::command]
pub fn peek_dismiss(app: AppHandle) {
    if let Some(w) = app.get_webview_window("peek") {
        let _ = w.set_position(PhysicalPosition::new(-30000, -30000));
    }
}

/// 启动预驻留（与取景层同策）：建好 peek 网页窗停屏外，截图时只移位显示——
/// 消灭「动画末帧驻留期点击穿透」的幻影期（用户实测：假卡片期点击无反应）。
pub fn prewarm(app: &AppHandle) {
    if app.get_webview_window("peek").is_some() {
        return;
    }
    let win = WebviewWindowBuilder::new(
        app,
        "peek",
        WebviewUrl::App("peek.html".into()),
    )
    .title("定影截图")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .additional_browser_args(crate::DEBUG_BROWSER_ARGS)
    .build();
    if let Ok(win) = win {
        // 屏外可见驻留（hide 会触发 WebView2 渲染挂起——取景层同款坑）
        let _ = win.set_position(PhysicalPosition::new(-30000, -30000));
        let _ = win.show();
    }
}

/// 无缝版：动画线程调用——先等编码（与动画并行）、显示预驻留卡，再回调销毁动画窗（不留空档）。
fn show_peek_handoff(
    app: &AppHandle,
    m: &MonitorInfo,
    outcome: &crate::deliver::DeliverOutcome,
    data_url: Option<String>,
    on_shown: impl FnOnce() + Send + 'static,
) {
    let Some(data_url) = data_url else { on_shown(); return }; // 编码失败：直接收动画窗，反馈降级
    let app2 = app.clone();
    let path = outcome.path.clone();
    let (w, h) = (outcome.width, outcome.height);
    let dpi = m.dpi_scale;
    let rect = m.rect;
    std::thread::spawn(move || {
        let w_phys = (240.0 * dpi) as i32;
        let h_phys = (168.0 * dpi) as i32;
        let (rx, ry, rw, rh) = rect;
        let x = rx + rw - w_phys - 16;
        let y = ry + rh - h_phys - 12;

        // 预驻留窗优先；不在（prewarm 失败等）则按需建窗兜底
        let win = match app2.get_webview_window("peek") {
            Some(w) => Some(w),
            None => build_peek_window(&app2).ok(),
        };
        let Some(win) = win else { on_shown(); return };

        // 页面就绪握手（防首次截图早于页面加载完成）；就绪后 eval 直灌载荷——
        // 屏外待命窗的 JS 定时器会被 Chromium 遮挡节流（轮询近乎停摆曾致整卡死壳），
        // eval 是直接脚本执行不走定时器，长驻页面无竞态
        let mut ready = PEEK_PAGE_READY.load(std::sync::atomic::Ordering::SeqCst);
        let mut waited = 0u32;
        while !ready && waited < 3000 {
            std::thread::sleep(std::time::Duration::from_millis(30));
            waited += 30;
            ready = PEEK_PAGE_READY.load(std::sync::atomic::Ordering::SeqCst);
        }
        let payload = serde_json::json!({ "img": data_url, "w": w, "h": h, "path": path });
        let script = format!("window.__peekApply({});", payload);
        let mut applied = win.eval(&script).is_ok();
        if !applied {
            for _ in 0..10 {
                std::thread::sleep(std::time::Duration::from_millis(50));
                if win.eval(&script).is_ok() {
                    applied = true;
                    break;
                }
            }
        }
        if applied {
            std::thread::sleep(std::time::Duration::from_millis(60)); // 让页面应用载荷
        }
        let _ = win.set_position(PhysicalPosition::new(x, y));
        let _ = win.set_size(PhysicalSize::new(w_phys as u32, h_phys as u32));
        let _ = win.show();
        on_shown(); // 卡已可见：此刻才销毁动画窗（末帧驻留到交接完成，零空档）

        // 到期驻留：代次守卫（新截图使旧到期失效），屏外驻留不销毁（渲染挂起坑）
        let gen = PEEK_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let app3 = app2.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            if PEEK_GEN.load(std::sync::atomic::Ordering::SeqCst) == gen + 1 {
                if let Some(t) = app3.get_webview_window("peek") {
                    let _ = t.set_position(PhysicalPosition::new(-30000, -30000));
                }
            }
        });
    });
}

/// 按需建窗兜底（prewarm 常驻失败时）。位置尺寸由调用方设置。
fn build_peek_window(app: &AppHandle) -> std::result::Result<tauri::WebviewWindow, tauri::Error> {
    WebviewWindowBuilder::new(
        app, "peek", WebviewUrl::App("peek.html".into()),
    )
    .title("定影截图")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .additional_browser_args(crate::DEBUG_BROWSER_ARGS)
    .build()
}
