//! Agent 客户端 MCP 注册中心（路线图 Phase 1）。
//! 接入单位是"配置文件"，不是"家族"：共用配置的形态注册一次双端生效，独立配置各接一次。
//! 铁律：写前必备份（`<appdata>/Onceglance/agent-backups`）；只合并自身条目，不碰用户其他内容；
//!       配置文件内容（常含密钥）绝不进日志、不进返回值——对外只暴露"写入了什么条目"。

use crate::error::{OnceError, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const OUR_KEY: &str = "onceglance";

#[derive(Debug, Clone, Serialize)]
pub struct AgentEntry {
    pub id: String,
    pub family: String,
    /// 桌面 | CLI
    pub form: String,
    pub config_path: String,
    pub client_installed: bool,
    pub registered: bool,
    /// connected（真实握手/在跑的连接）| awaiting（已写入·等待首次连接）| none
    pub conn: String,
    /// 最近一次握手来源父进程名（空=尚无握手记录）
    pub last_handshake_from: String,
    /// file（写配置文件）| cli（官方命令注册）| copy-only（应用内配置，提供复制）
    pub mode: String,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegisterOutcome {
    pub id: String,
    pub config_path: String,
    pub backup_path: Option<String>,
    /// 写入的条目（仅自身，供 GUI 预览；绝不包含配置文件全量）
    pub entry: serde_json::Value,
    pub via_cli: bool,
    pub already: bool,
}

/// 注册用的路径集合（全部可注入以便测试）。
pub struct Dirs<'a> {
    pub appdata: &'a Path,
    pub home: &'a Path,
}

fn claude_desktop_cfg(appdata: &Path) -> PathBuf {
    appdata.join("Claude").join("claude_desktop_config.json")
}
fn claude_code_cfg(home: &Path) -> PathBuf {
    home.join(".claude.json")
}
fn cursor_cfg(home: &Path) -> PathBuf {
    home.join(".cursor").join("mcp.json")
}
fn codex_cfg(home: &Path) -> PathBuf {
    home.join(".codex").join("config.toml")
}
fn vscode_cfg(appdata: &Path) -> PathBuf {
    appdata.join("Code").join("User").join("mcp.json")
}
fn trae_cn_cfg(appdata: &Path) -> PathBuf {
    appdata.join("Trae CN").join("User").join("mcp.json")
}
fn zcode_cfg(home: &Path) -> PathBuf {
    home.join(".zcode").join("cli").join("config.json")
}
fn backup_dir(appdata: &Path) -> PathBuf {
    appdata.join("Onceglance").join("agent-backups")
}

fn handshake_path(appdata: &Path) -> PathBuf {
    appdata.join("Onceglance").join("mcp-handshake.json")
}

fn registry_path(appdata: &Path) -> PathBuf {
    appdata.join("Onceglance").join("agent-registry.json")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- 连接证据（握手记录 / 进程检测 / 注册时刻）----

/// MCP 服务端收到 initialize 时调用：记录握手时间戳与来源父进程。
/// 尽力而为，任何失败静默忽略——绝不干扰 MCP 协议层。
pub fn record_handshake() {
    let Some(appdata) = dirs::data_dir() else { return };
    record_handshake_at(&appdata);
}

/// 可注入路径版本（测试与工具用）。
pub fn record_handshake_at(appdata: &Path) {
    let appdata = appdata.to_path_buf();
    let client = parent_process_name().unwrap_or_else(|| "unknown".into());
    let mut root = read_json(&handshake_path(appdata.as_path())).unwrap_or_else(|| serde_json::json!({}));
    let Some(obj) = root.as_object_mut() else { return };
    let hs = obj
        .entry("handshakes")
        .or_insert_with(|| serde_json::json!({}));
    let Some(hs) = hs.as_object_mut() else { return };
    let e = hs
        .entry(client.clone())
        .or_insert_with(|| serde_json::json!({ "count": 0 }));
    if let Some(e) = e.as_object_mut() {
        let count = e.get("count").and_then(|v| v.as_u64()).unwrap_or(0) + 1;
        e.insert("count".into(), serde_json::json!(count));
        e.insert("last_ts".into(), serde_json::json!(now_ms()));
    }
    obj.insert("last_ts".into(), serde_json::json!(now_ms()));
    obj.insert("last_from".into(), serde_json::json!(client));
    if let Ok(bytes) = serde_json::to_vec_pretty(&root) {
        let p = handshake_path(appdata.as_path());
        let _ = std::fs::create_dir_all(p.parent().unwrap_or(Path::new(".")));
        let _ = crate::storage::write_atomic(&p, &bytes);
    }
}

/// 最近一次握手：(时间戳, 来源父进程)。
pub fn last_handshake(appdata: &Path) -> Option<(u64, String)> {
    let v = read_json(&handshake_path(appdata))?;
    let ts = v.get("last_ts").and_then(|x| x.as_u64())?;
    let from = v
        .get("last_from")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    Some((ts, from))
}

fn registry_get(appdata: &Path, id: &str) -> Option<u64> {
    read_json(&registry_path(appdata))?
        .get("agents")?
        .get(id)?
        .as_u64()
}

fn registry_set(appdata: &Path, id: &str, ts: u64) {
    let mut root = read_json(&registry_path(appdata)).unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        return;
    }
    if let Some(obj) = root.as_object_mut() {
        let agents = obj.entry("agents").or_insert_with(|| serde_json::json!({}));
        if let Some(a) = agents.as_object_mut() {
            a.insert(id.to_string(), serde_json::json!(ts));
        }
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&root) {
        let p = registry_path(appdata);
        let _ = std::fs::create_dir_all(p.parent().unwrap_or(Path::new(".")));
        let _ = crate::storage::write_atomic(&p, &bytes);
    }
}

fn registry_clear(appdata: &Path, id: &str) {
    let mut root = read_json(&registry_path(appdata)).unwrap_or_default();
    if let Some(a) = root
        .get_mut("agents")
        .and_then(|v| v.as_object_mut())
    {
        a.remove(id);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&root) {
        let p = registry_path(appdata);
        let _ = std::fs::create_dir_all(p.parent().unwrap_or(Path::new(".")));
        let _ = crate::storage::write_atomic(&p, &bytes);
    }
}

fn process_snapshot() -> Vec<(u32, u32, String)> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
        PROCESSENTRY32W,
    };
    let mut out: Vec<(u32, u32, String)> = Vec::new();
    unsafe {
        let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return out,
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let name = String::from_utf16_lossy(
                    &entry.szExeFile[..entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(0)],
                );
                out.push((entry.th32ProcessID, entry.th32ParentProcessID, name));
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snap);
    }
    out
}

