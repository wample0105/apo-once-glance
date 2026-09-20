//! 屏幕捕获（GDI BitBlt / PrintWindow）。
//! 坐标一律物理像素；虚拟桌面原点可为负（多显示器）。

use crate::error::{OnceError, Result};
use windows::core::{w, BOOL};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateDCW, DeleteDC, DeleteObject,
    EnumDisplayMonitors, GetDIBits, GetMonitorInfoW, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, HMONITOR, MONITORINFOEXW, ROP_CODE, SRCCOPY,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetSystemMetrics, GetWindowLongW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, WindowFromPoint,
    GWL_EXSTYLE, MONITORINFOF_PRIMARY, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

const PW_RENDERFULLCONTENT: u32 = 0x0000_0002;

/// 一次捕获得到的位图（RGBA8888），origin 为其在虚拟桌面坐标系中的物理像素原点。
#[derive(Debug, Clone)]
pub struct CapturedBitmap {
    pub width: u32,
    pub height: u32,
    /// RGBA8888，行 stride = width*4。
    pub pixels: Vec<u8>,
    pub origin: (i32, i32),
}

impl CapturedBitmap {
    pub fn to_image(&self) -> Result<image::RgbaImage> {
        image::RgbaImage::from_raw(self.width, self.height, self.pixels.clone())
            .ok_or_else(|| OnceError::capture("位图数据长度不匹配"))
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MonitorInfo {
    pub index: usize,
    /// 虚拟桌面物理像素 (x, y, w, h)。
    pub rect: (i32, i32, i32, i32),
    pub dpi_scale: f32,
    pub name: String,
    pub primary: bool,
}

/// 屏幕布局快照（写进 manifest，CAP-5）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScreenLayout {
    pub virtual_desktop: (i32, i32, i32, i32),
    pub monitors: Vec<MonitorInfo>,
}

pub fn virtual_desktop() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

/// 枚举所有显示器（物理像素 + DPI 缩放）。
pub fn monitors() -> Vec<MonitorInfo> {
    let mut ctx = MonitorCtx { out: Vec::new() };
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(monitor_proc),
            LPARAM(&mut ctx as *mut MonitorCtx as isize),
        );
    }
    let primary_x = ctx.out.iter().find(|m| m.primary).map(|m| m.rect.0);
    // EnumDisplayMonitors 不保证顺序；按主屏优先、再按坐标排序，index 从 1 开始
    ctx.out.sort_by_key(|m| (m.rect.1, m.rect.0));
    if let Some(px) = primary_x {
        ctx.out.sort_by_key(|m| if m.rect.0 == px { 0 } else { 1 });
    }
    for (i, m) in ctx.out.iter_mut().enumerate() {
        m.index = i + 1; // 人类可读：屏幕 1 起
    }
    ctx.out
}

struct MonitorCtx {
    out: Vec<MonitorInfo>,
}

unsafe extern "system" fn monitor_proc(
    hmon: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut MonitorCtx);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(hmon, &mut info as *mut _ as *mut _).as_bool() {
        let r = info.monitorInfo.rcMonitor;
        let mut dpi_x = 96u32;
        let mut dpi_y = 96u32;
        let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        ctx.out.push(MonitorInfo {
            index: 0,
            rect: (r.left, r.top, r.right - r.left, r.bottom - r.top),
            dpi_scale: dpi_x as f32 / 96.0,
            name: String::from_utf16_lossy(&info.szDevice)
                .trim_end_matches('\0')
                .to_string(),
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        });
    }
    BOOL(1)
}

/// 屏幕布局快照。
pub fn screen_layout() -> ScreenLayout {
    ScreenLayout { virtual_desktop: virtual_desktop(), monitors: monitors() }
}

