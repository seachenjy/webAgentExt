import init, { build_ir_wasm, compress_ir, resolve_action } from './wasm/web_agent_ir.js';

let wasmReady = false;
let abortController = null;

async function ensureWasm() {
  if (wasmReady) return;
  await init({ module_or_path: chrome.runtime.getURL('wasm/web_agent_ir_bg.wasm') });
  wasmReady = true;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function injectAndRun(fn, args = []) {
  const tab = await getActiveTab();
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fn, args });
  return results[0]?.result;
}

async function waitForTabLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, timeout);
    function listener(id, info) { if (id === tabId && info.status === 'complete') { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); } }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function navigateTo(url) {
  const tab = await getActiveTab();
  await chrome.tabs.update(tab.id, { url });
  await waitForTabLoad(tab.id);
}

const NODE_TEMPLATES = {
  navigate: { label: '导航', desc: '打开URL', fields: [
    { key: 'url', label: 'URL', type: 'text', placeholder: 'https://example.com', required: true },
    { key: 'waitMs', label: '等待(ms)', type: 'number', default: 2000 },
  ]},
  summarize: { label: '总结', desc: 'LLM总结页面', fields: [
    { key: 'prompt', label: '提示词', type: 'textarea', placeholder: '总结页面内容', default: '请用中文简要总结以下页面内容，提取关键信息。' },
    { key: 'maxChars', label: '最大字符', type: 'number', default: 8000 },
  ]},
  action: { label: '操作', desc: '执行操作', fields: [
    { key: 'actionType', label: '类型', type: 'select', options: ['click', 'type', 'select', 'hover', 'scroll'], default: 'click' },
    { key: 'actionId', label: '元素ID', type: 'text', placeholder: '留空则按优先级', required: false },
    { key: 'selector', label: 'CSS选择器', type: 'text', placeholder: '#btn', required: false },
    { key: 'semanticText', label: '语义文本', type: 'text', placeholder: '登录按钮', required: false },
    { key: 'actionValue', label: '值', type: 'text', placeholder: '输入文本', required: false },
  ]},
  agent_loop: { label: 'Agent', desc: 'LLM多步操作', fields: [
    { key: 'task', label: '任务', type: 'textarea', placeholder: '描述任务', required: true },
    { key: 'maxSteps', label: '最大步数', type: 'number', default: 10 },
  ]},
  export_data: { label: '导出', desc: '收集页面数据', fields: [
    { key: 'selector', label: '选择器', type: 'text', placeholder: 'body', default: 'body' },
    { key: 'format', label: '格式', type: 'select', options: ['text', 'html', 'table', 'links'], default: 'text' },
  ]},
  wait: { label: '等待', desc: '暂停ms', fields: [
    { key: 'ms', label: '毫秒', type: 'number', default: 1000, required: true },
  ]},
  log: { label: '日志', desc: '输出消息', fields: [
    { key: 'message', label: '消息', type: 'text', placeholder: '内容', required: true },
  ]},
};

const INJECT_IDS = () => {
  const selectors = ['button', 'input:not([type="hidden"])', 'textarea', 'select', 'a', '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="menuitem"]', '[onclick]', '[data-agent-id]'].join(',');
  let id = 0;
  document.body.querySelectorAll(selectors).forEach(el => { el.setAttribute('data-agent-id', String(id)); id++; });
  return id;
};
const COLLECT_DOM = () => ({ html: document.body.innerHTML });
const COLLECT_BBOX = () => {
  const bboxes = [];
  document.body.querySelectorAll('[data-agent-id]').forEach(el => { const r = el.getBoundingClientRect(); bboxes.push(r.x, r.y, r.width, r.height); });
  return bboxes;
};
const COLLECT_TEXT_CONTENT = (maxChars) => {
  const collect = (root) => {
    let result = '';
    root.querySelectorAll('table').forEach(t => { t.querySelectorAll('tr').forEach(r => { result += Array.from(r.querySelectorAll('th,td')).map(c => c.innerText.trim()).join(' | ') + '\n'; }); result += '\n'; });
    root.querySelectorAll('ul,ol').forEach(l => { l.querySelectorAll('li').forEach(li => { result += '- ' + li.innerText.trim() + '\n'; }); result += '\n'; });
    root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => { result += '# ' + h.innerText.trim() + '\n'; });
    if (!result) result = root.innerText || '';
    return result;
  };
  const text = collect(document.body);
  return maxChars ? text.slice(0, maxChars) : text;
};
const EXECUTE_ACTION_DOM = (strategy, actionType, actionValue) => {
  let el = null;
  if (strategy.strategy === 'AgentId') el = document.querySelector(`[data-agent-id="${strategy.value}"]`);
  else if (strategy.strategy === 'Selector') el = document.querySelector(strategy.value);
  else if (strategy.strategy === 'SemanticText') { const { text, tag } = strategy.value; el = Array.from(document.querySelectorAll(tag || '*')).find(e => e.innerText && e.innerText.includes(text)); }
  if (!el) return { success: false, error: 'Element not found', strategy };
  switch (actionType) {
    case 'click': el.click(); break;
    case 'type': el.focus(); el.value = actionValue || ''; el.dispatchEvent(new Event('input', { bubbles: true })); break;
    case 'select': el.value = actionValue || ''; el.dispatchEvent(new Event('change', { bubbles: true })); break;
    case 'hover': el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); break;
    case 'scroll': el.scrollIntoView({ behavior: 'smooth' }); break;
  }
  return { success: true, tag: el.tagName, text: el.innerText?.slice(0, 50), strategy };
};

