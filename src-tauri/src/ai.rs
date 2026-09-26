//! AI 配置中心命令（v0.2 M1）：配置 CRUD（Key 进系统凭据库）、连接测试、审计。
//! 所有返回值不含 Key 明文；密钥只在凭据库与写入瞬间存在。

use once_core::ai::{self, AiConfig, AiProfile, TestKind};
use once_core::settings;
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// 前端视图：profile + has_key + 默认角色标记（无 Key 字段，密钥不出凭据库）。
#[derive(Serialize, Clone)]
pub struct AiProfileView {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub provider_name: String,
    pub base_url: String,
    pub text_model: String,
    pub vision_model: String,
    pub has_key: bool,
    pub is_default_text: bool,
    pub is_default_vision: bool,
}

/// 默认角色补任：缺失或悬空时改任第一套有对应模型的配置（与「首套配置自动担任默认」同策）。
/// 返回本次补任的（角色，配置名）——删除迁移时用于 toast 告知。
/// 只看模型名非空，不查 Key：Key 缺失在调用时报人话错误，不在补任路径做凭据查询。
fn autofill_defaults(cfg: &mut once_core::ai::AiConfig) -> Vec<(&'static str, String)> {
    let mut roles = Vec::new();
    let need_text = cfg
        .default_text
        .as_ref()
        .map_or(true, |id| cfg.profile(id).is_none());
    if need_text {
        let cand = cfg
            .profiles
            .iter()
            .find(|p| !p.text_model.is_empty())
            .map(|c| (c.id.clone(), c.name.clone()));
        if let Some((id, name)) = cand {
            cfg.default_text = Some(id);
            roles.push(("默认文字模型", name));
        }
    }
    let need_vision = cfg
        .default_vision
        .as_ref()
        .map_or(true, |id| cfg.profile(id).is_none());
    if need_vision {
        let cand = cfg
            .profiles
            .iter()
            .find(|p| !p.vision_model.is_empty())
            .map(|c| (c.id.clone(), c.name.clone()));
        if let Some((id, name)) = cand {
            cfg.default_vision = Some(id);
            roles.push(("默认视觉模型", name));
        }
    }
    roles
}

/// 启动自愈：历史数据默认角色缺失/悬空（如有视觉模型却未指定默认）时补任，幂等；无需修复不落盘。
pub fn heal_default_roles() {
    let mut probe = settings::load();
    if autofill_defaults(&mut probe.ai).is_empty() {
        return;
    }
    let _ = settings::update(|s| {
        autofill_defaults(&mut s.ai);
    });
}

fn views() -> Vec<AiProfileView> {
    let cfg = settings::load().ai;
    cfg.profiles
        .iter()
        .map(|p| AiProfileView {
            id: p.id.clone(),
            name: p.name.clone(),
            provider: p.provider.clone(),
            provider_name: ai::preset(&p.provider)
                .map(|x| x.name.to_string())
                .unwrap_or_else(|| p.provider.clone()),
            base_url: p.base_url.clone(),
            text_model: p.text_model.clone(),
            vision_model: p.vision_model.clone(),
            has_key: ai::key_exists(&p.id),
            is_default_text: cfg.default_text.as_deref() == Some(p.id.as_str()),
            is_default_vision: cfg.default_vision.as_deref() == Some(p.id.as_str()),
        })
        .collect()
}

/// 服务商预设（前端表单：名称/默认接口地址/建议模型 datalist/获取 Key 链接）。
#[tauri::command]
pub fn ai_presets() -> &'static [ai::ProviderPreset] {
    ai::PRESETS
}

/// 拉取该配置的可用模型列表（OpenAI 兼容 GET /models，独立线程跑阻塞 HTTP）。
#[tauri::command]
pub async fn ai_fetch_models(profile_id: String) -> Result<Vec<String>, String> {
    let cfg = settings::load().ai;
    let base_url = cfg
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or("配置不存在")?
        .base_url
        .clone();
    let key = ai::get_key(&profile_id).map_err(|e| e.to_string())?;
    let r = std::thread::spawn(move || ai::fetch_models(&base_url, &key))
        .join()
        .map_err(|e| format!("拉取线程异常：{e:?}"))?;
    r.map_err(|e| e.to_string())
}

