//! DPI 感知：全链路坐标一律物理像素（PRD CAP-5）。
//! CLI 与 GUI 各自入口处调用一次 `ensure_per_monitor_dpi_aware`。

use windows::core::Result;
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::SetProcessDPIAware;

/// 让进程按"每显示器 v2"感知 DPI。失败时回退 `SetProcessDPIAware`。
/// 返回 false 表示两次都失败（极旧系统），坐标将可能是虚拟化值。
pub fn ensure_per_monitor_dpi_aware() -> bool {
    unsafe {
        let r: Result<()> =
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        if r.is_ok() {
            return true;
        }
        // 已设置过时也会成功或返回假错误；兜底再试一次系统级。
        SetProcessDPIAware().as_bool()
    }
}