function buildSystemPrompt() {
  return `You are a web automation agent. Given compressed web page tokens (TYPE(text)#id or Tid=text), respond with ONE JSON action:\n{"action":"click","id":12}\n{"action":"type","id":13,"value":"hello"}\n{"action":"done"}\n{"action":"fail","reason":"..."}\nOnly use IDs from tokens. Respond with ONLY JSON.`;
}

function parseAction(text) {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try { const obj = JSON.parse(cleaned); if (obj?.action) return obj; } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) { try { const obj = JSON.parse(match[0]); if (obj?.action) return obj; } catch {} }
  return null;
}

async function capturePageTokens(mode, budget) {
  await injectAndRun(INJECT_IDS);
  const dom = await injectAndRun(COLLECT_DOM);
  const bbox = await injectAndRun(COLLECT_BBOX);
  const ir = build_ir_wasm(dom.html, new Float32Array(bbox));
  if (!ir || !Array.isArray(ir)) throw new Error('IR 构建失败');
  const tokens = compress_ir(JSON.stringify(ir), mode, budget);
  return { ir, tokens };
}

async function callLLM(messages) {
  const s = await getSettings();
  if (!s.apiBase || !s.apiKey) throw new Error('请先配置 API');
  abortController = new AbortController();
  const res = await fetch(`${s.apiBase.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify({ model: s.apiModel, messages, temperature: 0, max_tokens: 1024 }),
    signal: abortController.signal,
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()).choices?.[0]?.message?.content || '';
}

async function getSettings() {
  const d = await chrome.storage.local.get(['apiBase', 'apiKey', 'apiModel', 'mode', 'maxSteps', 'budget']);
  return { apiBase: (d.apiBase || '').trim(), apiKey: (d.apiKey || '').trim(), apiModel: (d.apiModel || 'gpt-4o').trim(), mode: d.mode || 'normal', maxSteps: parseInt(d.maxSteps) || 10, budget: d.budget ? parseInt(d.budget) : null };
}

async function loadTasks() { return (await chrome.storage.local.get('tasks')).tasks || []; }
async function saveTasks(tasks) { await chrome.storage.local.set({ tasks }); }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function nodeDesc(node) {
  switch (node.type) {
    case 'navigate': return node.params.url || '';
    case 'summarize': return (node.params.prompt || '').slice(0, 40);
    case 'action': return `${node.params.actionType} → ${node.params.actionId || node.params.selector || node.params.semanticText || '?'}`;
    case 'agent_loop': return (node.params.task || '').slice(0, 40);
    case 'export_data': return `${node.params.format} @ ${node.params.selector}`;
    case 'wait': return `${node.params.ms}ms`;
    case 'log': return node.params.message || '';
    default: return '';
  }
}

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));
}

let currentTasks = [];
let editingTaskId = null;
let currentRunner = null;
let graph = null;

class GraphEditor {
  constructor(canvasEl, innerEl, svgEl) {
    this.canvas = canvasEl;
    this.inner = innerEl;
    this.svg = svgEl;
    this.nodes = [];
    this.edges = [];
    this.offset = { x: 0, y: 0 };
    this.scale = 1;
    this.dragging = null;
    this.connecting = null;
    this.tempLine = null;
    this.selectedNode = null;
    this.nextZ = 10;
    this.bindCanvas();
  }

  bindCanvas() {
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this.scale = Math.max(0.3, Math.min(3, this.scale * delta));
      this.applyTransform();
    }, { passive: false });

    let panning = false, startX, startY;
    this.canvas.addEventListener('mousedown', e => {
      if (e.target === this.canvas || e.target.closest('.graph-inner')?.querySelector('.graph-grid') && !e.target.closest('.gn') && !e.target.closest('.gn-port')) {
        panning = true; startX = e.clientX - this.offset.x; startY = e.clientY - this.offset.y;
        this.selectNode(null);
      }
    });
    window.addEventListener('mousemove', e => {
      if (panning) { this.offset.x = e.clientX - startX; this.offset.y = e.clientY - startY; this.applyTransform(); }
      if (this.dragging) { this.onNodeDrag(e); }
      if (this.connecting) { this.onConnectDrag(e); }
    });
    window.addEventListener('mouseup', e => {
      panning = false;
      if (this.dragging) { this.onNodeDragEnd(); }
      if (this.connecting) { this.onConnectEnd(e); }
    });
  }

  applyTransform() {
    this.inner.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px) scale(${this.scale})`;
  }

  clear() {
    this.nodes = [];
    this.edges = [];
    this.inner.querySelectorAll('.gn').forEach(el => el.remove());
    this.svg.innerHTML = '';
    this.selectedNode = null;
  }

  load(task) {
    this.clear();
    const nodes = task.nodes || [];
    const edges = task.edges || [];
    nodes.forEach(n => this.addNode(n, false));
    edges.forEach(e => this.addEdge(e.from, e.to, false));
    this.renderEdges();
  }

  save() {
    return { nodes: this.nodes.map(n => ({ id: n.id, type: n.type, params: { ...n.params }, x: n.x, y: n.y })), edges: this.edges.map(e => ({ from: e.from, to: e.to })) };
  }

  addNode(nodeData, render = true) {
    const id = nodeData.id || genId();
    const tpl = NODE_TEMPLATES[nodeData.type];
    const x = nodeData.x ?? 60 + this.nodes.length * 40;
    const y = nodeData.y ?? 60 + this.nodes.length * 30;
    const node = { id, type: nodeData.type, params: { ...nodeData.params }, x, y };
    this.nodes.push(node);

    const el = document.createElement('div');
    el.className = 'gn';
    el.dataset.id = id;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.zIndex = this.nextZ++;
    el.innerHTML = `
      <div class="gn-port input" data-port="in" data-node="${id}"></div>
      <div class="gn-port output" data-port="out" data-node="${id}"></div>
      <div class="gn-header">
        <span class="gn-badge ${nodeData.type}">${tpl?.label || nodeData.type}</span>
        <span class="gn-label">${nodeDesc(node)}</span>
        <button class="gn-delete" data-del="${id}">×</button>
      </div>
      <div class="gn-body">${nodeDesc(node)}</div>
    `;
    this.inner.appendChild(el);

    el.querySelector('.gn-header').addEventListener('mousedown', e => {
      if (e.target.closest('.gn-delete')) return;
      e.stopPropagation();
      this.selectNode(id);
      this.dragging = { id, el, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y };
      el.style.zIndex = this.nextZ++;
    });

    el.addEventListener('dblclick', e => {
      e.stopPropagation();
      openNodeEditor(id);
    });

    el.querySelector('.gn-delete').addEventListener('click', e => {
      e.stopPropagation();
      this.removeNode(id);
    });

    el.querySelectorAll('.gn-port').forEach(port => {
      port.addEventListener('mousedown', e => {
        e.stopPropagation();
        const portType = port.dataset.port;
        if (portType === 'out') {
          this.connecting = { fromId: id, startX: e.clientX, startY: e.clientY };
          this.canvas.classList.add('connecting');
          this.tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          this.tempLine.classList.add('edge-temp');
          this.svg.appendChild(this.tempLine);
        }
      });
      port.addEventListener('mouseup', e => {
        if (this.connecting && port.dataset.port === 'in' && port.dataset.node !== this.connecting.fromId) {
          this.addEdge(this.connecting.fromId, port.dataset.node);
        }
      });
    });

    if (render) this.renderEdges();
    return node;
  }

  removeNode(id) {
    this.nodes = this.nodes.filter(n => n.id !== id);
    this.edges = this.edges.filter(e => e.from !== id && e.to !== id);
    this.inner.querySelector(`.gn[data-id="${id}"]`)?.remove();
    if (this.selectedNode === id) this.selectedNode = null;
    this.renderEdges();
  }

  selectNode(id) {
    this.selectedNode = id;
    this.inner.querySelectorAll('.gn').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
  }

  onNodeDrag(e) {
    const d = this.dragging;
    const dx = (e.clientX - d.startX) / this.scale;
    const dy = (e.clientY - d.startY) / this.scale;
    const node = this.nodes.find(n => n.id === d.id);
    node.x = d.origX + dx;
    node.y = d.origY + dy;
    d.el.style.left = node.x + 'px';
    d.el.style.top = node.y + 'px';
    this.renderEdges();
  }

  onNodeDragEnd() { this.dragging = null; }

  onConnectDrag(e) {
    if (!this.tempLine) return;
    const fromEl = this.inner.querySelector(`.gn[data-id="${this.connecting.fromId}"] .gn-port.output`);
    if (!fromEl) return;
    const canvasRect = this.canvas.getBoundingClientRect();
    const fromRect = fromEl.getBoundingClientRect();
    const x1 = (fromRect.left + fromRect.width / 2 - canvasRect.left - this.offset.x) / this.scale;
    const y1 = (fromRect.top + fromRect.height / 2 - canvasRect.top - this.offset.y) / this.scale;
    const x2 = (e.clientX - canvasRect.left - this.offset.x) / this.scale;
    const y2 = (e.clientY - canvasRect.top - this.offset.y) / this.scale;
    this.tempLine.setAttribute('d', this.bezierPath(x1, y1, x2, y2));
  }

  onConnectEnd(e) {
    this.canvas.classList.remove('connecting');
    if (this.tempLine) { this.tempLine.remove(); this.tempLine = null; }
    this.connecting = null;
  }

  addEdge(from, to, render = true) {
    if (from === to) return;
    if (this.edges.some(e => e.from === from && e.to === to)) return;
    this.edges.push({ from, to });
    if (render) this.renderEdges();
  }

  removeEdge(from, to) {
    this.edges = this.edges.filter(e => !(e.from === from && e.to === to));
    this.renderEdges();
  }

  getPortPos(nodeId, portType) {
    const el = this.inner.querySelector(`.gn[data-id="${nodeId}"] .gn-port.${portType === 'out' ? 'output' : 'input'}`);
    if (!el) return null;
    const canvasRect = this.canvas.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: (r.left + r.width / 2 - canvasRect.left - this.offset.x) / this.scale, y: (r.top + r.height / 2 - canvasRect.top - this.offset.y) / this.scale };
  }

  bezierPath(x1, y1, x2, y2) {
    const dx = Math.abs(x2 - x1) * 0.5;
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }

  renderEdges() {
    this.svg.querySelectorAll('path.edge-line').forEach(p => p.remove());
    this.inner.querySelectorAll('.gn-port').forEach(p => p.classList.remove('connected'));

    this.edges.forEach(edge => {
      const from = this.getPortPos(edge.from, 'out');
      const to = this.getPortPos(edge.to, 'in');
      if (!from || !to) return;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.classList.add('edge-line');
      path.setAttribute('d', this.bezierPath(from.x, from.y, to.x, to.y));
      path.addEventListener('dblclick', e => { e.stopPropagation(); this.removeEdge(edge.from, edge.to); });
      this.svg.appendChild(path);

      this.inner.querySelector(`.gn[data-id="${edge.from}"] .gn-port.output`)?.classList.add('connected');
      this.inner.querySelector(`.gn[data-id="${edge.to}"] .gn-port.input`)?.classList.add('connected');
    });
  }

  autoLayout() {
    if (!this.nodes.length) return;
    const inDegree = {};
    const adj = {};
    this.nodes.forEach(n => { inDegree[n.id] = 0; adj[n.id] = []; });
    this.edges.forEach(e => { inDegree[e.to] = (inDegree[e.to] || 0) + 1; adj[e.from]?.push(e.to); });

    const queue = this.nodes.filter(n => !inDegree[n.id]).map(n => n.id);
    const levels = {};
    queue.forEach(id => levels[id] = 0);

    while (queue.length) {
      const id = queue.shift();
      (adj[id] || []).forEach(next => {
        levels[next] = Math.max(levels[next] || 0, (levels[id] || 0) + 1);
        inDegree[next]--;
        if (inDegree[next] === 0) queue.push(next);
      });
    }

    this.nodes.forEach(n => { if (levels[n.id] == null) levels[n.id] = 0; });

    const byLevel = {};
    this.nodes.forEach(n => { const l = levels[n.id]; if (!byLevel[l]) byLevel[l] = []; byLevel[l].push(n); });

    const colW = 220, rowH = 120, startX = 60, startY = 60;
    Object.keys(byLevel).sort((a, b) => a - b).forEach(l => {
      byLevel[l].forEach((n, i) => {
        n.x = startX + l * colW;
        n.y = startY + i * rowH;
        const el = this.inner.querySelector(`.gn[data-id="${n.id}"]`);
        if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
      });
    });
    this.renderEdges();
  }

  fitView() {
    if (!this.nodes.length) return;
    const rect = this.canvas.getBoundingClientRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    this.nodes.forEach(n => { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + 180); maxY = Math.max(maxY, n.y + 60); });
    const pad = 40;
    const w = maxX - minX + pad * 2, h = maxY - minY + pad * 2;
    this.scale = Math.min(rect.width / w, rect.height / h, 1.5);
    this.offset.x = (rect.width - w * this.scale) / 2 - minX * this.scale + pad * this.scale;
    this.offset.y = (rect.height - h * this.scale) / 2 - minY * this.scale + pad * this.scale;
    this.applyTransform();
  }

  markNode(id, state) {
    const el = this.inner.querySelector(`.gn[data-id="${id}"]`);
    if (!el) return;
    el.classList.remove('running', 'done', 'error');
    if (state) el.classList.add(state);
  }

  clearMarks() {
    this.inner.querySelectorAll('.gn').forEach(el => el.classList.remove('running', 'done', 'error'));
  }
}

