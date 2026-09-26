//! AI 模型配置与调用（v0.2 M1）：BYOK 服务商预设、配置存储（settings，零密钥）、
//! API Key（系统凭据管理器：Windows 凭据管理器 / macOS 钥匙串）、
//! OpenAI 兼容协议客户端（连接测试）。GUI 与 CLI 共享本模块（三端同源）。
//!
//! 隐私铁律：Key 只进系统凭据库，绝不落 settings.json；任何网络调用都由用户主动触发。

use crate::error::{OnceError, Result};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

// ===== 服务商预设（第一批：OpenAI 兼容协议，一个 client 通吃）=====

#[derive(Debug, Clone, Serialize)]
pub struct ProviderPreset {
    pub id: &'static str,
    pub name: &'static str,
    /// OpenAI 兼容根路径（测试与后续调用拼 /chat/completions）。
    pub base_url: &'static str,
    /// 建议模型（前端 datalist 提示；自由文本，不锁死——模型名迭代快）。
    pub text_models: &'static [&'static str],
    pub vision_models: &'static [&'static str],
    pub hint: &'static str,
    /// 控制台「获取 Key」页面链接（前端展示为一键跳转）。
    pub key_url: &'static str,
}

pub const PRESETS: &[ProviderPreset] = &[
    ProviderPreset {
        id: "zhipu",
        name: "智谱 GLM",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        text_models: &["glm-4.6", "glm-4.5", "glm-4.5-air", "glm-4-flash"],
        vision_models: &["glm-4.5v", "glm-4v-plus"],
        hint: "推荐：文字与视觉模型齐备，国内直连",
        key_url: "https://open.bigmodel.cn/usercenter/apikeys",
    },
    ProviderPreset {
        id: "deepseek",
        name: "DeepSeek",
        base_url: "https://api.deepseek.com/v1",
        text_models: &["deepseek-chat", "deepseek-reasoner"],
        vision_models: &[],
        hint: "纯文字模型，适合截图翻译",
        key_url: "https://platform.deepseek.com/api_keys",
    },
    ProviderPreset {
        id: "openrouter",
        name: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1",
        text_models: &[],
        vision_models: &[],
        hint: "聚合网关：一个 Key 调多家模型",
        key_url: "https://openrouter.ai/keys",
    },
    ProviderPreset {
        id: "moonshot",
        name: "Kimi (Moonshot)",
        base_url: "https://api.moonshot.cn/v1",
        text_models: &["moonshot-v1-8k", "moonshot-v1-32k", "kimi-k2-0711-preview"],
        vision_models: &["moonshot-v1-8k-vision-preview"],
        hint: "长文本能力强，国内直连",
        key_url: "https://platform.moonshot.cn/console/api-keys",
    },
    ProviderPreset {
        id: "dashscope",
        name: "通义千问",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        text_models: &["qwen-max", "qwen-plus", "qwen-turbo"],
        vision_models: &["qwen-vl-max", "qwen-vl-plus"],
        hint: "阿里云百炼，国内直连",
        key_url: "https://bailian.console.aliyun.com/?apiKey=1",
    },
    ProviderPreset {
        id: "siliconflow",
        name: "硅基流动",
        base_url: "https://api.siliconflow.cn/v1",
        text_models: &["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
        vision_models: &["deepseek-ai/DeepSeek-VL2", "Qwen/Qwen2.5-VL-72B-Instruct"],
        hint: "国内聚合网关，含免费模型",
        key_url: "https://cloud.siliconflow.cn/account/ak",
    },
    ProviderPreset {
        id: "openai",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        text_models: &["gpt-4o", "gpt-4o-mini"],
        vision_models: &["gpt-4o"],
        hint: "海外服务，需网络可达",
        key_url: "https://platform.openai.com/api-keys",
    },
    ProviderPreset {
        id: "custom",
        name: "自定义端点",
        base_url: "",
        text_models: &[],
        vision_models: &[],
        hint: "任意 OpenAI 兼容服务，接口地址自填",
        key_url: "",
    },
];

pub fn preset(id: &str) -> Option<&'static ProviderPreset> {
    PRESETS.iter().find(|p| p.id == id)
}

// ===== 配置结构（settings.ai；全部非敏感字段）=====

/// 单套模型配置。API Key 不在本结构——只存系统凭据管理器。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AiProfile {
    pub id: String,
    pub name: String,
    /// ProviderPreset.id（custom = 自定义端点）。
    pub provider: String,
    pub base_url: String,
    /// 文字模型（翻译等文本任务；可空）。
    pub text_model: String,
    /// 视觉模型（问图、云端识别等读图任务；可空）。
    pub vision_model: String,
}