/// 截取虚拟桌面坐标系的矩形区域（物理像素）。
pub fn capture_region_px(x: i32, y: i32, w: u32, h: u32) -> Result<CapturedBitmap> {
    if w == 0 || h == 0 {
        return Err(OnceError::capture("选区为空"));
    }
    let (vx, vy, vw, vh) = virtual_desktop();
    // 裁剪到虚拟桌面内
    let x0 = x.max(vx);
    let y0 = y.max(vy);
    let x1 = (x + w as i32).min(vx + vw);
    let y1 = (y + h as i32).min(vy + vh);
    if x1 <= x0 || y1 <= y0 {
        return Err(OnceError::capture("选区完全在屏幕之外"));
    }
    bitblt(x0, y0, (x1 - x0) as u32, (y1 - y0) as u32)
}

/// 截取指定显示器全屏。
pub fn capture_monitor(index: usize) -> Result<CapturedBitmap> {
    let list = monitors();
    let m = list
        .iter()
        .find(|m| m.index == index)
        .ok_or_else(|| OnceError::usage(format!("屏幕 {index} 不存在（当前共 {} 块）", list.len())))?;
    capture_region_px(m.rect.0, m.rect.1, m.rect.2 as u32, m.rect.3 as u32)
}

/// 截取全部显示器：返回各屏位图（每屏一张，不拼接）。
pub fn capture_all_monitors() -> Result<Vec<CapturedBitmap>> {
    monitors()
        .iter()
        .map(|m| capture_region_px(m.rect.0, m.rect.1, m.rect.2 as u32, m.rect.3 as u32))
        .collect()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub title: String,
    pub class: String,
    pub process_name: String,
    pub pid: u32,
    /// 窗口边界（虚拟桌面物理像素 x, y, w, h；DWM 扩展框）。
    pub rect: (i32, i32, u32, u32),
    pub monitor_index: usize,
}

/// 枚举可捕获的顶层窗口（可见、非 cloaked、非工具窗）。
pub fn windows() -> Vec<WindowInfo> {
    let mut out: Vec<WindowInfo> = Vec::new();
    let ctx = &mut out as *mut Vec<WindowInfo> as isize;
    unsafe {
        let _ = EnumWindows(Some(window_proc), LPARAM(ctx));
    }
    let mons = monitors();
    for w in &mut out {
        // 计算窗口所在屏幕
        let cx = w.rect.0 + w.rect.2 as i32 / 2;
        let cy = w.rect.1 + w.rect.3 as i32 / 2;
        w.monitor_index = mons
            .iter()
            .find(|m| cx >= m.rect.0 && cx < m.rect.0 + m.rect.2 && cy >= m.rect.1 && cy < m.rect.1 + m.rect.3)
            .map(|m| m.index)
            .unwrap_or(1);
    }
    out.retain(|w| w.rect.2 > 0 && w.rect.3 > 0);
    out
}

unsafe extern "system" fn window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<WindowInfo>);
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return BOOL(1);
    }
    // 排除 cloaked（UWP 挂起窗口）
    let mut cloaked: u32 = 0;
    let _ = DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut u32 as *mut _,
        std::mem::size_of::<u32>() as u32,
    );
    if cloaked != 0 {
        return BOOL(1);
    }
    let exstyle = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    if exstyle & WS_EX_TOOLWINDOW != 0 {
        return BOOL(1);
    }
    let mut title_buf = [0u16; 512];
    let tlen = GetWindowTextW(hwnd, &mut title_buf);
    let title = String::from_utf16_lossy(&title_buf[..tlen.max(0) as usize]);
    let mut class_buf = [0u16; 256];
    let clen = GetClassNameW(hwnd, &mut class_buf);
    let class = String::from_utf16_lossy(&class_buf[..clen.max(0) as usize]);
    if title.is_empty() && class.is_empty() {
        return BOOL(1);
    }
    let mut pid = 0u32;
    let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let process_name = process_image_name(pid).unwrap_or_default();
    let rect = window_frame_rect(hwnd);
    if let Some(r) = rect {
        out.push(WindowInfo {
            hwnd: hwnd.0 as isize,
            title,
            class,
            process_name,
            pid,
            rect: r,
            monitor_index: 0,
        });
    }
    BOOL(1)
}

