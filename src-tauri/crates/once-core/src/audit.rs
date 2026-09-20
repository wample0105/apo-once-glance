//! 审计日志（SET-4）：本地 JSONL，只记元数据（时间、命令、耗时、状态、目标进程名），
//! 永不记录图片内容与 OCR 正文。默认保留 30 天自动清理，可一键清空。

use crate::error::Result;
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct AuditEntry {
    pub time: String,
    pub command: String,
    pub elapsed_ms: u64,
    /// 退出码（0 成功）。
    pub status: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_process: Option<String>,
}

pub fn audit_file() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Onceglance")
        .join("audit.jsonl")
}

pub fn append(entry: &AuditEntry) {
    let path = audit_file();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        if let Ok(line) = serde_json::to_string(entry) {
            let _ = writeln!(f, "{line}");
        }
    }
}

pub fn record(command: &str, elapsed_ms: u64, status: i32, target_process: Option<&str>) {
    append(&AuditEntry {
        time: crate::storage::now_iso(),
        command: command.into(),
        elapsed_ms,
        status,
        target_process: target_process.map(|s| s.to_string()),
    });
}

/// 读取最近 N 条（尾部优先）。
pub fn read_recent(limit: usize) -> Vec<AuditEntry> {
    let Ok(content) = std::fs::read_to_string(audit_file()) else {
        return Vec::new();
    };
    let mut out: Vec<AuditEntry> = content
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    out.reverse();
    out.truncate(limit);
    out
}

/// 一键清空（SET-4）。
pub fn clear() -> Result<()> {
    let path = audit_file();
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| {
            crate::error::OnceError::io("清空审计日志失败").with_source(e.to_string())
        })?;
    }
    Ok(())
}

/// 清理超过 30 天的记录（PRD §8-5）：重写文件。
pub fn cleanup_expired(days: u32) {
    let path = audit_file();
    let Ok(content) = std::fs::read_to_string(&path) else { return };
    let cutoff = chrono::Local::now() - chrono::Duration::days(days as i64);
    let kept: Vec<String> = content
        .lines()
        .filter(|l| {
            serde_json::from_str::<AuditEntry>(l)
                .ok()
                .and_then(|e| chrono::DateTime::parse_from_rfc3339(&e.time).ok())
                .map(|t| t.with_timezone(&chrono::Local) >= cutoff)
                .unwrap_or(false)
        })
        .map(String::from)
        .collect();
    if let Ok(mut f) = std::fs::File::create(&path) {
        for line in &kept {
            let _ = writeln!(f, "{line}");
        }
    }
}