impl Default for AiProfile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            provider: "zhipu".into(),
            base_url: preset("zhipu").map(|p| p.base_url.into()).unwrap_or_default(),
            text_model: String::new(),
            vision_model: String::new(),
        }
    }
}

/// settings.ai：配置列表 + 默认角色（角色存 profile id）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct AiConfig {
    pub profiles: Vec<AiProfile>,
    /// 默认文字模型 → profile id（截图翻译用）。
    pub default_text: Option<String>,
    /// 默认视觉模型 → profile id（问图 / 云端识别用）。
    pub default_vision: Option<String>,
    /// 问图自定义指令模板（chips 中与预置指令并列）。
    pub templates: Vec<PromptTemplate>,
    /// 截图翻译目标语言（源语言由模型自动识别）。
    pub translate_lang: String,
}

impl AiConfig {
    pub fn profile(&self, id: &str) -> Option<&AiProfile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    /// 删除 profile 后修剪悬空的默认角色引用。
    pub fn prune_defaults(&mut self) {
        if let Some(id) = &self.default_text {
            if self.profile(id).is_none() {
                self.default_text = None;
            }
        }
        if let Some(id) = &self.default_vision {
            if self.profile(id).is_none() {
                self.default_vision = None;
            }
        }
    }
}

// ===== API Key：系统凭据管理器 =====

const KEYRING_SERVICE: &str = "Onceglance";

fn key_entry(profile_id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("ai-key-{profile_id}"))
        .map_err(|e| OnceError::io("无法访问系统凭据管理器").with_source(e.to_string()))
}

/// Key 是否已保存（凭据库读取失败一律按未保存展示，避免误报"已配好"）。
pub fn key_exists(profile_id: &str) -> bool {
    match key_entry(profile_id) {
        Ok(entry) => entry.get_password().is_ok(),
        Err(_) => false,
    }
}

pub fn set_key(profile_id: &str, key: &str) -> Result<()> {
    key_entry(profile_id)?
        .set_password(key)
        .map_err(|e| OnceError::io("API Key 写入凭据管理器失败").with_source(e.to_string()))
}

/// 读取 Key（未保存时报错，提示语面向用户）。
pub fn get_key(profile_id: &str) -> Result<String> {
    key_entry(profile_id)?
        .get_password()
        .map_err(|_| OnceError::denied("未保存该配置的 API Key，请到「AI」页填写"))
}

/// 删除 Key（尽力而为：profile 删除时顺带清理，凭据本就不存在不算错）。
pub fn delete_key(profile_id: &str) {
    if let Ok(entry) = key_entry(profile_id) {
        let _ = entry.delete_credential();
    }
}

// ===== 生成（M2：截图翻译 / AI 问图）=====

/// 问图自定义指令模板（AI 页管理；chips 中与预置指令并列）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct PromptTemplate {
    pub id: String,
    pub name: String,
    pub prompt: String,
}

impl Default for PromptTemplate {
    fn default() -> Self {
        Self { id: String::new(), name: String::new(), prompt: String::new() }
    }
}

/// 预置问图指令（工具条 chips 固定四条；不做配置项——保持开箱即用）。
pub const BUILTIN_PROMPTS: &[(&str, &str)] = &[
    ("解释这段内容", "解释这张截图的内容，用简体中文，简明扼要。"),
    ("提取成 Markdown 表格", "把图中的表格或数据提取成 Markdown 表格，只输出表格本身。"),
    ("总结要点", "总结这张截图的要点，用简体中文条目式输出。"),
    ("翻成中文", "把图中全部文字翻译成简体中文，只输出译文。"),
];

/// 翻译消息组：本地 OCR 文本 → 文字模型（只输出译文，保留换行）。
pub fn translate_messages(text: &str, target_lang: &str) -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({"role":"system","content": format!(
            "你是专业翻译引擎。把用户消息中的文本翻译成{target_lang}。\
             只输出译文本身：不要解释、不要加引号、不要复述原文；保留原有段落与换行。")}),
        serde_json::json!({"role":"user","content": text}),
    ]
}

/// 问图消息组：图片（data URL）+ 问题 → 视觉模型。
pub fn ask_messages(question: &str, image_data_url: &str) -> Vec<serde_json::Value> {
    vec![serde_json::json!({"role":"user","content":[
        {"type":"text","text": question},
        {"type":"image_url","image_url":{"url": image_data_url}},
    ]})]
}