/// 来源父进程名（谁拉起了本 MCP 进程）。
pub fn parent_process_name() -> Option<String> {
    let cur = std::process::id();
    let procs = process_snapshot();
    let ppid = procs
        .iter()
        .find(|(pid, _, _)| *pid == cur)
        .map(|(_, ppid, _)| *ppid)?;
    procs
        .iter()
        .find(|(pid, _, _)| *pid == ppid)
        .map(|(_, _, name)| name.clone())
}

/// 当前在跑的 once.exe MCP 会话数（0 = 没有任何客户端连着）。
pub fn mcp_children_running() -> usize {
    process_snapshot()
        .iter()
        .filter(|(_, _, name)| name.eq_ignore_ascii_case("once.exe"))
        .count()
}

/// 连接态三值：connected（注册后有握手或连接在跑）/ awaiting（已写入·等待首次连接）/ none。
const HANDSHAKE_GRACE_MS: u64 = 30 * 60 * 1000;

pub fn conn_state(
    appdata: &Path,
    id: &str,
    registered: bool,
    hs: Option<(u64, String)>,
    mcp_running: bool,
) -> (String, String) {
    if !registered {
        return ("none".into(), String::new());
    }
    let from = hs.as_ref().map(|(_, f)| f.clone()).unwrap_or_default();
    let ra = registry_get(appdata, id);
    let strong = match (ra, &hs) {
        // 握手晚于注册，或此刻就有活跃的 mcp 连接，或注册前宽限窗口内有过握手——
        // 能对 once mcp 完成握手的只有配置过它的客户端，所以「先在客户端里接入、
        // 再回面板点一键接入」时，注册前的握手就是同一条链路的连接证据
        (Some(ra), Some((ts, _))) => {
            *ts >= ra || mcp_running || *ts + HANDSHAKE_GRACE_MS >= ra
        }
        // 升级边缘：老连接已在跑而握手尚未记录（该客户端接入前就已连着）
        (Some(_), None) => mcp_running,
        _ => false,
    };
    (
        if strong { "connected".into() } else { "awaiting".into() },
        from,
    )
}

fn backup_file(appdata: &Path, id: &str, cfg: &Path) -> Result<Option<String>> {
    if !cfg.exists() {
        return Ok(None);
    }
    let dir = backup_dir(appdata);
    std::fs::create_dir_all(&dir)
        .map_err(|e| OnceError::io("无法创建备份目录").with_source(e.to_string()))?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dst = dir.join(format!("{id}-{ms}.bak"));
    std::fs::copy(cfg, &dst)
        .map_err(|e| OnceError::io("备份失败，已中止写入").with_source(e.to_string()))?;
    Ok(Some(dst.to_string_lossy().into_owned()))
}