function topoSort(nodes, edges) {
  const inDeg = {};
  const adj = {};
  nodes.forEach(n => { inDeg[n.id] = 0; adj[n.id] = []; });
  edges.forEach(e => { inDeg[e.to] = (inDeg[e.to] || 0) + 1; adj[e.from]?.push(e.to); });
  const queue = nodes.filter(n => !inDeg[n.id]).map(n => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    (adj[id] || []).forEach(next => { inDeg[next]--; if (inDeg[next] === 0) queue.push(next); });
  }
  if (order.length !== nodes.length) return null;
  return order;
}

function buildPalette() {
  const pal = $('#palette');
  pal.innerHTML = '';
  Object.entries(NODE_TEMPLATES).forEach(([type, tpl]) => {
    const btn = document.createElement('div');
    btn.className = 'palette-btn';
    btn.innerHTML = `<span class="palette-dot ${type}"></span>${tpl.label}`;
    btn.addEventListener('click', () => {
      if (!graph || !editingTaskId) return;
      const rect = $('#graph-canvas').getBoundingClientRect();
      const x = (rect.width / 2 - graph.offset.x) / graph.scale;
      const y = (rect.height / 2 - graph.offset.y) / graph.scale;
      const defaults = {};
      tpl.fields.forEach(f => { if (f.default != null) defaults[f.key] = f.default; });
      graph.addNode({ type, params: defaults, x, y });
    });
    pal.appendChild(btn);
  });
}

