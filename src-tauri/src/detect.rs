//! 窗口/控件自动识别（业界同款：光标处高亮、单击选中、Tab 切换）。
//! 纯 Win32：WindowFromPoint → GA_ROOT → DWM 真实边界 → 子窗口枚举 + 同点其它顶层窗口。

use serde::Serialize;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetClassNameW, GetWindowLongW, GetWindowTextW,
    GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
    GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetLayeredWindowAttributes, LAYERED_WINDOW_ATTRIBUTES_FLAGS,
};
use windows::core::BOOL;

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    /// 物理屏幕坐标 [x, y, w, h]
    pub rect: [i32; 4],
    pub title: String,
    pub class: String,
    /// 1=顶层窗口 2=子窗口/控件
    pub level: u8,
}

fn real_rect(hwnd: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    unsafe {
        // DWM 扩展边界不含不可见阴影，边缘更准（失败回退 GetWindowRect）
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );
        if hr.is_ok() {
            return Some(r);
        }
        let mut f = RECT::default();
        if GetWindowRect(hwnd, &mut f).is_ok() {
            return Some(f);
        }
    }
    None
}

fn class_of(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn title_of(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn contains(r: &RECT, x: i32, y: i32) -> bool {
    r.left <= x && x < r.right && r.top <= y && y < r.bottom
}

/// 是否本进程窗口。
fn own_window(h: HWND) -> bool {
    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(h, Some(&mut pid));
    }
    pid == std::process::id()
}

/// 是否本进程的覆盖层（TOPMOST+全屏）——只有它必须排除；
/// 主面板/贴图是屏幕上的真实窗口，应可作为截图目标被识别。
fn own_overlay(h: HWND) -> bool {
    if !own_window(h) {
        return false;
    }
    let ex = unsafe { GetWindowLongW(h, GWL_EXSTYLE) } as u32;
    if ex & WS_EX_TOPMOST.0 == 0 {
        return false; // 非置顶的本进程窗口（主面板）不排除
    }
    // 置顶且近乎全屏 = 覆盖层
    match real_rect(h) {
        Some(r) => {
            let (w, hh) = (r.right - r.left, r.bottom - r.top);
            let (vx, vy, vw, vh) = crate::capture::virtual_desktop();
            w >= vw * 9 / 10 && hh >= vh * 9 / 10 && r.left <= vx && r.top <= vy
        }
        None => true,
    }
}

/// 不可交互的幻影窗口：cloaked（UWP 挂起/隐身）、工具窗、点击穿透/全透明悬浮层——
/// 加速器悬浮球一类会把识别抢走，同类产品 同样不识别它们。
fn ghost_window(h: HWND) -> bool {
    unsafe {
        let mut cloaked: u32 = 0;
        let hr = DwmGetWindowAttribute(
            h,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        );
        if hr.is_ok() && cloaked != 0 {
            return true;
        }
        let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TRANSPARENT.0 != 0 || ex & WS_EX_TOOLWINDOW.0 != 0 {
            return true;
        }
        if ex & WS_EX_LAYERED.0 != 0 {
            let mut alpha: u8 = 0;
            let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS(0);
            if GetLayeredWindowAttributes(h, None, Some(&mut alpha), Some(&mut flags)).is_ok()
                && flags.0 & LWA_ALPHA.0 != 0
                && alpha < 10
            {
                return true; // 近乎全透明的悬浮层
            }
        }
    }
    false
}

fn push_candidate(out: &mut Vec<Candidate>, h: HWND, x: i32, y: i32, level: u8) {
    if own_overlay(h) {
        return; // 只排除覆盖层；主面板/贴图可被识别
    }
    if ghost_window(h) {
        return; // cloaked/工具窗/透明悬浮层不参与识别
    }
    // WebView2 子窗口属于 msedgewebview2 进程，pid 排除失效——按类名再排除
    if class_of(h) == "WRY_WEBVIEW" {
        return;
    }
    let Some(r) = real_rect(h) else { return };
    let (w, hh) = (r.right - r.left, r.bottom - r.top);
    if w <= 2 || hh <= 2 || !contains(&r, x, y) {
        return;
    }
    out.push(Candidate {
        rect: [r.left, r.top, w, hh],
        title: title_of(h),
        class: class_of(h),
        level,
    });
}

/// 视觉命中探测："当前看到什么就探测什么"。
/// 光标永远落在本进程全屏覆盖层上，WindowFromPoint 只会返回覆盖层——
/// 因此用 EnumWindows 按 Z 序（TOPMOST 组在前 = 视觉从上到下）做穿透 hit-test：
/// 第一个非覆盖层、非幻影、包含光标点的顶层窗口 = 用户眼前可见的窗口；
/// 被它遮挡的窗口一律不探测。控件级候选取自该窗口的子窗口。
pub fn candidates_at(x: i32, y: i32) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    unsafe {
        let mut hit: Option<HWND> = None;
        let mut ctx = ZCtx { x, y, hit: &mut hit };
        let _ = EnumWindows(Some(z_proc), LPARAM(&mut ctx as *mut ZCtx as isize));
        if let Some(v) = hit {
            push_candidate(&mut out, v, x, y, 1);
            // 控件级（尽力而为——现代应用常为整块渲染）
            enum_children_collect(v, x, y, &mut out);
        }
    }
    // 控件级（更具体）排在顶层之前；stable 保持 Z 序
    out.sort_by_key(|c| if c.level == 2 { 0 } else { 1 });
    out.dedup_by(|a, b| a.rect == b.rect);
    out
}

struct ZCtx {
    x: i32,
    y: i32,
    hit: *mut Option<HWND>,
}

unsafe extern "system" fn z_proc(h: HWND, lp: LPARAM) -> BOOL {
    let ctx = unsafe { &mut *(lp.0 as *mut ZCtx) };
    if !IsWindowVisible(h).as_bool() {
        return BOOL(1);
    }
    if let Some(r) = real_rect(h) {
        if contains(&r, ctx.x, ctx.y)
            && !own_overlay(h)
            && !ghost_window(h)
        {
            *ctx.hit = Some(h);
            return BOOL(0); // 视觉最上层的可见窗口即命中，停止枚举
        }
    }
    BOOL(1)
}

unsafe fn enum_children_collect(root: HWND, x: i32, y: i32, out: &mut Vec<Candidate>) {
    struct Ctx {
        x: i32,
        y: i32,
        out: *mut Vec<Candidate>,
    }
    unsafe extern "system" fn proc_(h: HWND, lp: LPARAM) -> BOOL {
        // Chromium 子窗口类名排除（WebView2 宿主进程与宿主应用不同）
        let cls = class_of(h);
        if cls.starts_with("Chrome_WidgetWin") {
            return BOOL(1);
        }
        let ctx = unsafe { &mut *(lp.0 as *mut Ctx) };
        push_candidate(unsafe { &mut *ctx.out }, h, ctx.x, ctx.y, 2);
        BOOL(1)
    }
    let mut ctx = Ctx { x, y, out };
    let _ = EnumChildWindows(Some(root), Some(proc_), LPARAM(&mut ctx as *mut Ctx as isize));
}

/// Tauri 命令：物理屏幕坐标处的窗口/控件候选（面积升序）。
#[tauri::command]
pub async fn detect_candidates(x: i32, y: i32) -> Vec<Candidate> {
    // 枚举子窗口可能较重，移出主线程避免悬停卡顿
    tauri::async_runtime::spawn_blocking(move || detect_candidates_inner(x, y))
        .await
        .unwrap_or_default()
}

fn detect_candidates_inner(x: i32, y: i32) -> Vec<Candidate> {
    candidates_at(x, y)
}