fn mcp_entry(once_exe: &Path) -> serde_json::Value {
    serde_json::json!({ "command": once_exe.to_string_lossy(), "args": ["mcp"] })
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// 在 JSON 对象的嵌套容器（如 mcpServers / mcp.servers / servers）下合并自身条目。
/// 文件不存在则以空对象为基；容器缺失则逐级创建；其余键原样保留。
fn json_merge(path: &Path, containers: &[&str], entry: &serde_json::Value) -> Result<bool> {
    let mut root = read_json(path).unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        return Err(OnceError::usage(format!(
            "{} 不是合法的 JSON 对象，拒绝写入（已保留原文件，备份目录可手动恢复）",
            path.display()
        )));
    }
    let mut cur = &mut root;
    for key in containers {
        cur = cur
            .as_object_mut()
            .expect("root is object")
            .entry(key.to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !cur.is_object() {
            return Err(OnceError::usage(format!(
                "{} 中 {key} 不是对象，拒绝写入",
                path.display()
            )));
        }
    }
    cur.as_object_mut()
        .expect("container is object")
        .insert(OUR_KEY.to_string(), entry.clone());
    let bytes = serde_json::to_vec_pretty(&root)
        .map_err(|e| OnceError::io("JSON 序列化失败").with_source(e.to_string()))?;
    let mut out = bytes;
    out.push(b'\n');
    std::fs::write(path, &out)
        .map_err(|e| OnceError::io("配置写入失败").with_source(e.to_string()))?;
    Ok(true)
}

fn json_registered(path: &Path, containers: &[&str]) -> bool {
    let Some(mut cur) = read_json(path) else {
        return false;
    };
    for key in containers {
        cur = match cur.get(key) {
            Some(v) => v.clone(),
            None => return false,
        };
    }
    cur.get(OUR_KEY).is_some()
}

// ---- TOML（Codex：文本追加/切除节，保证原文件其余字节不动）----

fn toml_section_header() -> String {
    format!("[mcp_servers.{OUR_KEY}]")
}

fn toml_register(path: &Path, once_exe: &Path) -> Result<()> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    if text.contains(&toml_section_header()) {
        return Ok(()); // 幂等
    }
    // Windows 路径优先用 TOML 字面量字符串（不转义反斜杠）；含单引号时退回转义的基本字符串
    let p = once_exe.to_string_lossy();
    let cmd_line = if p.contains('\'') {
        format!("command = \"{}\"", p.replace('\\', "\\\\"))
    } else {
        format!("command = '{p}'")
    };
    let mut out = text.clone();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&format!(
        "{}\n{cmd_line}\nargs = [\"mcp\"]\n",
        toml_section_header()
    ));
    std::fs::write(path, out).map_err(|e| OnceError::io("TOML 写入失败").with_source(e.to_string()))
}

fn toml_unregister(path: &Path) -> Result<()> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let Some(start) = text.find(&toml_section_header()) else {
        return Ok(());
    };
    let after = &text[start..];
    let end = after
        ['['.len_utf8()..]
        .find("\n[")
        .map(|i| start + 1 + i + 1) // 指向下一个节头行首
        .unwrap_or(text.len());
    let mut out = String::new();
    out.push_str(&text[..start]);
    out.push_str(text[end..].trim_start_matches('\n'));
    std::fs::write(path, out).map_err(|e| OnceError::io("TOML 移除失败").with_source(e.to_string()))
}

// ---- JSONC（Trae：文本插入/切除自身块，保留注释与原格式）----

fn trae_insert_block(once_exe: &Path) -> String {
    let p = once_exe.to_string_lossy().replace('\\', "\\\\");
    format!(
        "\n    \"{OUR_KEY}\": {{\n      \"command\": \"{p}\",\n      \"args\": [\"mcp\"]\n    }},"
    )
}

fn trae_register(path: &Path, once_exe: &Path) -> Result<()> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    if text.contains(&format!("\"{OUR_KEY}\"")) {
        return Ok(()); // 幂等
    }
    let block = trae_insert_block(once_exe);
    let mut out = text.clone();
    if let Some(i) = text.find("\"mcpServers\"") {
        // 在 mcpServers 的开括号后插入，保留既有条目与注释
        let brace = text[i..]
            .find('{')
            .ok_or_else(|| OnceError::usage("mcpServers 缺少开括号，拒绝写入"))?;
        let at = i + brace + 1;
        out.insert_str(at, &block);
    } else if text.trim().is_empty() {
        out = format!(
            "{{\n  \"mcpServers\": {{{}\n  }}\n}}\n",
            block.trim_start_matches('\n')
        );
    } else {
        return Err(OnceError::usage(
            "未找到 mcpServers 容器，拒绝写入（已保留原文件）",
        ));
    }
    std::fs::write(path, out).map_err(|e| OnceError::io("写入失败").with_source(e.to_string()))
}

fn trae_unregister(path: &Path) -> Result<()> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    if !text.contains(&format!("\"{OUR_KEY}\"")) {
        return Ok(());
    }
    // 花括号配对切除（字符串字面量感知），与写入时的路径/缩进无关
    let Some((start, end)) = trae_block_range(&text) else {
        return Err(OnceError::usage(
            "条目格式异常无法自动移除；请从备份目录恢复或手动编辑",
        ));
    };
    let out = format!("{}{}", &text[..start], &text[end..]);
    std::fs::write(path, out).map_err(|e| OnceError::io("移除失败").with_source(e.to_string()))
}

/// 定位 onceglance 条目的字节区间（含行首缩进与尾随逗号）。
fn trae_block_range(text: &str) -> Option<(usize, usize)> {
    let ki = text.find(&format!("\"{OUR_KEY}\""))?;
    let bs = text[ki..].find('{')? + ki;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut esc = false;
    for (i, ch) in text[bs..].char_indices() {
        if in_str {
            if esc {
                esc = false;
            } else if ch == '\\' {
                esc = true;
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        match ch {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    let mut end = bs + i + 1;
                    if text[end..].starts_with(',') {
                        end += 1;
                    }
                    let mut ls = text[..ki].rfind('\n').map(|p| p + 1).unwrap_or(0);
                    // 吸收块前导换行（插入块自带 \n，切除时一并带走才能逐字节还原）
                    if ls > 0 && text.as_bytes()[ls - 1] == b'\n' {
                        ls -= 1;
                    }
                    return Some((ls, end));
                }
            }
            _ => {}
        }
    }
    None
}

