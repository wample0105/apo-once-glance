//! AI 配置中心命令（v0.2）：两层制——模型服务只管连接，功能区各选「服务+模型」。
//! 配置 CRUD（Key 进系统凭据库）、连接测试、功能位指定、识别引擎路由、审计。
//! 所有返回值不含 Key 明文；密钥只在凭据库与写入瞬间存在。

use once_core::ai::{self, AiProfile, FuncModel, TestKind};
use once_core::settings;
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// 前端视图：连接（profile）+ has_key。模型名不在连接上——各功能区自己持有。
#[derive(Serialize, Clone)]
pub struct AiProfileView {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub provider_name: String,
    pub base_url: String,
    pub has_key: bool,
}

// 功能位补任/自愈（autofill_defaults）与 v1→v2 迁移（migrate）都在 once_core::ai 三端共用：
// settings::load 挂迁移；GUI setup 的 heal_default_roles、删除迁移与本模块保存路径均调内核版。

/// 启动自愈：功能位缺失/悬空时补任，幂等；无需修复不落盘。
pub fn heal_default_roles() {
    let mut probe = settings::load();
    if once_core::ai::autofill_defaults(&mut probe.ai).is_empty() {
        return;
    }
    let _ = settings::update(|s| {
        once_core::ai::autofill_defaults(&mut s.ai);
    });
}

fn views() -> Vec<AiProfileView> {
    settings::load()
        .ai
        .profiles
        .iter()
        .map(|p| AiProfileView {
            id: p.id.clone(),
            name: p.name.clone(),
            provider: p.provider.clone(),
            provider_name: ai::preset(&p.provider)
                .map(|x| x.name.to_string())
                .unwrap_or_else(|| p.provider.clone()),
            base_url: p.base_url.clone(),
            has_key: ai::key_exists(&p.id),
        })
        .collect()
}

/// 服务商预设（前端表单：名称/默认接口地址/建议模型 datalist/获取 Key 链接）。
#[tauri::command]
pub fn ai_presets() -> &'static [ai::ProviderPreset] {
    ai::PRESETS
}

/// 拉取该连接的可用模型列表（OpenAI 兼容 GET /models，独立线程跑阻塞 HTTP）。
/// 返回 {models, latency_ms}——功能页「拉取模型列表」与模型服务页「测试 Key」共用。
#[tauri::command]
pub async fn ai_fetch_models(profile_id: String) -> Result<serde_json::Value, String> {
    let cfg = settings::load().ai;
    let base_url = cfg
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or("连接不存在")?
        .base_url
        .clone();
    let key = ai::get_key(&profile_id).map_err(|e| e.to_string())?;
    let t0 = std::time::Instant::now();
    let r = std::thread::spawn(move || ai::fetch_models(&base_url, &key))
        .join()
        .map_err(|e| format!("拉取线程异常：{e:?}"))?;
    let models = r.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "models": models, "latency_ms": t0.elapsed().as_millis() as u64 }))
}

/// 连接列表（含凭据存在性，不含密钥）。
#[tauri::command]
pub fn ai_list() -> Vec<AiProfileView> {
    views()
}

#[tauri::command]
pub fn ai_save_profile(profile: AiProfile, api_key: Option<String>) -> Result<once_core::ai::AiConfig, String> {
    save_profile_inner(profile, api_key)
        .map(|_| settings::load().ai)
        .map_err(|e| e.to_string())
}

