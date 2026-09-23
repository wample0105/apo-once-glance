//! 长截图 GUI 会话管理（说明书 §4.4：框选即开始、滚到哪截到哪、永不自动完成）。
//! 会话在 Rust 侧持有拼接画布；覆盖层每个滚轮事件触发一次区域 BitBlt + push_frame。

use crate::CapturedBitmap;
use once_core::longshot::ScrollSession;
use once_core::{capture, clipboard, history, settings, storage};
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use tauri::{AppHandle, Manager};

struct ScrollState {
    session: ScrollSession,
    abs_x: i32,
    abs_y: i32,
    #[allow(dead_code)]
    created: std::time::Instant,
}

static SCROLLS: std::sync::OnceLock<StdMutex<HashMap<u64, ScrollState>>> = std::sync::OnceLock::new();
static SCROLL_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static ACTIVE_SESSION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static REVIEW: std::sync::Mutex<Option<(u64, Vec<usize>)>> = std::sync::Mutex::new(None);

fn scrolls() -> std::sync::MutexGuard<'static, HashMap<u64, ScrollState>> {
    SCROLLS.get_or_init(|| StdMutex::new(HashMap::new())).lock().unwrap()
}

/// OnceError → String（命令层统一字符串错误）。
fn oe(e: once_core::OnceError) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn scroll_start(
    app: AppHandle,
    screen: usize,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<serde_json::Value, String> {
    let monitor = capture::monitors()
        .into_iter()
        .find(|m| m.index == screen)
        .ok_or("显示器不存在".to_string())?;
    let abs_x = monitor.rect.0 + x;
    let abs_y = monitor.rect.1 + y;
    let session = ScrollSession::new(w, h).map_err(oe)?;
    let id = SCROLL_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    scrolls().insert(id, ScrollState { session, abs_x, abs_y, created: std::time::Instant::now() });
    ACTIVE_SESSION.store(id, std::sync::atomic::Ordering::SeqCst);

    // 覆盖层鼠标穿透：滚轮必须落到下层应用，采集由轮询完成
    set_overlay_passthrough(&app, true);
    // 键盘钩子：Enter=完成 / Esc=取消（不依赖焦点）
    install_scroll_keyboard_hook(&app);

    // 结束条：独立不穿透小窗口，贴选区下沿外 8px（空间不足翻上方）
    create_endbar_window(&app, monitor.rect.0 + x, monitor.rect.1 + y, w, h, id)?;

    // 第 1 段：松手那一帧就是第 1 段（不需要"开始"动作）
    let status = scroll_grab_inner(id)?;

    // 轮询采样线程：120ms 一轮；每轮抓两帧（间隔 80ms）逐字节比对，
    // 只在画面静止时拼接——滚动动画中的过渡帧直接丢弃（消除重影接缝）。
    // 会话被移除/进入质检后自动退出。
    let app2 = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(70));
        if !scrolls().contains_key(&id) {
            break;
        }
        if REVIEW.lock().unwrap().as_ref().map(|r| r.0 == id).unwrap_or(false) {
            break;
        }
        match scroll_grab_stable(id) {
            Ok(v) => {
                if std::env::var("ONCE_DEBUG").is_ok() {
                    eprintln!("[scroll-worker] {}", v);
                }
                use tauri::Emitter;
                let _ = app2.emit("scroll-progress", v);
            }
            Err(e) => {
                eprintln!("[scroll-worker] grab error: {e}");
                break;
            }
        }
    });
    Ok(serde_json::json!({ "session": id, "status": status }))
}

/// 创建结束条窗口（不穿透、可点击、置顶）。
fn create_endbar_window(
    app: &AppHandle,
    abs_x: i32,
    abs_y: i32,
    w: u32,
    h: u32,
    session: u64,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(old) = app.get_webview_window("endbar") {
        let _ = old.destroy();
    }
    let mons = capture::monitors();
    let mon = mons
        .iter()
        .find(|m| abs_x >= m.rect.0 && abs_x < m.rect.0 + m.rect.2 && abs_y >= m.rect.1 && abs_y < m.rect.1 + m.rect.3)
        .or_else(|| mons.first())
        .ok_or("显示器不存在".to_string())?;
    // 业界同款紧凑单条（尺寸+四按钮）—— 物理像素按 DPI 缩放
    let k = mon.dpi_scale as f32;
    let bar_w = (252.0 * k).round() as i32;
    let bar_h = (44.0 * k).round() as i32;
    // 贴选区下沿外 8px；下方空间不足翻到上方（说明书 §4.4 结束条行为）
    let sel_bottom = abs_y + h as i32;
    let bx = abs_x.min(mon.rect.0 + mon.rect.2 - bar_w - 8).max(mon.rect.0 + 8);
    let below = mon.rect.1 + mon.rect.3 - sel_bottom;
    let by = if below >= bar_h + 20 {
        sel_bottom + 8
    } else {
        (abs_y - bar_h - 8).max(mon.rect.1 + 8)
    };
    let win = WebviewWindowBuilder::new(
        app,
        "endbar",
        WebviewUrl::App(format!("endbar.html?session={session}").into()),
    )
        .title("长截图")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .visible(false)
        .additional_browser_args(crate::DEBUG_BROWSER_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_position(tauri::PhysicalPosition::new(bx, by));
    let _ = win.set_size(tauri::PhysicalSize::new(bar_w as u32, bar_h as u32));
    let _ = win.eval(&format!("window.__SESSION={{id:{session}}};"));
    let _ = win.show();
    // visible(false)→show 的 WebView2 窗口渲染会挂起（预驻留同款坑）：kick 一帧强制合成，
    // 否则结束条不可见——用户看到的正是"框选完就没了"（会话在跑但无任何 UI 反馈）
    if let Ok(hwnd) = win.hwnd() {
        use windows::Win32::Graphics::Gdi::{InvalidateRect, RDW_INVALIDATE};
        unsafe {
            let _ = InvalidateRect(Some(hwnd.into()), None, true);
            let _ = windows::Win32::Graphics::Gdi::RedrawWindow(
                hwnd.into(), None, None,
                RDW_INVALIDATE | windows::Win32::Graphics::Gdi::RDW_UPDATENOW | windows::Win32::Graphics::Gdi::RDW_ALLCHILDREN,
            );
        }
    }
    Ok(())
}

/// 长截图出口必须恢复 overlay 可点击：scroll_start 设置的 WS_EX_LAYERED|WS_EX_TRANSPARENT
/// 不恢复的话，强加的 LAYERED 未设 alpha=窗口永久全透明，且下次截图蒙版收不到鼠标。
fn restore_overlay_passthrough(app: &AppHandle) {
    set_overlay_passthrough(app, false);
}

fn destroy_endbar_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("endbar") {
        let _ = win.destroy();
    }
}

/// 覆盖层鼠标穿透（WS_EX_TRANSPARENT | WS_EX_LAYERED）。
pub(crate) fn set_overlay_passthrough(app: &AppHandle, on: bool) {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE};
    let Some(win) = app.get_webview_window("overlay") else { eprintln!("[pt] on={on} no overlay win"); return };
    let Ok(hwnd) = win.hwnd() else { eprintln!("[pt] on={on} no hwnd"); return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        const WS_EX_LAYERED: u32 = 0x0008_0000;
        const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
        let new_ex = if on {
            ex | WS_EX_LAYERED | WS_EX_TRANSPARENT
        } else {
            ex & !(WS_EX_LAYERED | WS_EX_TRANSPARENT)
        };
        let ret = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex as isize);
        let after = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        eprintln!("[pt] on={on} ex 0x{ex:08X}->0x{new_ex:08X} ret=0x{ret:08X} after=0x{after:08X} applied={}", after == new_ex);
    }
}