// ---- Claude Code 官方命令 ----

pub fn claude_cli_available() -> bool {
    std::process::Command::new("claude")
        .arg("--version")
        .creation_flags_no_window()
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}
impl NoWindow for std::process::Command {
    #[cfg(windows)]
    fn creation_flags_no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    fn creation_flags_no_window(&mut self) -> &mut Self {
        self
    }
}

fn claude_code_via_cli(add: bool, once_exe: Option<&Path>) -> Result<bool> {
    let mut cmd = std::process::Command::new("claude");
    if add {
        cmd.args(["mcp", "add", OUR_KEY, "--scope", "user", "--"])
            .arg(once_exe.expect("add 模式必须提供 once.exe 路径"))
            .arg("mcp");
    } else {
        cmd.args(["mcp", "remove", OUR_KEY]);
    }
    cmd.creation_flags_no_window();
    let out = cmd
        .output()
        .map_err(|e| OnceError::io("claude 命令执行失败").with_source(e.to_string()))?;
    Ok(out.status.success())
}

// ---- 对外 API ----

/// 探测列表（顺序即 GUI 展示顺序）。
pub fn list(appdata: &Path, home: &Path) -> Vec<AgentEntry> {
    let hs = last_handshake(appdata);
    let running = mcp_children_running() > 0;
    let mut defs: Vec<AgentEntry> = vec![
        AgentEntry {
            id: "claude-desktop".into(),
            family: "Claude Desktop".into(),
            form: "桌面".into(),
            config_path: claude_desktop_cfg(appdata).to_string_lossy().into_owned(),
            client_installed: claude_desktop_cfg(appdata).parent().map(|p| p.exists()).unwrap_or(false),
            registered: json_registered(&claude_desktop_cfg(appdata), &["mcpServers"]),
            conn: String::new(),
            last_handshake_from: String::new(),
            mode: "file".into(),
            hint: String::new(),
        },
        AgentEntry {
            id: "claude-code".into(),
            family: "Claude Code".into(),
            form: "CLI".into(),
            config_path: claude_code_cfg(home).to_string_lossy().into_owned(),
            client_installed: claude_code_cfg(home).exists() || claude_cli_available(),
            registered: json_registered(&claude_code_cfg(home), &["mcpServers"]),
            conn: String::new(),
            last_handshake_from: String::new(),
            mode: "cli".into(),
            hint: "优先用官方命令 claude mcp add 注册；无 CLI 时降级写配置文件".into(),
        },
        AgentEntry {
            id: "cursor".into(),
            family: "Cursor".into(),
            form: "桌面".into(),
            config_path: cursor_cfg(home).to_string_lossy().into_owned(),
            client_installed: home.join(".cursor").exists(),
            registered: json_registered(&cursor_cfg(home), &["mcpServers"]),
            conn: String::new(),
            last_handshake_from: String::new(),
            mode: "file".into(),
            hint: String::new(),
        },
        AgentEntry {
            id: "codex".into(),
            family: "Codex".into(),
            form: "CLI/IDE 扩展".into(),
            config_path: codex_cfg(home).to_string_lossy().into_owned(),
            client_installed: home.join(".codex").exists(),
            registered: {
                let p = codex_cfg(home);
                std::fs::read_to_string(&p)
                    .map(|t| t.contains(&toml_section_header()))
                    .unwrap_or(false)
            },
            conn: String::new(),
            last_handshake_from: String::new(),
            mode: "file".into(),
            hint: "CLI 与 IDE 扩展共用此配置，注册一次双端生效".into(),
        },
        AgentEntry {
            id: "vscode".into(),
            family: "VS Code".into(),
            form: "桌面".into(),
            config_path: vscode_cfg(appdata).to_string_lossy().into_owned(),
            client_installed: appdata.join("Code").join("User").exists(),
            registered: json_registered(&vscode_cfg(appdata), &["servers"]),
            conn: String::new(),
            last_handshake_from: String::new(),
            mode: "file".into(),
            hint: String::new(),
        },
        AgentEntry {
            id: "workbuddy".into(),
            family: "WorkBuddy".into(),
            form: "桌面".into(),
            config_path: "应用内「添加 MCP」".into(),
            client_installed: appdata.join("WorkBuddy").exists(),
            registered: false,
            conn: String::new(),
            last_handshake_from: String::new(),
            mode: "copy-only".into(),
            hint: "应用内配置：点「复制配置」后，在 WorkBuddy 的添加 MCP 弹窗粘贴".into(),
        },
        AgentEntry {
            id: "trae-cn".into(),
            family: "Trae CN".into(),
            form: "桌面".into(),
            config_path: trae_cn_cfg(appdata).to_string_lossy().into_owned(),
            client_installed: appdata.join("Trae CN").join("User").exists(),
            registered: {
                let p = trae_cn_cfg(appdata);
                std::fs::read_to_string(&p)
                    .map(|t| t.contains(&format!("\"{OUR_KEY}\"")))
                    .unwrap_or(false)
            },
            conn: String::new(),
            last_handshake_from: String::new(),
            mode: "file".into(),
            hint: "该文件允许注释，采用原位插入以保留注释".into(),
        },
        AgentEntry {
            id: "zcode".into(),
            family: "ZCode".into(),
            form: "桌面/CLI".into(),
            config_path: zcode_cfg(home).to_string_lossy().into_owned(),
            client_installed: zcode_cfg(home).exists(),
            registered: json_registered(&zcode_cfg(home), &["mcp", "servers"]),
            conn: String::new(),
            last_handshake_from: String::new(),
            mode: "file".into(),
            hint: "桌面与 CLI 共用此配置，注册一次双端生效".into(),
        },
    ];
    for a in defs.iter_mut() {
        let (conn, from) = conn_state(appdata, &a.id, a.registered, hs.clone(), running);
        a.conn = conn;
        a.last_handshake_from = from;
    }
    defs
}

