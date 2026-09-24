//! once · 定影 CLI（PRD §6.7）。
//! 契约冻结：JSON envelope `{ok,data,error,meta}` + 退出码 0~6（PRD §4.4）。
//! CLI-5：无 GUI 时直接驱动内核；GUI 在线时共享历史与设置（同一 SQLite/JSON）。

mod mcp;

use clap::{Parser, Subcommand};
use once_core::error::OnceError;
use once_core::settings::Settings;
use once_core::{audit, capture, history, ocr, annotate, storage, ExitCode, Result};
use serde_json::{json, Value};
use std::io::Write as _;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser)]
#[command(
    name = "once",
    version = once_core::VERSION,
    about = "定影 Onceglance · Agent 视觉层（截图 / OCR / 标注）",
    after_help = "所有命令支持 --json（envelope：{ok,data,error,meta}）。退出码：0 成功 / 1 参数 / 2 捕获 / 3 OCR / 4 读写 / 5 权限 / 6 黑名单"
)]
struct Cli {
    /// 输出 JSON envelope（默认人类可读简文本）
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// 版本、实例、桥接、热键状态
    Status,
    /// 捕获（区域 / 窗口 / 全屏 / 长截图）
    Capture {
        #[command(subcommand)]
        kind: CaptureKind,
    },
    /// OCR 取字（blocks + bbox）
    Ocr {
        /// 图片路径，或 last（最近一次成功捕获）
        target: String,
        #[arg(long, default_value = "auto")]
        lang: String,
    },
    /// 指令驱动标注（脚本 → 衍生图，永不覆盖原图）
    Annotate {
        target: String,
        #[arg(long)]
        script: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
    /// 本地历史索引（FTS 检索）
    History {
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[arg(long, default_value = "")]
        query: String,
    },
    /// 在资源管理器中定位文件
    Open { target: String },
    /// 读取 / 写入设置
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// 诊断（实例/热键/捕获/落盘/OCR/桥接/运行时）
    Doctor,
    /// 以 stdio 启动 MCP Server
    Mcp,
}

#[derive(Subcommand)]
enum CaptureKind {
    Region {
        #[arg(long)]
        out: Option<PathBuf>,
        #[arg(long, default_value = None)]
        screen: Option<String>,
        #[arg(long, default_value_t = 0)]
        delay: u64,
        /// 扩展参数（确定性 E2E 用）：物理像素区域；不给则需 GUI 覆盖层
        #[arg(long)]
        x: Option<i32>,
        #[arg(long)]
        y: Option<i32>,
        #[arg(long)]
        w: Option<u32>,
        #[arg(long)]
        h: Option<u32>,
    },
    Window {
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        pid: Option<u32>,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    Fullscreen {
        #[arg(long, default_value = None)]
        screen: Option<String>,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    Scroll {
        #[arg(long)]
        out: Option<PathBuf>,
        #[arg(long, default_value_t = 20000)]
        max_height: u32,
        #[arg(long)]
        segments: bool,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    Get { key: String },
    Set { key: String, value: String },
}

fn main() {
    once_core::dpi::ensure_per_monitor_dpi_aware();
    let cli = Cli::parse();
    let started = Instant::now();
    let (cmd_name, result) = dispatch(&cli);
    let elapsed = started.elapsed().as_millis() as u64;
    let (payload, exit) = match &result {
        Ok(data) => (envelope(true, data.clone(), None, elapsed), ExitCode::Ok),
        Err(e) => {
            let error = json!({
                "code": e.exit.code_str(),
                "exit_code": e.exit as i32,
                "message": e.message,
                "hint": if e.hint.is_empty() { Value::Null } else { json!(e.hint) },
                "source": e.source.clone().map(Value::String).unwrap_or(Value::Null),
            });
            (envelope(false, Value::Null, Some(error), elapsed), e.exit)
        }
    };
    audit::record(
        &cmd_name,
        elapsed,
        exit as i32,
        result.as_ref().ok().and_then(|d| d.get("_target_process").and_then(|v| v.as_str())),
    );
    output(&cli, &payload, &result);
    std::process::exit(exit as i32);
}

fn dispatch(cli: &Cli) -> (String, Result<Value>) {
    match &cli.command {
        Commands::Status => ("status".into(), cmd_status()),
        Commands::Capture { kind } => dispatch_capture(kind),
        Commands::Ocr { target, lang } => ("ocr".into(), cmd_ocr(target, lang)),
        Commands::Annotate { target, script, out } => {
            ("annotate".into(), cmd_annotate(target, script, out))
        }
        Commands::History { limit, query } => ("history".into(), cmd_history(*limit, query)),
        Commands::Open { target } => ("open".into(), cmd_open(target)),
        Commands::Config { action } => cmd_config(action),
        Commands::Doctor => ("doctor".into(), cmd_doctor()),
        Commands::Mcp => {
            mcp::run();
            ("mcp".into(), Ok(json!({"stopped": true})))
        }
    }
}

fn envelope(ok: bool, data: Value, error: Option<Value>, elapsed_ms: u64) -> Value {
    json!({
        "ok": ok,
        "data": data,
        "error": error,
        "meta": { "version": once_core::VERSION, "elapsed_ms": elapsed_ms }
    })
}

fn output(cli: &Cli, payload: &Value, result: &Result<Value>) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    if cli.json {
        let _ = out.write_all(serde_json::to_string_pretty(payload).unwrap_or_default().as_bytes());
        let _ = out.write_all(b"\n");
    } else {
        // 人类可读简文本
        match result {
            Ok(data) => {
                let _ = out.write_all(human_ok(data).as_bytes());
            }
            Err(e) => {
                let hint = if e.hint.is_empty() { String::new() } else { format!("。建议：{}", e.hint) };
                let line = format!(
                    "失败（退出码 {}）· {}{}\n",
                    e.exit as i32, e.message, hint
                );
                let _ = out.write_all(line.as_bytes());
            }
        }
    }
    let _ = out.flush();
}

fn human_ok(data: &Value) -> String {
    let path = data.get("path").and_then(|v| v.as_str());
    if let Some(p) = path {
        let ocr_note = data
            .get("ocr_text_len")
            .map(|n| format!(" · {} 字", n))
            .unwrap_or_default();
        return format!("已保存 {p}{ocr_note}\n");
    }
    if let Some(rows) = data.get("rows").and_then(|v| v.as_array()) {
        let mut s = format!("共 {} 条\n", rows.len());
        for r in rows {
            s.push_str(&format!(
                "{}  [{}]  {}\n",
                r.get("created_at").and_then(|v| v.as_str()).unwrap_or("?"),
                r.get("kind").and_then(|v| v.as_str()).unwrap_or("?"),
                r.get("path").and_then(|v| v.as_str()).unwrap_or("?"),
            ));
        }
        return s;
    }
    let mut s = String::new();
    if let Some(obj) = data.as_object() {
        for (k, v) in obj {
            if k.starts_with('_') {
                continue;
            }
            s.push_str(&format!("{k}: {v}\n"));
        }
    }
    s
}

fn deny_if_agent_disabled() -> Result<()> {
    let s = once_core::settings::load();
    if s.agent_enabled {
        Ok(())
    } else {
        Err(OnceError::denied("Agent 调用已切断（设置：允许本机 Agent 调用定影 = 关）")
            .with_hint("在「Agent 与隐私」页打开总开关，或 once config set agent_enabled true"))
    }
}

fn blacklist_guard(process: &str, title: &str) -> Result<()> {
    let s = once_core::settings::load();
    if let Some(hit) = once_core::blacklist::check(&s, process, title) {
        return Err(OnceError::blacklist(format!(
            "已拦截：目标命中隐私黑名单（{hit}）",
            hit = hit.pattern
        ))
        .with_hint("如需调整，请在「Agent 与隐私」页停用该条目（不提供本次放行）"));
    }
    Ok(())
}

fn save_png_and_record(
    kind: &str,
    bmp: &capture::CapturedBitmap,
    out: Option<&PathBuf>,
    screen: Option<usize>,
    src_window: Option<capture::WindowInfo>,
) -> Result<Value> {
    let png = capture::encode_png(bmp)?;
    let settings = once_core::settings::load();
    let root = settings.save_root();

    let (id, paths) = match out {
        Some(p) => {
            let dir = p.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
            std::fs::create_dir_all(&dir).map_err(|e| {
                OnceError::io(format!("无法创建输出目录 {}", dir.display())).with_source(e.to_string())
            })?;
            let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            storage::write_atomic(p, &png)?;
            let manifest = storage::Manifest {
                id: String::new(),
                file: p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                kind: kind.into(),
                created_at: storage::now_iso(),
                width: bmp.width,
                height: bmp.height,
                screen,
                dpi_scale: layout_scale(),
                screen_layout: Some(capture::screen_layout()),
                source_window: src_window.as_ref().map(|w| storage::SourceWindow {
                    title: w.title.clone(),
                    pid: w.pid,
                    process_name: w.process_name.clone(),
                }),
                parent_id: None,
                script_sha256: None,
                ops_count: None,
                segments: None,
                manual_fixes: None,
            };
            let json = serde_json::to_vec_pretty(&manifest).unwrap_or_default();
            let json_path = p.with_extension("json");
            storage::write_atomic(&json_path, &json).ok();
            let rel_date_dir = dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let id = format!("{}#{}", rel_date_dir, stem);
            (id, storage::AssetPaths { dir, stem, png: p.clone(), json: json_path, rel_date_dir })
        }
        None => {
            let mut manifest = storage::Manifest {
                id: String::new(),
                file: String::new(),
                kind: kind.into(),
                created_at: storage::now_iso(),
                width: bmp.width,
                height: bmp.height,
                screen,
                dpi_scale: layout_scale(),
                screen_layout: Some(capture::screen_layout()),
                source_window: src_window.as_ref().map(|w| storage::SourceWindow {
                    title: w.title.clone(),
                    pid: w.pid,
                    process_name: w.process_name.clone(),
                }),
                parent_id: None,
                script_sha256: None,
                ops_count: None,
                segments: None,
                manual_fixes: None,
            };
            storage::save_capture(&root, kind, &png, &mut manifest)?
        }
    };

    let row = history::HistoryRow {
        id: id.clone(),
        path: paths.png.to_string_lossy().into_owned(),
        kind: kind.into(),
        created_at: storage::now_iso(),
        width: bmp.width,
        height: bmp.height,
        ocr_status: "none".into(),
        ocr_text: String::new(),
        ocr_preview: String::new(),
        annotated: false,
        parent_id: None,
    };
    history::upsert_capture(&row)?;

    Ok(json!({
        "id": id,
        "path": paths.png.to_string_lossy(),
        "kind": kind,
        "width": bmp.width,
        "height": bmp.height,
        "manifest": paths.json.to_string_lossy(),
        "_target_process": src_window.as_ref().map(|w| w.process_name.clone()),
    }))
}

fn layout_scale() -> f32 {
    capture::monitors().first().map(|m| m.dpi_scale).unwrap_or(1.0)
}

fn cmd_status() -> Result<Value> {
    let s = once_core::settings::load();
    let count = history::count().unwrap_or(0);
    Ok(json!({
        "app": "onceglance",
        "version": once_core::VERSION,
        "gui_online": bridge_online(),
        "agent_enabled": s.agent_enabled,
        "auto_capture_enabled": s.auto_capture_enabled,
        "save_dir": s.save_root().to_string_lossy(),
        "save_dir_writable": s.save_dir_writable(),
        "ocr_engine": ocr::engine_language(),
        "hotkeys": s.hotkeys,
        "history_count": count,
    }))
}

fn bridge_online() -> bool {
    std::path::Path::new(r"\\.\pipe\once-bridge").exists()
}

fn dispatch_capture(kind: &CaptureKind) -> (String, Result<Value>) {
    match kind {
        CaptureKind::Region { out, screen, delay, x, y, w, h } => (
            "capture region".into(),
            cmd_capture_region(out.clone(), screen.as_deref(), *delay, *x, *y, *w, *h),
        ),
        CaptureKind::Window { title, pid, out } => {
            ("capture window".into(), cmd_capture_window(title.as_deref(), *pid, out.as_ref()))
        }
        CaptureKind::Fullscreen { screen, out } => {
            ("capture fullscreen".into(), cmd_capture_fullscreen(screen.as_deref(), out.as_ref()))
        }
        CaptureKind::Scroll { .. } => (
            "capture scroll".into(),
            Err(OnceError::usage("长截图需要人工滚动采集，CLI 不能独立完成")
                .with_hint("用全局热键 Alt+Shift+L（GUI 覆盖层引导滚动），或等待 MCP 的 scroll_capture 工具")),
        ),
    }
}

fn gate_and_check_foreground_blacklist() -> Result<()> {
    deny_if_agent_disabled()?;
    if let Some(fg) = capture::foreground_window() {
        blacklist_guard(&fg.process_name, &fg.title)?;
    }
    Ok(())
}

fn cmd_capture_region(
    out: Option<PathBuf>,
    screen: Option<&str>,
    delay: u64,
    x: Option<i32>,
    y: Option<i32>,
    w: Option<u32>,
    h: Option<u32>,
) -> Result<Value> {
    gate_and_check_foreground_blacklist()?;
    if delay > 0 {
        std::thread::sleep(std::time::Duration::from_secs(delay));
    }
    // 指定 --screen：整屏（screen all 走 fullscreen 语义）
    if let Some(sc) = screen {
        return match sc {
            "all" => cmd_capture_fullscreen(Some("all"), out.as_ref()),
            n => {
                let idx: usize = n.parse().map_err(|_| OnceError::usage("--screen 需要数字或 all"))?;
                deny_if_agent_disabled()?;
                let bmp = capture::capture_monitor(idx)?;
                save_png_and_record("fullscreen", &bmp, out.as_ref(), Some(idx), None)
            }
        };
    }
    match (x, y, w, h) {
        (Some(x), Some(y), Some(w), Some(h)) => {
            let t0 = Instant::now();
            let bmp = capture::capture_region_px(x, y, w, h)?;
            let _ = t0;
            save_png_and_record("region", &bmp, out.as_ref(), None, None)
        }
        _ => {
            if bridge_online() {
                // GUI 在线：请覆盖层交互采集（经管道触发；M2 接通）
                Err(OnceError::usage("区域截图需要 GUI 覆盖层框选；当前桥接路径未接通")
                    .with_hint("此链路将在 GUI 桥接（M2）可用，或使用扩展参数 --x --y --w --h 直接指定物理像素区域"))
            } else {
                Err(OnceError::usage("区域截图需要 GUI 覆盖层框选")
                    .with_hint("无 GUI 时请使用扩展参数 --x --y --w --h（物理像素），或用 capture window / fullscreen"))
            }
        }
    }
}

fn cmd_capture_window(title: Option<&str>, pid: Option<u32>, out: Option<&PathBuf>) -> Result<Value> {
    deny_if_agent_disabled()?;
    let target = match (title, pid) {
        (Some(t), _) => capture::find_window_by_title(t).ok_or_else(|| {
            OnceError::capture(format!("未找到标题含「{t}」的窗口")).with_hint("可先运行 once status 查看实例；确认窗口未最小化")
        })?,
        (_, Some(p)) => capture::find_window_by_pid(p).ok_or_else(|| {
            OnceError::capture(format!("未找到 PID {p} 对应的窗口"))
        })?,
        _ => capture::foreground_window().ok_or_else(|| {
            OnceError::capture("无法确定前台窗口")
        })?,
    };
    blacklist_guard(&target.process_name, &target.title)?;
    let t0 = Instant::now();
    let bmp = capture::capture_window_hwnd(target.hwnd)?;
    let _ = t0;
    let mut v = save_png_and_record("window", &bmp, out, Some(target.monitor_index), Some(target.clone()))?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert("source_window".into(), json!({
            "title": target.title,
            "pid": target.pid,
            "process_name": target.process_name,
        }));
    }
    Ok(v)
}

fn cmd_capture_fullscreen(screen: Option<&str>, out: Option<&PathBuf>) -> Result<Value> {
    deny_if_agent_disabled()?;
    // 全屏也要过黑名单：检查前台窗口
    if let Some(fg) = capture::foreground_window() {
        blacklist_guard(&fg.process_name, &fg.title)?;
    }
    match screen {
        Some("all") => {
            let bmps = capture::capture_all_monitors()?;
            let mut saved = Vec::new();
            for (i, bmp) in bmps.iter().enumerate() {
                saved.push(save_png_and_record("fullscreen", bmp, out, Some(i + 1), None)?);
            }
            Ok(json!({ "screens": saved, "count": saved.len() }))
        }
        other => {
            let idx: usize = other
                .and_then(|s| s.parse().ok())
                .unwrap_or(1);
            let bmp = capture::capture_monitor(idx)?;
            save_png_and_record("fullscreen", &bmp, out, Some(idx), None)
        }
    }
}

fn resolve_target(target: &str) -> Result<PathBuf> {
    if target == "last" {
        let row = history::last_capture().ok_or_else(|| {
            OnceError::usage("没有可用的最近捕获（last）").with_hint("先执行 once capture window/fullscreen")
        })?;
        return Ok(PathBuf::from(row.path));
    }
    let p = PathBuf::from(target);
    if !p.exists() {
        return Err(OnceError::io(format!("文件不存在：{}", p.display())));
    }
    Ok(p)
}

fn cmd_ocr(target: &str, lang: &str) -> Result<Value> {
    let path = resolve_target(target)?;
    let png = std::fs::read(&path)
        .map_err(|e| OnceError::io(format!("读取失败：{}", path.display())).with_source(e.to_string()))?;
    let _ = lang; // v1 引擎按系统语言；auto 保留参数位

    // §9：引擎异常重试 1 次
    let result = match ocr::provider().recognize_png(&png) {
        Ok(r) => r,
        Err(e) => match ocr::provider().recognize_png(&png) {
            Ok(r) => r,
            Err(e2) => {
                return Err(OnceError::ocr(format!("OCR 失败（已重试 1 次）：{}", e2.message))
                    .with_hint("图片需为 PNG；系统需安装中文/英文 OCR 语言包")
                    .with_source(e.source.clone().unwrap_or_default()))
            }
        },
    };

    // 结果缓存：<stem>.ocr.json（OCR-5 内容寻址由 manifest 关联）
    let stem_path = path.with_extension("");
    let ocr_json_path = stem_path.with_file_name(format!(
        "{}.ocr.json",
        stem_path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    let doc = json!({
        "source": path.to_string_lossy(),
        "engine": ocr::provider().name(),
        "language": result.language,
        "blocks": result.blocks,
        "full_text": result.full_text,
        "empty_reason": result.empty_reason,
        "created_at": storage::now_iso(),
    });
    storage::write_atomic(&ocr_json_path, &serde_json::to_vec_pretty(&doc).unwrap_or_default())?;

    // 历史状态更新
    if target == "last" {
        if let Some(row) = history::last_capture() {
            let status = if result.blocks.is_empty() { "empty" } else { "done" };
            history::update_ocr(&row.id, status, &result.full_text).ok();
        }
    }

    Ok(json!({
        "path": path.to_string_lossy(),
        "ocr_json": ocr_json_path.to_string_lossy(),
        "language": result.language,
        "blocks": result.blocks,
        "full_text": result.full_text,
        "empty_reason": result.empty_reason,
        "width": result.width,
        "height": result.height,
        "ocr_text_len": result.full_text.chars().count(),
    }))
}

fn sha256_hex(bytes: &[u8]) -> String {
    // 轻量 FNV-1a 128？不行——ANN-4 要脚本哈希可复现即可，但用标准 SHA-256 更稳妥。
    // 为避免额外依赖，用兼容实现：此处用 twox 风格不可接受，改为内置 sha2 不可得 →
    // 决定：引入 sha2 依赖（见 Cargo.toml）。
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    let out = h.finalize();
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn cmd_annotate(target: &str, script_path: &PathBuf, out: &PathBuf) -> Result<Value> {
    let script_bytes = std::fs::read(script_path)
        .map_err(|e| OnceError::io(format!("脚本读取失败：{}", script_path.display())).with_source(e.to_string()))?;
    let script: annotate::AnnotationScript = serde_json::from_slice(&script_bytes).map_err(|e| {
        OnceError::usage(format!("标注脚本 JSON 解析失败：{e}")).with_hint("schema 见 PRD §4.3；字段名请勿自造")
    })?;
    annotate_impl(target, &script, Some(script_bytes), out)
}

/// 标注核心（CLI 与 MCP 共用）。
pub(crate) fn annotate_impl(
    target: &str,
    script: &annotate::AnnotationScript,
    known_bytes: Option<Vec<u8>>,
    out: &PathBuf,
) -> Result<Value> {
    let path = resolve_target(target)?;
    let png = std::fs::read(&path)
        .map_err(|e| OnceError::io(format!("读取失败：{}", path.display())).with_source(e.to_string()))?;
    let script_bytes =
        known_bytes.unwrap_or_else(|| serde_json::to_vec(script).unwrap_or_default());

    // 衍生图永不覆盖原图（硬约束 4）：--out 指向原图或已存在 → 自动 -ann2 递增
    let mut out = out.clone();
    let is_same = out == path
        || (out.exists()
            && path.canonicalize().ok().map(|c| Some(c) == out.canonicalize().ok()).unwrap_or(false));
    if is_same || out.exists() {
        out = storage::derivative_png_path(&path);
    }

    let settings = once_core::settings::load();
    let anchors = annotate::load_anchor_blocks(&path);
    let rendered = annotate::render(&annotate::RenderInput {
        png: &png,
        script: &script,
        anchor_blocks: anchors.as_deref(),
        defaults: &settings.annotation,
    })?;
    storage::write_atomic(&out, &rendered.png)?;

    // 记录：衍生表 + manifest
    let parent_id = history::get_by_id_or_path(&path.to_string_lossy())
        .map(|r| r.id)
        .unwrap_or_default();
    let script_hash = sha256_hex(&script_bytes);
    let stem = out.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let did = format!(
        "{}#{}",
        out.parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        stem
    );
    history::upsert_derivative(&history::DerivativeRow {
        id: did.clone(),
        parent_id: parent_id.clone(),
        path: out.to_string_lossy().into_owned(),
        ops_count: script.operations.len() as u32,
        script_sha256: script_hash.clone(),
        created_at: storage::now_iso(),
    })?;

    // 衍生 manifest：lineage 指回原图（CLP-4）
    let parent_manifest: Value = std::fs::read(path.with_extension("json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let manifest = json!({
        "id": did,
        "file": out.file_name().map(|s| s.to_string_lossy()).unwrap_or_default(),
        "kind": "annotated",
        "created_at": storage::now_iso(),
        "width": rendered.width,
        "height": rendered.height,
        "parent_id": parent_id,
        "parent_file": path.file_name().map(|s| s.to_string_lossy()).unwrap_or_default(),
        "script_sha256": script_hash,
        "ops_count": script.operations.len(),
        "inherits": parent_manifest,
    });
    let json_path = out.with_extension("json");
    storage::write_atomic(&json_path, &serde_json::to_vec_pretty(&manifest).unwrap_or_default()).ok();

    Ok(json!({
        "id": did,
        "path": out.to_string_lossy(),
        "parent": path.to_string_lossy(),
        "ops_count": script.operations.len(),
        "script_sha256": script_hash,
        "manifest": json_path.to_string_lossy(),
    }))
}

fn cmd_history(limit: usize, query: &str) -> Result<Value> {
    let rows = history::search(query, limit)?;
    Ok(json!({ "count": rows.len(), "rows": rows }))
}

fn cmd_open(target: &str) -> Result<Value> {
    let row = history::get_by_id_or_path(target);
    let path = match row {
        Some(r) => PathBuf::from(r.path),
        None => PathBuf::from(target),
    };
    if !path.exists() {
        return Err(OnceError::io(format!("文件不存在：{}", path.display())));
    }
    let status = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn();
    match status {
        Ok(_) => Ok(json!({ "opened": path.to_string_lossy() })),
        Err(e) => Err(OnceError::io("无法打开资源管理器").with_source(e.to_string())),
    }
}

fn cmd_config(action: &ConfigAction) -> (String, Result<Value>) {
    match action {
        ConfigAction::Get { key } => ("config get".into(), config_get(key)),
        ConfigAction::Set { key, value } => ("config set".into(), config_set(key, value)),
    }
}

/// 扁平键位映射（冻结对外键名，内部结构可演进）。
const CONFIG_KEYS: &[(&str, &str)] = &[
    ("agent_enabled", "bool"),
    ("auto_capture_enabled", "bool"),
    ("save_dir", "string|null"),
    ("default_action", "string"),
    ("remember_annotation", "bool"),
    ("keep_days", "int|null"),
    ("hotkeys.region", "string"),
    ("hotkeys.window", "string"),
    ("hotkeys.fullscreen", "string"),
    ("hotkeys.ocr", "string"),
    ("hotkeys.scroll", "string"),
    ("hotkeys.panel", "string"),
];

fn config_get(key: &str) -> Result<Value> {
    let s = once_core::settings::load();
    let v = match key {
        "agent_enabled" => json!(s.agent_enabled),
        "auto_capture_enabled" => json!(s.auto_capture_enabled),
        "save_dir" => s.save_dir.clone().map(|v| json!(v)).unwrap_or(Value::Null),
        "default_action" => json!(s.default_action),
        "remember_annotation" => json!(s.remember_annotation),
        "keep_days" => s.keep_days.map(|v| json!(v)).unwrap_or(Value::Null),
        "hotkeys.region" => json!(s.hotkeys.region),
        "hotkeys.window" => json!(s.hotkeys.window),
        "hotkeys.fullscreen" => json!(s.hotkeys.fullscreen),
        "hotkeys.ocr" => json!(s.hotkeys.ocr),
        "hotkeys.scroll" => json!(s.hotkeys.scroll),
        "hotkeys.panel" => json!(s.hotkeys.panel),
        other => {
            return Err(OnceError::usage(format!("未知设置键：{other}")).with_hint(format!(
                "可用键：{}",
                CONFIG_KEYS.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", ")
            )))
        }
    };
    Ok(json!({ "key": key, "value": v }))
}

fn config_set(key: &str, value: &str) -> Result<Value> {
    let known = CONFIG_KEYS.iter().any(|(k, _)| *k == key);
    if !known {
        return Err(OnceError::usage(format!("未知设置键：{key}")).with_hint(format!(
            "可用键：{}",
            CONFIG_KEYS.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", ")
        )));
    }
    // 值解析：true/false/数字/JSON null/字符串
    let parsed: Value = match value {
        "true" => json!(true),
        "false" => json!(false),
        "null" => Value::Null,
        v if v.parse::<i64>().is_ok() => json!(v.parse::<i64>().unwrap()),
        v => json!(v),
    };
    once_core::settings::update(|s| {
        match key {
            "agent_enabled" => s.agent_enabled = parsed.as_bool().unwrap_or(s.agent_enabled),
            "auto_capture_enabled" => {
                s.auto_capture_enabled = parsed.as_bool().unwrap_or(s.auto_capture_enabled)
            }
            "save_dir" => {
                s.save_dir = parsed.as_str().map(|x| x.to_string()).filter(|x| !x.is_empty())
            }
            "default_action" => {
                if let Some(v) = parsed.as_str() {
                    if ["copy_image", "ocr_copy", "save_only"].contains(&v) {
                        s.default_action = v.into();
                    }
                }
            }
            "remember_annotation" => {
                s.remember_annotation = parsed.as_bool().unwrap_or(s.remember_annotation)
            }
            "keep_days" => s.keep_days = parsed.as_u64().map(|v| v as u32),
            "hotkeys.region" => {
                if let Some(v) = parsed.as_str() { s.hotkeys.region = v.into() }
            }
            "hotkeys.window" => {
                if let Some(v) = parsed.as_str() { s.hotkeys.window = v.into() }
            }
            "hotkeys.fullscreen" => {
                if let Some(v) = parsed.as_str() { s.hotkeys.fullscreen = v.into() }
            }
            "hotkeys.ocr" => {
                if let Some(v) = parsed.as_str() { s.hotkeys.ocr = v.into() }
            }
            "hotkeys.scroll" => {
                if let Some(v) = parsed.as_str() { s.hotkeys.scroll = v.into() }
            }
            "hotkeys.panel" => {
                if let Some(v) = parsed.as_str() { s.hotkeys.panel = v.into() }
            }
            _ => {}
        };
    })?;
    config_get(key)
}

fn cmd_doctor() -> Result<Value> {
    let s = once_core::settings::load();
    let mut items: Vec<Value> = Vec::new();
    let mut all_ok = true;

    // 1 实例
    items.push(json!({ "check": "instance", "ok": true, "detail": "单实例 CLI 直接驱动内核" }));
    // 2 热键（GUI 注册；CLI 只报告）
    let hotkeys_note = if bridge_online() { "GUI 在线，热键由 GUI 注册" } else { "GUI 离线，热键未注册（CLI 不注册热键）" };
    items.push(json!({ "check": "hotkeys", "ok": true, "detail": hotkeys_note }));
    // 3 捕获自检：屏幕角落 64×64 非全黑
    let cap_ok = (|| -> Result<bool> {
        let vd = capture::virtual_desktop();
        let bmp = capture::capture_region_px(vd.0 + vd.2 - 64, vd.1 + vd.3 - 64, 64, 64)?;
        Ok(!bmp.pixels.chunks_exact(4).all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0))
    })()
    .unwrap_or(false);
    if !cap_ok { all_ok = false; }
    items.push(json!({
        "check": "capture",
        "ok": cap_ok,
        "detail": if cap_ok { "角落捕获非全黑" } else { "捕获失败或全黑（检查驱动/杀软）" }
    }));
    // 4 落盘目录
    let dir_ok = s.save_dir_writable();
    if !dir_ok { all_ok = false; }
    items.push(json!({
        "check": "save_dir",
        "ok": dir_ok,
        "detail": format!("{} ({})", s.save_root().display(), if dir_ok { "可写" } else { "不可写" })
    }));
    // 4.5 MCP 就绪：总开关决定 MCP 是否可被 Agent 调用
    items.push(json!({
        "check": "mcp",
        "ok": s.agent_enabled,
        "detail": if s.agent_enabled { "Agent 调用已启用（MCP 可用）".to_string() } else { "agent_enabled=false，Agent 调用被拒".to_string() }
    }));
    // 5 OCR 引擎
    let ocr_ok = ocr::engine_available();
    if !ocr_ok { all_ok = false; }
    items.push(json!({
        "check": "ocr_engine",
        "ok": ocr_ok,
        "detail": format!("{} ({})", ocr::engine_language(), if ocr_ok { "可用" } else { "不可用，检查系统语言包" })
    }));
    // 6 桥接
    let bridge = bridge_online();
    items.push(json!({ "check": "bridge", "ok": true, "detail": if bridge { "Named Pipe 在线" } else { "GUI 离线；CLI 直接驱动内核（共享历史与设置）" } }));
    // 7 运行时（WebView2 / 系统）
    let webview2 = webview2_present();
    if !webview2 { all_ok = false; }
    items.push(json!({
        "check": "runtime",
        "ok": webview2,
        "detail": if webview2 { "WebView2 Runtime 已安装" } else { "未检测到 WebView2 Runtime，GUI 将无法启动" }
    }));

    Ok(json!({
        "ok_all": all_ok,
        "items": items,
    }))
}

fn webview2_present() -> bool {
    [
        r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application",
        r"C:\Program Files\Microsoft\EdgeWebView\Application",
    ]
    .iter()
    .any(|p| {
        std::fs::read_dir(p)
            .map(|entries| {
                entries.filter_map(|e| e.ok()).any(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_digit())
                })
            })
            .unwrap_or(false)
    })
}

