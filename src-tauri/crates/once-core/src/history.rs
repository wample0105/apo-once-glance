//! 本地历史索引（P0-11）：SQLite + FTS5，支持搜索语法
//! `kind:window` / `after:2026-09-17` / `has:annotated` / `ocr:failed` + 自由文本（与 UI 搜索同一解析器）。
//! 数据库在 `%APPDATA%\Onceglance\history.db`，CLI 与 GUI 共享（CLI-5）。

use crate::error::{OnceError, Result};
use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Default)]
pub struct HistoryRow {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub created_at: String,
    pub width: u32,
    pub height: u32,
    pub ocr_status: String,
    /// 全文（入库用；序列化时只输出预览）。
    #[serde(skip_serializing)]
    pub ocr_text: String,
    pub ocr_preview: String,
    pub annotated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DerivativeRow {
    pub id: String,
    pub parent_id: String,
    pub path: String,
    pub ops_count: u32,
    pub script_sha256: String,
    pub created_at: String,
}

pub fn db_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Onceglance")
        .join("history.db")
}

fn open() -> Result<Connection> {
    let path = db_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| OnceError::io(format!("无法创建数据目录 {}", dir.display())).with_source(e.to_string()))?;
    }
    let conn = Connection::open(&path)
        .map_err(|e| OnceError::io(format!("无法打开历史库 {}", path.display())).with_source(e.to_string()))?;
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS captures (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            kind TEXT NOT NULL,
            created_at TEXT NOT NULL,
            width INTEGER DEFAULT 0,
            height INTEGER DEFAULT 0,
            ocr_status TEXT DEFAULT 'none',
            ocr_text TEXT DEFAULT '',
            annotated INTEGER DEFAULT 0,
            fts_rowid INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_cap_created ON captures(created_at DESC);
        CREATE TABLE IF NOT EXISTS derivatives (
            id TEXT PRIMARY KEY,
            parent_id TEXT NOT NULL,
            path TEXT NOT NULL,
            ops_count INTEGER DEFAULT 0,
            script_sha256 TEXT DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(ocr_text, file_name);
        ",
    )
    .map_err(|e| OnceError::io("初始化历史库失败").with_source(e.to_string()))?;
    Ok(conn)
}

pub fn upsert_capture(row: &HistoryRow) -> Result<()> {
    let conn = open()?;
    // FTS：先删旧行
    let old_fts: Option<i64> = conn
        .query_row("SELECT fts_rowid FROM captures WHERE id = ?1", [&row.id], |r| r.get(0))
        .ok();
    if let Some(fr) = old_fts {
        let _ = conn.execute("DELETE FROM captures_fts WHERE rowid = ?1", [fr]);
    }
    let file_name = std::path::Path::new(&row.path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    conn.execute(
        "INSERT INTO captures_fts(ocr_text, file_name) VALUES (?1, ?2)",
        rusqlite::params![row.ocr_text, file_name],
    )
    .map_err(|e| OnceError::io("FTS 写入失败").with_source(e.to_string()))?;
    let fts_rowid = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO captures(id, path, kind, created_at, width, height, ocr_status, ocr_text, annotated, fts_rowid)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET path=?2, kind=?3, created_at=?4, width=?5, height=?6,
           ocr_status=?7, ocr_text=?8, annotated=?9, fts_rowid=?10",
        rusqlite::params![
            row.id,
            row.path,
            row.kind,
            row.created_at,
            row.width,
            row.height,
            row.ocr_status,
            row.ocr_text,
            row.annotated as i64,
            fts_rowid
        ],
    )
    .map_err(|e| OnceError::io("历史写入失败").with_source(e.to_string()))?;
    Ok(())
}

pub fn upsert_derivative(row: &DerivativeRow) -> Result<()> {
    let conn = open()?;
    conn.execute(
        "INSERT INTO derivatives(id, parent_id, path, ops_count, script_sha256, created_at)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET path=?3, ops_count=?4, script_sha256=?5, created_at=?6",
        rusqlite::params![row.id, row.parent_id, row.path, row.ops_count, row.script_sha256, row.created_at],
    )
    .map_err(|e| OnceError::io("衍生记录写入失败").with_source(e.to_string()))?;
    conn.execute("UPDATE captures SET annotated = 1 WHERE id = ?1", [&row.parent_id])
        .ok();
    Ok(())
}