fn assert_installed(installed: bool, family: &str) -> Result<()> {
    if installed {
        Ok(())
    } else {
        Err(OnceError::usage(format!(
            "未检测到 {family}，请先安装后再接入"
        )))
    }
}

/// 注册（幂等：已注册时直接返回 already=true，不重复写）。
pub fn register(
    dirs: &Dirs,
    once_exe: &Path,
    id: &str,
    claude_cli_probe: impl Fn() -> bool,
) -> Result<RegisterOutcome> {
    let entry = mcp_entry(once_exe);
    let (cfg, family, mode): (PathBuf, &str, &str) = match id {
        "claude-desktop" => (claude_desktop_cfg(dirs.appdata), "Claude Desktop", "file"),
        "claude-code" => (claude_code_cfg(dirs.home), "Claude Code", "cli"),
        "cursor" => (cursor_cfg(dirs.home), "Cursor", "file"),
        "codex" => (codex_cfg(dirs.home), "Codex", "file"),
        "vscode" => (vscode_cfg(dirs.appdata), "VS Code", "file"),
        "workbuddy" => {
            return Ok(RegisterOutcome {
                id: id.into(),
                config_path: "应用内「添加 MCP」".into(),
                backup_path: None,
                entry,
                via_cli: false,
                already: false,
            });
        }
        "trae-cn" => (trae_cn_cfg(dirs.appdata), "Trae CN", "file"),
        "zcode" => (zcode_cfg(dirs.home), "ZCode", "file"),
        other => return Err(OnceError::usage(format!("未知客户端：{other}"))),
    };
    assert_installed(
        match id {
            "claude-desktop" => cfg.parent().map(|p| p.exists()).unwrap_or(false),
            "cursor" => dirs.home.join(".cursor").exists(),
            "codex" => dirs.home.join(".codex").exists(),
            "vscode" => dirs.appdata.join("Code").join("User").exists(),
            "trae-cn" => dirs.appdata.join("Trae CN").join("User").exists(),
            _ => cfg.exists(),
        },
        family,
    )?;

    // 幂等短路：已注册时不重写配置、不刷新注册时刻——重复点击「接入」
    // 若刷新 ra，会把接入前就已建立的连接判成「早于注册」，状态永远回不到已接入
    let already_registered = match id {
        "claude-desktop" | "claude-code" | "cursor" => json_registered(&cfg, &["mcpServers"]),
        "vscode" => json_registered(&cfg, &["servers"]),
        "zcode" => json_registered(&cfg, &["mcp", "servers"]),
        "codex" => std::fs::read_to_string(&cfg)
            .map(|t| t.contains(&toml_section_header()))
            .unwrap_or(false),
        "trae-cn" => std::fs::read_to_string(&cfg)
            .map(|t| t.contains(&format!("\"{OUR_KEY}\"")))
            .unwrap_or(false),
        _ => false,
    };
    if already_registered {
        return Ok(RegisterOutcome {
            id: id.into(),
            config_path: cfg.to_string_lossy().into_owned(),
            backup_path: None,
            entry,
            via_cli: false,
            already: true,
        });
    }

    let backup = backup_file(dirs.appdata, id, &cfg)?;
    match id {
        "claude-code" => {
            if claude_cli_probe() {
                claude_code_via_cli(true, Some(once_exe))?;
                registry_set(dirs.appdata, id, now_ms());
                return Ok(RegisterOutcome {
                    id: id.into(),
                    config_path: cfg.to_string_lossy().into_owned(),
                    backup_path: None,
                    entry,
                    via_cli: true,
                    already: false,
                });
            }
            json_merge(&cfg, &["mcpServers"], &entry)?;
        }
        "claude-desktop" => { json_merge(&cfg, &["mcpServers"], &entry)?; }
        "cursor" => { json_merge(&cfg, &["mcpServers"], &entry)?; }
        "vscode" => { json_merge(&cfg, &["servers"], &entry)?; }
        "zcode" => { json_merge(&cfg, &["mcp", "servers"], &entry)?; }
        "codex" => toml_register(&cfg, once_exe)?,
        "trae-cn" => trae_register(&cfg, once_exe)?,
        _ => unreachable!("已在上方匹配"),
    }
    registry_set(dirs.appdata, id, now_ms());
    Ok(RegisterOutcome {
        id: id.into(),
        config_path: cfg.to_string_lossy().into_owned(),
        backup_path: backup,
        entry,
        via_cli: false,
        already: false,
    })
}

