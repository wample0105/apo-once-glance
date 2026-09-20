//! 错误类型与退出码契约（PRD §4.4，冻结：变更须升主版本）。
//!
//! 退出码：0 成功 / 1 参数错误 / 2 捕获失败 / 3 OCR 失败 /
//! 4 文件读写失败 / 5 桥接与权限被拒 / 6 隐私黑名单拦截。

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum ExitCode {
    Ok = 0,
    Usage = 1,
    Capture = 2,
    Ocr = 3,
    Io = 4,
    Denied = 5,
    Blacklist = 6,
}

impl ExitCode {
    /// 机器可读错误码（envelope.error.code）。
    pub fn code_str(self) -> &'static str {
        match self {
            ExitCode::Ok => "ok",
            ExitCode::Usage => "usage_error",
            ExitCode::Capture => "capture_failed",
            ExitCode::Ocr => "ocr_failed",
            ExitCode::Io => "io_failed",
            ExitCode::Denied => "permission_denied",
            ExitCode::Blacklist => "blacklist_hit",
        }
    }
}

#[derive(Debug, Clone)]
pub struct OnceError {
    pub exit: ExitCode,
    /// 人类可读信息（中文）。
    pub message: String,
    /// 面向 Agent 的恢复建议。
    pub hint: String,
    /// 底层错误文本（不参与语义，仅供诊断）。
    pub source: Option<String>,
}

impl fmt::Display for OnceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)?;
        if let Some(s) = &self.source {
            write!(f, "（{s}）")?;
        }
        Ok(())
    }
}

impl std::error::Error for OnceError {}

impl OnceError {
    pub fn new(exit: ExitCode, message: impl Into<String>) -> Self {
        Self { exit, message: message.into(), hint: String::new(), source: None }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = hint.into();
        self
    }

    pub fn with_source(mut self, source: impl Into<String>) -> Self {
        self.source = Some(source.into());
        self
    }

    pub fn usage(message: impl Into<String>) -> Self {
        Self::new(ExitCode::Usage, message)
    }

    pub fn capture(message: impl Into<String>) -> Self {
        Self::new(ExitCode::Capture, message)
    }

    pub fn ocr(message: impl Into<String>) -> Self {
        Self::new(ExitCode::Ocr, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ExitCode::Io, message)
    }

    pub fn denied(message: impl Into<String>) -> Self {
        Self::new(ExitCode::Denied, message)
    }

    pub fn blacklist(message: impl Into<String>) -> Self {
        Self::new(ExitCode::Blacklist, message)
    }
}

impl From<std::io::Error> for OnceError {
    fn from(e: std::io::Error) -> Self {
        OnceError::io("文件读写失败").with_source(e.to_string())
    }
}

impl From<windows::core::Error> for OnceError {
    fn from(e: windows::core::Error) -> Self {
        OnceError::new(ExitCode::Capture, "系统调用失败").with_source(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, OnceError>;