function showNodeModal(nodeId) {
  const node = graph.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const tpl = NODE_TEMPLATES[node.type];
  const overlay = $('#modal-node');
  const paramsDiv = $('#node-params');
  $('#modal-node-title').textContent = `${tpl.label} - 节点属性`;
  paramsDiv.innerHTML = '';
  tpl.fields.forEach(f => {
    const div = document.createElement('div'); div.className = 'field';
    const lbl = document.createElement('label'); lbl.textContent = f.label; div.appendChild(lbl);
    let input;
    if (f.type === 'select') { input = document.createElement('select'); f.options.forEach(opt => { const o = document.createElement('option'); o.value = opt; o.textContent = opt; input.appendChild(o); }); }
    else if (f.type === 'textarea') { input = document.createElement('textarea'); input.rows = 3; }
    else { input = document.createElement('input'); input.type = f.type === 'number' ? 'number' : 'text'; }
    input.dataset.key = f.key;
    if (f.placeholder) input.placeholder = f.placeholder;
    if (node.params[f.key] != null) input.value = node.params[f.key];
    else if (f.default != null) input.value = f.default;
    if (f.required) input.dataset.required = '1';
    div.appendChild(input); paramsDiv.appendChild(div);
  });
  overlay._nodeId = nodeId;
  overlay.classList.add('show');
}

