//! MCP Server（MCP-1~5）：stdio 传输，随 Agent 会话生命周期运行。
//! 无网络监听、无常驻后台任务。工具返回 envelope JSON 文本，路径一律绝对路径。

use once_core::error::OnceError;
use once_core::Result;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

const PROTOCOL_VERSION: &str = "2024-11-05";

pub fn run() {
    once_core::dpi::ensure_per_monitor_dpi_aware();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    loop {
        let mut line = String::new();
        match stdin.lock().read_line(&mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(_) => break,
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                let _ = write_msg(
                    &mut stdout,
                    json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}),
                );
                continue;
            }
        };
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
        let id = msg.get("id").cloned();

        // 通知（无 id）：不回包
        let is_notification = id.is_none();
        match method.as_str() {
            "initialize" => {
                // 连接证据：谁连上了 MCP，记录握手（时间戳 + 来源父进程），供 GUI 注册中心判定"已接入"
                once_core::agents::record_handshake();
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": { "tools": {} },
                        "serverInfo": {
                            "name": "onceglance",
                            "version": once_core::VERSION,
                            "title": "定影 Onceglance · Agent 视觉层"
                        }
                    }
                });
                let _ = write_msg(&mut stdout, resp);
            }
            "notifications/initialized" | "initialized" => { /* 无需回包 */ }
            "ping" => {
                if !is_notification {
                    let _ = write_msg(&mut stdout, json!({"jsonrpc":"2.0","id":id,"result":{}}));
                }
            }
            "tools/list" => {
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "tools": tool_definitions() }
                });
                let _ = write_msg(&mut stdout, resp);
            }
            "tools/call" => {
                let name = msg
                    .pointer("/params/name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let args = msg.pointer("/params/arguments").cloned().unwrap_or(json!({}));
                let result = call_tool(&name, &args);
                let (is_error, text) = match result {
                    Ok(v) => (false, serde_json::to_string(&v).unwrap_or_default()),
                    Err(structured) => (true, serde_json::to_string(&structured).unwrap_or_default()),
                };
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [ { "type": "text", "text": text } ],
                        "isError": is_error
                    }
                });
                let _ = write_msg(&mut stdout, resp);
            }
            "resources/list" => {
                // MCP-3：暴露最近捕获 manifest 作为 resource
                let last = once_core::history::last_capture();
                let resources = last
                    .map(|r| {
                        let manifest_path = std::path::Path::new(&r.path).with_extension("json");
                        json!([{
                            "uri": format!("file://{}", manifest_path.display().to_string().replace('\\', "/")),
                            "name": format!("最近捕获 manifest · {}", std::path::Path::new(&r.path).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()),
                            "mimeType": "application/json",
                            "description": "最近一次成功捕获的 Capture Artifact manifest"
                        }])
                    })
                    .unwrap_or(json!([]));
                let _ = write_msg(
                    &mut stdout,
                    json!({"jsonrpc":"2.0","id":id,"result":{"resources": resources}}),
                );
            }
            "shutdown" | "exit" => break,
            other => {
                if !is_notification {
                    let _ = write_msg(
                        &mut stdout,
                        json!({
                            "jsonrpc":"2.0","id":id,
                            "error":{"code":-32601,"message":format!("Method not found: {other}")}
                        }),
                    );
                }
            }
        }
        if method == "shutdown" || method == "exit" {
            break;
        }
    }
}

fn write_msg(stdout: &mut std::io::Stdout, v: Value) -> std::io::Result<()> {
    let mut s = std::io::BufWriter::new(stdout.lock());
    s.write_all(serde_json::to_string(&v).unwrap_or_default().as_bytes())?;
    s.write_all(b"\n")?;
    s.flush()
}

fn tool_error(exit: i32, code: &str, message: &str, hint: &str) -> Value {
    json!({
        "ok": false,
        "data": null,
        "error": { "code": code, "exit_code": exit, "message": message, "hint": hint },
        "meta": { "version": once_core::VERSION }
    })
}