fn save_profile_inner(mut profile: AiProfile, api_key: Option<String>) -> once_core::Result<()> {
    profile.name = profile.name.trim().to_string();
    profile.base_url = profile.base_url.trim().trim_end_matches('/').to_string();
    if profile.name.is_empty() {
        profile.name = ai::preset(&profile.provider)
            .map(|p| p.name.to_string())
            .unwrap_or_else(|| "模型服务".into());
    }
    if profile.id.is_empty() {
        profile.id = format!("p{}", once_core::storage::shortid());
    }
    if ai::preset(&profile.provider).is_none() {
        return Err(once_core::OnceError::usage(format!("未知服务商：{}", profile.provider)));
    }
    if profile.base_url.is_empty() {
        return Err(once_core::OnceError::usage("接口地址不能为空（自定义端点必填）"));
    }
    // 先写凭据库再改配置：凭据写失败则整体失败，避免"连接在但 Key 缺"的半态
    if let Some(k) = api_key {
        let k = k.trim();
        if !k.is_empty() {
            ai::set_key(&profile.id, k)?;
        }
    }
    let id = profile.id.clone();
    settings::update(|s| {
        let cfg = &mut s.ai;
        if let Some(slot) = cfg.profiles.iter_mut().find(|p| p.id == id) {
            *slot = profile.clone();
        } else {
            cfg.profiles.push(profile.clone());
        }
        // 功能位自动补任：缺失/悬空时改任第一套连接（用户可改）
        once_core::ai::autofill_defaults(cfg);
    })
    .map(|_| ())
}

