#[cfg(test)]
mod tests {
    use web_agent_ir::compress_html;
    use web_agent_ir::compress_ir;

    #[test]
    fn test_basic_html() {
        let html = r#"<div><button>登录</button><input placeholder="用户名" /></div>"#;
        let result = compress_html(html);
        assert!(result.contains("BTN(login)"));
        assert!(result.contains("INP(username)"));
    }

    #[test]
    fn test_skips_script() {
        let html = r#"<div><script>alert(1)</script><button>搜索</button></div>"#;
        let result = compress_html(html);
        assert!(!result.contains("alert"));
        assert!(result.contains("BTN(search)"));
    }

    #[test]
    fn test_hidden_elements() {
        let html = r#"<button style="display:none">隐藏</button><button>提交</button>"#;
        let result = compress_html(html);
        assert!(!result.contains("隐藏"));
        assert!(result.contains("BTN(submit)"));
    }

    #[test]
    fn test_link_element() {
        let html = r#"<a href="/home">首页</a>"#;
        let result = compress_html(html);
        assert!(result.contains("LNK("));
    }

    #[test]
    fn test_compress_ir_ultra() {
        let ir_json = r##"[{"id":12,"kind":"Btn","text":"login","selector":"[data-agent-id=\"12\"]","bbox":{"x":0,"y":0,"w":0,"h":0},"anchor":"0"}]"##;
        let result = compress_ir(ir_json, "ultra", None);
        assert_eq!(result, "B12=login");
    }

    #[test]
    fn test_compress_ir_normal() {
        let ir_json = r##"[{"id":12,"kind":"Btn","text":"login","selector":"#login-btn","bbox":{"x":0,"y":0,"w":0,"h":0},"anchor":"0"}]"##;
        let result = compress_ir(ir_json, "normal", None);
        assert_eq!(result, "BTN(login)#12");
    }
}
