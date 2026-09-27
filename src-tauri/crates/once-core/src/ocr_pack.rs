//! PaddleOCR 本地增强包：PP-OCRv4 mobile ONNX 模型 + 字典，按需下载（默认魔搭 ModelScope 源）。
//! 本模块只管下载/状态/删除（RapidAI/RapidOCR 官方模型仓库，约 21MB）；
//! 推理在 `ocr_paddle`（仅 `paddle` feature 编译，CLI 默认不带）。

use crate::error::{OnceError, Result};
use crate::settings::config_dir;
use std::path::PathBuf;
use std::time::Duration;

/// 包版本（模型集合变更时递增，用于显示与后续更新判断）。
pub const PACK_VERSION: &str = "ppocrv4-mobile-1";

pub const SOURCE_MODELSCOPE: &str = "modelscope";
pub const SOURCE_HUGGINGFACE: &str = "huggingface";

/// 仓库文件 → 包内文件（expected 为仓库 LFS 固定字节数，用于完整性校验）。
const FILES: &[(&str, &str, u64)] = &[
    (
        "onnx/PP-OCRv4/det/ch_PP-OCRv4_det_mobile.onnx",
        "det.onnx",
        4_745_517,
    ),
    (
        "onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
        "cls.onnx",
        585_532,
    ),
    (
        "onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile.onnx",
        "rec.onnx",
        10_857_958,
    ),
    (
        "paddle/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile/ppocr_keys_v1.txt",
        "dict.txt",
        26_249,
    ),
];

fn base_url(source: &str) -> &'static str {
    if source == SOURCE_HUGGINGFACE {
        "https://huggingface.co/RapidAI/RapidOCR/resolve/main"
    } else {
        "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master"
    }
}

/// 包安装目录：%APPDATA%\Onceglance\ocr-pack
pub fn pack_dir() -> PathBuf {
    config_dir().join("ocr-pack")
}

/// 是否已安装（四个文件齐且非空）。
pub fn installed() -> bool {
    FILES.iter().all(|(_, name, _)| {
        let p = pack_dir().join(name);
        p.is_file() && std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false)
    })
}

/// 删除本地包（尽力而为；目录不存在不算错）。
pub fn delete() -> Result<()> {
    let dir = pack_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| OnceError::io("删除本地增强包失败").with_source(e.to_string()))?;
    }
    Ok(())
}

/// 下载模型包（阻塞 HTTP，逐文件流式落盘；progress(已收字节, 总字节)）。
/// 完整性：与仓库 LFS 字节数严格比对；落盘走原子写，中断不留半文件。
pub fn download(source: &str, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
    let dir = pack_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| OnceError::io(format!("无法创建目录 {}", dir.display())).with_source(e.to_string()))?;
    let base = base_url(source);
    let total: u64 = FILES.iter().map(|f| f.2).sum();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .connect_timeout(Duration::from_secs(15))
        // 魔搭 LFS CDN 拦截无 UA 的请求（reqwest 默认不发 UA → 403），显式声明
        .user_agent(concat!("Onceglance/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| OnceError::io("HTTP 客户端初始化失败").with_source(e.to_string()))?;
    let mut done: u64 = 0;
    for (repo_path, name, expected) in FILES {
        let url = format!("{base}/{repo_path}");
        let mut resp = client
            .get(&url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| OnceError::io(format!("下载失败：{repo_path}")).with_source(e.to_string()))?;
        let mut buf: Vec<u8> = Vec::with_capacity((*expected as usize).min(64 * 1024 * 1024));
        use std::io::Read;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let n = resp
                .read(&mut chunk)
                .map_err(|e| OnceError::io(format!("下载中断：{repo_path}")).with_source(e.to_string()))?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            progress(done + buf.len() as u64, total);
        }
        if buf.len() as u64 != *expected {
            return Err(OnceError::io(format!(
                "完整性校验失败：{repo_path}（收到 {} 字节，应为 {expected} 字节）",
                buf.len()
            )));
        }
        crate::storage::write_atomic(&dir.join(name), &buf)?;
        done += buf.len() as u64;
        progress(done, total);
    }
    let meta = serde_json::json!({
        "version": PACK_VERSION,
        "source": source,
        "downloaded_at": crate::storage::now_iso(),
    });
    crate::storage::write_atomic(
        &dir.join("pack.json"),
        &serde_json::to_vec_pretty(&meta).unwrap_or_default(),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_table_sane() {
        // 四件套齐全，尺寸为正；URL 分源可达性由实机下载验证
        assert_eq!(FILES.len(), 4);
        assert!(FILES.iter().all(|(_, _, s)| *s > 1_000));
        assert!(base_url(SOURCE_MODELSCOPE).starts_with("https://www.modelscope.cn"));
        assert!(base_url(SOURCE_HUGGINGFACE).starts_with("https://huggingface.co"));
        assert_eq!(base_url("other"), base_url(SOURCE_MODELSCOPE));
    }
}