/// 按角色取默认模型 + Key（未配置/配置缺失时报面向用户的人话错误）。
pub fn default_profile(cfg: &AiConfig, kind: TestKind) -> Result<(AiProfile, String)> {
    let id = match kind {
        TestKind::Text => cfg.default_text.as_ref(),
        TestKind::Vision => cfg.default_vision.as_ref(),
    }
    .ok_or_else(|| OnceError::denied("未设置默认模型——请到「AI」页选择"))?;
    let p = cfg
        .profile(id)
        .ok_or_else(|| OnceError::denied("默认模型配置已不存在——请到「AI」页重新选择"))?
        .clone();
    let key = get_key(&p.id)?;
    Ok((p, key))
}

pub struct ChatReq<'a> {
    pub base_url: &'a str,
    pub api_key: &'a str,
    pub model: &'a str,
    pub messages: &'a [serde_json::Value],
    pub max_tokens: u32,
}

pub struct GenOutcome {
    pub text: String,
    pub latency_ms: u128,
}

fn api_error(status: u16, body: &str, url: &str) -> OnceError {
    let brief: String = body.chars().take(160).collect();
    match status {
        401 | 403 => OnceError::denied("API Key 无效或无权限——核对 Key 与所属账号"),
        404 => OnceError::usage(format!("接口不存在（{url}）——接口地址应为 OpenAI 兼容根路径")),
        429 => OnceError::usage("触发限流：Key 有效，但请求过频或额度不足"),
        _ => OnceError::io(format!("服务返回 {status}：{brief}")),
    }
}

/// 通用对话补全（阻塞 HTTP，生成超时放宽到 120 秒）。
/// 拉取服务商可用模型列表（OpenAI 兼容 GET {base_url}/models，15 秒超时）。
/// 结果按字母序返回 id 列表；前端用于填充模型下拉（「没有选项」痛点的根治）。
pub fn fetch_models(base_url: &str, api_key: &str) -> Result<Vec<String>> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| OnceError::io(format!("HTTP 客户端初始化失败：{e}")))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .send()
        .map_err(|e| OnceError::io(format!("拉取失败：{e}")))?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if status.as_u16() != 200 {
        return Err(api_error(status.as_u16(), &body, &url));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| OnceError::io(format!("响应不是合法 JSON：{e}")))?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    Ok(ids)
}

pub fn chat_completion(req: &ChatReq) -> Result<GenOutcome> {
    let t0 = Instant::now();
    let url = chat_url(req.base_url);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| OnceError::io(format!("HTTP 客户端初始化失败：{e}")))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", req.api_key))
        .json(&serde_json::json!({
            "model": req.model,
            "messages": req.messages,
            "max_tokens": req.max_tokens,
            "temperature": 0.3,
        }))
        .send();
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            let msg = if e.is_timeout() {
                "生成超时（120 秒无响应）——缩小选区或换更快的模型再试".to_string()
            } else if e.is_connect() {
                format!("无法连接服务（{url}）——检查网络与接口地址")
            } else {
                format!("网络错误：{e}")
            };
            return Err(OnceError::io(msg));
        }
    };
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if status.as_u16() != 200 {
        return Err(api_error(status.as_u16(), &body, &url));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| OnceError::io(format!("响应不是合法 JSON：{e}")))?;
    let text = v["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OnceError::io("服务返回 200 但没有回复内容"))?;
    Ok(GenOutcome { text, latency_ms: t0.elapsed().as_millis() })
}

/// 截图翻译：本地提取的文本 → 默认文字模型。
pub fn translate_text(cfg: &AiConfig, text: &str, target_lang: &str) -> Result<(AiProfile, GenOutcome)> {
    let (p, key) = default_profile(cfg, TestKind::Text)?;
    if p.text_model.is_empty() {
        return Err(OnceError::usage("默认文字模型未填模型名——到「AI」页补齐"));
    }
    let msgs = translate_messages(text, target_lang);
    let out = chat_completion(&ChatReq {
        base_url: &p.base_url,
        api_key: &key,
        model: &p.text_model,
        messages: &msgs,
        max_tokens: 4096,
    })?;
    Ok((p.clone(), out))
}