// ===== MCP 复用入口（mcp.rs 调用；与 CLI 命令走同一内核路径） =====

pub(crate) fn cmd_capture_window_for_mcp(title: Option<&str>, pid: Option<u32>) -> Result<Value> {
    cmd_capture_window(title, pid, None)
}

pub(crate) fn cmd_capture_fullscreen_for_mcp(screen: Option<&str>) -> Result<Value> {
    cmd_capture_fullscreen(screen, None)
}

pub(crate) fn cmd_capture_region_px_for_mcp(x: i32, y: i32, w: u32, h: u32) -> Result<Value> {
    gate_and_check_foreground_blacklist()?;
    let bmp = capture::capture_region_px(x, y, w, h)?;
    save_png_and_record("region", &bmp, None, None, None)
}

pub(crate) fn cmd_ocr_for_mcp(target: &str) -> Result<Value> {
    cmd_ocr(target, "auto")
}

pub(crate) fn cmd_annotate_for_mcp(
    target: &str,
    script: &annotate::AnnotationScript,
) -> Result<Value> {
    let out = std::env::temp_dir().join(format!(
        "once-mcp-ann-{}.png",
        chrono::Local::now().format("%H%M%S%3f")
    ));
    annotate_impl(target, script, None, &out)
}

pub(crate) fn cmd_history_for_mcp(query: &str, limit: usize) -> Result<Value> {
    cmd_history(limit, query)
}

pub(crate) fn cmd_doctor_for_mcp() -> Result<Value> {
    cmd_doctor()
}
