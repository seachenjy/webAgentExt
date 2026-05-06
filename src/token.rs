use crate::ir::NodeIR;
use crate::types::TokenMode;

pub struct TokenConfig {
    pub mode: TokenMode,
    pub budget: Option<usize>,
}

pub fn generate_tokens(nodes: &[NodeIR], config: &TokenConfig) -> String {
    if nodes.is_empty() {
        return String::new();
    }

    // 如果没有预算限制，直接生成
    if config.budget.is_none() {
        let mut buf = String::with_capacity(nodes.len() * 16);
        for node in nodes {
            if !buf.is_empty() {
                buf.push('\n');
            }
            node_to_token(node, config.mode, &mut buf);
        }
        return buf;
    }

    let budget = config.budget.unwrap();
    let mut allowed_ids = std::collections::HashSet::new();
    let mut prioritized_indices: Vec<usize> = (0..nodes.len()).collect();

    // 按重要程度排序索引
    prioritized_indices.sort_by_key(|&i| match nodes[i].kind {
        crate::types::NodeKind::Btn | crate::types::NodeKind::Inp | crate::types::NodeKind::Sel | crate::types::NodeKind::Chk => 0,
        crate::types::NodeKind::Lnk => 1,
        crate::types::NodeKind::Txt => 2,
        crate::types::NodeKind::Img => 3,
    });

    let mut current_len = 0;
    for &i in &prioritized_indices {
        let node = &nodes[i];
        let mut node_buf = String::new();
        node_to_token(node, config.mode, &mut node_buf);
        let entry_len = node_buf.len() + if allowed_ids.is_empty() { 0 } else { 1 };

        if current_len + entry_len <= budget {
            allowed_ids.insert(node.id);
            current_len += entry_len;
        }
    }

    // 按原始顺序生成最终的 token 字符串
    let mut buf = String::with_capacity(current_len);
    for node in nodes {
        if allowed_ids.contains(&node.id) {
            if !buf.is_empty() {
                buf.push('\n');
            }
            node_to_token(node, config.mode, &mut buf);
        }
    }

    buf
}

fn node_to_token(node: &NodeIR, mode: TokenMode, buf: &mut String) {
    match mode {
        TokenMode::Normal => {
            buf.push_str(node.kind.label());
            buf.push('(');
            buf.push_str(&node.text);
            buf.push_str(")#");
            buf.push_str(&node.id.to_string());
        }
        TokenMode::Ultra => {
            buf.push(node.kind.abbrev());
            buf.push_str(&node.id.to_string());
            buf.push('=');
            buf.push_str(&node.text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{BBox, NodeKind};

    #[test]
    fn test_normal_mode() {
        let nodes = vec![NodeIR {
            id: 12,
            kind: NodeKind::Btn,
            text: "login".to_string(),
            dom_id: None,
            selector: "[data-agent-id=\"12\"]".to_string(),
            bbox: BBox::default(),
            anchor: String::new(),
        }];
        let config = TokenConfig { mode: TokenMode::Normal, budget: None };
        assert_eq!(generate_tokens(&nodes, &config), "BTN(login)#12");
    }

    #[test]
    fn test_ultra_mode() {
        let nodes = vec![NodeIR {
            id: 13,
            kind: NodeKind::Inp,
            text: "username".to_string(),
            dom_id: None,
            selector: "input[placeholder=\"用户名\"]".to_string(),
            bbox: BBox::default(),
            anchor: String::new(),
        }];
        let config = TokenConfig { mode: TokenMode::Ultra, budget: None };
        assert_eq!(generate_tokens(&nodes, &config), "I13=username");
    }
}