function openNodeEditor(nodeId) { showNodeModal(nodeId); }

function hideNodeModal() { $('#modal-node').classList.remove('show'); }

$('#btn-modal-cancel').onclick = hideNodeModal;
$('#btn-modal-confirm').onclick = () => {
  const overlay = $('#modal-node');
  const nodeId = overlay._nodeId;
  const node = graph.nodes.find(n => n.id === nodeId);
  if (!node) { hideNodeModal(); return; }
  const tpl = NODE_TEMPLATES[node.type];
  const params = {};
  $$('#node-params [data-key]').forEach(input => {
    let val = input.value;
    if (input.type === 'number') val = val ? Number(val) : undefined;
    params[input.dataset.key] = val;
  });
  for (const f of tpl.fields) { if (f.required && (params[f.key] == null || params[f.key] === '')) { alert(`请填写「${f.label}」`); return; } }
  node.params = params;
  const el = graph.inner.querySelector(`.gn[data-id="${nodeId}"]`);
  if (el) { el.querySelector('.gn-label').textContent = nodeDesc(node); el.querySelector('.gn-body').textContent = nodeDesc(node); }
  hideNodeModal();
};

function renderTaskList() {
  const container = $('#task-list');
  container.innerHTML = '';
  if (!currentTasks.length) { container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">暂无任务，点击「新建」创建第一个任务</div></div>'; return; }
  currentTasks.forEach(task => {
    const div = document.createElement('div');
    div.className = 'task-card' + (task.id === editingTaskId ? ' selected' : '');
    const nc = task.nodes?.length || 0;
    const ec = task.edges?.length || 0;
    const types = [...new Set((task.nodes || []).map(n => NODE_TEMPLATES[n.type]?.label || n.type))];
    div.innerHTML = `
      <div class="task-name">${task.name}</div>
      <div class="task-meta">${nc} 个节点 · ${ec} 条连线 · ${types.join(', ') || '空流程'}</div>
      <div class="task-actions">
        <button class="btn btn-primary btn-sm" data-act="edit" data-id="${task.id}">编辑</button>
        <button class="btn btn-secondary btn-sm" data-act="run" data-id="${task.id}">运行</button>
        <button class="btn btn-secondary btn-sm" data-act="dup" data-id="${task.id}">复制</button>
        <button class="btn btn-secondary btn-sm" data-act="exp" data-id="${task.id}">导出</button>
        <button class="btn btn-danger btn-sm" data-act="del" data-id="${task.id}">删除</button>
      </div>
    `;
    container.appendChild(div);
  });
}

function renderRunSelect() {
  const sel = $('#run-task-select'); sel.innerHTML = '';
  currentTasks.forEach(t => { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; sel.appendChild(o); });
}

function openEditor(taskId) {
  editingTaskId = taskId;
  const task = currentTasks.find(t => t.id === taskId);
  if (!task) return;
  if (!task.nodes) task.nodes = [];
  if (!task.edges) task.edges = [];
  if (task.nodes.length && !task.nodes[0].x) {
    task.nodes.forEach((n, i) => { n.x = 60 + i * 220; n.y = 80; });
  }
  graph.load(task);
  $('#editor-title').textContent = `编辑: ${task.name}`;
  setTimeout(() => { graph.fitView(); }, 50);
  switchTab('editor');
}

async function loadSettings() {
  const s = await getSettings();
  $('#set-api-base').value = s.apiBase;
  $('#set-api-key').value = s.apiKey;
  $('#set-api-model').value = s.apiModel;
  $('#set-mode').value = s.mode;
  $('#set-max-steps').value = s.maxSteps;
  if (s.budget) $('#set-budget').value = s.budget;
}

async function saveSettings() {
  await chrome.storage.local.set({ apiBase: $('#set-api-base').value.trim(), apiKey: $('#set-api-key').value.trim(), apiModel: $('#set-api-model').value.trim() || 'gpt-4o', mode: $('#set-mode').value, maxSteps: $('#set-max-steps').value, budget: $('#set-budget').value || '' });
  const el = $('#settings-status'); el.textContent = '✓ 已保存'; setTimeout(() => { el.textContent = ''; }, 2000);
}

class TaskRunner {
  constructor(task, logEl, progressEl, summaryEl) {
    this.task = task;
    this.logEl = logEl;
    this.progressEl = progressEl;
    this.summaryEl = summaryEl;
    this.stopped = false;
    this.startTime = 0;
    this.stats = { total: 0, success: 0, fail: 0, outputs: [] };
  }
  stop() { this.stopped = true; if (abortController) abortController.abort(); }
  log(type, msg) { const d = document.createElement('div'); d.className = `log-line ${type}`; d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`; this.logEl.appendChild(d); this.logEl.scrollTop = this.logEl.scrollHeight; }
  setProgress(p) { this.progressEl.style.width = `${Math.min(p, 100)}%`; }

  async run() {
    this.startTime = Date.now();
    const { nodes, edges } = this.task;
    this.logEl.innerHTML = '';
    this.summaryEl.style.display = 'none';
    graph?.clearMarks();

    if (!nodes?.length) { this.log('error', '任务无节点'); this.finish(); return; }
    const order = topoSort(nodes, edges || []);
    if (!order) { this.log('error', '流程存在循环依赖'); this.finish(); return; }

    const settings = await getSettings();
    const nodeMap = {};
    nodes.forEach(n => nodeMap[n.id] = n);
    this.stats.total = order.length;
    this.log('info', `▶ 任务「${this.task.name}」· ${order.length} 节点 · 拓扑序执行`);

    for (let i = 0; i < order.length; i++) {
      if (this.stopped) break;
      const nodeId = order[i];
      const node = nodeMap[nodeId];
      if (!node) continue;
      const tpl = NODE_TEMPLATES[node.type];
      this.setProgress(((i + 1) / order.length) * 100);
      this.log('info', `[${i + 1}/${order.length}] ${tpl?.label}: ${nodeDesc(node)}`);
      graph?.markNode(nodeId, 'running');

      try {
        const output = await this.executeNode(node, settings);
        if (output != null) this.stats.outputs.push({ nodeId, type: node.type, data: typeof output === 'string' ? output.slice(0, 200) : output });
        this.stats.success++;
        graph?.markNode(nodeId, 'done');
        this.log('result', `✓ 完成`);
      } catch (e) {
        this.stats.fail++;
        graph?.markNode(nodeId, 'error');
        this.log('error', `✗ ${e.message}`);
      }
    }
    this.finish();
  }

  async executeNode(node, settings) {
    switch (node.type) {
      case 'navigate': {
        if (!node.params.url) throw new Error('URL 为空');
        await navigateTo(node.params.url);
        await new Promise(r => setTimeout(r, node.params.waitMs || 2000));
        return null;
      }
      case 'summarize': {
        await ensureWasm();
        await injectAndRun(INJECT_IDS);
        const text = await injectAndRun(COLLECT_TEXT_CONTENT, [node.params.maxChars || 8000]);
        if (!text) throw new Error('页面内容为空');
        const summary = await callLLM([
          { role: 'system', content: 'You summarize web pages. Same language as user.' },
          { role: 'user', content: `${node.params.prompt || '总结内容'}\n\n---\n${text}` },
        ]);
        this.log('result', `📝 ${summary}`);
        return summary;
      }
      case 'action': {
        await ensureWasm();
        const { actionType, actionId, selector, semanticText, actionValue } = node.params;
        if (!actionType) throw new Error('操作类型为空');
        await injectAndRun(INJECT_IDS);
        if (actionId) {
          const { ir } = await capturePageTokens(settings.mode, settings.budget);
          const strategy = resolve_action(JSON.stringify({ action: actionType, id: parseInt(actionId), value: actionValue }), JSON.stringify(ir));
          const r = await injectAndRun(EXECUTE_ACTION_DOM, [strategy, actionType, actionValue || '']);
          if (!r?.success) throw new Error(r?.error || '操作失败');
          this.log('action', `→ ${actionType} #${actionId} via ${r.strategy?.strategy}`);
          return r;
        }
        if (selector) {
          const r = await injectAndRun(EXECUTE_ACTION_DOM, [{ strategy: 'Selector', value: selector }, actionType, actionValue || '']);
          if (!r?.success) throw new Error(`选择器未找到`);
          this.log('action', `→ ${actionType} "${selector}"`);
          return r;
        }
        if (semanticText) {
          const { ir, tokens } = await capturePageTokens(settings.mode, settings.budget);
          this.log('info', `语义匹配: ${ir.length} 节点`);
          const hint = actionType !== 'click' && actionValue ? `${actionType} "${semanticText}" (value: "${actionValue}")` : `${actionType} "${semanticText}"`;
          const resp = await callLLM([{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: `Page tokens:\n${tokens}\n\nTask: ${hint}\nStep: 1` }]);
          const action = parseAction(resp);
          if (!action || action.action === 'fail') throw new Error(`LLM无法定位: ${action?.reason || resp.slice(0, 100)}`);
          if (action.action === 'done') return { done: true };
          const strategy = resolve_action(JSON.stringify(action), JSON.stringify(ir));
          await injectAndRun(INJECT_IDS);
          const r = await injectAndRun(EXECUTE_ACTION_DOM, [strategy, action.action, action.value || '']);
          if (!r?.success) throw new Error(`执行失败`);
          this.log('action', `→ LLM: ${action.action}(${action.id}) via ${r.strategy?.strategy}`);
          return r;
        }
        throw new Error('需要提供元素ID、CSS选择器或语义文本');
      }
      case 'agent_loop': {
        await ensureWasm();
        if (!node.params.task) throw new Error('任务描述为空');
        const maxSteps = node.params.maxSteps || settings.maxSteps || 10;
        const msgs = [{ role: 'system', content: buildSystemPrompt() }];
        for (let step = 1; step <= maxSteps; step++) {
          if (this.stopped) break;
          this.log('info', `  Agent ${step}/${maxSteps}`);
          const { ir, tokens } = await capturePageTokens(settings.mode, settings.budget);
          msgs.push({ role: 'user', content: `Page tokens:\n${tokens}\n\nTask: ${node.params.task}\nStep: ${step}` });
          let resp;
          try { resp = await callLLM(msgs); } catch (e) { this.log('error', `  LLM: ${e.message}`); throw e; }
          msgs.push({ role: 'assistant', content: resp });
          const action = parseAction(resp);
          if (!action) { throw new Error('LLM返回无效action'); }
          if (action.action === 'done') { this.log('result', `  ✓ 完成 (${step}步)`); return { done: true, steps: step }; }
          if (action.action === 'fail') throw new Error(`失败: ${action.reason}`);
          this.log('action', `  → ${action.action}(${action.id}${action.value ? ', "' + action.value + '"' : ''})`);
          try {
            const strategy = resolve_action(JSON.stringify(action), JSON.stringify(ir));
            await injectAndRun(INJECT_IDS);
            const r = await injectAndRun(EXECUTE_ACTION_DOM, [strategy, action.action, action.value || '']);
            this.log(r?.success ? 'result' : 'error', r?.success ? `  ✓ ${r.tag} "${r.text || ''}"` : `  ✗ 未找到`);
          } catch (e) { this.log('error', `  ${e.message}`); }
          await new Promise(r => setTimeout(r, 500));
        }
        return { done: false, steps: maxSteps };
      }
      case 'export_data': {
        await injectAndRun(INJECT_IDS);
        const data = await injectAndRun((sel, fmt) => {
          const root = document.querySelector(sel); if (!root) return null;
          if (fmt === 'html') return root.innerHTML;
          if (fmt === 'table') { const r = []; root.querySelectorAll('table').forEach(t => { const rows = []; t.querySelectorAll('tr').forEach(tr => rows.push(Array.from(tr.querySelectorAll('th,td')).map(c => c.innerText.trim()))); r.push(rows); }); return JSON.stringify(r); }
          if (fmt === 'links') { const l = []; root.querySelectorAll('a[href]').forEach(a => l.push({ text: a.innerText.trim(), href: a.href })); return JSON.stringify(l); }
          return root.innerText;
        }, [node.params.selector || 'body', node.params.format || 'text']);
        if (!data) throw new Error('未匹配到元素');
        this.log('result', `📦 ${data.slice(0, 300)}${data.length > 300 ? '...' : ''}`);
        return data;
      }
      case 'wait': { const ms = node.params.ms || 1000; this.log('info', `⏱ ${ms}ms`); await new Promise(r => setTimeout(r, ms)); return null; }
      case 'log': { this.log('warn', `📋 ${node.params.message || ''}`); return null; }
      default: throw new Error(`未知类型: ${node.type}`);
    }
  }

  finish() {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const { total, success, fail, outputs } = this.stats;
    this.setProgress(100);
    this.summaryEl.style.display = 'block';
    this.summaryEl.className = 'summary-box' + (fail > 0 || this.stopped ? ' error' : '');
    this.summaryEl.innerHTML = `
      <div class="summary-row"><span class="summary-label">状态</span><span class="summary-value">${this.stopped ? '⏹ 已停止' : (fail > 0 ? '⚠ 有错误' : '✓ 完成')}</span></div>
      <div class="summary-row"><span class="summary-label">耗时</span><span class="summary-value">${elapsed}s</span></div>
      <div class="summary-row"><span class="summary-label">节点</span><span class="summary-value">${success}/${total} 成功 · ${fail} 失败</span></div>
      ${outputs.length ? `<div class="summary-row"><span class="summary-label">输出</span><span class="summary-value">${outputs.length} 项</span></div>` : ''}
    `;
    $('#btn-start-run').disabled = false;
    $('#btn-stop-run').disabled = true;
    currentRunner = null;
  }
}