/// DWM 扩展框（不含不可见阴影），物理像素。
fn window_frame_rect(hwnd: HWND) -> Option<(i32, i32, u32, u32)> {
    unsafe {
        let mut r = RECT::default();
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );
        if hr.is_err() {
            return None;
        }
        Some((r.left, r.top, (r.right - r.left) as u32, (r.bottom - r.top) as u32))
    }
}

pub fn process_image_name(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if ok {
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            Some(
                std::path::Path::new(&full)
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or(full),
            )
        } else {
            None
        }
    }
}

/// 光标点下的窗口（供覆盖层悬停吸附）。
pub fn window_at_point(x: i32, y: i32) -> Option<WindowInfo> {
    unsafe {
        let hwnd = WindowFromPoint(POINT { x, y });
        if hwnd.is_invalid() {
            return None;
        }
        // 借用单元素枚举取信息
        let mut out: Vec<WindowInfo> = Vec::new();
        // WindowFromPoint 返回的是子窗口级的 HWND；向上找顶层窗口信息由前端直接调 win 信息命令处理
        let info = fill_window_info(hwnd);
        if let Some(i) = info {
            out.push(i);
        }
        out.into_iter().next()
    }
}

fn fill_window_info(hwnd: HWND) -> Option<WindowInfo> {
    unsafe {
        let mut title_buf = [0u16; 512];
        let tlen = GetWindowTextW(hwnd, &mut title_buf);
        let mut pid = 0u32;
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut r = RECT::default();
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );
        if hr.is_err() {
            return None;
        }
        Some(WindowInfo {
            hwnd: hwnd.0 as isize,
            title: String::from_utf16_lossy(&title_buf[..tlen.max(0) as usize]),
            class: String::new(),
            process_name: process_image_name(pid).unwrap_or_default(),
            pid,
            rect: (r.left, r.top, (r.right - r.left) as u32, (r.bottom - r.top) as u32),
            monitor_index: 0,
        })
    }
}

/// 当前前台窗口。
pub fn foreground_window() -> Option<WindowInfo> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            None
        } else {
            fill_window_info(hwnd)
        }
    }
}

/// 按 hwnd 截窗：优先 PrintWindow（不叠影），失败回退区域截。
pub fn capture_window_hwnd(hwnd: isize) -> Result<CapturedBitmap> {
    let hwnd = HWND(hwnd as *mut _);
    let (x, y, w, h) = window_frame_rect(hwnd)
        .ok_or_else(|| OnceError::capture("无法获取窗口边界（窗口可能已关闭）"))?;
    if w == 0 || h == 0 {
        return Err(OnceError::capture("窗口尺寸为 0"));
    }
    if let Ok(bmp) = print_window(hwnd, w, h) {
        if !is_all_black(&bmp) {
            return Ok(bmp);
        }
    }
    // 回退：从屏幕 DC 区域截（可能含遮挡，但内容正确性优先于空白）
    capture_region_px(x, y, w, h)
}

/// 按 id（PRD 的 --pid/--title 语义之外补充）与标题查找窗口。
pub fn find_window_by_title(title_sub: &str) -> Option<WindowInfo> {
    let t = title_sub.to_lowercase();
    windows().into_iter().find(|w| w.title.to_lowercase().contains(&t))
}

pub fn find_window_by_pid(pid: u32) -> Option<WindowInfo> {
    windows().into_iter().find(|w| w.pid == pid)
}