/// 长截图采集期的选区边框条（4 条原生细窗）：webview overlay 已 park、
/// 中央无任何窗口 → 滚轮 hover 路由直达下层应用（webview 的子窗口无法穿透，
/// 是此前滚轮被吞的根治点）。窗口仅做视觉指示，不接收输入。
pub(crate) static LS_FRAMES: std::sync::Mutex<[isize; 4]> = std::sync::Mutex::new([0; 4]);

unsafe extern "system" fn ls_frame_proc(hwnd: windows::Win32::Foundation::HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(hwnd, msg, wp, lp)
}

pub(crate) fn show_ls_frame(x: i32, y: i32, w: u32, h: u32) {
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::Graphics::Gdi::CreateSolidBrush;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, RegisterClassW, SetLayeredWindowAttributes, ShowWindow,
        CS_HREDRAW, CS_VREDRAW, LWA_ALPHA, SW_SHOWNOACTIVATE, WNDCLASSW, WS_EX_LAYERED,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };
    use windows::core::w;
    unsafe {
        static REGISTERED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        REGISTERED.get_or_init(|| {
            let wc = WNDCLASSW {
                lpfnWndProc: Some(ls_frame_proc),
                hInstance: GetModuleHandleW(None).unwrap().into(),
                lpszClassName: w!("ONCE_LS_FRAME"),
                hbrBackground: CreateSolidBrush(COLORREF(0x0030_3BFF)), // accent #FF3B30（COLORREF=BBGGRR）
                style: CS_HREDRAW | CS_VREDRAW,
                ..Default::default()
            };
            RegisterClassW(&wc);
        });
        let ex = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        let style = WS_POPUP;
        let t = 3i32; let g = 5i32; // 条厚 3px、外扩 5px（框线在采集矩形外沿，拼接段零污染）
        let wi = w as i32; let hi = h as i32;
        let frames: [(i32, i32, i32, i32); 4] = [
            (x - g, y - g, wi + 2 * g, t),                       // 上
            (x - g, y + hi + g - t, wi + 2 * g, t),              // 下
            (x - g, y - g, t, hi + 2 * g),                       // 左
            (x + wi + g - t, y - g, t, hi + 2 * g),              // 右
        ];
        let mut hs = [0isize; 4];
        for (i, (rx, ry, rw, rh)) in frames.iter().enumerate() {
            if let Ok(hwnd) = CreateWindowExW(
                ex, w!("ONCE_LS_FRAME"), w!(""), style, *rx, *ry, *rw, *rh,
                None, None, Some(windows::Win32::Foundation::HINSTANCE(GetModuleHandleW(None).unwrap().0)), None,
            ) {
                let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 230, LWA_ALPHA);
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                hs[i] = hwnd.0 as isize;
            }
        }
        *LS_FRAMES.lock().unwrap() = hs;
        eprintln!("[ls-frame] shown at ({x},{y}) {w}x{h}");
    }
}

/// 销毁选区边框条（PostMessage WM_CLOSE：跨线程安全，由窗口自身线程销毁）
pub(crate) fn hide_ls_frame() {
    let hs = { *LS_FRAMES.lock().unwrap() };
    let mut n = 0;
    unsafe {
        for h in hs {
            if h != 0 {
                let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(
                    Some(windows::Win32::Foundation::HWND(h as *mut _)),
                    windows::Win32::UI::WindowsAndMessaging::WM_CLOSE,
                    WPARAM(0), LPARAM(0),
                );
                n += 1;
            }
        }
    }
    if n > 0 { eprintln!("[ls-frame] hidden x{n}"); }
}

/// 把键盘焦点/前台让还给下层应用（长截图采集模式专用）。
/// WM_MOUSEWHEEL 发给焦点窗口而非鼠标下窗口——overlay 持焦时用户滚动会被 overlay
/// 吃掉（EXSTYLE 穿透只影响 hit-test，不影响滚轮路由），必须让焦。
/// 跨线程 SetFocus 需 AttachThreadInput 桥接（经典解法）。
/// 截图激活前的前台窗口（= 用户正在操作的应用）：show_overlay 激活时记录，
/// 长截图采集模式让焦时切回。存 isize 规避 HWND 的跨线程约束。
pub(crate) static PREV_FOREGROUND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// 把键盘焦点/前台让还给下层应用（长截图采集模式专用）。
/// WM_MOUSEWHEEL 发给焦点窗口而非鼠标下窗口——overlay 持焦时用户滚动会被 overlay
/// 吃掉（EXSTYLE 穿透只影响 hit-test，不影响滚轮路由），必须让焦。
/// 注意不能用 GW_HWNDNEXT 找目标：从 TOPMOST 的 overlay 出发只在置顶窗口链内遍历，
/// 永远到不了普通应用窗口（实测 "no target below"）——必须用激活前记录的前台窗口。
pub(crate) fn yield_focus_to_below() {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow,
        SwitchToThisWindow,
    };
    unsafe {
        let raw = PREV_FOREGROUND.load(std::sync::atomic::Ordering::SeqCst);
        if raw == 0 {
            eprintln!("[yield] no prev foreground recorded");
            return;
        }
        let target = HWND(raw as *mut _);
        if !IsWindow(Some(target)).as_bool() || !IsWindowVisible(target).as_bool() || IsIconic(target).as_bool() {
            eprintln!("[yield] prev foreground no longer usable");
            return;
        }
        // 前台锁（foreground lock）会静默拒绝非前台进程的 SetForegroundWindow/SwitchToThisWindow
        //（实测切了等于没切）——经典 Alt hack：按下 Alt 的瞬间本进程获得设置前台的权利
        const VK_MENU: u8 = 0x12;
        keybd_event(VK_MENU, 0, KEYBD_EVENT_FLAGS(0), 0);
        let ok = SetForegroundWindow(target).as_bool();
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
        if !ok {
            SwitchToThisWindow(target, true);
        }
        let now = GetForegroundWindow();
        eprintln!(
            "[yield] focus {:#x} -> {:#x} ok={} now={:#x}",
            raw, target.0 as usize, ok, now.0 as usize
        );
    }
}

#[tauri::command]
pub async fn scroll_grab(_app: AppHandle, session: u64) -> Result<serde_json::Value, String> {
    scroll_grab_inner(session).map_err(|e| e.to_string())
}

/// 抓帧 + 稳定检测：两帧（间隔 80ms）完全一致才 push，动画过渡帧丢弃。
fn scroll_grab_stable(id: u64) -> Result<serde_json::Value, String> {
    if std::env::var("ONCE_DEBUG").is_err() {
        // 正常路径保持安静
    }
    let (abs_x, abs_y, w, h) = {
        let mut map = scrolls();
        let st = map.get_mut(&id).ok_or("会话不存在（可能已结束）")?;
        (st.abs_x, st.abs_y, st.session.width, st.session.height)
    };
    let first = capture::capture_region_px(abs_x, abs_y, w, h).map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(60));
    let second = capture::capture_region_px(abs_x, abs_y, w, h).map_err(|e| e.to_string())?;
    if first.pixels != second.pixels {
        // 画面仍在滚动/动画：丢弃，不拼接
        return Ok(serde_json::json!({ "session": id, "status": "moving" }));
    }
    scroll_push_frame(id, &first.pixels)
}

fn scroll_grab_inner(id: u64) -> Result<serde_json::Value, String> {
    let (abs_x, abs_y, w, h) = {
        let mut map = scrolls();
        let st = map.get_mut(&id).ok_or("会话不存在（可能已结束）")?;
        (st.abs_x, st.abs_y, st.session.width, st.session.height)
    };
    let bmp = capture::capture_region_px(abs_x, abs_y, w, h).map_err(|e| e.to_string())?;
    scroll_push_frame(id, &bmp.pixels)
}