$('#btn-new-task').onclick = () => { $('#new-task-name').value = ''; $('#modal-task-name').classList.add('show'); setTimeout(() => $('#new-task-name').focus(), 100); };
$('#btn-tn-cancel').onclick = () => $('#modal-task-name').classList.remove('show');
$('#btn-tn-confirm').onclick = async () => {
  const name = $('#new-task-name').value.trim(); if (!name) return;
  const task = { id: genId(), name, nodes: [], edges: [], createdAt: Date.now() };
  currentTasks.push(task); await saveTasks(currentTasks);
  $('#modal-task-name').classList.remove('show');
  renderTaskList(); renderRunSelect(); openEditor(task.id);
};

$('#btn-import-task').onclick = () => {
  const input = $('#file-import');
  input.onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      (Array.isArray(imported) ? imported : [imported]).forEach(t => { if (!t.id) t.id = genId(); t.createdAt = t.createdAt || Date.now(); if (!t.edges) t.edges = []; currentTasks.push(t); });
      await saveTasks(currentTasks); renderTaskList(); renderRunSelect();
    } catch (err) { alert('导入失败: ' + err.message); }
    input.value = '';
  };
  input.click();
};

$('#task-list').onclick = async (e) => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'edit') openEditor(id);
  else if (act === 'run') { $('#run-task-select').value = id; switchTab('run'); $('#btn-start-run').click(); }
  else if (act === 'dup') {
    const task = currentTasks.find(t => t.id === id); if (!task) return;
    const dup = JSON.parse(JSON.stringify(task)); dup.id = genId(); dup.name += ' (副本)'; dup.createdAt = Date.now();
    currentTasks.push(dup); await saveTasks(currentTasks); renderTaskList(); renderRunSelect();
  }
  else if (act === 'exp') {
    const task = currentTasks.find(t => t.id === id); if (!task) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(task, null, 2)], { type: 'application/json' })); a.download = `${task.name}.json`; a.click();
  }
  else if (act === 'del') {
    if (!confirm('确定删除？')) return;
    currentTasks = currentTasks.filter(t => t.id !== id); if (editingTaskId === id) editingTaskId = null;
    await saveTasks(currentTasks); renderTaskList(); renderRunSelect();
  }
};