/// 配置列表（含凭据存在性，不含密钥）。
#[tauri::command]
pub fn ai_list() -> Vec<AiProfileView> {
    views()
}

#[tauri::command]
pub fn ai_save_profile(profile: AiProfile, api_key: Option<String>) -> Result<AiConfig, String> {
    save_profile_inner(profile, api_key)
        .map(|_| settings::load().ai)
        .map_err(|e| e.to_string())
}

fn save_profile_inner(mut profile: AiProfile, api_key: Option<String>) -> once_core::Result<()> {
    profile.name = profile.name.trim().to_string();
    profile.base_url = profile.base_url.trim().trim_end_matches('/').to_string();
    profile.text_model = profile.text_model.trim().to_string();
    profile.vision_model = profile.vision_model.trim().to_string();
    if profile.name.is_empty() {
        profile.name = ai::preset(&profile.provider)
            .map(|p| p.name.to_string())
            .unwrap_or_else(|| "模型配置".into());
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
    // 先写凭据库再改配置：凭据写失败则整体失败，避免"配置在但 Key 缺"的半态
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
        // 默认角色自动补任：缺失/悬空时改任有对应模型的配置（用户可改）——
        // 保存任意配置即自愈历史遗留的空默认（如配了视觉模型却没指定默认视觉）
        autofill_defaults(cfg);
    })
    .map(|_| ())
}