fn scroll_push_frame(id: u64, pixels: &[u8]) -> Result<serde_json::Value, String> {
    let mut map = scrolls();
    let st = map.get_mut(&id).ok_or("会话不存在")?;
    let r = st.session.push_frame(pixels).map_err(|e| e.to_string())?;
    let status = match r {
        once_core::longshot::PushResult::Appended { .. } => "appended",
        once_core::longshot::PushResult::Duplicate => "duplicate",
        once_core::longshot::PushResult::RolledBack => "rolledback",
        once_core::longshot::PushResult::BottomReached => "bottom",
    };
    Ok(serde_json::json!({
        "session": id,
        "status": status,
        "width": st.session.width,
        "height": st.session.content_height(),
        "segments": st.session.seam_count() + 1,
        "failed_frames": st.session.failed_frame_count(),
        "fixed_top": st.session.fixed_top,
    }))
}

#[allow(dead_code)]
fn scroll_grab_inner_old(id: u64) -> Result<serde_json::Value, String> {
    let (abs_x, abs_y, w, h) = {
        let mut map = scrolls();
        let st = map.get_mut(&id).ok_or("会话不存在（可能已结束）")?;
        (st.abs_x, st.abs_y, st.session.width, st.session.height)
    };
    let bmp = capture::capture_region_px(abs_x, abs_y, w, h).map_err(|e| e.to_string())?;
    let mut map = scrolls();
    let st = map.get_mut(&id).ok_or("会话不存在")?;
    let r = st.session.push_frame(&bmp.pixels).map_err(oe)?;
    let status = match r {
        once_core::longshot::PushResult::Appended { .. } => "appended",
        once_core::longshot::PushResult::Duplicate => "duplicate",
        once_core::longshot::PushResult::RolledBack => "rolledback",
        once_core::longshot::PushResult::BottomReached => "bottom",
    };
    Ok(serde_json::json!({
        "session": id,
        "status": status,
        "height": st.session.content_height(),
        "segments": st.session.seam_count() + 1,
        "failed_frames": st.session.failed_frame_count(),
        "fixed_top": st.session.fixed_top,
    }))
}

#[tauri::command]
pub async fn scroll_finish(app: AppHandle, session: u64) -> Result<serde_json::Value, String> {
    // 同步对话框（rfd 阻塞式）不能跑在 async runtime 线程上：挪到阻塞线程池
    tauri::async_runtime::spawn_blocking(move || scroll_finish_sync(app, session))
        .await
        .map_err(|e| format!("任务失败：{e}"))?
}

fn scroll_finish_sync(app: AppHandle, session_in: u64) -> Result<serde_json::Value, String> {
    eprintln!("[scroll-finish] called session_in={session_in}");
    // session<=0（endbar 的 URL 参数在 Tauri App URL 中不可用）→ 用活跃会话兜底
    let session = if session_in == 0 {
        ACTIVE_SESSION.load(std::sync::atomic::Ordering::SeqCst)
    } else {
        session_in
    };
    eprintln!("[scroll-finish] resolved session={session}");
    ACTIVE_SESSION.store(0, std::sync::atomic::Ordering::SeqCst);
    let mut st = {
        let mut map = scrolls();
        map.remove(&session).ok_or("会话不存在（可能已结束）")?
    };
    // 用户裁定（2026-09-24）：可疑接缝自动采用最优位置（adjust_seam(_,0)），不再弹质检页——
    // 丝滑优先；正确性由静止帧双帧比对评分保底
    let idxs: Vec<usize> = st
        .session
        .seams()
        .iter()
        .enumerate()
        .filter(|(_, s)| s.confidence < once_core::longshot::CONFIDENCE_OK)
        .map(|(i, _)| i)
        .collect();
    let auto_fixed = idxs.len();
    for i in &idxs {
        let _ = st.session.adjust_seam(*i, 0);
    }
    if auto_fixed > 0 {
        eprintln!("[scroll-finish] auto-fixed seams={auto_fixed}");
    }
    eprintln!("[scroll-finish] saving...");
    let (w, h, rgba) = st.session.export();
    let bmp = capture::CapturedBitmap { width: w, height: h, pixels: rgba, origin: (0, 0) };
    let png = capture::encode_png(&bmp).map_err(|e| oe(e))?;
    // 用户裁定（2026-09-24）：保存=弹对话框选位置（与普通截图"保存"语义一致）
    let root = settings::load().save_root();
    let default_name = storage::new_asset_paths(&root, "scroll")
        .ok()
        .and_then(|p| p.png.file_name().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "onceglance-scroll.png".into());
    let app2 = app.clone();
    // rfd 同步 API：阻塞当前线程（钩子 spawn 线程/spawn_blocking 线程）直到对话框关闭；
    // 挂覆盖层为父窗口：对话框跟随 always_on_top 显示在最上层（曾沉在遮罩下用户看不见）
    let dest = {
        let mut dlg = rfd::FileDialog::new()
            .set_title("保存长截图")
            .set_file_name(&default_name)
            .add_filter("PNG 图片", &["png"]);
        if let Some(w) = app2.get_webview_window("overlay") {
            dlg = dlg.set_parent(&w);
        }
        dlg.save_file()
    };
    let Some(dest) = dest else {
        // 用户取消对话框：会话放回、结束条保留（可改选贴图/复制/再保存）
        scrolls().insert(session, st);
        ACTIVE_SESSION.store(session, std::sync::atomic::Ordering::SeqCst);
        use tauri::Emitter;
        if let Some(w) = app.get_webview_window("endbar") {
            let _ = w.emit("scroll-save-cancelled", ());
        }
        return Ok(serde_json::json!({ "saved": false }));
    };
    std::fs::write(&dest, &png).map_err(|e| format!("保存失败：{e}"))?;
    crate::deliver::toast(&app, "success", &format!("已保存到 {}", dest.display()));
    scroll_teardown(&app);
    Ok(serde_json::json!({ "needs_review": false, "saved": true, "path": dest.to_string_lossy(), "auto_fixed": auto_fixed }))
}

/// 保存长截图：kind=scroll，manifest 记录段数/人工修正次数（说明书 §4.4 阶段 3）。
fn save_scroll(app: &AppHandle, session: &mut ScrollSession) -> Result<serde_json::Value, String> {
    let (w, h, rgba) = session.export();
    let bmp = CapturedBitmap { width: w, height: h, pixels: rgba, origin: (0, 0) };
    let png = capture::encode_png(&bmp).map_err(|e| oe(e))?;
    let s = settings::load();
    let root = s.save_root();
    let mut manifest = storage::Manifest {
        id: String::new(),
        file: String::new(),
        kind: "scroll".into(),
        created_at: storage::now_iso(),
        width: w,
        height: h,
        screen: None,
        dpi_scale: capture::monitors().first().map(|m| m.dpi_scale).unwrap_or(1.0),
        screen_layout: Some(capture::screen_layout()),
        source_window: None,
        parent_id: None,
        script_sha256: None,
        ops_count: None,
        segments: Some(session.seam_count() as u32 + 1),
        manual_fixes: Some(session.manual_fix_count()),
    };
    let (id, paths) = storage::save_capture(&root, "scroll", &png, &mut manifest).map_err(oe)?;
    history::upsert_capture(&history::HistoryRow {
        id: id.clone(),
        path: paths.png.to_string_lossy().into_owned(),
        kind: "scroll".into(),
        created_at: storage::now_iso(),
        width: w,
        height: h,
        ocr_status: "none".into(),
        ocr_text: String::new(),
        ocr_preview: String::new(),
        annotated: false,
        parent_id: None,
    })
    .map_err(oe)?;
    let clip = clipboard::ClipboardPayload {
        png: Some(&png),
        rgba: Some((&bmp.pixels, w, h)),
        files: vec![paths.png.clone()],
        text: None,
    };
    let clip_ok = clipboard::write(&clip).is_ok();
    if clip_ok {
        crate::deliver::toast(
            app,
            "success",
            &format!("长截图已保存 · {} 段 · {}px", session.seam_count() + 1, h),
        );
    } else {
        crate::deliver::toast(app, "warn", "长截图已保存，剪贴板写入失败（退出码 4）");
    }
    Ok(serde_json::json!({
        "id": id,
        "path": paths.png.to_string_lossy(),
        "segments": session.seam_count() + 1,
        "height": h,
    }))
}

