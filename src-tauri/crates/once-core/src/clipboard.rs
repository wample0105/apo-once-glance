//! 剪贴板（CLP-1/2）：PNG 位图 + DIB + 文件路径（CF_HDROP）+ 文本同时写入，
//! 写入后读回校验；占用时按 50/200/500ms 退避重试 3 次。
//! 剪贴板序列号用于"不覆盖用户新内容"（CLP-2）。

use crate::error::{OnceError, Result};
use windows::core::w;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
    OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::Win32::System::Ole::{CF_DIB, CF_HDROP, CF_UNICODETEXT};

pub struct ClipboardPayload<'a> {
    pub png: Option<&'a [u8]>,
    /// RGBA8888 像素 + 尺寸（用于合成 DIB）。
    pub rgba: Option<(&'a [u8], u32, u32)>,
    pub files: Vec<std::path::PathBuf>,
    pub text: Option<String>,
}

/// 当前剪贴板序列号（CLP-2 冲突检测）。
pub fn sequence_number() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

/// 写入剪贴板。成功返回 Ok；全部格式失败返回 Err（退出码 4）。
pub fn write(payload: &ClipboardPayload) -> Result<()> {
    // 退避重试：50/200/500ms（PRD §9）
    let mut last_err: Option<OnceError> = None;
    for delay in [0u64, 50, 200, 500] {
        if delay > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay));
        }
        match write_once(payload) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| OnceError::io("剪贴板写入失败")))
}

fn write_once(payload: &ClipboardPayload) -> Result<()> {
    unsafe {
        OpenClipboard(None).map_err(|_| {
            OnceError::io("剪贴板被占用").with_hint("稍后重试；图片已落盘，路径见输出")
        })?;
        let _guard = finally(|| {
            CloseClipboard().ok();
        });
        EmptyClipboard().map_err(|_| OnceError::io("清空剪贴板失败"))?;

        let mut any = false;

        // 1) DIB（最大兼容性：Word/微信/Chrome）
        if let Some((rgba, w, h)) = payload.rgba {
            if let Ok(hg) = build_dib(rgba, w, h) {
                if SetClipboardData(CF_DIB.0 as u32, Some(HANDLE(hg.0))).is_ok() {
                    any = true;
                }
            }
        }
        // 2) PNG 自定义格式
        if let Some(png) = payload.png {
            let fmt = windows::Win32::System::DataExchange::RegisterClipboardFormatW(w!("png"));
            if let Ok(hg) = copy_to_global(png) {
                if SetClipboardData(fmt, Some(HANDLE(hg.0))).is_ok() {
                    any = true;
                }
            }
        }
        // 3) CF_HDROP 文件路径
        if !payload.files.is_empty() {
            if let Ok(hg) = build_hdrop(&payload.files) {
                if SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(hg.0))).is_ok() {
                    any = true;
                }
            }
        }
        // 4) 文本
        if let Some(text) = &payload.text {
            if let Ok(hg) = build_utf16(text) {
                if SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(hg.0))).is_ok() {
                    any = true;
                }
            }
        }

        if !any {
            return Err(OnceError::io("剪贴板写入全部格式失败").with_hint("图片已落盘，可直接粘贴文件或重试"));
        }

        // CLP-1 写入后读回校验
        if GetClipboardData(CF_DIB.0 as u32).is_err() && GetClipboardData(CF_HDROP.0 as u32).is_err()
        {
            return Err(OnceError::io("剪贴板读回校验失败"));
        }
        Ok(())
    }
}

struct Finally<F: FnMut()>(F);
impl<F: FnMut()> Drop for Finally<F> {
    fn drop(&mut self) {
        (self.0)();
    }
}
fn finally<F: FnMut()>(f: F) -> Finally<F> {
    Finally(f)
}

fn copy_to_global(bytes: &[u8]) -> Result<HGLOBAL> {
    unsafe {
        let hg = GlobalAlloc(windows::Win32::System::Memory::GMEM_MOVEABLE, bytes.len())
            .map_err(|e| OnceError::io("剪贴板内存分配失败").with_source(e.to_string()))?;
        let p = GlobalLock(hg);
        if p.is_null() {
            GlobalFree(Some(hg)).ok();
            return Err(OnceError::io("剪贴板内存锁定失败"));
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, bytes.len());
        let _ = GlobalUnlock(hg);
        Ok(hg)
    }
}