pub fn update_ocr(id: &str, status: &str, text: &str) -> Result<()> {
    let conn = open()?;
    conn.execute(
        "UPDATE captures SET ocr_status = ?2, ocr_text = ?3 WHERE id = ?1",
        rusqlite::params![id, status, text],
    )
    .map_err(|e| OnceError::io("OCR 状态写入失败").with_source(e.to_string()))?;
    let fts: Option<i64> = conn
        .query_row("SELECT fts_rowid FROM captures WHERE id = ?1", [id], |r| r.get(0))
        .ok();
    if let Some(fr) = fts {
        let file_name: String = conn
            .query_row(
                "SELECT path FROM captures WHERE id = ?1",
                [id],
                |r| {
                    Ok(std::path::Path::new(&r.get::<_, String>(0)?)
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default())
                },
            )
            .unwrap_or_default();
        let _ = conn.execute("DELETE FROM captures_fts WHERE rowid = ?1", [fr]);
        let _ = conn.execute(
            "INSERT INTO captures_fts(rowid, ocr_text, file_name) VALUES (?1, ?2, ?3)",
            rusqlite::params![fr, text, file_name],
        );
    }
    Ok(())
}

/// 最近一次成功捕获（CLI-4 `last` 语义，跨进程共享）。
pub fn last_capture() -> Option<HistoryRow> {
    let conn = open().ok()?;
    query_rows(
        &conn,
        "SELECT id, path, kind, created_at, width, height, ocr_status, ocr_text, annotated, NULL FROM captures
         WHERE kind IN ('region','window','fullscreen','scroll') ORDER BY created_at DESC LIMIT 1",
        [],
    )
    .ok()
    .and_then(|v| v.into_iter().next())
}

pub fn get_by_id_or_path(id_or_path: &str) -> Option<HistoryRow> {
    let conn = open().ok()?;
    if let Some(r) = query_rows(
        &conn,
        "SELECT id, path, kind, created_at, width, height, ocr_status, ocr_text, annotated, NULL FROM captures WHERE id = ?1 LIMIT 1",
        [id_or_path],
    )
    .ok()
    .and_then(|v| v.into_iter().next())
    {
        return Some(r);
    }
    query_rows(
        &conn,
        "SELECT id, path, kind, created_at, width, height, ocr_status, ocr_text, annotated, NULL FROM captures WHERE path = ?1 LIMIT 1",
        [id_or_path],
    )
    .ok()
    .and_then(|v| v.into_iter().next())
}

/// 列表 + 搜索（PRD CLI-1 与 UI 搜索同一语法）。
pub fn search(query: &str, limit: usize) -> Result<Vec<HistoryRow>> {
    let conn = open()?;
    let parsed = parse_query(query);
    let mut sql = String::from(
        "SELECT id, path, kind, created_at, width, height, ocr_status, ocr_text, annotated, NULL FROM captures",
    );
    let mut where_clauses: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();

    if let Some(kind) = &parsed.kind {
        where_clauses.push(format!("kind = ?{}", params.len() + 1));
        params.push(kind.clone());
    }
    if let Some(after) = &parsed.after {
        where_clauses.push(format!("created_at >= ?{}", params.len() + 1));
        params.push(after.clone());
    }
    if let Some(before) = &parsed.before {
        where_clauses.push(format!("created_at < ?{}", params.len() + 1));
        params.push(before.clone());
    }
    if parsed.has_annotated {
        where_clauses.push("annotated = 1".into());
    }
    match parsed.ocr_filter.as_deref() {
        Some("failed") => where_clauses.push("ocr_status = 'failed'".into()),
        Some("done") => where_clauses.push("ocr_status IN ('done','empty')".into()),
        _ => {}
    }
    if let Some(text) = &parsed.text {
        // FTS5 全文（OCR 正文 + 文件名）
        where_clauses.push(format!(
            "id IN (SELECT c.id FROM captures c JOIN captures_fts f ON c.fts_rowid = f.rowid WHERE captures_fts MATCH ?{})",
            params.len() + 1
        ));
        params.push(format!("\"{}\"", text.replace('"', "\"\"")));
    }
    if !where_clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY created_at DESC LIMIT ");
    sql.push_str(&limit.to_string());
    query_rows(&conn, &sql, rusqlite::params_from_iter(params.iter()))
}

/// 占位记录数（诊断用）。
pub fn count() -> Result<u64> {
    let conn = open()?;
    conn.query_row("SELECT COUNT(*) FROM captures", [], |r| r.get::<_, i64>(0))
        .map(|n| n as u64)
        .map_err(|e| OnceError::io("历史统计失败").with_source(e.to_string()))
}