#[tauri::command]
pub async fn scroll_cancel(app: AppHandle, session: u64) -> Result<(), String> {
    scroll_cancel_sync(app, session)
}

fn scroll_cancel_sync(app: AppHandle, session: u64) -> Result<(), String> {
    let session = if session == 0 {
        ACTIVE_SESSION.load(std::sync::atomic::Ordering::SeqCst)
    } else {
        session
    };
    ACTIVE_SESSION.store(0, std::sync::atomic::Ordering::SeqCst);
    destroy_endbar_window(&app);
    hide_ls_frame();
    // 覆盖层屏外驻留（不 destroy：预驻留窗口永不销毁，destroy 异步会让紧随的热键
    // 拍在濒死窗口上=没反应；park 屏外画面同样即时消失）
    if let Some(w) = app.get_webview_window("overlay") {
        crate::park_overlay_offscreen(&w);
    }
    scrolls().remove(&session);
    restore_overlay_passthrough(&app);
    // Esc 取消：不落盘（说明书 §4.4 明确："取消就是取消"）
    crate::deliver::toast(&app, "success", "已取消长截图");
    Ok(())
}

#[tauri::command]
pub async fn scroll_adjust(
    session: u64,
    seam_index: usize,
    delta: i64,
) -> Result<serde_json::Value, String> {
    let mut map = scrolls();
    let st = map.get_mut(&session).ok_or("会话不存在")?;
    st.session.adjust_seam(seam_index, delta).map_err(|e| e.to_string())?;
    let remaining: Vec<usize> = st
        .session
        .seams()
        .iter()
        .enumerate()
        .filter(|(_, s)| s.confidence < once_core::longshot::CONFIDENCE_OK && !s.accepted)
        .map(|(i, _)| i)
        .collect();
    Ok(serde_json::json!({ "ok": true, "remaining": remaining.len(), "height": st.session.content_height() }))
}

#[tauri::command]
pub async fn scroll_accept_all(session: u64) -> Result<(), String> {
    let mut map = scrolls();
    let st = map.get_mut(&session).ok_or("会话不存在")?;
    for i in 0..st.session.seam_count() {
        let _ = st.session.adjust_seam(i, 0);
    }
    Ok(())
}

/// 质检后保存（确认并保存）。
#[tauri::command]
pub async fn scroll_save(app: AppHandle, session: u64) -> Result<serde_json::Value, String> {
    let mut st = {
        let mut map = scrolls();
        map.remove(&session).ok_or("会话不存在（可能已结束）")?
    };
    let outcome = save_scroll(&app, &mut st.session).map_err(|e| e.to_string())?;
    // 收尾：结束条/质检页销毁；覆盖层屏外驻留（预驻留窗口永不 destroy，理由同 scroll_cancel）
    for label in ["endbar", "quality"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
    if let Some(w) = app.get_webview_window("overlay") {
        crate::park_overlay_offscreen(&w);
    }
    restore_overlay_passthrough(&app);
    Ok(serde_json::json!({ "saved": outcome }))
}

/// 收尾共用：销毁结束条、park 覆盖层、恢复覆盖层可点击
fn scroll_teardown(app: &AppHandle) {
    destroy_endbar_window(app);
    hide_ls_frame();
    if let Some(w) = app.get_webview_window("overlay") {
        crate::park_overlay_offscreen(&w);
    }
    restore_overlay_passthrough(app);
}

/// 长截图复制：全图 PNG 进剪贴板（不落盘、不进历史）
#[tauri::command]
pub async fn scroll_copy(app: AppHandle, session: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ACTIVE_SESSION.store(0, std::sync::atomic::Ordering::SeqCst);
        let mut st = {
            let mut map = scrolls();
            map.remove(&session).ok_or("会话不存在（可能已结束）")?
        };
        let (w, h, rgba) = st.session.export();
        let bmp = capture::CapturedBitmap { width: w, height: h, pixels: rgba, origin: (0, 0) };
        let png = capture::encode_png(&bmp).map_err(|e| oe(e))?;
        let clip = clipboard::ClipboardPayload {
            png: Some(&png),
            rgba: Some((&bmp.pixels, w, h)),
            files: vec![],
            text: None,
        };
        let ok = clipboard::write(&clip).is_ok();
        let n = st.session.seam_count() + 1;
        scroll_teardown(&app);
        if ok {
            crate::deliver::toast(&app, "success", &format!("长截图已复制 · {} 段 · {}px", n, h));
        } else {
            crate::deliver::toast(&app, "warn", "剪贴板写入失败");
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("任务失败：{e}"))?
}

/// 长截图贴图：全图钉到桌面选区原位，高度超屏自动等比适配（同类产品 长图贴图语义）
#[tauri::command]
pub async fn scroll_pin(app: AppHandle, session: u64) -> Result<u32, String> {
    // 同步准备（export/编码/落临时文件——MutexGuard 不得跨 await）
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        ACTIVE_SESSION.store(0, std::sync::atomic::Ordering::SeqCst);
        let mut st = {
            let mut map = scrolls();
            map.remove(&session).ok_or("会话不存在（可能已结束）")?
        };
        let (w, h, rgba) = st.session.export();
        let bmp = capture::CapturedBitmap { width: w, height: h, pixels: rgba, origin: (0, 0) };
        let png = capture::encode_png(&bmp).map_err(|e| oe(e))?;
        let tmp = std::env::temp_dir().join("onceglance-scroll-pin.png");
        std::fs::write(&tmp, &png).map_err(|e| format!("写临时文件失败：{e}"))?;
        Ok::<(i32, i32, u32), String>((st.abs_x, st.abs_y, h))
    })
    .await
    .map_err(|e| format!("任务失败：{e}"))??;
    let (px, py, _img_h) = prepared;
    // 长图贴图：高度不超过工作区 90%（物理），超出等比缩小
    let mon = capture::monitors().into_iter().next().ok_or("无显示器")?;
    let max_h = (mon.rect.3 as f32 * 0.9) as u32;
    let pad = (24.0 * mon.dpi_scale).round() as u32;
    let id = crate::pin::pin_create(app.clone(), std::env::temp_dir().join("onceglance-scroll-pin.png").to_string_lossy().into_owned(), Some(px), Some(py), Some(1.0), Some(pad), Some(max_h)).await?;
    crate::deliver::toast(&app, "success", "长截图已贴到桌面");
    scroll_teardown(&app);
    Ok(id)
}

