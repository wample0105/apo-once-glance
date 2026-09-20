//! 隐私 App 黑名单（SET-3）：进程名精确匹配（大小写不敏感）+
//! 窗口标题关键字包含匹配（支持 `*关键字*` 通配写法），命中其一即拒。
//! 只提供"拦截 + 调整黑名单"路径，绝不提供"本次放行"。

use crate::settings::Settings;

pub struct BlacklistHit {
    pub pattern: String,
}

/// 返回命中的条目；未命中返回 None。
pub fn check(settings: &Settings, process_name: &str, window_title: &str) -> Option<BlacklistHit> {
    let proc_lower = process_name.to_lowercase();
    let title_lower = window_title.to_lowercase();
    for entry in &settings.blacklist {
        if !entry.enabled || entry.pattern.trim().is_empty() {
            continue;
        }
        let pat = entry.pattern.trim();
        // 去掉用户写的通配星号，语义统一为"包含匹配"
        let pat_clean = pat.trim_matches('*').to_lowercase();
        if pat_clean.is_empty() {
            continue;
        }
        if proc_lower == pat_clean || proc_lower == format!("{pat_clean}.exe") {
            return Some(BlacklistHit { pattern: pat.to_string() });
        }
        if title_lower.contains(&pat_clean) {
            return Some(BlacklistHit { pattern: pat.to_string() });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{builtin_blacklist, Settings};

    #[test]
    fn hits_process_and_title() {
        let mut s = Settings::default();
        s.blacklist = builtin_blacklist();
        assert!(check(&s, "1password.exe", "").is_some());
        assert!(check(&s, "notepad.exe", "工商银行 - 登录").is_some());
        assert!(check(&s, "chrome.exe", "GitHub").is_none());
        // 停用后不再命中
        s.blacklist[0].enabled = false;
        assert!(check(&s, "1Password.exe", "").is_none());
    }
}