/// 移除（先备份；返回备份路径）。
pub fn unregister(
    dirs: &Dirs,
    id: &str,
    claude_cli_probe: impl Fn() -> bool,
) -> Result<Option<String>> {
    let (cfg, kind): (PathBuf, &str) = match id {
        "claude-desktop" => (claude_desktop_cfg(dirs.appdata), "json-mcpServers"),
        "claude-code" => (claude_code_cfg(dirs.home), "claude-code"),
        "cursor" => (cursor_cfg(dirs.home), "json-mcpServers"),
        "codex" => (codex_cfg(dirs.home), "toml"),
        "vscode" => (vscode_cfg(dirs.appdata), "json-servers"),
        "trae-cn" => (trae_cn_cfg(dirs.appdata), "jsonc-trae"),
        "zcode" => (zcode_cfg(dirs.home), "json-mcp-servers"),
        "workbuddy" => {
            return Err(OnceError::usage(
                "WorkBuddy 为应用内配置，请在 WorkBuddy 中移除",
            ))
        }
        other => return Err(OnceError::usage(format!("未知客户端：{other}"))),
    };
    let backup = backup_file(dirs.appdata, id, &cfg)?;
    registry_clear(dirs.appdata, id);
    match kind {
        "json-mcpServers" => {
            let mut root = read_json(&cfg).ok_or_else(|| {
                OnceError::usage("配置解析失败；可从备份目录恢复后手动处理")
            })?;
            if let Some(m) = root.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
                m.remove(OUR_KEY);
            }
            write_pretty(&cfg, &root)?;
        }
        "json-servers" => {
            let mut root = read_json(&cfg).ok_or_else(|| {
                OnceError::usage("配置解析失败；可从备份目录恢复后手动处理")
            })?;
            if let Some(m) = root.get_mut("servers").and_then(|v| v.as_object_mut()) {
                m.remove(OUR_KEY);
            }
            write_pretty(&cfg, &root)?;
        }
        "json-mcp-servers" => {
            let mut root = read_json(&cfg).ok_or_else(|| {
                OnceError::usage("配置解析失败；可从备份目录恢复后手动处理")
            })?;
            if let Some(s) = root
                .get_mut("mcp")
                .and_then(|v| v.get_mut("servers"))
                .and_then(|v| v.as_object_mut())
            {
                s.remove(OUR_KEY);
            }
            write_pretty(&cfg, &root)?;
        }
        "claude-code" => {
            if claude_cli_probe() {
                claude_code_via_cli(false, None)?;
            } else {
                let mut root = read_json(&cfg).ok_or_else(|| {
                    OnceError::usage("配置解析失败；可从备份目录恢复后手动处理")
                })?;
                if let Some(m) = root.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
                    m.remove(OUR_KEY);
                }
                write_pretty(&cfg, &root)?;
            }
        }
        "toml" => toml_unregister(&cfg)?,
        "jsonc-trae" => trae_unregister(&cfg)?,
        _ => unreachable!(),
    }
    Ok(backup)
}

