use serde::{Deserialize, Serialize};

use crate::anchor::compute_anchor;
use crate::normalize::{infer_placeholder_semantic, normalize_text};
use crate::parser::ParsedNode;
use crate::types::{BBox, NodeKind};

#[derive(Debug, Serialize, Deserialize)]
pub struct NodeIR {
    pub id: u32,
    pub kind: NodeKind,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dom_id: Option<String>,
    pub selector: String,
    pub bbox: BBox,
    pub anchor: String,
}

fn build_selector(node: &ParsedNode, id: u32) -> String {
    if let Some(dom_id) = node.get_attr("id") {
        return format!("#{}", dom_id);
    }
    if let Some(name) = node.get_attr("name") {
        return format!("{}[name=\"{}\"]", node.tag, name);
    }
    if let Some(placeholder) = node.get_attr("placeholder") {
        return format!("{}[placeholder=\"{}\"]", node.tag, placeholder);
    }
    format!("[data-agent-id=\"{}\"]", id)
}

fn extract_text(node: &ParsedNode) -> String {
    // 优先使用 aria-label，因为它通常包含开发者专门为可访问性准备的语义
    if let Some(aria_label) = node.get_attr("aria-label") {
        return normalize_text(aria_label).into_owned();
    }
    // 其次是 placeholder，常用于输入框
    if let Some(placeholder) = node.get_attr("placeholder") {
        if let Some(semantic) = infer_placeholder_semantic(placeholder) {
            return semantic.to_string();
        }
        return normalize_text(placeholder).into_owned();
    }
    // 然后是节点本身的文本内容
    if !node.text.is_empty() {
        return normalize_text(&node.text).into_owned();
    }
    // 最后尝试其他属性
    if let Some(alt) = node.get_attr("alt") {
        return normalize_text(alt).into_owned();
    }
    if let Some(title) = node.get_attr("title") {
        return normalize_text(title).into_owned();
    }
    if let Some(value) = node.get_attr("value") {
        if !value.is_empty() {
            return normalize_text(value).into_owned();
        }
    }
    String::new()
}

pub fn build_ir(nodes: &[ParsedNode], bbox_data: &[f32]) -> Vec<NodeIR> {
    let mut ir_nodes = Vec::with_capacity(nodes.len());
    let mut fallback_id = 10000; // 为没有 data-agent-id 的节点（如纯文本）分配的高位 ID

    for (i, node) in nodes.iter().enumerate() {
        let kind = match node.infer_kind() {
            Some(k) => k,
            None => continue,
        };

        // 优先从属性中读取 JS 注入的 ID
        let id = node
            .get_attr("data-agent-id")
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or_else(|| {
                let id = fallback_id;
                fallback_id += 1;
                id
            });

        let text = extract_text(node);
        let dom_id = node.get_attr("id").map(|s| s.to_string());
        let selector = build_selector(node, id);

        let bbox = if bbox_data.len() >= (i + 1) * 4 {
            let base = i * 4;
            BBox {
                x: bbox_data[base],
                y: bbox_data[base + 1],
                w: bbox_data[base + 2],
                h: bbox_data[base + 3],
            }
        } else {
            BBox::default()
        };

        let anchor = compute_anchor(&node.tag, &text, id);

        ir_nodes.push(NodeIR {
            id,
            kind,
            text,
            dom_id,
            selector,
            bbox,
            anchor,
        });
    }

    ir_nodes
}
