//! 本机桥接（PRD §4.5 / SET-2）：Named Pipe `\\.\pipe\once-bridge`。
//! 仅当前用户可连（CreateNamedPipeW 默认 DACL 基于当前进程令牌，无 Everyone 项）；
//! 无网络监听。CLI/MCP 直接驱动内核，管道用于 GUI 在线时的活状态（ping/status/最近调用）。

use std::io::{BufRead, BufReader, Write};
use tauri::AppHandle;

use windows::Win32::Foundation::{GetLastError, ERROR_PIPE_CONNECTED, HANDLE, WIN32_ERROR};
use windows::Win32::Storage::FileSystem::{
    FlushFileBuffers, ReadFile, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, PIPE_ACCESS_DUPLEX,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, NAMED_PIPE_MODE,
    PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows::core::{w, PCWSTR};

const PIPE_NAME: PCWSTR = w!(r"\\.\pipe\once-bridge");
const BUFSIZE: u32 = 64 * 1024;

/// HANDLE 的 Send 包装（命名管道句柄为进程级资源，跨线程使用合法）。
#[derive(Clone, Copy)]
struct SendHandle(HANDLE);
unsafe impl Send for SendHandle {}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        // 多实例模式：客户端消费一个实例后其余实例仍可连，消除重建间隙误报
        loop {
            unsafe {
                let pipe = CreateNamedPipeW(
                    PIPE_NAME,
                    FILE_FLAGS_AND_ATTRIBUTES(PIPE_ACCESS_DUPLEX.0),
                    NAMED_PIPE_MODE(PIPE_TYPE_BYTE.0 | PIPE_READMODE_BYTE.0 | PIPE_WAIT.0),
                    PIPE_UNLIMITED_INSTANCES,
                    BUFSIZE,
                    BUFSIZE,
                    0,
                    None,
                );
                if pipe.is_invalid() {
                    eprintln!("[bridge] CreateNamedPipeW failed: {}", windows::core::Error::from(GetLastError()));
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    continue;
                }
                let connected = ConnectNamedPipe(pipe, None).is_ok()
                    || GetLastError() == ERROR_PIPE_CONNECTED;
                if !connected {
                    let _ = DisconnectNamedPipe(pipe);
                    continue;
                }
                let app = app.clone();
                let spipe = SendHandle(pipe);
                std::thread::spawn(move || {
                    let p = spipe; // 整体捕获（edition2021 精确捕获会拆字段）
                    handle_client(p.0, &app)
                });
            }
        }
    });
}

fn handle_client(pipe: HANDLE, app: &AppHandle) {
    // 读一行 JSON 请求
    let mut reader = BufReader::new(PipeIo(pipe));
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        unsafe {
            let _ = DisconnectNamedPipe(pipe);
        }
        return;
    }
    let request: serde_json::Value = serde_json::from_str(line.trim()).unwrap_or(serde_json::json!({}));
    let cmd = request.get("cmd").and_then(|v| v.as_str()).unwrap_or("ping").to_string();
    let started = std::time::Instant::now();

    let s = once_core::settings::load();
    let data = match cmd.as_str() {
        "ping" | "status" => serde_json::json!({
            "app": "onceglance",
            "version": once_core::VERSION,
            "gui_online": true,
            "agent_enabled": s.agent_enabled,
            "auto_capture_enabled": s.auto_capture_enabled,
            "save_dir": s.save_root().to_string_lossy(),
            "ocr_engine": once_core::ocr::engine_language(),
            "history_count": once_core::history::count().unwrap_or(0),
        }),
        other => serde_json::json!({ "error": format!("未知命令：{other}（ping|status）") }),
    };
    let envelope = serde_json::json!({
        "ok": data.get("error").is_none(),
        "data": data,
        "error": serde_json::Value::Null,
        "meta": { "version": once_core::VERSION, "elapsed_ms": started.elapsed().as_millis() as u64 }
    });

    // 审计：仅元数据（SET-4）
    once_core::audit::record(&format!("bridge:{cmd}"), started.elapsed().as_millis() as u64, 0, None);

    let mut io = PipeIo(pipe);
    let resp = format!("{envelope}\n");
    let _ = io.write_all(resp.as_bytes());
    let _ = io.flush();
    unsafe {
        let _ = FlushFileBuffers(pipe);
        let _ = DisconnectNamedPipe(pipe);
    }
}

/// ReadFile/WriteFile 的简单句柄封装。
struct PipeIo(HANDLE);
impl std::io::Read for PipeIo {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut read = 0u32;
        let ok = unsafe { ReadFile(self.0, Some(buf), Some(&mut read), None) };
        if ok.is_err() {
            return Err(std::io::Error::last_os_error());
        }
        Ok(read as usize)
    }
}
impl Write for PipeIo {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut written = 0u32;
        let ok = unsafe { WriteFile(self.0, Some(buf), Some(&mut written), None) };
        if ok.is_err() {
            return Err(std::io::Error::last_os_error());
        }
        Ok(written as usize)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