fn write_pretty(path: &Path, v: &serde_json::Value) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(v)
        .map_err(|e| OnceError::io("JSON 序列化失败").with_source(e.to_string()))?;
    let mut out = bytes;
    out.push(b'\n');
    std::fs::write(path, &out).map_err(|e| OnceError::io("写入失败").with_source(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempHome {
        base: PathBuf,
        appdata: PathBuf,
        home: PathBuf,
    }
    impl TempHome {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "once-agents-test-{tag}-{}",
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
            ));
            let appdata = base.join("appdata");
            let home = base.join("home");
            std::fs::create_dir_all(&appdata).unwrap();
            std::fs::create_dir_all(&home).unwrap();
            TempHome { base, appdata, home }
        }
        fn dirs(&self) -> Dirs<'_> {
            Dirs { appdata: &self.appdata, home: &self.home }
        }
    }
    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    const EXE: &str = "C:\\Onceglance\\bin\\once.exe";

    #[test]
    fn json_mcp_servers_roundtrip_preserves_others() {
        let t = TempHome::new("cursor");
        let cfg = t.home.join(".cursor");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(
            cfg.join("mcp.json"),
            r#"{ "mcpServers": { "amap": { "url": "https://x" } } }"#,
        )
        .unwrap();
        let d = t.dirs();
        let out = register(&d, Path::new(EXE), "cursor", || false).unwrap();
        assert!(!out.already);
        let v = read_json(&cursor_cfg(d.home)).unwrap();
        assert_eq!(v["mcpServers"]["onceglance"]["command"], EXE);
        assert!(v["mcpServers"]["amap"].is_object(), "既有条目必须保留");
        // 幂等
        let out2 = register(&d, Path::new(EXE), "cursor", || false).unwrap();
        let v2 = read_json(&cursor_cfg(d.home)).unwrap();
        assert_eq!(v, v2, "重复注册不得产生重复条目");
        let _ = out2;
        // 移除后语义还原（仅少自身条目）
        unregister(&d, "cursor", || false).unwrap();
        let v3 = read_json(&cursor_cfg(d.home)).unwrap();
        assert!(v3["mcpServers"].get(OUR_KEY).is_none());
        assert!(v3["mcpServers"]["amap"].is_object());
        // 至少一份备份存在
        let bdir = t.appdata.join("Onceglance").join("agent-backups");
        assert!(std::fs::read_dir(bdir).unwrap().count() >= 2);
    }

    #[test]
    fn claude_json_merge_keeps_unknown_state() {
        let t = TempHome::new("claude");
        let cfg = t.home.join(".claude.json");
        std::fs::write(
            &cfg,
            r#"{ "numStartups": 3, "mcpServers": { "mcp-chrome": { "url": "http://127.0.0.1:12306/mcp" } }, "tipsHistory": [] }"#,
        )
        .unwrap();
        let d = t.dirs();
        register(&d, Path::new(EXE), "claude-code", || false).unwrap();
        let v = read_json(&cfg).unwrap();
        assert_eq!(v["mcpServers"]["onceglance"]["args"][0], "mcp");
        assert_eq!(v["numStartups"], 3, "用户状态必须原样保留");
        assert!(v["mcpServers"]["mcp-chrome"].is_object());
        unregister(&d, "claude-code", || false).unwrap();
        let v2 = read_json(&cfg).unwrap();
        assert!(v2["mcpServers"].get(OUR_KEY).is_none());
        assert_eq!(v2["numStartups"], 3);
    }

    #[test]
    fn vscode_uses_servers_container() {
        let t = TempHome::new("vscode");
        let user = t.appdata.join("Code").join("User");
        std::fs::create_dir_all(&user).unwrap();
        let d = t.dirs();
        register(&d, Path::new(EXE), "vscode", || false).unwrap();
        let v = read_json(&vscode_cfg(d.appdata)).unwrap();
        assert_eq!(v["servers"]["onceglance"]["command"], EXE);
        unregister(&d, "vscode", || false).unwrap();
        assert!(read_json(&vscode_cfg(d.appdata)).unwrap()["servers"]
            .get(OUR_KEY)
            .is_none());
    }

    #[test]
    fn zcode_nested_mcp_servers() {
        let t = TempHome::new("zcode");
        let zc = t.home.join(".zcode").join("cli");
        std::fs::create_dir_all(&zc).unwrap();
        std::fs::write(
            zc.join("config.json"),
            r#"{ "plugins": {}, "mcp": { "servers": { "node_repl": { "command": "x" } } } }"#,
        )
        .unwrap();
        let d = t.dirs();
        register(&d, Path::new(EXE), "zcode", || false).unwrap();
        let v = read_json(&zcode_cfg(d.home)).unwrap();
        assert_eq!(v["mcp"]["servers"]["onceglance"]["args"][0], "mcp");
        assert!(v["mcp"]["servers"]["node_repl"].is_object());
        unregister(&d, "zcode", || false).unwrap();
        assert!(read_json(&zcode_cfg(d.home)).unwrap()["mcp"]["servers"]
            .get(OUR_KEY)
            .is_none());
    }

    #[test]
    fn codex_toml_append_remove_is_byte_exact() {
        let t = TempHome::new("codex");
        let cd = t.home.join(".codex");
        std::fs::create_dir_all(&cd).unwrap();
        let original = "model = \"glm-5.3-flash\"\n\n[plugins.\"pdf@x\"]\nenabled = true\n";
        std::fs::write(cd.join("config.toml"), original).unwrap();
        let d = t.dirs();
        register(&d, Path::new(EXE), "codex", || false).unwrap();
        let after = std::fs::read_to_string(cd.join("config.toml")).unwrap();
        assert!(after.contains("[mcp_servers.onceglance]"));
        assert!(after.starts_with("model = "), "追加节不得移动既有顶层键");
        assert!(after.contains("[plugins.\"pdf@x\"]"));
        unregister(&d, "codex", || false).unwrap();
        let restored = std::fs::read_to_string(cd.join("config.toml")).unwrap();
        assert_eq!(restored, original, "移除后必须逐字节还原");
        // 幂等移除：再移除一次不报错
        unregister(&d, "codex", || false).unwrap();
    }

    #[test]
    fn trae_jsonc_insert_keeps_comments() {
        let t = TempHome::new("trae");
        let user = t.appdata.join("Trae CN").join("User");
        std::fs::create_dir_all(&user).unwrap();
        let original = "{\n  \"mcpServers\": {\n    \"amap\": {\n      \"url\": \"https://x\"\n    }\n    // \"注释掉的服务\": {}\n  }\n}\n";
        std::fs::write(user.join("mcp.json"), original).unwrap();
        let d = t.dirs();
        register(&d, Path::new(EXE), "trae-cn", || false).unwrap();
        let after = std::fs::read_to_string(user.join("mcp.json")).unwrap();
        assert!(after.contains("\"onceglance\""));
        assert!(after.contains("// \"注释掉的服务\": {}"), "注释必须保留");
        unregister(&d, "trae-cn", || false).unwrap();
        let restored = std::fs::read_to_string(user.join("mcp.json")).unwrap();
        assert_eq!(restored, original, "JSONC 移除后必须逐字节还原");
    }

    #[test]
    fn refuses_when_client_absent() {
        let t = TempHome::new("absent");
        let d = t.dirs();
        let err = register(&d, Path::new(EXE), "cursor", || false).unwrap_err();
        assert!(err.to_string().contains("未检测到"));
    }

    #[test]
    fn workbuddy_is_copy_only() {
        let t = TempHome::new("wb");
        let d = t.dirs();
        let out = register(&d, Path::new(EXE), "workbuddy", || false).unwrap();
        assert_eq!(out.entry["args"][0], "mcp");
        assert!(unregister(&d, "workbuddy", || false).is_err());
    }

    #[test]
    fn list_reports_detection_flags() {
        let t = TempHome::new("list");
        std::fs::create_dir_all(t.home.join(".cursor")).unwrap();
        std::fs::create_dir_all(t.appdata.join("WorkBuddy")).unwrap();
        let d = t.dirs();
        let all = list(d.appdata, d.home);
        let cur = all.iter().find(|a| a.id == "cursor").unwrap();
        assert!(cur.client_installed && !cur.registered);
        let wb = all.iter().find(|a| a.id == "workbuddy").unwrap();
        assert!(wb.client_installed && wb.mode == "copy-only");
        let cd = all.iter().find(|a| a.id == "claude-desktop").unwrap();
        assert!(!cd.client_installed);
    }

    #[test]
    fn conn_state_transitions_driven_by_handshake() {
        let t = TempHome::new("conn");
        let d = t.dirs();
        std::fs::create_dir_all(t.home.join(".cursor")).unwrap();
        register(&d, Path::new(EXE), "cursor", || false).unwrap();
        let ra = registry_get(d.appdata, "cursor").expect("注册时刻必须入册");
        let (conn, _) = conn_state(d.appdata, "cursor", true, None, false);
        assert_eq!(conn, "awaiting");
        // 宽限窗口外的老握手不算连接证据
        let old = ra - (HANDSHAKE_GRACE_MS + 60_000);
        let (conn, _) =
            conn_state(d.appdata, "cursor", true, Some((old, "ZCode.exe".into())), false);
        assert_eq!(conn, "awaiting");
        // 宽限窗口内的注册前握手算已接入（先客户端接入、后回面板注册的常态）
        let (conn, _) =
            conn_state(d.appdata, "cursor", true, Some((ra - 1, "ZCode.exe".into())), false);
        assert_eq!(conn, "connected");
        let (conn, from) =
            conn_state(d.appdata, "cursor", true, Some((ra + 1, "ZCode.exe".into())), false);
        assert_eq!(conn, "connected");
        assert_eq!(from, "ZCode.exe");
        // 回归：握手早于注册（重复接入刷新 ra 场景）但连接此刻在跑，必须判已接入
        let (conn, _) =
            conn_state(d.appdata, "cursor", true, Some((ra - 1, "ZCode.exe".into())), true);
        assert_eq!(conn, "connected");
        let (conn, _) = conn_state(d.appdata, "cursor", true, None, true);
        assert_eq!(conn, "connected");
    }

    #[test]
    fn register_is_idempotent_and_keeps_registered_at() {
        let t = TempHome::new("idem");
        let d = t.dirs();
        std::fs::create_dir_all(t.home.join(".cursor")).unwrap();
        let o1 = register(&d, Path::new(EXE), "cursor", || false).unwrap();
        assert!(!o1.already);
        let ra1 = registry_get(d.appdata, "cursor").expect("注册时刻必须入册");
        std::thread::sleep(std::time::Duration::from_millis(15));
        let o2 = register(&d, Path::new(EXE), "cursor", || false).unwrap();
        assert!(o2.already, "重复注册必须走幂等短路");
        assert_eq!(
            registry_get(d.appdata, "cursor"),
            Some(ra1),
            "幂等注册不得刷新注册时刻"
        );
    }

    #[test]
    fn record_handshake_merges_and_increments() {
        let t = TempHome::new("hs");
        let d = t.dirs();
        record_handshake_at(d.appdata);
        let v = read_json(&handshake_path(d.appdata)).expect("握手文件必须生成");
        let from = v["last_from"].as_str().expect("必须记录来源").to_string();
        assert!(v["last_ts"].as_u64().unwrap() > 0);
        assert!(v["handshakes"][from.as_str()]["last_ts"].as_u64().unwrap() > 0);
        record_handshake_at(d.appdata);
        let v2 = read_json(&handshake_path(d.appdata)).unwrap();
        assert!(
            v2["handshakes"][from.as_str()]["count"].as_u64().unwrap()
                >= v["handshakes"][from.as_str()]["count"].as_u64().unwrap() + 1,
            "同源握手计数必须累加"
        );
    }

    #[test]
    #[ignore] // 用真实用户目录冒烟:cargo test -p once-core agents -- --ignored --nocapture
    fn real_dirs_smoke() {
        let appdata = dirs::data_dir().expect("no appdata");
        let home = dirs::home_dir().expect("no home");
        let t0 = std::time::Instant::now();
        let all = list(&appdata, &home);
        println!("list elapsed: {:?}, entries: {}", t0.elapsed(), all.len());
        for a in &all {
            println!("{:14} installed={} registered={} conn={} from={}", a.id, a.client_installed, a.registered, a.conn, a.last_handshake_from);
        }
    }

    #[test]
    fn unregister_clears_registry() {
        let t = TempHome::new("unreg");
        let d = t.dirs();
        std::fs::create_dir_all(t.home.join(".cursor")).unwrap();
        register(&d, Path::new(EXE), "cursor", || false).unwrap();
        assert!(registry_get(d.appdata, "cursor").is_some());
        unregister(&d, "cursor", || false).unwrap();
        assert!(registry_get(d.appdata, "cursor").is_none());
    }
}
