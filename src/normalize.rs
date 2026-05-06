use std::borrow::Cow;

static ZH_EN_MAP: &[(&str, &str)] = &[
    ("下一步", "next"),
    ("上一步", "prev"),
    ("关闭", "close"),
    ("删除", "delete"),
    ("取消", "cancel"),
    ("发送", "send"),
    ("提交", "submit"),
    ("搜索", "search"),
    ("注册", "register"),
    ("登录", "login"),
    ("确认", "confirm"),
    ("用户名", "username"),
    ("密码", "password"),
];

pub fn normalize_text(input: &str) -> Cow<'_, str> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Cow::Borrowed("");
    }

    // 常用词汇中英文映射
    for &(zh, en) in ZH_EN_MAP {
        if trimmed == zh {
            return Cow::Borrowed(en);
        }
    }

    // 限制长度，避免大段文本占用过多 token
    const MAX_TEXT_LEN: usize = 32;
    if trimmed.chars().count() > MAX_TEXT_LEN {
        let truncated: String = trimmed.chars().take(MAX_TEXT_LEN).collect();
        return Cow::Owned(format!("{}...", truncated));
    }

    if trimmed.len() != input.len() {
        Cow::Owned(trimmed.to_string())
    } else {
        Cow::Borrowed(input)
    }
}

pub fn infer_placeholder_semantic(placeholder: &str) -> Option<&'static str> {
    for &(zh, en) in ZH_EN_MAP {
        if placeholder.contains(zh) {
            return Some(en);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize() {
        assert_eq!(normalize_text("登录"), "login");
        assert_eq!(normalize_text("用户名"), "username");
        assert_eq!(normalize_text("hello"), "hello");
        assert_eq!(normalize_text(" 搜索 "), "search");
    }
}
