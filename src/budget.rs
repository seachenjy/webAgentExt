use crate::ir::NodeIR;
use crate::types::NodeKind;

pub fn filter_useless(nodes: &mut Vec<NodeIR>) {
    nodes.retain(|node| {
        if node.kind == NodeKind::Txt && node.text.is_empty() {
            return false;
        }
        true
    });
}

fn score_node(node: &NodeIR) -> u8 {
    match node.kind {
        NodeKind::Btn | NodeKind::Inp | NodeKind::Sel | NodeKind::Chk => 10,
        NodeKind::Lnk => 8,
        NodeKind::Img => 4,
        NodeKind::Txt => {
            if node.text.len() > 2 {
                6
            } else {
                2
            }
        }
    }
}

pub fn trim_to_budget(nodes: &mut Vec<NodeIR>, budget: usize) {
    let mut total: usize = nodes.iter().map(|n| estimate_token_len(n)).sum();

    if total <= budget {
        return;
    }

    let mut scored: Vec<(usize, u8)> = nodes.iter().enumerate().map(|(i, n)| (i, score_node(n))).collect();
    scored.sort_by_key(|(_, s)| *s);

    let mut remove_set = Vec::new();
    for (idx, _) in &scored {
        if total <= budget {
            break;
        }
        total -= estimate_token_len(&nodes[*idx]);
        remove_set.push(*idx);
    }

    remove_set.sort_unstable();
    for idx in remove_set.into_iter().rev() {
        nodes.remove(idx);
    }
}

fn estimate_token_len(node: &NodeIR) -> usize {
    node.kind.label().len() + node.text.len() + 6
}
