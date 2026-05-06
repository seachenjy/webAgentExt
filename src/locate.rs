use serde::Serialize;

use crate::ir::NodeIR;
use crate::types::AgentAction;

#[derive(Debug, Serialize)]
#[serde(tag = "strategy", content = "value")]
pub enum LocateStrategy {
    AgentId(u32),
    Selector(String),
    SemanticText { text: String, tag: String },
}

pub fn resolve_location(action: &AgentAction, ir: &[NodeIR]) -> LocateStrategy {
    let node = ir.iter().find(|n| n.id == action.id);

    match node {
        Some(n) => {
            if n.dom_id.is_some() || n.selector.starts_with("[data-agent-id=") {
                LocateStrategy::AgentId(n.id)
            } else if !n.selector.is_empty() {
                LocateStrategy::Selector(n.selector.clone())
            } else {
                LocateStrategy::SemanticText {
                    text: n.text.clone(),
                    tag: String::new(),
                }
            }
        }
        None => LocateStrategy::AgentId(action.id),
    }
}
