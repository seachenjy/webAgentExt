mod anchor;
mod budget;
mod ir;
mod locate;
mod normalize;
mod parser;
mod token;
mod types;

use wasm_bindgen::prelude::*;

use crate::budget::{filter_useless, trim_to_budget};
use crate::ir::build_ir;
use crate::parser::parse_html;
use crate::token::{generate_tokens, TokenConfig};
use crate::types::TokenMode;

#[wasm_bindgen]
pub fn compress_html(html: &str) -> String {
    let nodes = parse_html(html);
    let mut ir_nodes = build_ir(&nodes, &[]);
    filter_useless(&mut ir_nodes);
    let config = TokenConfig {
        mode: TokenMode::Normal,
        budget: None,
    };
    generate_tokens(&ir_nodes, &config)
}

#[wasm_bindgen]
pub fn build_ir_wasm(html: &str, bbox_data: Option<Box<[f32]>>) -> JsValue {
    let nodes = parse_html(html);
    let bbox = bbox_data.as_deref().unwrap_or(&[]);
    let ir_nodes = build_ir(&nodes, bbox);
    serde_wasm_bindgen::to_value(&ir_nodes).unwrap_or(JsValue::NULL)
}

#[wasm_bindgen]
pub fn compress_ir(ir_json: &str, mode: &str, budget: Option<usize>) -> String {
    let mut ir_nodes: Vec<ir::NodeIR> = match serde_json::from_str(ir_json) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };

    filter_useless(&mut ir_nodes);

    if let Some(b) = budget {
        trim_to_budget(&mut ir_nodes, b);
    }

    let token_mode = match mode {
        "ultra" => TokenMode::Ultra,
        _ => TokenMode::Normal,
    };

    let config = TokenConfig {
        mode: token_mode,
        budget,
    };
    generate_tokens(&ir_nodes, &config)
}

#[wasm_bindgen]
pub fn resolve_action(action_json: &str, ir_json: &str) -> JsValue {
    let action: types::AgentAction = match serde_json::from_str(action_json) {
        Ok(v) => v,
        Err(_) => return JsValue::NULL,
    };
    let ir_nodes: Vec<ir::NodeIR> = match serde_json::from_str(ir_json) {
        Ok(v) => v,
        Err(_) => return JsValue::NULL,
    };

    let strategy = locate::resolve_location(&action, &ir_nodes);
    serde_wasm_bindgen::to_value(&strategy).unwrap_or(JsValue::NULL)
}