fn print_window(hwnd: HWND, w: u32, h: u32) -> Result<CapturedBitmap> {
    unsafe {
        let hdc_screen = CreateDCW(w!("DISPLAY"), None, None, None);
        if hdc_screen.is_invalid() {
            return Err(OnceError::capture("CreateDC(DISPLAY) 失败"));
        }
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
        let hbmp = CreateCompatibleBitmap(hdc_screen, w as i32, h as i32);
        if hbmp.is_invalid() {
            return Err(OnceError::capture("创建兼容位图失败"));
        }
        let old = SelectObject(hdc_mem, hbmp.into());
        let ok = windows::Win32::Storage::Xps::PrintWindow(
            hwnd,
            hdc_mem,
            windows::Win32::Storage::Xps::PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT),
        );
        let mut out = if ok.as_bool() {
            read_dib(hdc_mem, hbmp, w as i32, h as i32)
        } else {
            Err(OnceError::capture("PrintWindow 失败"))
        };
        SelectObject(hdc_mem, old);
        let _ = DeleteObject(hbmp.into());
        let _ = DeleteDC(hdc_mem);
        let _ = DeleteDC(hdc_screen);
        if let Ok(ref mut b) = out {
            b.origin = (0, 0);
        }
        out
    }
}

fn is_all_black(b: &CapturedBitmap) -> bool {
    b.pixels.chunks_exact(4).all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0)
}

fn bitblt(x: i32, y: i32, w: u32, h: u32) -> Result<CapturedBitmap> {
    unsafe {
        let hdc_screen = CreateDCW(w!("DISPLAY"), None, None, None);
        if hdc_screen.is_invalid() {
            return Err(OnceError::capture("CreateDC(DISPLAY) 失败"));
        }
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
        let hbmp = CreateCompatibleBitmap(hdc_screen, w as i32, h as i32);
        if hbmp.is_invalid() {
            return Err(OnceError::capture("创建兼容位图失败"));
        }
        let old = SelectObject(hdc_mem, hbmp.into());
        let rop = ROP_CODE(SRCCOPY.0 | 0x4000_0000); // SRCCOPY | CAPTUREBLT
        let ok = BitBlt(hdc_mem, 0, 0, w as i32, h as i32, Some(hdc_screen), x, y, rop);
        let mut out = if ok.is_ok() {
            read_dib(hdc_mem, hbmp, w as i32, h as i32)
        } else {
            Err(OnceError::capture("BitBlt 失败（可能被安全桌面或驱动拦截）")
                .with_hint("可重试；若持续失败，检查杀毒软件是否拦截了屏幕捕获"))
        };
        SelectObject(hdc_mem, old);
        let _ = DeleteObject(hbmp.into());
        let _ = DeleteDC(hdc_mem);
        let _ = DeleteDC(hdc_screen);
        if let Ok(ref mut b) = out {
            b.origin = (x, y);
        }
        out
    }
}

/// 从内存 DC 的 HBITMAP 读出 RGBA 像素。
unsafe fn read_dib(hdc: HDC, hbmp: HBITMAP, w: i32, h: i32) -> Result<CapturedBitmap> {
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h; // top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB.0;
    let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
    let lines = GetDIBits(
        hdc,
        hbmp,
        0,
        h as u32,
        Some(buf.as_mut_ptr() as _),
        &mut bmi,
        DIB_RGB_COLORS,
    );
    if lines == 0 {
        return Err(OnceError::capture("GetDIBits 失败"));
    }
    // BGRA -> RGBA
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2);
        px[3] = 0xFF;
    }
    Ok(CapturedBitmap { width: w as u32, height: h as u32, pixels: buf, origin: (0, 0) })
}

/// 编码 PNG。
pub fn encode_png(bmp: &CapturedBitmap) -> Result<Vec<u8>> {
    let img = bmp.to_image()?;
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| OnceError::io("PNG 编码失败").with_source(e.to_string()))?;
    Ok(out.into_inner())
}

/// 解码 PNG → RGBA。
pub fn decode_png(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>)> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|e| OnceError::io("PNG 解码失败").with_source(e.to_string()))?
        .to_rgba8();
    let (w, h) = img.dimensions();
    Ok((w, h, img.into_raw()))
}