/// 选区图预处理：RGBA → data URL；长边超 max_side 等比缩小；PNG 超 2MB 转 JPEG q85 控体积。
pub fn prepare_image_data_url(rgba: &[u8], w: u32, h: u32, max_side: u32) -> Result<String> {
    use base64::Engine as _;
    let mut img = image::RgbaImage::from_raw(w, h, rgba.to_vec())
        .ok_or_else(|| OnceError::capture("选区图像尺寸与数据不匹配"))?;
    let long = w.max(h);
    if long > max_side {
        let k = max_side as f64 / long as f64;
        let nw = ((w as f64) * k).round().max(1.0) as u32;
        let nh = ((h as f64) * k).round().max(1.0) as u32;
        img = image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Triangle);
    }
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(img.clone())
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| OnceError::io(format!("图像编码失败：{e}")))?;
    if png.len() <= 2 * 1024 * 1024 {
        return Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png)));
    }
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    let mut jpg = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 85);
    enc.encode_image(&image::DynamicImage::ImageRgb8(rgb))
        .map_err(|e| OnceError::io(format!("JPEG 编码失败：{e}")))?;
    Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&jpg)))
}

/// RGBA 裸像素 → PNG（本地 OCR 等需要编码输入的场合）。
pub fn rgba_to_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>> {
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec())
        .ok_or_else(|| OnceError::capture("图像尺寸与数据不匹配"))?;
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| OnceError::io(format!("图像编码失败：{e}")))?;
    Ok(png)
}

/// AI 问图：选区 RGBA 图 → 默认视觉模型。
pub fn ask_image_rgba(cfg: &AiConfig, rgba: &[u8], w: u32, h: u32, question: &str) -> Result<(AiProfile, GenOutcome)> {
    let (p, key) = default_profile(cfg, TestKind::Vision)?;
    if p.vision_model.is_empty() {
        return Err(OnceError::usage("默认视觉模型未填模型名——到「AI」页补齐"));
    }
    let data_url = prepare_image_data_url(rgba, w, h, 2048)?;
    let msgs = ask_messages(question, &data_url);
    let out = chat_completion(&ChatReq {
        base_url: &p.base_url,
        api_key: &key,
        model: &p.vision_model,
        messages: &msgs,
        max_tokens: 4096,
    })?;
    Ok((p.clone(), out))
}

#[cfg(test)]
mod gen_tests {
    use super::*;

    #[test]
    fn translate_messages_shape() {
        let m = translate_messages("hello", "简体中文");
        assert!(m[0]["content"].as_str().unwrap().contains("简体中文"));
        assert_eq!(m[1]["content"], "hello");
    }

    #[test]
    fn ask_messages_shape() {
        let m = ask_messages("这是什么", "data:image/png;base64,AAA");
        let content = m[0]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "text");
        assert!(content[1]["image_url"]["url"].as_str().unwrap().starts_with("data:image/"));
    }

    #[test]
    fn builtin_prompts_nonempty() {
        assert!(BUILTIN_PROMPTS.iter().all(|(n, p)| !n.is_empty() && !p.is_empty()));
    }

    #[test]
    fn config_carries_templates_and_lang() {
        let cfg = AiConfig {
            templates: vec![PromptTemplate { id: "t1".into(), name: "周报".into(), prompt: "整理成周报".into() }],
            translate_lang: "English".into(),
            ..Default::default()
        };
        let back: AiConfig = serde_json::to_value(&cfg).and_then(|v| serde_json::from_value(v)).unwrap();
        assert_eq!(back.templates[0].name, "周报");
        assert_eq!(back.translate_lang, "English");
        // 默认值：translate_lang 为空时上层回落简体中文
        assert!(AiConfig::default().translate_lang.is_empty());
    }
}

/// 测试目标：文字模型发最小对话；视觉模型发 1×1 图（读图链路双向验证）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TestKind {
    Text,
    Vision,
}

impl TestKind {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "text" => Ok(TestKind::Text),
            "vision" => Ok(TestKind::Vision),
            _ => Err(OnceError::usage(format!("未知测试类型：{s}（text|vision）"))),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TestOutcome {
    pub ok: bool,
    pub latency_ms: u128,
    pub model: String,
    pub kind: TestKind,
    pub message: String,
}

/// 1×1 PNG（透明像素）的 base64——视觉链路验证用最小图。
const PING_PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/// base_url 拼接 /chat/completions（容忍尾部斜杠与 /v1 后缀写法差异）。
pub fn chat_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

/// 纯函数构造请求体（单测覆盖）。
fn chat_body(model: &str, kind: TestKind) -> serde_json::Value {
    let message = match kind {
        TestKind::Text => serde_json::json!({ "role": "user", "content": "回复 ok 两个字母即可" }),
        TestKind::Vision => serde_json::json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "这张图里有什么？回复 ok 两个字母即可" },
                { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{PING_PNG_1X1}") } },
            ],
        }),
    };
    serde_json::json!({
        "model": model,
        "messages": [message],
        "max_tokens": 16,
        "temperature": 0,
    })
}

