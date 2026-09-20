//! 确定性落盘（PRD §4.4 / CLP-3/4）：
//! `%USERPROFILE%\Pictures\Onceglance\<yyyy-MM-dd>\HHmmss-<kind>-<shortid>.png`
//! + 同名 `.json` manifest。原子写入；衍生图永不覆盖原图。

use crate::capture::ScreenLayout;
use crate::error::{OnceError, Result};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const KIND_REGION: &str = "region";
pub const KIND_WINDOW: &str = "window";
pub const KIND_FULLSCREEN: &str = "fullscreen";
pub const KIND_SCROLL: &str = "scroll";

#[derive(Debug, Clone, Serialize)]
pub struct SourceWindow {
    pub title: String,
    pub pid: u32,
    pub process_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Manifest {
    pub id: String,
    pub file: String,
    pub kind: String,
    pub created_at: String,
    pub width: u32,
    pub height: u32,
    pub screen: Option<usize>,
    pub dpi_scale: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_layout: Option<ScreenLayout>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_window: Option<SourceWindow>,
    /// 衍生图时指向原图 id（PRD CLP-4 lineage）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// 标注脚本内容哈希（ANN-4 可复现）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script_sha256: Option<String>,
    /// 标注操作数。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ops_count: Option<u32>,
    /// 长截图段数 / 人工修正次数。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segments: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual_fixes: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct AssetPaths {
    pub dir: PathBuf,
    pub stem: String,
    pub png: PathBuf,
    pub json: PathBuf,
    /// 相对落盘根目录的日期子目录（如 2026-09-18）。
    pub rel_date_dir: String,
}

pub fn shortid() -> String {
    const ALPHA: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789"; // 去易混字符
    use rand::Rng;
    let mut rng = rand::rng();
    (0..4).map(|_| ALPHA[rng.random_range(0..ALPHA.len())] as char).collect()
}

/// 默认落盘根目录：Pictures\Onceglance。
pub fn default_save_root() -> PathBuf {
    let pics = dirs::picture_dir()
        .or_else(|| std::env::var("USERPROFILE").ok().map(|p| PathBuf::from(p).join("Pictures")))
        .unwrap_or_else(|| PathBuf::from("."));
    pics.join("Onceglance")
}

/// 生成不冲突的资产路径（同秒同 id 冲突时递增 shortid）。
pub fn new_asset_paths(root: &Path, kind: &str) -> Result<AssetPaths> {
    let now = chrono::Local::now();
    let date_dir = now.format("%Y-%m-%d").to_string();
    let time_part = now.format("%H%M%S").to_string();
    let dir = root.join(&date_dir);
    std::fs::create_dir_all(&dir)
        .map_err(|e| OnceError::io(format!("无法创建落盘目录 {}", dir.display())).with_source(e.to_string()))?;
    for _ in 0..8 {
        let stem = format!("{time_part}-{kind}-{}", shortid());
        let png = dir.join(format!("{stem}.png"));
        let json = dir.join(format!("{stem}.json"));
        if !png.exists() && !json.exists() {
            return Ok(AssetPaths { dir, stem, png, json, rel_date_dir: date_dir });
        }
    }
    Err(OnceError::io("无法生成唯一文件名（重试 8 次）"))
}

/// 原子写文件：先写同目录 .tmp 再 rename。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| OnceError::io(format!("写入失败：{}", tmp.display())).with_source(e.to_string()))?;
        f.write_all(bytes).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            OnceError::io(format!("写入失败：{}", tmp.display())).with_source(e.to_string())
        })?;
        f.sync_all().ok();
    }
    std::fs::rename(&tmp, path)
        .map_err(|e| OnceError::io(format!("落盘失败：{}", path.display())).with_source(e.to_string()))?;
    Ok(())
}

/// 保存捕获：写 PNG + manifest，返回资产 id 与路径。
pub fn save_capture(
    root: &Path,
    kind: &str,
    png: &[u8],
    manifest: &mut Manifest,
) -> Result<(String, AssetPaths)> {
    let paths = new_asset_paths(root, kind)?;
    write_atomic(&paths.png, png)?;
    let id = format!("{}#{}", paths.rel_date_dir, paths.stem);
    manifest.id = id.clone();
    manifest.file = format!("{}.png", paths.stem);
    let json = serde_json::to_vec_pretty(manifest)
        .map_err(|e| OnceError::io("manifest 序列化失败").with_source(e.to_string()))?;
    write_atomic(&paths.json, &json)?;
    Ok((id, paths))
}

/// 派生资产命名：`<stem>-ann.png`，已存在则 `-ann2` 递增（说明书 §4.7）。
pub fn derivative_png_path(original_png: &Path) -> PathBuf {
    let dir = original_png.parent().unwrap_or(Path::new("."));
    let stem = original_png
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image".into());
    for i in 1..=999 {
        let name = if i == 1 { format!("{stem}-ann.png") } else { format!("{stem}-ann{i}.png") };
        let p = dir.join(name);
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem}-ann-{}.png", shortid()))
}

pub fn now_iso() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naming_format() {
        let id = shortid();
        assert_eq!(id.len(), 4);
    }

    #[test]
    fn derivative_naming() {
        let tmp = std::env::temp_dir().join(format!("once-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let orig = tmp.join("143012-window-a1b2.png");
        let d1 = derivative_png_path(&orig);
        assert!(d1.to_string_lossy().ends_with("-ann.png"));
        std::fs::write(&d1, b"x").unwrap();
        let d2 = derivative_png_path(&orig);
        assert!(d2.to_string_lossy().ends_with("-ann2.png"));
        std::fs::remove_dir_all(&tmp).ok();
    }
}
