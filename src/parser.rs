use crate::types::NodeKind;

pub struct ParsedNode {
    pub tag: String,
    pub text: String,
    pub attrs: Vec<(String, String)>,
    #[allow(dead_code)]
    pub depth: u16,
}

impl ParsedNode {
    pub fn get_attr(&self, key: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    pub fn infer_kind(&self) -> Option<NodeKind> {
        let role = self.get_attr("role");
        match self.tag.as_str() {
            "button" => Some(NodeKind::Btn),
            "a" => Some(NodeKind::Lnk),
            "img" => Some(NodeKind::Img),
            "select" => Some(NodeKind::Sel),
            "input" => {
                let t = self.get_attr("type").unwrap_or("text");
                match t {
                    "checkbox" | "radio" => Some(NodeKind::Chk),
                    "submit" | "button" => Some(NodeKind::Btn),
                    "hidden" => None,
                    _ => Some(NodeKind::Inp),
                }
            }
            "textarea" => Some(NodeKind::Inp),
            _ => {
                if role == Some("button")
                    || role == Some("link")
                    || role == Some("checkbox")
                    || role == Some("menuitem")
                    || self.get_attr("onclick").is_some()
                    || self.get_attr("data-agent-id").is_some()
                {
                    match role {
                        Some("link") => Some(NodeKind::Lnk),
                        Some("checkbox") => Some(NodeKind::Chk),
                        _ => Some(NodeKind::Btn),
                    }
                } else if !self.text.is_empty() && self.tag != "div" && self.tag != "span" {
                    // 仅当文本节点在有意义的标签中时才保留，减少 div/span 噪音
                    Some(NodeKind::Txt)
                } else {
                    None
                }
            }
        }
    }
}

const SKIP_TAGS: &[&str] = &[
    "script", "style", "noscript", "meta", "link", "head", "svg", "path",
];

fn is_skip_tag(tag: &str) -> bool {
    SKIP_TAGS.contains(&tag)
}

fn is_inline_hidden(attrs: &[(String, String)]) -> bool {
    for (k, v) in attrs {
        if k == "style" {
            let lower = v.to_lowercase();
            if lower.contains("display:none")
                || lower.contains("display: none")
                || lower.contains("visibility:hidden")
                || lower.contains("visibility: hidden")
            {
                return true;
            }
        }
        if k == "aria-hidden" && v == "true" {
            return true;
        }
        if k == "hidden" {
            return true;
        }
    }
    false
}

fn collect_text<'a>(node: &'a tl::Node<'a>, parser: &'a tl::Parser<'a>) -> String {
    match node {
        tl::Node::Raw(raw) => raw.as_utf8_str().trim().to_string(),
        tl::Node::Tag(tag) => {
            let name = tag.name().as_utf8_str().to_lowercase();
            if is_skip_tag(&name) {
                return String::new();
            }
            let mut text = String::new();
            let children = tag.children();
            for child in children.top().iter() {
                if let Some(child_node) = child.get(parser) {
                    let child_text = collect_text(child_node, parser);
                    if !child_text.is_empty() {
                        if !text.is_empty() {
                            text.push(' ');
                        }
                        text.push_str(&child_text);
                    }
                }
            }
            text
        }
        _ => String::new(),
    }
}

pub fn parse_html(html: &str) -> Vec<ParsedNode> {
    let dom = tl::parse(html, tl::ParserOptions::default()).unwrap();
    let parser = dom.parser();
    let mut nodes = Vec::new();

    for node_handle in dom.nodes() {
        if let tl::Node::Tag(tag) = node_handle {
            let tag_name = tag.name().as_utf8_str().to_lowercase();

            if is_skip_tag(&tag_name) {
                continue;
            }

            let attrs: Vec<(String, String)> = tag
                .attributes()
                .iter()
                .map(|(k, v)| {
                    (
                        k.to_string(),
                        v.map(|val| val.to_string()).unwrap_or_default(),
                    )
                })
                .collect();

            if is_inline_hidden(&attrs) {
                continue;
            }

            let mut text = {
                let mut t = String::new();
                let children = tag.children();
                for child in children.top().iter() {
                    if let Some(child_node) = child.get(parser) {
                        let ct = collect_text(child_node, parser);
                        if !ct.is_empty() {
                            if !t.is_empty() {
                                t.push(' ');
                            }
                            t.push_str(&ct);
                        }
                    }
                }
                t
            };

            // 如果节点本身没有文本，尝试从属性中获取语义信息
            if text.is_empty() {
                if let Some(aria) = attrs.iter().find(|(k, _)| k == "aria-label").map(|(_, v)| v) {
                    text = aria.clone();
                } else if let Some(placeholder) = attrs.iter().find(|(k, _)| k == "placeholder").map(|(_, v)| v) {
                    text = placeholder.clone();
                } else if let Some(title) = attrs.iter().find(|(k, _)| k == "title").map(|(_, v)| v) {
                    text = title.clone();
                } else if let Some(alt) = attrs.iter().find(|(k, _)| k == "alt").map(|(_, v)| v) {
                    text = alt.clone();
                }
            }

            let parsed = ParsedNode {
                tag: tag_name,
                text,
                attrs,
                depth: 0,
            };

            if parsed.infer_kind().is_some() {
                nodes.push(parsed);
            }
        }
    }

    nodes
}
