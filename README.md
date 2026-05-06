# Web Agent IR (Intermediate Representation)

[English](#english) | [中文](#中文)

---

## 中文

Web Agent IR 是一个高性能的网页中间表示生成器，旨在为大语言模型（LLM）提供精炼、语义丰富且高效的网页交互界面描述。它通过 Rust 编写并编译为 WebAssembly，可在浏览器扩展或自动化脚本中无缝运行。

### 核心特性

- **高效压缩**：通过 Token DSL 将复杂的 HTML 结构压缩为极简表示（Normal/Ultra 模式），显著降低 LLM 的上下文消耗。
- **语义增强**：智能提取 `aria-label`、`placeholder` 等关键属性，即使是无文字的交互元素也能被准确识别。
- **智能预算管理**：支持按 Token 预算自动筛选最重要的交互节点（如按钮、输入框），确保核心功能优先。
- **三层定位策略**：生成的 Action 支持 `AgentId`、`Selector` 和 `SemanticText` 三层回退定位，确保自动化执行的稳定性。
- **浏览器扩展集成**：内置 Chrome 侧边栏（Side Panel）扩展，支持实时页面分析、Action 执行测试以及自动化 Agent 循环。

### 快速开始

1. **构建 WASM**:
   ```bash
   wasm-pack build --target web --out-dir pkg
   ```
2. **安装扩展**:
   - 打开 Chrome 扩展程序页面 (`chrome://extensions/`)
   - 开启“开发者模式”
   - 点击“加载已解压的扩展程序”，选择 `extension` 目录

---

<a name="english"></a>
## English

Web Agent IR is a high-performance web intermediate representation generator designed to provide LLMs with concise, semantically rich, and efficient descriptions of web interactive interfaces. Built with Rust and compiled to WebAssembly, it runs seamlessly in browser extensions or automation scripts.

### Key Features

- **Efficient Compression**: Compresses complex HTML structures into minimalist Token DSL (Normal/Ultra modes), significantly reducing LLM context consumption.
- **Semantic Enrichment**: Intelligently extracts key attributes like `aria-label` and `placeholder`, ensuring interactive elements without text are accurately recognized.
- **Smart Budget Management**: Supports automatic filtering of the most important interactive nodes (e.g., buttons, inputs) based on a token budget, prioritizing core functionality.
- **Triple-Layer Resolution**: Generated actions support a fallback resolution strategy across `AgentId`, `Selector`, and `SemanticText`, ensuring stable automation execution.
- **Browser Extension**: Includes a built-in Chrome Side Panel extension for real-time page analysis, action execution testing, and an automated agent loop.

### Quick Start

1. **Build WASM**:
   ```bash
   wasm-pack build --target web --out-dir pkg
   ```
2. **Install Extension**:
   - Open Chrome Extensions page (`chrome://extensions/`)
   - Enable "Developer mode"
   - Click "Load unpacked" and select the `extension` directory
