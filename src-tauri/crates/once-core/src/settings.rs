//! 设置（SET-1~7）。全量本地存储于 `%APPDATA%\Onceglance\settings.json`，无任何密钥。
//! CLI 与 GUI 共享同一份文件（CLI-5）。

use crate::error::{OnceError, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Hotkeys {
    pub region: String,
    pub window: String,
    pub fullscreen: String,
    pub ocr: String,
    pub scroll: String,
    pub panel: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Self {
            region: "Alt+Shift+A".into(),
            window: "Alt+Shift+W".into(),
            fullscreen: "Alt+Shift+F".into(),
            ocr: "Alt+Shift+T".into(),
            scroll: "Alt+Shift+L".into(),
            panel: "Alt+Shift+H".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct BlacklistEntry {
    pub pattern: String,
    pub builtin: bool,
    pub enabled: bool,
}

impl BlacklistEntry {
    fn builtin(pattern: &str) -> Self {
        Self { pattern: pattern.into(), builtin: true, enabled: true }
    }
}

/// 标注默认值（编辑器自动记忆；SET-7"记住上次"模型的存储）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AnnotationDefaults {
    pub color: String,
    pub arrow_width: f32,
    pub shape_width: f32,
    pub text_size: f32,
    pub text_bold: bool,
    pub text_italic: bool,
    pub text_underline: bool,
    pub text_shadow: bool,
    pub text_align: String,
    pub step_diameter: f32,
    pub step_style: String,
    pub mosaic_strength: u32,
    pub highlight_opacity: f32,
    // v1.1 标注属性扩展（一次全量对齐业界）
    pub text_family: String,
    pub text_line_height: f32,
    pub text_background: bool,
    pub text_bg_color: String,
    pub text_bg_opacity: f32,
    pub text_bg_radius: f32,
    pub text_stroke: bool,
    pub arrow_dash: bool,
    pub arrow_double_head: bool,
    pub arrow_heads: String,
    pub arrow_line_style: String,
    pub shape_dash: bool,
    pub shape_radius: bool,
    pub shape_opacity: f32,
    pub shape_fill: String,
    pub mosaic_mode: String,
    pub num_start: i32,
    // 输出选项偏好（GUI 记忆值，原样透传；渲染契约见 annotate::OutputFx）
    pub output_shadow: Option<serde_json::Value>,
    pub output_border: Option<serde_json::Value>,
    /// 每工具独立色（GUI 记忆值透传：{arrow,pen,marker,rect,ellipse,text,num}）
    pub tool_colors: Option<serde_json::Value>,
}

impl Default for AnnotationDefaults {
    fn default() -> Self {
        Self {
            color: "#FF3B30".into(),
            arrow_width: 8.0,
            shape_width: 6.0,
            text_size: 44.0,
            text_bold: false,
            text_italic: false,
            text_underline: false,
            text_shadow: true,
            text_align: "left".into(),
            step_diameter: 56.0,
            step_style: "solid".into(),
            mosaic_strength: 12,
            highlight_opacity: 0.4,
            text_family: "default".into(),
            text_line_height: 1.0,
            text_background: false,
            text_bg_color: "#FFF7D6".into(),
            text_bg_opacity: 1.0,
            text_bg_radius: 4.0,
            text_stroke: false,
            arrow_dash: false,
            arrow_double_head: false,
            arrow_heads: "end".into(),
            arrow_line_style: "solid".into(),
            shape_dash: false,
            shape_radius: false,
            shape_opacity: 1.0,
            shape_fill: "outline".into(),
            mosaic_mode: "mosaic".into(),
            num_start: 1,
            output_shadow: None,
            output_border: None,
            tool_colors: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// SET-2 「允许本机 Agent 调用定影」总开关（默认开）。
    pub agent_enabled: bool,
    /// SET-6 「允许无感自动截图」。
    pub auto_capture_enabled: bool,
    /// SET-1 落盘根目录（None → Pictures\Onceglance）。
    pub save_dir: Option<String>,
    /// 截图后默认动作：copy_image | ocr_copy | save_only。
    pub default_action: String,
    pub hotkeys: Hotkeys,
    /// SET-7 记住标注设置。
    pub remember_annotation: bool,
    pub annotation: AnnotationDefaults,
    /// SET-3 隐私黑名单。
    pub blacklist: Vec<BlacklistEntry>,
    /// G-1 历史保留天数（None = 永久）。
    pub keep_days: Option<u32>,
    /// 详情页默认显示文字框。
    pub show_text_boxes: bool,
    pub onboarding_done: bool,
    /// D-2 Windows 关闭主窗口：最小化到托盘（默认）或退出。
    pub close_to_tray: bool,
    /// Esc 退出确认记忆：enabled=弹窗询问；action=记住的选择（discard|save），勾选后不再询问。
    pub esc_exit_confirm: EscExitConfirm,
    /// AI 模型配置（v0.2）：全部非敏感字段；API Key 只存系统凭据管理器。
    pub ai: crate::ai::AiConfig,
    /// 主面板窗口尺寸记忆（逻辑像素 [w,h]）。
    pub win_size: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EscExitConfirm {
    pub enabled: bool,
    /// 记住的按钮行为：""（未记住，弹窗）| "discard"（不保存）| "save"（保存）
    pub action: String,
}

impl Default for EscExitConfirm {
    fn default() -> Self {
        Self { enabled: true, action: String::new() }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            agent_enabled: true,
            auto_capture_enabled: true,
            save_dir: None,
            default_action: "copy_image".into(),
            hotkeys: Hotkeys::default(),
            remember_annotation: true,
            annotation: AnnotationDefaults::default(),
            blacklist: builtin_blacklist(),
            keep_days: None,
            show_text_boxes: true,
            onboarding_done: false,
            close_to_tray: true,
            esc_exit_confirm: EscExitConfirm::default(),
            ai: crate::ai::AiConfig::default(),
            win_size: None,
        }
    }
}

pub fn builtin_blacklist() -> Vec<BlacklistEntry> {
    [
        "1password",
        "bitwarden",
        "keepass",
        "lastpass",
        "enpass",
        "微信支付",
        "工商银行",
        "建设银行",
        "农业银行",
        "中国银行",
        "交通银行",
        "招商银行",
    ]
    .iter()
    .map(|p| BlacklistEntry::builtin(p))
    .collect()
}

fn config_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("Onceglance")
}

pub fn config_file() -> PathBuf {
    config_dir().join("settings.json")
}

static SETTINGS: RwLock<Option<Settings>> = RwLock::new(None);

/// 读取全局设置（首次调用时从磁盘加载，坏文件回退默认值）。
pub fn load() -> Settings {
    if let Some(s) = SETTINGS.read().unwrap().clone() {
        return s;
    }
    let mut s = std::fs::read(config_file())
        .ok()
        .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
        .unwrap_or_default();
    // 自愈：default_action 只允许冻结的三值，历史脏数据（如空串）回退默认
    if !matches!(s.default_action.as_str(), "copy_image" | "ocr_copy" | "save_only") {
        s.default_action = "copy_image".into();
    }
    *SETTINGS.write().unwrap() = Some(s.clone());
    s
}

/// 更新并持久化。
pub fn update<F: FnOnce(&mut Settings)>(f: F) -> Result<Settings> {
    let mut s = load();
    f(&mut s);
    persist(&s)?;
    *SETTINGS.write().unwrap() = Some(s.clone());
    Ok(s)
}

pub fn persist(s: &Settings) -> Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| OnceError::io(format!("无法创建配置目录 {}", dir.display())).with_source(e.to_string()))?;
    let bytes = serde_json::to_vec_pretty(s)
        .map_err(|e| OnceError::io("设置序列化失败").with_source(e.to_string()))?;
    crate::storage::write_atomic(&config_file(), &bytes)
}

impl Settings {
    /// 实际落盘根目录（save_dir 覆盖 > Pictures\Onceglance）。
    pub fn save_root(&self) -> PathBuf {
        match &self.save_dir {
            Some(p) if !p.trim().is_empty() => PathBuf::from(p),
            _ => crate::storage::default_save_root(),
        }
    }

    /// 落盘目录是否可写（doctor / 设置页红字用）。
    pub fn save_dir_writable(&self) -> bool {
        let root = self.save_root();
        if let Err(e) = std::fs::create_dir_all(&root) {
            let _ = e;
            return false;
        }
        let probe = root.join(format!(".once-write-probe-{}", std::process::id()));
        match std::fs::write(&probe, b"ok") {
            Ok(_) => {
                std::fs::remove_file(&probe).ok();
                true
            }
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_have_frozen_hotkeys() {
        let s = Settings::default();
        assert_eq!(s.hotkeys.region, "Alt+Shift+A");
        assert!(s.agent_enabled);
        assert!(s.auto_capture_enabled);
        assert!(!s.blacklist.is_empty());
    }
}

#[cfg(test)]
mod saveprops_tests {
    use super::*;
    #[test]
    fn saveprops_payload_roundtrip() {
        // 与 ui/js/overlay.js saveProps 逐字段对齐的真实 payload
        let v: serde_json::Value = serde_json::json!({
            "color": "#29B6F6", "arrow_width": 8, "shape_width": 8,
            "text_size": 45, "text_bold": false, "text_italic": false, "text_underline": false,
            "text_shadow": false, "text_align": "left", "text_family": "default", "text_line_height": 1,
            "text_background": true, "text_bg_color": "#FF0000", "text_bg_opacity": 1, "text_bg_radius": 4, "text_stroke": false,
            "step_diameter": 56, "step_style": "solid",
            "mosaic_strength": 14, "highlight_opacity": 0.4,
            "arrow_dash": false, "arrow_double_head": false,
            "arrow_heads": "end", "arrow_line_style": "solid",
            "shape_dash": false, "shape_radius": false, "shape_opacity": 1, "shape_fill": "outline",
            "mosaic_mode": "mosaic", "num_start": 1,
            "output_shadow": {"on": false, "blur": 24, "color": "#000000"},
            "output_border": {"on": false, "width": 6, "color": "#FFFFFF"},
        });
        match serde_json::from_value::<AnnotationDefaults>(v) {
            Ok(a) => assert_eq!(a.shape_fill, "outline"),
            Err(e) => panic!("saveProps payload 反序列化失败: {e}"),
        }
    }
}