/// 超长图分段导出（LONG-5）：默认段高 8000，导出为 xxx-partN。
#[tauri::command]
pub async fn scroll_export_segments(
    app: AppHandle,
    session: u64,
    segment_height: u32,
) -> Result<serde_json::Value, String> {
    let st = {
        let mut map = scrolls();
        map.remove(&session).ok_or("会话不存在（可能已结束）")?
    };
    let (w, h, rgba) = st.session.export();
    let seg = segment_height.max(1000) as usize;
    let rows_total = h as usize;
    let mut parts: Vec<serde_json::Value> = Vec::new();
    let mut part_idx = 1;
    let mut y0 = 0usize;
    let s = settings::load();
    let root = s.save_root();
    let row_bytes = w as usize * 4;
    while y0 < rows_total {
        let rows = (rows_total - y0).min(seg);
        let mut part = Vec::with_capacity(rows * row_bytes);
        for r in y0..y0 + rows {
            let start = r * row_bytes;
            part.extend_from_slice(&rgba[start..start + row_bytes]);
        }
        let bmp = CapturedBitmap { width: w, height: rows as u32, pixels: part, origin: (0, 0) };
        let png = capture::encode_png(&bmp).map_err(|e| oe(e))?;
        let mut manifest = storage::Manifest {
            id: String::new(),
            file: String::new(),
            kind: "scroll".into(),
            created_at: storage::now_iso(),
            width: w,
            height: rows as u32,
            screen: None,
            dpi_scale: 1.0,
            screen_layout: None,
            source_window: None,
            parent_id: None,
            script_sha256: None,
            ops_count: None,
            segments: Some(part_idx as u32),
            manual_fixes: Some(st.session.manual_fix_count()),
        };
        let (_id, paths) = storage::save_capture(&root, "scroll", &png, &mut manifest).map_err(oe)?;
        parts.push(serde_json::json!({ "path": paths.png.to_string_lossy(), "height": rows as u32 }));
        part_idx += 1;
        y0 += rows;
    }
    crate::deliver::toast(&app, "success", &format!("已分段导出 {} 部分", parts.len()));
    Ok(serde_json::json!({ "parts": parts }))
}

/// 打开接缝质检窗口（只有可疑接缝时才出现——说明书 §4.4 阶段 3）。
#[tauri::command]
pub async fn open_quality_window(
    app: AppHandle,
    session: u64,
    width: u32,
    height: u32,
    seams: Vec<usize>,
) -> Result<(), String> {
    let (session, seams) = if session == 0 {
        REVIEW
            .lock()
            .unwrap()
            .clone()
            .ok_or("没有待质检会话".to_string())?
    } else {
        (session, seams)
    };
    open_quality_sync(&app, session, width, height, seams)
}

fn open_quality_sync(
    app: &AppHandle,
    session: u64,
    width: u32,
    height: u32,
    seams: Vec<usize>,
) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    if let Some(old) = app.get_webview_window("quality") {
        let _ = old.destroy();
    }
    let seams_q: Vec<String> = seams.iter().map(|s| s.to_string()).collect();
    let win = WebviewWindowBuilder::new(app, "quality", WebviewUrl::App("quality.html".into()))
        .title("长截图接缝质检")
        .decorations(true)
        .resizable(true)
        .inner_size(860.0, 560.0)
        .visible(false)
        .additional_browser_args(crate::DEBUG_BROWSER_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.eval(&format!(
        "window.__SESSION={{id:{session},width:{width},height:{height},seams:{seams_q:?}}}; if(window.__QC_INIT)window.__QC_INIT();"
    ));
    let _ = win.show();
    Ok(())
}

/// 质检页取会话参数（避免 eval 注入时序问题）。
#[tauri::command]
pub async fn scroll_get_review_session() -> Result<serde_json::Value, String> {
    let r = REVIEW.lock().unwrap().clone().ok_or("没有待质检会话".to_string())?;
    let map = scrolls();
    let st = map.get(&r.0).ok_or("会话不存在")?;
    let (w, h, _) = st.session.export();
    Ok(serde_json::json!({ "id": r.0, "seams": r.1, "width": w, "height": h }))
}

/// 质检页预览：整图缩略（base64 PNG data URL）+ 各接缝当前 y 坐标。
#[tauri::command]
pub async fn scroll_preview(session: u64, max_w: u32) -> Result<serde_json::Value, String> {
    use base64::Engine as _;
    let map = scrolls();
    let st = map.get(&session).ok_or("会话不存在")?;
    let (w, h, rgba) = st.session.export();
    let img = image::RgbaImage::from_raw(w, h, rgba).ok_or("画布无效")?;
    let dynimg = image::DynamicImage::ImageRgba8(img);
    let dynimg = if w > max_w {
        let nh = (h as f64 * max_w as f64 / w as f64).round() as u32;
        dynimg.resize_exact(max_w, nh, image::imageops::FilterType::Triangle)
    } else {
        dynimg
    };
    let mut cur = std::io::Cursor::new(Vec::new());
    dynimg
        .write_to(&mut cur, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(cur.into_inner()));
    let seam_ys: serde_json::Map<String, serde_json::Value> = st
        .session
        .seams()
        .iter()
        .enumerate()
        .map(|(i, s)| (i.to_string(), serde_json::json!(s.y)))
        .collect();
    Ok(serde_json::json!({ "url": url, "seam_ys": seam_ys, "width": w, "height": h }))
}

// ===== 采集期低级键盘钩子：Enter=完成 / Esc=取消（不依赖窗口焦点）=====

use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    GetMessageW, PostMessageW, SetWindowsHookExW, UnhookWindowsHookEx, CallNextHookEx,
    KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WM_MOUSEWHEEL, WM_QUIT, WindowFromPoint,
};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use tauri::Emitter;

static HOOK_APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
static HOOK_THREAD_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

unsafe extern "system" fn scroll_kbd_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        #[cfg(debug_assertions)]
        if kb.vkCode == 13 || kb.vkCode == 27 {
            eprintln!("[scroll-hook] vk={} active={}", kb.vkCode, ACTIVE_SESSION.load(std::sync::atomic::Ordering::SeqCst));
        }
        // 本产品从不注入键盘事件，无需过滤 injected；会话活跃时才拦截
        if !scrolls().is_empty() {
            let enter = windows::Win32::UI::Input::KeyboardAndMouse::VK_RETURN.0 as u32;
            let esc = windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE.0 as u32;
            if kb.vkCode == enter || kb.vkCode == esc {
                let s = ACTIVE_SESSION.load(std::sync::atomic::Ordering::SeqCst);
                if s != 0 {
                    let is_enter = kb.vkCode == enter;
                    if let Some(app) = HOOK_APP.get() {
                        let app = app.clone();
                        std::thread::spawn(move || {
                            // 直接在 Rust 侧完成，不依赖覆盖层 JS/焦点
                            if is_enter {
                                let _ = scroll_finish_sync(app, s);
                            } else {
                                let _ = scroll_cancel_sync(app, s);
                            }
                        });
                    }
                }
                return LRESULT(1); // 吞掉，下层应用不收到
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// 安装采集期键盘钩子（一次即可；会话活跃期间生效）。
pub fn install_scroll_keyboard_hook(app: &AppHandle) {
    let _ = HOOK_APP.set(app.clone());
    if HOOK_THREAD_ID.load(std::sync::atomic::Ordering::SeqCst) != 0 {
        return; // 已安装
    }
    std::thread::spawn(|| unsafe {
        let hmod = GetModuleHandleW(None).unwrap_or_default();
        let kbd = SetWindowsHookExW(WH_KEYBOARD_LL, Some(scroll_kbd_proc), Some(windows::Win32::Foundation::HINSTANCE(hmod.0)), 0);
        let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(scroll_mouse_proc), Some(windows::Win32::Foundation::HINSTANCE(hmod.0)), 0);
        match (&kbd, &mouse) {
            (Ok(_), Ok(_)) => eprintln!("[scroll-hook] installed (kbd+mouse)"),
            (e, m) => eprintln!("[scroll-hook] install kbd={e:?} mouse={m:?}"),
        }
        // 线程 id 仅用于语义标记；卸载依赖进程退出
        HOOK_THREAD_ID.store(1, std::sync::atomic::Ordering::SeqCst);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_QUIT {
                break;
            }
        }
        if let Ok(h) = kbd { let _ = UnhookWindowsHookEx(h); }
        if let Ok(h) = mouse { let _ = UnhookWindowsHookEx(h); }
    });
}