$('#btn-save-flow').onclick = async () => {
  if (!editingTaskId || !graph) return;
  const task = currentTasks.find(t => t.id === editingTaskId); if (!task) return;
  const data = graph.save();
  task.nodes = data.nodes;
  task.edges = data.edges;
  task.updatedAt = Date.now();
  await saveTasks(currentTasks);
  renderTaskList(); renderRunSelect();
  const el = $('#editor-title'); const orig = el.textContent; el.textContent = '✓ 已保存'; setTimeout(() => { el.textContent = `编辑: ${task.name}`; }, 1500);
};

$('#btn-fit-view').onclick = () => graph?.fitView();
$('#btn-auto-layout').onclick = () => graph?.autoLayout();

$('#btn-start-run').onclick = async () => {
  const task = currentTasks.find(t => t.id === $('#run-task-select').value);
  if (!task || !task.nodes?.length) { alert('任务为空'); return; }
  const settings = await getSettings();
  if (!settings.apiBase || !settings.apiKey) {
    if (task.nodes.some(n => n.type === 'agent_loop' || n.type === 'summarize')) { alert('请先配置 API'); return; }
  }
  await ensureWasm();
  const logEl = $('#run-log'), progressEl = $('#run-progress'), summaryEl = $('#run-summary');
  progressEl.style.width = '0'; summaryEl.style.display = 'none';
  $('#btn-start-run').disabled = true; $('#btn-stop-run').disabled = false;
  $('#run-title').textContent = `运行: ${task.name}`;
  currentRunner = new TaskRunner(task, logEl, progressEl, summaryEl);
  await currentRunner.run();
};