/// RGBA → 底朝上 BGRA DIB（BITMAPINFOHEADER + 像素）。
fn build_dib(rgba: &[u8], w: u32, h: u32) -> Result<HGLOBAL> {
    let header_size = std::mem::size_of::<windows::Win32::Graphics::Gdi::BITMAPINFOHEADER>();
    let stride = (w as usize * 4).div_ceil(4) * 4;
    let mut buf = vec![0u8; header_size + stride * h as usize];
    let header = windows::Win32::Graphics::Gdi::BITMAPINFOHEADER {
        biSize: header_size as u32,
        biWidth: w as i32,
        biHeight: h as i32, // bottom-up
        biPlanes: 1,
        biBitCount: 32,
        biCompression: windows::Win32::Graphics::Gdi::BI_RGB.0,
        biSizeImage: (stride * h as usize) as u32,
        ..Default::default()
    };
    buf[..header_size].copy_from_slice(unsafe { &std::mem::transmute::<_, [u8; 40]>(header) });
    for row in 0..h as usize {
        let src = &rgba[row * w as usize * 4..(row + 1) * w as usize * 4];
        let dst_row = header_size + (h as usize - 1 - row) * stride;
        for x in 0..w as usize {
            buf[dst_row + x * 4] = src[x * 4 + 2];
            buf[dst_row + x * 4 + 1] = src[x * 4 + 1];
            buf[dst_row + x * 4 + 2] = src[x * 4];
            buf[dst_row + x * 4 + 3] = 255;
        }
    }
    copy_to_global(&buf)
}

fn build_hdrop(files: &[std::path::PathBuf]) -> Result<HGLOBAL> {
    let mut list: Vec<u16> = Vec::new();
    for f in files {
        let wide: Vec<u16> = f.as_os_str().to_string_lossy().encode_utf16().collect();
        list.extend(wide);
        list.push(0);
    }
    list.push(0);
    let dropfiles_size = std::mem::size_of::<windows::Win32::UI::Shell::DROPFILES>();
    let mut buf = vec![0u8; dropfiles_size + list.len() * 2];
    let df = windows::Win32::UI::Shell::DROPFILES {
        pFiles: dropfiles_size as u32,
        pt: windows::Win32::Foundation::POINT::default(),
        fNC: windows::core::BOOL(0),
        fWide: windows::core::BOOL(1),
    };
    buf[..dropfiles_size].copy_from_slice(unsafe { &std::mem::transmute::<_, [u8; 20]>(df) });
    for (i, u) in list.iter().enumerate() {
        buf[dropfiles_size + i * 2..dropfiles_size + i * 2 + 2].copy_from_slice(&u.to_le_bytes());
    }
    copy_to_global(&buf)
}

fn build_utf16(text: &str) -> Result<HGLOBAL> {
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    let bytes: Vec<u8> = wide.iter().flat_map(|u| u.to_le_bytes()).collect();
    copy_to_global(&bytes)
}

/// 回收站删除（说明书 §3-10：SHFileOperation + FOF_ALLOWUNDO）。
pub fn delete_to_recycle_bin(paths: &[std::path::PathBuf]) -> Result<()> {
    use windows::Win32::UI::Shell::{SHFileOperationW, SHFILEOPSTRUCTW, FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_SILENT};
    if paths.is_empty() {
        return Ok(());
    }
    let mut list: Vec<u16> = Vec::new();
    for p in paths {
        let wide: Vec<u16> = p.as_os_str().to_string_lossy().encode_utf16().collect();
        list.extend(wide);
        list.push(0);
    }
    list.push(0);
    unsafe {
        let mut op = SHFILEOPSTRUCTW {
            hwnd: windows::Win32::Foundation::HWND::default(),
            wFunc: FO_DELETE,
            pFrom: windows::core::PCWSTR(list.as_ptr()),
            pTo: windows::core::PCWSTR::null(),
            fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_SILENT.0) as u16,
            ..Default::default()
        };
        let r = SHFileOperationW(&mut op);
        if r != 0 {
            return Err(OnceError::io(format!("删除失败（SHFileOperation 代码 {r}）")));
        }
    }
    Ok(())
}