/// 删除连接：连带清理凭据库中的 Key；功能位悬空时自动迁移到下一套连接并 toast 告知
/// （不迁移会让翻译/问图在下次调用才报「未设置模型」，用户无从归因到这次删除）。
/// 必须 async：toast() 建窗口不能在同步 command 的主线程里做（死锁，见 deliver 同族坑）。
#[tauri::command]
pub async fn ai_delete_profile(app: AppHandle, id: String) -> Result<once_core::ai::AiConfig, String> {
    ai::delete_key(&id);
    let mut migrated: Vec<(&'static str, String)> = Vec::new();
    let r = settings::update(|s| {
        s.ai.profiles.retain(|p| p.id != id);
        s.ai.prune_defaults();
        migrated = once_core::ai::autofill_defaults(&mut s.ai);
    });
    match r {
        Ok(s) => {
            let moved = migrated;
            if !moved.is_empty() {
                let parts: Vec<String> = moved
                    .iter()
                    .map(|(role, name)| format!("{role}→{name}"))
                    .collect();
                crate::deliver::toast(&app, "ok", &format!("已自动迁移：{}", parts.join("、")));
            }
            Ok(s.ai)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// 功能位指定（func: translate|ask|ocr_online；模型名随位存，互不绑定）。
#[tauri::command]
pub fn ai_set_func(func: String, profile_id: String, model: String) -> Result<once_core::ai::AiConfig, String> {
    let fm = FuncModel {
        profile_id: profile_id.trim().to_string(),
        model: model.trim().to_string(),
    };
    settings::update(|s| match func.as_str() {
        "translate" => s.ai.translate = fm,
        "ask" => s.ai.ask = fm,
        "ocr_online" => s.ai.ocr.online = fm,
        _ => {}
    })
    .map(|s| s.ai)
    .map_err(|e| e.to_string())
}

/// 识别引擎切换（engine: builtin|paddle|online）。切 online 且识别位为空时，
/// 从问图位预填一份读图配置（同一链路，用户可改）——一键可用的业界惯例。
#[tauri::command]
pub fn ai_set_ocr_engine(engine: String) -> Result<once_core::ai::AiConfig, String> {
    if !matches!(engine.as_str(), "builtin" | "paddle" | "online") {
        return Err(format!("未知识别引擎：{engine}"));
    }
    settings::update(|s| {
        s.ai.ocr.engine = engine;
        once_core::ai::autofill_defaults(&mut s.ai);
    })
    .map(|s| s.ai)
    .map_err(|e| e.to_string())
}

/// 连接测试：按调用方给定的模型名发最小请求（text=纯文本对话，vision=带 1×1 图）。
/// 阻塞 HTTP 经独立线程执行。每次测试入审计（服务商/模型/是否发送图像），不记录 Key 与响应正文。
#[tauri::command]
pub async fn ai_test(id: String, model: String, kind: String) -> Result<serde_json::Value, String> {
    let kind = TestKind::parse(&kind).map_err(|e| e.to_string())?;
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("请先填写模型名".into());
    }
    let cfg = settings::load().ai;
    let profile = cfg
        .profile(&id)
        .cloned()
        .ok_or_else(|| "连接不存在或已被删除".to_string())?;
    let key = ai::get_key(&id).map_err(|e| e.to_string())?;
    let base_url = profile.base_url.clone();
    let provider = profile.provider.clone();
    let model_for_audit = model.clone();
    let outcome = std::thread::spawn(move || ai::test_connection(&base_url, &key, &model, kind))
        .join()
        .map_err(|e| format!("测试线程异常：{e:?}"))?;
    once_core::audit::record_ai(
        "ai.test",
        outcome.latency_ms as u64,
        if outcome.ok { 0 } else { 1 },
        Some(&provider),
        Some(&model_for_audit),
        Some(kind == TestKind::Vision),
    );
    Ok(serde_json::to_value(&outcome).unwrap_or_default())
}

// ===== 生成：截图翻译 / AI 问图 =====
// 链路：无损冻结帧裁剪（不落历史）→ 取字（翻译跟随识别引擎）→ 功能位模型生成 → 结果浮层。
// 每次调用入审计（服务商/模型/是否发送图像）；在线取字单独入审计（上传事实可追溯）。

/// 截图翻译：冻结帧区域 → 取字（跟随识别引擎：内置/本地包不出网；在线时上传截图）
/// → 翻译功能位文本模型 → 译文。meta 标注完整去向（界面明示）。
#[tauri::command]
pub async fn ai_translate_region(x: i32, y: i32, w: u32, h: u32) -> Result<serde_json::Value, String> {
    let cfg = settings::load().ai;
    let lang = if cfg.translate_lang.trim().is_empty() {
        "简体中文".to_string()
    } else {
        cfg.translate_lang.clone()
    };
    let engine = cfg.ocr.engine().to_string();
    let ocr_fm = cfg.ocr.online.clone();
    let t_fm = cfg.translate.clone();
    // 线程外预取审计/展示标签（闭包会拿走 cfg 与功能位）
    let (tp_name, tp_model) = t_fm
        .resolve(&cfg)
        .map(|p| (p.name.clone(), t_fm.model.clone()))
        .unwrap_or_default();
    let ocr_model = ocr_fm.model.clone();
    let r = std::thread::spawn(move || -> Result<(String, String, bool, u64, u128), once_core::OnceError> {
        let (rgba, rw, rh) = crate::scrollcmd::freeze_region_rgba(x, y, w, h)
            .map_err(|e| once_core::OnceError::capture(format!("冻结画面已失效：{e}")))?;
        let png = once_core::ai::rgba_to_png(&rgba, rw, rh)?;
        // 取字：跟随文字识别引擎（online 时上传截图——用户已在识别页知悉）
        let (text, ocr_meta, uploaded, ocr_ms) = if engine == once_core::ai::OCR_ENGINE_ONLINE {
            let (p, out) = once_core::ai::online_ocr_text(&cfg, &png)?;
            (
                out.text.trim().to_string(),
                format!("识别 {}·{}", p.name, ocr_fm.model),
                true,
                out.latency_ms as u64,
            )
        } else {
            let local = once_core::ocr::local_provider(&engine)?;
            let ocr = local
                .recognize_png(&png)
                .or_else(|_| local.recognize_png(&png))
                .map_err(|_| once_core::OnceError::ocr("本地识别失败——选区太窄或对比度过低"))?;
            (
                ocr.full_text.trim().to_string(),
                "本地识别".to_string(),
                false,
                0,
            )
        };
        if text.is_empty() {
            return Err(once_core::OnceError::ocr(
                "选区里没有发现文字——纯图内容请改用「问图」",
            ));
        }
        let (tp, out) = once_core::ai::translate_text(&cfg, &text, &lang)?;
        let meta = format!("{ocr_meta} → 翻译 {}·{}", tp.name, t_fm.model);
        Ok((out.text, meta, uploaded, ocr_ms, out.latency_ms))
    })
    .join()
    .map_err(|e| format!("翻译线程异常：{e:?}"))?;
    match r {
        Ok((text, meta, uploaded, ocr_ms, gen_ms)) => {
            once_core::audit::record_ai("ai.translate", gen_ms as u64, 0, Some(&tp_name), Some(&tp_model), Some(false));
            if uploaded {
                // 上传事实单独入审计：识别引擎为在线模型时截图确实离机
                once_core::audit::record_ai("ai.ocr_online", ocr_ms, 0, Some(&tp_name), Some(&ocr_model), Some(true));
            }
            Ok(serde_json::json!({
                "ok": true,
                "text": text,
                "latency_ms": gen_ms,
                "meta": meta,
            }))
        }
        Err(e) => {
            once_core::audit::record_ai("ai.translate", 0, 1, Some(&tp_name), Some(&tp_model), Some(false));
            Err(e.to_string())
        }
    }
}

/// AI 问图：冻结帧区域图 → 问图功能位视觉模型 → 回答。
/// Hard-abort flag for the streaming ask. The overlay's busy lock guarantees at
/// most one in-flight ask; the cancel command sets it and the stream read loop
/// breaks at the next chunk arrival.
static ASK_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub async fn ai_ask_cancel() -> Result<(), String> {
    ASK_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn ai_ask_region(
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    question: String,
    history: Option<Vec<once_core::ai::AskHistoryTurn>>,
    on_delta: tauri::ipc::Channel<String>,
) -> Result<serde_json::Value, String> {
    let cfg = settings::load().ai;
    let q = question.trim().to_string();
    if q.is_empty() {
        return Err("问题不能为空".into());
    }
    let history = history.unwrap_or_default();
    let a_fm = cfg.ask.clone();
    let (ap_name, ap_model) = a_fm
        .resolve(&cfg)
        .map(|p| (p.name.clone(), a_fm.model.clone()))
        .unwrap_or_default();
    ASK_CANCEL.store(false, std::sync::atomic::Ordering::Relaxed);
    let r = std::thread::spawn(move || -> Result<(once_core::ai::AiProfile, once_core::ai::StreamOutcome), once_core::OnceError> {
        let (rgba, rw, rh) = crate::scrollcmd::freeze_region_rgba(x, y, w, h)
            .map_err(|e| once_core::OnceError::capture(format!("冻结画面已失效：{e}")))?;
        // 多轮：图挂在历史首条 user 轮，新问题纯文本；首问（无历史）图随问题
        once_core::ai::ask_image_history_stream(&cfg, &rgba, rw, rh, &q, &history, &ASK_CANCEL, &mut |s| {
            let _ = on_delta.send(s.to_string());
        })
    })
    .join()
    .map_err(|e| format!("问图线程异常：{e:?}"))?;
    match r {
        Ok((_, out)) => {
            if out.cancelled {
                // User aborted: neither a success nor a service failure — no audit entry.
                return Ok(serde_json::json!({ "ok": true, "cancelled": true }));
            }
            once_core::audit::record_ai("ai.ask", out.latency_ms as u64, 0, Some(&ap_name), Some(&ap_model), Some(true));
            Ok(serde_json::json!({
                "ok": true,
                "cancelled": false,
                "text": out.text,
                "latency_ms": out.latency_ms,
                "meta": format!("{ap_name} · {ap_model}"),
            }))
        }
        Err(e) => {
            once_core::audit::record_ai("ai.ask", 0, 1, Some(&ap_name), Some(&ap_model), Some(true));
            Err(e.to_string())
        }
    }
}

/// 未配置 Key 时的就地引导：打开主面板并跳到「模型配置」页对应功能区
/// （sub: translate|ocr|ask|profiles，缺省 translate；前端 nav-to 支持 ai-* 直达）。
#[tauri::command]
pub fn ai_open_settings(app: AppHandle, sub: Option<String>) -> Result<(), String> {
    crate::show_main(&app);
    use tauri::Emitter;
    let sub = sub.unwrap_or_default();
    let target = if matches!(sub.as_str(), "translate" | "ocr" | "ask" | "profiles") {
        format!("ai-{sub}")
    } else {
        "ai".to_string()
    };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.emit("nav-to", target);
    }
    Ok(())
}

/// 问图自定义指令模板整存整取（空 id 由后端补；空 prompt 丢弃）。
#[tauri::command]
pub fn ai_templates_set(templates: Vec<once_core::ai::PromptTemplate>) -> Result<once_core::ai::AiConfig, String> {
    settings::update(|s| {
        let mut t = templates;
        for (i, tpl) in t.iter_mut().enumerate() {
            if tpl.id.trim().is_empty() {
                tpl.id = format!("t{}", once_core::storage::shortid());
            }
            tpl.name = tpl.name.trim().to_string();
            if tpl.name.is_empty() {
                tpl.name = format!("模板 {}", i + 1);
            }
            tpl.prompt = tpl.prompt.trim().to_string();
        }
        t.retain(|tpl| !tpl.prompt.is_empty());
        s.ai.templates = t;
    })
    .map(|s| s.ai)
    .map_err(|e| e.to_string())
}

// ===== PaddleOCR 本地增强包（状态/下载/删除；推理在 once-core `paddle` feature）=====

/// 下载互斥：同一时刻只允许一个下载（前端按钮 disabled 兜底，后端再防一层）。
static PACK_DOWNLOADING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 包状态：installed + 版本（读 pack.json；文件缺失/坏 JSON 视为未安装）。
#[tauri::command]
pub fn ocr_pack_status() -> serde_json::Value {
    let installed = once_core::ocr_pack::installed();
    let version = std::fs::read_to_string(once_core::ocr_pack::pack_dir().join("pack.json"))
        .ok()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v["version"].as_str().map(String::from))
        .unwrap_or_default();
    serde_json::json!({
        "installed": installed,
        "version": version,
        "downloading": PACK_DOWNLOADING.load(std::sync::atomic::Ordering::Relaxed),
    })
}

/// 下载模型包（阻塞 HTTP 独立线程；进度经 ocr-pack-progress 事件推送）。
/// source: modelscope（默认，国内快）| huggingface。完成/失败由 invoke 返回值承接。
#[tauri::command]
pub async fn ocr_pack_download(app: AppHandle, source: String) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if !matches!(source.as_str(), "modelscope" | "huggingface") {
        return Err(format!("未知下载源：{source}"));
    }
    if PACK_DOWNLOADING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有下载在进行——请等待完成".into());
    }
    use tauri::Emitter;
    let handle = app.clone();
    let r = std::thread::spawn(move || {
        let mut last = std::time::Instant::now() - std::time::Duration::from_millis(500);
        once_core::ocr_pack::download(&source, &mut |received, total| {
            // 150ms 节流：事件风暴会卡 UI 线程
            if last.elapsed() >= std::time::Duration::from_millis(150) || received >= total {
                last = std::time::Instant::now();
                let _ = handle.emit(
                    "ocr-pack-progress",
                    serde_json::json!({ "received": received, "total": total }),
                );
            }
        })
    })
    .join()
    .map_err(|e| format!("下载线程异常：{e:?}"));
    PACK_DOWNLOADING.store(false, Ordering::Relaxed);
    match r {
        Ok(inner) => inner.map_err(|e| e.to_string()),
        Err(msg) => Err(msg),
    }
}

/// 删除本地包（删除后若引擎指向 paddle，调用时会报「未安装」并引导，不静默回退）。
#[tauri::command]
pub fn ocr_pack_delete() -> Result<(), String> {
    once_core::ocr_pack::delete().map_err(|e| e.to_string())
}