/// 采集期滚轮转发（同类产品 同款机制）：
/// WM_MOUSEWHEEL 发给键盘焦点窗口而非鼠标下窗口——overlay 持焦时滚轮被吞。
/// 此钩子在鼠标低级层拦下滚轮，按**鼠标坐标**找到下层真实窗口
/// （overlay 已 WS_EX_TRANSPARENT，WindowFromPoint 会跳过它），PostMessage 转发后
/// 吞掉原始事件——滚轮直达下层应用，与焦点归属无关。仅会话活跃时生效。
unsafe extern "system" fn scroll_mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && wparam.0 as u32 == WM_MOUSEWHEEL && !scrolls().is_empty() {
        let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        // 合成 WM_MOUSEWHEEL：高字=delta，低字=修饰键（读实时状态），坐标=鼠标屏幕位置
        let delta = ((ms.mouseData >> 16) as u16) as i16;
        let keys = windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(
            windows::Win32::UI::Input::KeyboardAndMouse::VK_CONTROL.0 as i32,
        ) & i16::MIN != 0;
        let wp = (((delta as u16 as u32) << 16) | if keys { 0x8 } else { 0 }) as usize;
        let lp = (((ms.pt.y as u16 as u32) << 16) | (ms.pt.x as u16 as u32)) as isize;
        let target = WindowFromPoint(windows::Win32::Foundation::POINT { x: ms.pt.x, y: ms.pt.y });
        eprintln!("[wheel-fwd] -> hwnd {:#x} delta={}", target.0 as isize, delta);
        let _ = PostMessageW(Some(target), WM_MOUSEWHEEL, WPARAM(wp), LPARAM(lp));
        return LRESULT(1); // 吞掉原始滚轮，防止焦点窗口再滚
    }
    CallNextHookEx(None, code, wparam, lparam)
}

#[allow(dead_code)]
pub fn uninstall_scroll_keyboard_hook() {
    // 钩子在会话结束后仍拦截 Enter/Esc 会影响系统——
    // 通过向钩子线程投递退出消息使其自行卸载（当前实现改为常驻直到进程退出，
    // 依赖 proc 内的"会话活跃"检查保证非采集期不吞键）。
}

// ===== 人类兜底标注（说明书 §4.7：截完直接画，保存走同一渲染引擎）=====

/// 覆盖层"标注"入口：截选区存为原图（region 资产），返回给前端进入编辑模式。
#[tauri::command]
pub async fn annotate_begin(
    app: AppHandle,
    screen: usize,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<serde_json::Value, String> {
    let monitor = capture::monitors()
        .into_iter()
        .find(|m| m.index == screen)
        .ok_or("显示器不存在".to_string())?;
    let abs_x = monitor.rect.0 + x;
    let abs_y = monitor.rect.1 + y;
    std::thread::sleep(std::time::Duration::from_millis(120)); // 等覆盖层隐藏选区
    let bmp = capture::capture_region_px(abs_x, abs_y, w, h).map_err(|e| e.to_string())?;
    let png = capture::encode_png(&bmp).map_err(|e| e.to_string())?;
    let s = once_core::settings::load();
    let root = s.save_root();
    let mut manifest = storage::Manifest {
        id: String::new(),
        file: String::new(),
        kind: "region".into(),
        created_at: storage::now_iso(),
        width: bmp.width,
        height: bmp.height,
        screen: Some(monitor.index),
        dpi_scale: capture::monitors().first().map(|m| m.dpi_scale).unwrap_or(1.0),
        screen_layout: Some(capture::screen_layout()),
        source_window: None,
        parent_id: None,
        script_sha256: None,
        ops_count: None,
        segments: None,
        manual_fixes: None,
    };
    let (id, paths) = storage::save_capture(&root, "region", &png, &mut manifest).map_err(|e| e.to_string())?;
    history::upsert_capture(&history::HistoryRow {
        id: id.clone(),
        path: paths.png.to_string_lossy().into_owned(),
        kind: "region".into(),
        created_at: storage::now_iso(),
        width: bmp.width,
        height: bmp.height,
        ocr_status: "none".into(),
        ocr_text: String::new(),
        ocr_preview: String::new(),
        annotated: false,
        parent_id: None,
    })
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "id": id,
        "path": paths.png.to_string_lossy(),
        "width": bmp.width,
        "height": bmp.height,
    }))
}