/// 删除配置：连带清理凭据库中的 Key；默认角色悬空时自动迁移到下一套可用配置并 toast 告知
/// （不迁移会让翻译/问图在下次调用才报「未设置默认模型」，用户无从归因到这次删除）。
/// 必须 async：toast() 建窗口不能在同步 command 的主线程里做（死锁，见 deliver 同族坑）。
#[tauri::command]
pub async fn ai_delete_profile(app: AppHandle, id: String) -> Result<once_core::ai::AiConfig, String> {
    ai::delete_key(&id);
    let mut migrated: Vec<(&'static str, String)> = Vec::new();
    let r = settings::update(|s| {
        s.ai.profiles.retain(|p| p.id != id);
        s.ai.prune_defaults();
        migrated = autofill_defaults(&mut s.ai);
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

/// 默认角色指定（role: text|vision；id=None 清除）。
#[tauri::command]
pub fn ai_set_default(role: String, id: Option<String>) -> Result<AiConfig, String> {
    if !matches!(role.as_str(), "text" | "vision") {
        return Err(format!("未知角色：{role}"));
    }
    settings::update(|s| match role.as_str() {
        "text" => s.ai.default_text = id,
        "vision" => s.ai.default_vision = id,
        _ => {}
    })
    .map(|s| s.ai)
    .map_err(|e| e.to_string())
}

/// 连接测试：文字模型发最小对话，视觉模型发 1×1 图。阻塞 HTTP 经独立线程执行。
/// 每次测试入审计（服务商/模型/是否发送图像），不记录 Key 与响应正文。
#[tauri::command]
pub async fn ai_test(id: String, kind: String) -> Result<serde_json::Value, String> {
    let kind = TestKind::parse(&kind).map_err(|e| e.to_string())?;
    let cfg = settings::load().ai;
    let profile = cfg
        .profile(&id)
        .cloned()
        .ok_or_else(|| "配置不存在或已被删除".to_string())?;
    let model = match kind {
        TestKind::Text if profile.text_model.is_empty() => return Err("该配置未填写文字模型".into()),
        TestKind::Text => profile.text_model.clone(),
        TestKind::Vision if profile.vision_model.is_empty() => return Err("该配置未填写视觉模型".into()),
        TestKind::Vision => profile.vision_model.clone(),
    };
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

// ===== 生成（M2）：截图翻译 / AI 问图 =====
// 链路：无损冻结帧裁剪（不落历史）→ 本地 OCR（仅翻译）→ 默认模型生成 → 结果贴图。
// 每次调用入审计（服务商/模型/是否发送图像）；阻塞 HTTP 一律独立线程执行。

fn resolve_role(
    cfg: &once_core::ai::AiConfig,
    kind: TestKind,
) -> Result<(once_core::ai::AiProfile, String), String> {
    once_core::ai::default_profile(cfg, kind).map_err(|e| e.to_string())
}

/// 截图翻译：冻结帧区域 → 本地 OCR → 默认文字模型 → 译文。
#[tauri::command]
pub async fn ai_translate_region(x: i32, y: i32, w: u32, h: u32) -> Result<serde_json::Value, String> {
    let cfg = settings::load().ai;
    let lang = if cfg.translate_lang.trim().is_empty() {
        "简体中文".to_string()
    } else {
        cfg.translate_lang.clone()
    };
    let (profile, key) = resolve_role(&cfg, TestKind::Text)?;
    let provider = profile.provider.clone();
    let model = profile.text_model.clone();
    let r = std::thread::spawn(move || -> Result<(once_core::ai::AiProfile, once_core::ai::GenOutcome), once_core::OnceError> {
        let (rgba, rw, rh) = crate::scrollcmd::freeze_region_rgba(x, y, w, h)
            .map_err(|e| once_core::OnceError::capture(format!("冻结画面已失效：{e}")))?;
        let png = once_core::ai::rgba_to_png(&rgba, rw, rh)?;
        let ocr = once_core::ocr::provider()
            .recognize_png(&png)
            .map_err(|_| once_core::OnceError::ocr("本地识别失败——选区太窄或对比度过低"))?;
        let text = ocr.full_text.trim().to_string();
        if text.is_empty() {
            return Err(once_core::OnceError::ocr(
                "选区里没有发现文字——纯图内容请改用「问图」",
            ));
        }
        once_core::ai::translate_text(&cfg, &text, &lang)
    })
    .join()
    .map_err(|e| format!("翻译线程异常：{e:?}"))?;
    match r {
        Ok((_, out)) => {
            once_core::audit::record_ai("ai.translate", out.latency_ms as u64, 0, Some(&provider), Some(&model), Some(false));
            Ok(serde_json::json!({
                "ok": true,
                "text": out.text,
                "latency_ms": out.latency_ms,
                "meta": format!("{provider} · {model}"),
            }))
        }
        Err(e) => {
            once_core::audit::record_ai("ai.translate", 0, 1, Some(&provider), Some(&model), Some(false));
            Err(e.to_string())
        }
    }
}

/// AI 问图：冻结帧区域图 → 默认视觉模型 → 回答。
#[tauri::command]
pub async fn ai_ask_region(x: i32, y: i32, w: u32, h: u32, question: String) -> Result<serde_json::Value, String> {
    let cfg = settings::load().ai;
    let q = question.trim().to_string();
    if q.is_empty() {
        return Err("问题不能为空".into());
    }
    let (profile, key) = resolve_role(&cfg, TestKind::Vision)?;
    let provider = profile.provider.clone();
    let model = profile.vision_model.clone();
    let r = std::thread::spawn(move || -> Result<(once_core::ai::AiProfile, once_core::ai::GenOutcome), once_core::OnceError> {
        let (rgba, rw, rh) = crate::scrollcmd::freeze_region_rgba(x, y, w, h)
            .map_err(|e| once_core::OnceError::capture(format!("冻结画面已失效：{e}")))?;
        once_core::ai::ask_image_rgba(&cfg, &rgba, rw, rh, &q)
    })
    .join()
    .map_err(|e| format!("问图线程异常：{e:?}"))?;
    match r {
        Ok((_, out)) => {
            once_core::audit::record_ai("ai.ask", out.latency_ms as u64, 0, Some(&provider), Some(&model), Some(true));
            Ok(serde_json::json!({
                "ok": true,
                "text": out.text,
                "latency_ms": out.latency_ms,
                "meta": format!("{provider} · {model}"),
            }))
        }
        Err(e) => {
            once_core::audit::record_ai("ai.ask", 0, 1, Some(&provider), Some(&model), Some(true));
            Err(e.to_string())
        }
    }
}

/// 未配置 Key 时的就地引导：打开主面板并跳到「AI」页。
#[tauri::command]
pub fn ai_open_settings(app: AppHandle) -> Result<(), String> {
    crate::show_main(&app);
    use tauri::Emitter;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.emit("nav-to", "ai");
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