$('#btn-stop-run').onclick = () => currentRunner?.stop();
$('#btn-save-settings').onclick = saveSettings;

$('#btn-export-all').onclick = () => {
  if (!currentTasks.length) { alert('暂无任务'); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(currentTasks, null, 2)], { type: 'application/json' })); a.download = 'web-agent-tasks.json'; a.click();
};

$('#btn-import-all').onclick = () => {
  const input = $('#file-import');
  input.onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      (Array.isArray(imported) ? imported : [imported]).forEach(t => { if (!t.id) t.id = genId(); t.createdAt = t.createdAt || Date.now(); if (!t.edges) t.edges = []; currentTasks.push(t); });
      await saveTasks(currentTasks); renderTaskList(); renderRunSelect();
    } catch (err) { alert('导入失败: ' + err.message); }
    input.value = '';
  };
  input.click();
};

$('#btn-clear-all').onclick = async () => { if (!confirm('清空所有数据？')) return; currentTasks = []; await saveTasks(currentTasks); renderTaskList(); renderRunSelect(); };

$$('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

async function bootstrap() {
  currentTasks = await loadTasks();
  graph = new GraphEditor($('#graph-canvas'), $('#graph-inner'), $('#graph-svg'));
  buildPalette();
  renderTaskList();
  renderRunSelect();
  await loadSettings();
}

bootstrap();