/// 连接测试（阻塞 HTTP——GUI 侧经 spawn_blocking 调用，CLI 侧直调）。
/// 永不 panic、永不超时卡死（30s 上限）；结果面向用户展示。
pub fn test_connection(base_url: &str, api_key: &str, model: &str, kind: TestKind) -> TestOutcome {
    let t0 = Instant::now();
    let finish = |ok: bool, message: String| TestOutcome {
        ok,
        latency_ms: t0.elapsed().as_millis(),
        model: model.to_string(),
        kind,
        message,
    };
    let url = chat_url(base_url);
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return finish(false, format!("HTTP 客户端初始化失败：{e}")),
    };
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&chat_body(model, kind))
        .send();
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            let msg = if e.is_timeout() {
                "请求超时（30 秒无响应）——检查网络或接口地址".to_string()
            } else if e.is_connect() {
                format!("无法连接服务——检查网络与接口地址（{url}）")
            } else {
                format!("网络错误：{e}")
            };
            return finish(false, msg);
        }
    };
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    match status.as_u16() {
        200 => {
            let parsed: std::result::Result<serde_json::Value, _> = serde_json::from_str(&body);
            match parsed {
                Ok(v) if v.get("choices").is_some() => {
                    finish(true, "连接成功，模型可用".into())
                }
                _ => finish(false, "服务返回 200 但响应不是 OpenAI 兼容格式——确认接口地址".into()),
            }
        }
        401 | 403 => finish(false, "API Key 无效或无权限——核对 Key 与所属账号".into()),
        404 => finish(false, format!("接口不存在（{url}）——接口地址应为 OpenAI 兼容根路径")),
        429 => finish(false, "触发限流：Key 有效，但请求过频或额度不足".into()),
        code => {
            // 摘要服务端错误信息（截断，审计与界面都不落全量响应）
            let brief: String = body.chars().take(160).collect();
            finish(false, format!("服务返回 {code}：{brief}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_lookup_and_shapes() {
        assert_eq!(preset("zhipu").unwrap().name, "智谱 GLM");
        assert!(preset("nope").is_none());
        assert_eq!(PRESETS.len(), 4);
        assert!(!preset("zhipu").unwrap().vision_models.is_empty());
    }

    #[test]
    fn profile_roundtrip_without_key() {
        let p = AiProfile {
            id: "p1".into(),
            name: "智谱主力".into(),
            provider: "zhipu".into(),
            base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
            text_model: "glm-4.6".into(),
            vision_model: "glm-4.5v".into(),
        };
        let cfg = AiConfig { profiles: vec![p.clone()], default_text: Some("p1".into()), default_vision: None, ..Default::default() };
        let v = serde_json::to_value(&cfg).unwrap();
        let s = serde_json::to_string(&v).unwrap();
        // 铁律：配置序列化结果里不允许出现 key 字样字段（Key 只在凭据库）
        assert!(!s.contains("api_key"));
        let back: AiConfig = serde_json::from_value(v).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn prune_defaults_removes_dangling() {
        let mut cfg = AiConfig {
            profiles: vec![],
            default_text: Some("gone".into()),
            default_vision: Some("gone2".into()),
            ..Default::default()
        };
        cfg.prune_defaults();
        assert!(cfg.default_text.is_none());
        assert!(cfg.default_vision.is_none());
    }

    #[test]
    fn chat_url_tolerates_trailing_slash() {
        assert_eq!(chat_url("https://x.com/v1/"), "https://x.com/v1/chat/completions");
        assert_eq!(chat_url("https://x.com/v1"), "https://x.com/v1/chat/completions");
    }

    #[test]
    fn chat_body_shapes() {
        let text = chat_body("glm-4.6", TestKind::Text);
        assert_eq!(text["messages"][0]["content"], "回复 ok 两个字母即可");
        let vision = chat_body("glm-4.5v", TestKind::Vision);
        let content = vision["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image_url");
        assert!(content[1]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    #[test]
    fn test_kind_parse() {
        assert!(matches!(TestKind::parse("text"), Ok(TestKind::Text)));
        assert!(matches!(TestKind::parse("vision"), Ok(TestKind::Vision)));
        assert!(TestKind::parse("nope").is_err());
    }
}