fn query_rows<P: rusqlite::Params>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<HistoryRow>> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| OnceError::io("历史查询失败").with_source(e.to_string()))?;
    let rows = stmt
        .query_map(params, |r| {
            let ocr_text: String = r.get(7)?;
            let ocr_preview: String = ocr_text.chars().take(80).collect();
            Ok(HistoryRow {
                id: r.get(0)?,
                path: r.get(1)?,
                kind: r.get(2)?,
                created_at: r.get(3)?,
                width: r.get::<_, i64>(4).unwrap_or(0) as u32,
                height: r.get::<_, i64>(5).unwrap_or(0) as u32,
                ocr_status: r.get(6)?,
                ocr_text,
                ocr_preview,
                annotated: r.get::<_, i64>(8).unwrap_or(0) != 0,
                parent_id: r.get(9).ok().flatten(),
            })
        })
        .map_err(|e| OnceError::io("历史查询失败").with_source(e.to_string()))?;
    rows.filter_map(|r| r.ok()).collect::<Vec<_>>().pipe(Ok)
}

trait Pipe: Sized {
    fn pipe<F: FnOnce(Self) -> T, T>(self, f: F) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

pub fn derivatives_of(parent_id: &str) -> Result<Vec<DerivativeRow>> {
    let conn = open()?;
    let mut stmt = conn
        .prepare("SELECT id, parent_id, path, ops_count, script_sha256, created_at FROM derivatives WHERE parent_id = ?1 ORDER BY created_at ASC")
        .map_err(|e| OnceError::io("衍生查询失败").with_source(e.to_string()))?;
    let rows = stmt
        .query_map([parent_id], |r| {
            Ok(DerivativeRow {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                path: r.get(2)?,
                ops_count: r.get::<_, i64>(3).unwrap_or(0) as u32,
                script_sha256: r.get(4)?,
                created_at: r.get(5)?,
            })
        })
        .map_err(|e| OnceError::io("衍生查询失败").with_source(e.to_string()))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Debug, Default, Clone)]
pub struct ParsedQuery {
    pub text: Option<String>,
    pub kind: Option<String>,
    pub after: Option<String>,
    pub before: Option<String>,
    pub has_annotated: bool,
    pub ocr_filter: Option<String>,
}

/// 解析搜索语法：`kind:window after:昨天 设置`。
pub fn parse_query(q: &str) -> ParsedQuery {
    let mut p = ParsedQuery::default();
    let mut free: Vec<String> = Vec::new();
    let today = chrono::Local::now().date_naive();
    for tok in q.split_whitespace() {
        if let Some(v) = tok.strip_prefix("kind:") {
            p.kind = Some(v.to_lowercase());
        } else if let Some(v) = tok.strip_prefix("after:") {
            p.after = Some(parse_date_expr(v, false, today).unwrap_or_default());
        } else if let Some(v) = tok.strip_prefix("before:") {
            p.before = Some(parse_date_expr(v, true, today).unwrap_or_default());
        } else if tok == "has:annotated" {
            p.has_annotated = true;
        } else if let Some(v) = tok.strip_prefix("ocr:") {
            p.ocr_filter = Some(v.to_lowercase());
        } else if !tok.is_empty() {
            free.push(tok.to_string());
        }
    }
    if !free.is_empty() {
        p.text = Some(free.join(" "));
    }
    p
}

/// 支持 `2026-09-17` / `今天` / `昨天`。
fn parse_date_expr(expr: &str, end: bool, today: chrono::NaiveDate) -> Option<String> {
    let date = match expr {
        "今天" => Some(today),
        "昨天" => Some(today - chrono::Duration::days(1)),
        s => chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok(),
    }?;
    let dt = if end {
        date.and_hms_opt(0, 0, 0)? + chrono::Duration::days(1)
    } else {
        date.and_hms_opt(0, 0, 0)?
    };
    Some(dt.and_local_timezone(chrono::Local).single()?.to_rfc3339_opts(chrono::SecondsFormat::Millis, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_syntax() {
        let p = parse_query("kind:window has:annotated 设置");
        assert_eq!(p.kind.as_deref(), Some("window"));
        assert!(p.has_annotated);
        assert_eq!(p.text.as_deref(), Some("设置"));
        let p2 = parse_query("after:昨天");
        assert!(p2.after.is_some());
    }
}