/// 保存标注：script（px 坐标，相对原图）→ 渲染 → 衍生图 + manifest + 剪贴板 + toast。
#[tauri::command]
pub async fn annotate_save(
    app: AppHandle,
    base_path: String,
    script: serde_json::Value,
    action: Option<String>,
) -> Result<serde_json::Value, String> {
    use once_core::annotate;
    // 业界语义：save=只落盘不占剪贴板（同类产品 同款）；默认 copy 兼容历史编辑器调用
    let action = action.unwrap_or_else(|| "copy".into());
    let path = std::path::PathBuf::from(&base_path);
    let png = std::fs::read(&path)
        .map_err(|e| format!("读取原图失败：{e}"))?;
    let script_parsed: annotate::AnnotationScript = serde_json::from_value(script)
        .map_err(|e| format!("标注脚本解析失败：{e}"))?;
    let script_bytes = serde_json::to_vec(&script_parsed).unwrap_or_default();

    // 衍生图命名 -ann/-ann2…，永不覆盖原图
    let out = storage::derivative_png_path(&path);

    let settings = once_core::settings::load();
    let anchors = annotate::load_anchor_blocks(&path);
    let rendered = annotate::render(&annotate::RenderInput {
        png: &png,
        script: &script_parsed,
        anchor_blocks: anchors.as_deref(),
        defaults: &settings.annotation,
    })
    .map_err(|e| e.to_string())?;
    storage::write_atomic(&out, &rendered.png).map_err(|e| e.to_string())?;

    // 记录衍生表 + manifest（与 CLI annotate_impl 相同语义）
    let parent_id = history::get_by_id_or_path(&path.to_string_lossy())
        .map(|r| r.id)
        .unwrap_or_default();
    let script_hash = {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(&script_bytes);
        h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    let stem = out.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let did = format!(
        "{}#{}",
        out.parent().and_then(|p| p.file_name()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        stem
    );
    history::upsert_derivative(&history::DerivativeRow {
        id: did.clone(),
        parent_id: parent_id.clone(),
        path: out.to_string_lossy().into_owned(),
        ops_count: script_parsed.operations.len() as u32,
        script_sha256: script_hash.clone(),
        created_at: storage::now_iso(),
    })
    .map_err(|e| e.to_string())?;

    let parent_manifest: serde_json::Value = std::fs::read(path.with_extension("json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(serde_json::Value::Null);
    let manifest = serde_json::json!({
        "id": did,
        "file": out.file_name().map(|s| s.to_string_lossy()).unwrap_or_default(),
        "kind": "annotated",
        "created_at": storage::now_iso(),
        "width": rendered.width,
        "height": rendered.height,
        "parent_id": parent_id,
        "parent_file": path.file_name().map(|s| s.to_string_lossy()).unwrap_or_default(),
        "script_sha256": script_hash,
        "ops_count": script_parsed.operations.len(),
        "inherits": parent_manifest,
    });
    let json_path = out.with_extension("json");
    let _ = storage::write_atomic(&json_path, &serde_json::to_vec_pretty(&manifest).unwrap_or_default());

    // 剪贴板 + toast（复制图片 + 文件路径）；save 模式只落盘
    if action == "save" {
        crate::deliver::toast(&app, "success", &format!("已保存标注 · {}", out.display()));
    } else {
        let clip = clipboard::ClipboardPayload {
            png: Some(&rendered.png),
            rgba: None,
            files: vec![out.clone()],
            text: None,
        };
        if clipboard::write(&clip).is_ok() {
            crate::deliver::toast(&app, "success", &format!("已保存标注 · {} 个操作", script_parsed.operations.len()));
        } else {
            crate::deliver::toast(&app, "warn", "标注已保存，剪贴板写入失败（退出码 4）");
        }
    }
    Ok(serde_json::json!({
        "id": did,
        "path": out.to_string_lossy(),
        "ops_count": script_parsed.operations.len(),
    }))
}

/// 从历史「编辑」进入：待打开的底图路径（一次消费）。
static ANN_FILE: StdMutex<Option<String>> = StdMutex::new(None);

/// 主面板「编辑」：以既有图片为底图打开覆盖层标注编辑器（衍生图会显示 lineage 横幅）。
#[tauri::command]
pub async fn annotate_open_file(app: AppHandle, path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    *ANN_FILE.lock().unwrap() = Some(path);
    crate::launch_overlay(app, "annotate".to_string()).await
}

/// 覆盖层编辑器启动时取底图信息（含 lineage：衍生图回传 parent_file）。
#[tauri::command]
pub fn annotate_file_payload() -> Result<Option<serde_json::Value>, String> {
    let Some(path) = ANN_FILE.lock().unwrap().take() else {
        return Ok(None);
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败：{e}"))?;
    let (w, h, _) = once_core::capture::decode_png(&bytes).map_err(|e| e.to_string())?;
    let p = std::path::Path::new(&path);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    // lineage：衍生图（-annN / -ann 后缀）读取同目录 manifest 的 parent_file
    let parent_file = if stem.contains("-ann") {
        let manifest_path = p.with_extension("json");
        std::fs::read(&manifest_path)
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|m| m.get("parent_file").and_then(|v| v.as_str()).map(|s| s.to_string()))
    } else {
        None
    };
    Ok(Some(serde_json::json!({
        "path": path,
        "width": w,
        "height": h,
        "parent": parent_file,
    })))
}

/// 冻结画面（同类产品 手感核心）：进入截图时抓全屏一次；BGRA 留内存供裁剪/取色，
/// PNG 写临时文件供覆盖层显示。选区所见即冻结所得，不受实时桌面变化影响。
struct FreezeFrame {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    origin: (i32, i32),
    path: std::path::PathBuf,
}
static FREEZE: StdMutex<Option<FreezeFrame>> = StdMutex::new(None);

#[tauri::command]
pub async fn freeze_begin() -> Result<serde_json::Value, String> {
    // 编码全屏 JPEG 较重，移出主线程避免界面卡顿
    tauri::async_runtime::spawn_blocking(freeze_begin_inner)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn freeze_begin_inner() -> Result<serde_json::Value, String> {
    let m = capture::monitors()
        .into_iter()
        .next()
        .ok_or_else(|| "无显示器".to_string())?;
    let (sx, sy, sw, sh) = m.rect;
    let bmp = capture::capture_region_px(sx, sy, sw as u32, sh as u32).map_err(oe)?;
    // 预览用 JPEG data URL（asset 协议作用域不含 TEMP，data URL 100% 可加载）；
    // 精确裁剪/取色走内存 BGRA，不受预览压缩影响。
    // 热路径提速：RGBA→RGB 直编 JPEG q70（旧 PNG 编码→解码→JPEG 三连是数百 ms 大头）
    let preview = {
        let rgb = image::RgbImage::from_raw(bmp.width, bmp.height, {
            let mut v = Vec::with_capacity((bmp.width * bmp.height * 3) as usize);
            for px in bmp.pixels.chunks_exact(4) {
                v.extend_from_slice(&[px[0], px[1], px[2]]);
            }
            v
        })
        .ok_or("预览帧构造失败")?;
        let mut jout = std::io::Cursor::new(Vec::new());
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jout, 70);
        image::DynamicImage::ImageRgb8(rgb)
            .write_with_encoder(enc)
            .map_err(|e| e.to_string())?;
        format!("data:image/jpeg;base64,{}", crate::base64_encode(&jout.into_inner()))
    };
    *FREEZE.lock().unwrap() = Some(FreezeFrame {
        rgba: bmp.pixels,
        width: bmp.width,
        height: bmp.height,
        origin: (sx, sy),
        path: std::env::temp_dir().join("onceglance-freeze.png"),
    });
    Ok(serde_json::json!({
        "dataUrl": preview,
        "width": bmp.width,
        "height": bmp.height,
    }))
}

/// 热键路径直调（不经 IPC）：返回 (dataUrl, w, h)；失败时 JS 兜底走 freeze_begin 命令
pub fn freeze_begin_inner_ok() -> Option<(String, u32, u32)> {
    match freeze_begin_inner() {
        Ok(v) => {
            let url = v.get("dataUrl").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let w = v.get("width").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            let h = v.get("height").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            if url.is_empty() { None } else { Some((url, w, h)) }
        }
        Err(e) => {
            eprintln!("freeze_begin_inner_ok: {e}");
            None
        }
    }
}


/// 冻结取色：返回光标处物理像素颜色 (r,g,b,hex)
#[tauri::command]
pub fn freeze_pixel(x: i32, y: i32) -> Result<serde_json::Value, String> {
    let g = FREEZE.lock().unwrap();
    let Some(f) = g.as_ref() else { return Err("冻结画面不存在".into()) };
    let lx = x - f.origin.0;
    let ly = y - f.origin.1;
    if lx < 0 || ly < 0 || lx >= f.width as i32 || ly >= f.height as i32 {
        return Err("坐标越界".into());
    }
    let idx = (ly as usize * f.width as usize + lx as usize) * 4;
    let (r, gg, b) = (f.rgba[idx], f.rgba[idx + 1], f.rgba[idx + 2]);
    Ok(serde_json::json!({ "r": r, "g": gg, "b": b, "hex": format!("#{:02X}{:02X}{:02X}", r, gg, b) }))
}

/// 冻结裁剪：把选区从冻结帧裁出，按 region 原图落盘并写历史（截图=标注一个动作的底图）。
#[tauri::command]
pub fn freeze_take_region(
    app: AppHandle,
    screen: usize,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<serde_json::Value, String> {
    let monitor = capture::monitors()
        .into_iter()
        .find(|m| m.index == screen)
        .ok_or("显示器不存在".to_string())?;
    let g = FREEZE.lock().unwrap();
    let Some(f) = g.as_ref() else { return Err("冻结画面不存在".into()) };
    let lx = (x - f.origin.0).clamp(0, f.width as i32 - 1);
    let ly = (y - f.origin.1).clamp(0, f.height as i32 - 1);
    let w = w.min(f.width - lx as u32);
    let h = h.min(f.height - ly as u32);
    let stride = f.width as usize * 4;
    let mut cropped = Vec::with_capacity(w as usize * h as usize * 4);
    for row in 0..h as usize {
        let start = (ly as usize + row) * stride + lx as usize * 4;
        cropped.extend_from_slice(&f.rgba[start..start + w as usize * 4]);
    }
    let bmp = capture::CapturedBitmap { pixels: cropped, width: w, height: h, origin: f.origin };
    let png = capture::encode_png(&bmp).map_err(oe)?;

    let s = once_core::settings::load();
    let root = s.save_root();
    let mut manifest = storage::Manifest {
        id: String::new(),
        file: String::new(),
        kind: "region".into(),
        created_at: storage::now_iso(),
        width: w,
        height: h,
        screen: Some(monitor.index),
        dpi_scale: capture::monitors().first().map(|m| m.dpi_scale).unwrap_or(1.0),
        screen_layout: Some(capture::screen_layout()),
        source_window: None,
        parent_id: None,
        script_sha256: None,
        ops_count: None,
        segments: None,
        manual_fixes: None,
    };
    let (id, paths) = storage::save_capture(&root, "region", &png, &mut manifest).map_err(|e| e.to_string())?;
    let _ = history::upsert_capture(&history::HistoryRow {
        id: id.clone(),
        path: paths.png.to_string_lossy().into_owned(),
        kind: "region".into(),
        created_at: storage::now_iso(),
        width: w,
        height: h,
        ocr_status: "none".into(),
        ocr_text: String::new(),
        ocr_preview: String::new(),
        annotated: false,
        parent_id: None,
    });
    Ok(serde_json::json!({
        "id": id,
        "path": paths.png.to_string_lossy(),
        "width": w,
        "height": h,
    }))
}

/// 冻结帧裁剪（同步 helper：guard 生命周期锁死在本函数内——
/// async 命令体里的 MutexGuard 即便显式 drop 也会破坏 future 的 Send，曾致编译失败）
fn freeze_crop(x: i32, y: i32, w: u32, h: u32) -> Result<(Vec<u8>, u32, u32), String> {
    let g = FREEZE.lock().unwrap();
    let Some(f) = g.as_ref() else { return Err("冻结画面不存在".into()) };
    let lx = (x - f.origin.0).clamp(0, f.width as i32 - 1);
    let ly = (y - f.origin.1).clamp(0, f.height as i32 - 1);
    let w = w.min(f.width - lx as u32);
    let h = h.min(f.height - ly as u32);
    let stride = f.width as usize * 4;
    let mut cropped = Vec::with_capacity(w as usize * h as usize * 4);
    for row in 0..h as usize {
        let start = (ly as usize + row) * stride + lx as usize * 4;
        cropped.extend_from_slice(&f.rgba[start..start + w as usize * 4]);
    }
    Ok((cropped, w, h))
}

/// 冻结交付：从冻结帧裁剪选区 → 走标准 deliver（落盘+剪贴板+取字/OCR+审计）。
/// action: copy | save | ocr | saveas。保证"所见即所得"——不受实时桌面已变化影响。
/// 必须为 async：deliver 内部 toast 会创建窗口，同步命令阻塞主线程会造成死锁。
#[tauri::command]
pub async fn freeze_deliver(
    app: AppHandle,
    screen: usize,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    action: String,
) -> Result<serde_json::Value, String> {
    let (cropped, w, h) = freeze_crop(x, y, w, h)?;
    // 另存为（业界语义）：只写用户选择的路径——不进默认目录、不进历史、不占剪贴板；
    // 取消对话框不算错误，返回 saved=false（覆盖层保持，可继续编辑）
    if action == "saveas" {
        let png = capture::encode_png(&capture::CapturedBitmap {
            pixels: cropped, width: w, height: h, origin: (x, y),
        })
        .map_err(|e| e.to_string())?;
        let root = settings::load().save_root();
        let default_name = storage::new_asset_paths(&root, "region")
            .ok()
            .and_then(|p| p.png.file_name().map(|s| s.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "onceglance.png".into());
        let app2 = app.clone();
        let dest = tauri::async_runtime::spawn_blocking(move || {
            let mut dlg = rfd::FileDialog::new()
                .set_title("另存为")
                .set_file_name(&default_name)
                .add_filter("PNG 图片", &["png"]);
            // 挂覆盖层为父窗口：对话框跟随 always_on_top 显示在最上层（曾沉在遮罩下用户看不见）
            if let Some(w) = app2.get_webview_window("overlay") {
                dlg = dlg.set_parent(&w);
            }
            dlg.save_file()
        })
        .await
        .map_err(|e| format!("对话框任务失败：{e}"))?;
        let Some(dest) = dest else {
            return Ok(serde_json::json!({ "saved": false }));
        };
        std::fs::write(&dest, &png).map_err(|e| format!("保存失败：{e}"))?;
        crate::deliver::toast(&app, "success", &format!("已保存到 {}", dest.display()));
        return Ok(serde_json::json!({ "saved": true, "path": dest.to_string_lossy() }));
    }
    let bmp = capture::CapturedBitmap { pixels: cropped, width: w, height: h, origin: (x, y) };
    let outcome = crate::deliver::deliver_capture(&app, "region", &action, &bmp, Some(screen), None)
        .map_err(|e| e.message)?;
    Ok(serde_json::to_value(outcome).unwrap_or_default())
}

/// 有标注的另存为：冻结帧裁剪 → 引擎渲染 → 直接写用户选择路径。
/// 不落默认目录（无原图/-ann 衍生）、不进历史、不占剪贴板——与无标注 saveas 同语义。
#[tauri::command]
pub async fn freeze_annotate_saveas(
    app: AppHandle,
    screen: usize,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    script: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use once_core::annotate;
    let (cropped, cw, ch) = freeze_crop(x, y, w, h)?;
    let _ = screen;
    let png = capture::encode_png(&capture::CapturedBitmap { pixels: cropped, width: cw, height: ch, origin: (x, y) })
        .map_err(|e| e.to_string())?;
    let script_parsed: annotate::AnnotationScript = serde_json::from_value(script)
        .map_err(|e| format!("标注脚本解析失败：{e}"))?;
    let settings = once_core::settings::load();
    let rendered = annotate::render(&annotate::RenderInput {
        png: &png,
        script: &script_parsed,
        anchor_blocks: None,
        defaults: &settings.annotation,
    })
    .map_err(|e| e.to_string())?;
    let root = settings::load().save_root();
    let default_name = storage::new_asset_paths(&root, "region")
        .ok()
        .and_then(|p| p.png.file_name().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "onceglance.png".into());
    let app2 = app.clone();
    let dest = tauri::async_runtime::spawn_blocking(move || {
        let mut dlg = rfd::FileDialog::new()
            .set_title("另存为")
            .set_file_name(&default_name)
            .add_filter("PNG 图片", &["png"]);
        if let Some(w) = app2.get_webview_window("overlay") {
            dlg = dlg.set_parent(&w); // 同上：跟随覆盖层置顶
        }
        dlg.save_file()
    })
    .await
    .map_err(|e| format!("对话框任务失败：{e}"))?;
    let Some(dest) = dest else {
        return Ok(serde_json::json!({ "saved": false }));
    };
    std::fs::write(&dest, &rendered.png).map_err(|e| format!("保存失败：{e}"))?;
    crate::deliver::toast(&app, "success", &format!("已保存到 {}", dest.display()));
    Ok(serde_json::json!({ "saved": true, "path": dest.to_string_lossy() }))
}

/// 另存为：系统保存对话框选择目标路径，把源文件（原图或标注衍生图）复制过去。
/// rfd 对话框必须离开主线程：spawn_blocking，避免重蹈同步命令阻塞的死锁。
#[tauri::command]
pub async fn save_as_dialog(path: String) -> Result<serde_json::Value, String> {
    let src = std::path::PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        let default_name = src
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "onceglance.png".into());
        let Some(dest) = rfd::FileDialog::new()
            .set_title("另存为")
            .set_file_name(&default_name)
            .add_filter("PNG 图片", &["png"])
            .save_file()
        else {
            // 用户取消：不算错误，覆盖层保持关闭即可
            return Ok(serde_json::json!({ "saved": false }));
        };
        std::fs::copy(&src, &dest).map_err(|e| format!("保存失败：{e}"))?;
        Ok(serde_json::json!({ "saved": true, "path": dest.to_string_lossy() }))
    })
    .await
    .map_err(|e| format!("对话框任务失败：{e}"))?
}