fn call_tool(name: &str, args: &Value) -> std::result::Result<Value, Value> {
    let r: Result<Value> = (|| {
        match name {
            "capture_screen" => {
                let kind = args.get("kind").and_then(|k| k.as_str()).unwrap_or("window");
                match kind {
                    "window" => {
                        let title = args.get("title").and_then(|v| v.as_str());
                        let pid = args.get("pid").and_then(|v| v.as_u64());
                        crate::cmd_capture_window_for_mcp(title, pid.map(|p| p as u32))
                    }
                    "fullscreen" => {
                        let screen = args.get("screen").and_then(|v| v.as_str());
                        crate::cmd_capture_fullscreen_for_mcp(screen)
                    }
                    "region" => {
                        let (x, y, w, h) = (
                            args.get("x").and_then(|v| v.as_i64()),
                            args.get("y").and_then(|v| v.as_i64()),
                            args.get("w").and_then(|v| v.as_u64()),
                            args.get("h").and_then(|v| v.as_u64()),
                        );
                        match (x, y, w, h) {
                            (Some(x), Some(y), Some(w), Some(h)) => {
                                crate::cmd_capture_region_px_for_mcp(x as i32, y as i32, w as u32, h as u32)
                            }
                            _ => Err(OnceError::usage(
                                "region 捕获需要 x/y/w/h（物理像素）；交互式框选请用 GUI",
                            )),
                        }
                    }
                    other => Err(OnceError::usage(format!("未知 kind：{other}（region|window|fullscreen）"))),
                }
            }
            "scroll_capture" => Err(OnceError::usage(
                "长截图需要人工滚动采集；请引导用户按 Alt+Shift+L 使用 GUI 长截图",
            )),
            "ocr_image" => {
                let target = args.get("path").and_then(|v| v.as_str()).unwrap_or("last");
                crate::cmd_ocr_for_mcp(target)
            }
            "annotate_image" => {
                let target = args.get("path").and_then(|v| v.as_str()).unwrap_or("last");
                let script = args.get("script").cloned().unwrap_or(Value::Null);
                let parsed: once_core::annotate::AnnotationScript =
                    serde_json::from_value(script).map_err(|e| {
                        OnceError::usage(format!("标注脚本解析失败：{e}"))
                            .with_hint("schema：unit(px|rel) + operations[]（arrow/rect/ellipse/step_number/text/highlight/mosaic/crop）")
                    })?;
                crate::cmd_annotate_for_mcp(target, &parsed)
            }
            "list_history" => {
                let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
                let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize;
                crate::cmd_history_for_mcp(query, limit)
            }
            "doctor" => crate::cmd_doctor_for_mcp(),
            other => Err(OnceError::usage(format!("未知工具：{other}"))),
        }
    })();
    match r {
        Ok(v) => Ok(json!({
            "ok": true,
            "data": v,
            "error": null,
            "meta": { "version": once_core::VERSION }
        })),
        Err(e) => Err(tool_error(
            e.exit as i32,
            e.exit.code_str(),
            &e.message,
            if e.hint.is_empty() { "无" } else { &e.hint },
        )),
    }
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "capture_screen",
            "description": "捕获屏幕：kind=window（默认前台窗口，可传 title 子串或 pid）、kind=fullscreen（可传 screen=\"1\"/\"2\"/\"all\"）、kind=region（需 x/y/w/h 物理像素）。隐私黑名单命中的窗口会被拒绝（退出码 6）。返回 JSON envelope，data.path 为截图绝对路径，data.manifest 为同名 manifest。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["region", "window", "fullscreen"], "default": "window" },
                    "title": { "type": "string", "description": "window 模式：窗口标题子串" },
                    "pid": { "type": "integer", "description": "window 模式：进程 ID" },
                    "screen": { "type": "string", "description": "fullscreen 模式：屏幕编号或 all" },
                    "x": { "type": "integer" }, "y": { "type": "integer" },
                    "w": { "type": "integer" }, "h": { "type": "integer" }
                }
            }
        },
        {
            "name": "scroll_capture",
            "description": "滚动长截图需要用户手动滚动采集（产品刻意不自动完成）。当前通过引导用户按全局热键 Alt+Shift+L 完成；直接调用会返回说明性错误。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "ocr_image",
            "description": "本地离线 OCR：path 为图片绝对路径，缺省 last=最近一次成功捕获。返回 blocks[]（type: text|code|table|ui，text、bbox=[x,y,w,h] 物理像素、confidence、lines[]）+ full_text + language。无文字时 ok=true 且 empty_reason 有值。",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "图片路径或省略（=last）" } }
            }
        },
        {
            "name": "annotate_image",
            "description": "指令驱动标注：在截图上叠加箭头/矩形/椭圆/步骤序号/文字/高亮/马赛克/裁剪，生成衍生图（永不覆盖原图）。坐标默认物理像素 px，可用 unit=\"rel\" 传 0–1 相对坐标（推荐视觉模型使用），或 anchor=\"block:N\" 引用 OCR 块。未显式指定的样式属性（颜色/线宽/字体/序号样式/马赛克模式/整图阴影边框）继承用户标注主题默认值（主面板「标注主题」页只读可见），显式传参优先。返回 data.path 衍生图绝对路径。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "图片路径或省略（=last）" },
                    "script": {
                        "type": "object",
                        "properties": {
                            "unit": { "type": "string", "enum": ["px", "rel"], "default": "px" },
                            "operations": {
                                "type": "array",
                                "items": { "type": "object" },
                                "description": "示例：[{\"type\":\"arrow\",\"from\":[0.1,0.1],\"to\":[0.5,0.5]}]（unit=rel 时坐标 0–1）"
                            }
                        },
                        "required": ["operations"]
                    }
                },
                "required": ["script"]
            }
        },
        {
            "name": "list_history",
            "description": "本地历史检索：query 支持 OCR 全文 + 文件名，以及 kind:window / after:2026-09-17 / after:昨天 / has:annotated / ocr:failed 语法，组合为与关系。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "default": 20 }
                }
            }
        },
        {
            "name": "doctor",
            "description": "诊断：实例、捕获自检、落盘目录可写性、OCR 引擎、桥接、WebView2 运行时。不含任何截图内容。",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}
