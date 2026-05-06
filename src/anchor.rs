use fnv::FnvHasher;
use std::hash::{Hash, Hasher};

pub fn compute_anchor(tag: &str, text: &str, sibling_index: u32) -> String {
    let mut hasher = FnvHasher::default();
    tag.hash(&mut hasher);
    text.hash(&mut hasher);
    sibling_index.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deterministic() {
        let a = compute_anchor("button", "login", 0);
        let b = compute_anchor("button", "login", 0);
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn test_different_inputs() {
        let a = compute_anchor("button", "login", 0);
        let b = compute_anchor("button", "login", 1);
        assert_ne!(a, b);
    }
}
