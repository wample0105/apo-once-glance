//! 定影 Onceglance 内核：捕获 / OCR / 标注渲染 / 落盘 / 历史 / 设置。
//! 人类 UI 与 Agent 接口（CLI / MCP）共享同一内核（PRD §3.3-6）。

pub mod annotate;
pub mod audit;
pub mod blacklist;
pub mod capture;
pub mod clipboard;
pub mod dpi;
pub mod error;
pub mod history;
pub mod longshot;
pub mod ocr;
pub mod settings;
pub mod storage;

pub use error::{ExitCode, OnceError, Result};

/// 应用版本（CLI/MCP envelope meta 用）。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
