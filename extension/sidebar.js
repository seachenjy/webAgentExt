import init, { build_ir_wasm, compress_ir, resolve_action } from './wasm/web_agent_ir.js';

let wasmReady = false;
let abortController = null;

async function ensureWasm() {
  if (wasmReady) return;
  const wasmUrl = chrome.runtime.getURL('wasm/web_agent_ir_bg.wasm');
  await init({ module_or_path: wasmUrl });
  wasmReady = true;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function injectAndRun(fn, args = []) {
  const tab = await getActiveTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: fn,
    args,
  });
  return results[0]?.result;
}

async function waitForTabLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function navigateTo(url) {
  const tab = await getActiveTab();
  await chrome.tabs.update(tab.id, { url });
  await waitForTabLoad(tab.id);
}

const NODE_TEMPLATES = {
  navigate: {
    label: '导航',
    desc: '打开指定URL',
    fields: [
      { key: 'url', label: 'URL', type: 'text', placeholder: 'https://example.com', required: true },
      { key: 'waitMs', label: '等待(ms)', type: 'number', default: 2000 },
    ],
  },
  summarize: {
    label: '总结',
    desc: '用LLM总结页面内容',
    fields: [
      { key: 'prompt', label: '总结提示词', type: 'textarea', placeholder: '请用中文简要总结以下页面内容', default: '请用中文简要总结以下页面内容，提取关键信息。' },
      { key: 'maxChars', label: '最大字符数', type: 'number', default: 8000 },
    ],
  },
  action: {
    label: '操作',
    desc: '执行点击/输入等操作',
    fields: [
      { key: 'actionType', label: '操作类型', type: 'select', options: ['click', 'type', 'select', 'hover', 'scroll'], default: 'click' },
      { key: 'actionId', label: '元素ID (优先)', type: 'text', placeholder: '留空则按优先级匹配', required: false },
      { key: 'selector', label: 'CSS选择器 (次选)', type: 'text', placeholder: '#btn-login', required: false },
      { key: 'semanticText', label: '语义文本 (三选)', type: 'text', placeholder: '如：登录按钮、用户名输入框', required: false },
      { key: 'actionValue', label: '值 (type/select)', type: 'text', placeholder: '输入的文本', required: false },
    ],
  },
  agent_loop: {
    label: 'Agent循环',
    desc: 'LLM驱动的多步自动操作',
    fields: [
      { key: 'task', label: '任务描述', type: 'textarea', placeholder: '描述要执行的自动化任务', required: true },
      { key: 'maxSteps', label: '最大步数', type: 'number', default: 10 },
    ],
  },
  export_data: {
    label: '导出数据',
    desc: '收集并输出页面数据',
    fields: [
      { key: 'selector', label: '选择器', type: 'text', placeholder: 'body', default: 'body' },
      { key: 'format', label: '格式', type: 'select', options: ['text', 'html', 'table', 'links'], default: 'text' },
    ],
  },
  wait: {
    label: '等待',
    desc: '暂停指定毫秒',
    fields: [
      { key: 'ms', label: '等待时间(ms)', type: 'number', default: 1000, required: true },
    ],
  },
  log: {
    label: '日志',
    desc: '输出一条日志消息',
    fields: [
      { key: 'message', label: '消息', type: 'text', placeholder: '日志内容', required: true },
    ],
  },
};

const INJECT_IDS = () => {
  const selectors = [
    'button', 'input:not([type="hidden"])', 'textarea', 'select', 'a',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="menuitem"]',
    '[onclick]', '[data-agent-id]',
  ].join(',');
  const elements = document.body.querySelectorAll(selectors);
  let id = 0;
  elements.forEach((el) => {
    el.setAttribute('data-agent-id', String(id));
    id++;
  });
  return id;
};

const COLLECT_DOM = () => ({ html: document.body.innerHTML });

const COLLECT_BBOX = () => {
  const elements = document.body.querySelectorAll('[data-agent-id]');
  const bboxes = [];
  elements.forEach((el) => {
    const rect = el.getBoundingClientRect();
    bboxes.push(rect.x, rect.y, rect.width, rect.height);
  });
  return bboxes;
};

const COLLECT_TEXT_CONTENT = (maxChars) => {
  const collect = (root) => {
    let result = '';
    const tables = root.querySelectorAll('table');
    tables.forEach((t) => {
      const rows = t.querySelectorAll('tr');
      rows.forEach((r) => {
        const cells = Array.from(r.querySelectorAll('th, td')).map(c => c.innerText.trim());
        result += cells.join(' | ') + '\n';
      });
      result += '\n';
    });
    const lists = root.querySelectorAll('ul, ol');
    lists.forEach((l) => {
      l.querySelectorAll('li').forEach(li => { result += '- ' + li.innerText.trim() + '\n'; });
      result += '\n';
    });
    const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6');
    headings.forEach(h => { result += '# ' + h.innerText.trim() + '\n'; });
    if (!tables.length && !lists.length && !headings.length) {
      result = root.innerText || '';
    }
    return result;
  };
  const text = collect(document.body);
  return maxChars ? text.slice(0, maxChars) : text;
};

const EXECUTE_ACTION_DOM = (strategy, actionType, actionValue) => {
  let el = null;
  if (strategy.strategy === 'AgentId') {
    el = document.querySelector(`[data-agent-id="${strategy.value}"]`);
  } else if (strategy.strategy === 'Selector') {
    el = document.querySelector(strategy.value);
  } else if (strategy.strategy === 'SemanticText') {
    const { text, tag } = strategy.value;
    const candidates = document.querySelectorAll(tag || '*');
    el = Array.from(candidates).find((e) => e.innerText && e.innerText.includes(text));
  }
  if (!el) return { success: false, error: 'Element not found', strategy };
  switch (actionType) {
    case 'click': el.click(); break;
    case 'type':
      el.focus(); el.value = actionValue || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      break;
    case 'select':
      el.value = actionValue || '';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    case 'hover':
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      break;
    case 'scroll':
      el.scrollIntoView({ behavior: 'smooth' });
      break;
  }
  return { success: true, tag: el.tagName, text: el.innerText?.slice(0, 50), strategy };
};

function buildSystemPrompt() {
  return `You are a web automation agent. You are given a compressed representation of a web page as Token DSL, where each token represents an interactive DOM element.

Token format (Normal): TYPE(text)#id
Token format (Ultra): Tid=text

TYPE mapping: BTN=button, INP=input, LNK=link, TXT=text, IMG=image, SEL=select, CHK=checkbox

When given a user task, respond with EXACTLY ONE JSON object (no markdown, no explanation) representing the next action to take:

{"action":"click","id":12}
{"action":"type","id":13,"value":"hello"}
{"action":"select","id":14,"value":"option1"}
{"action":"hover","id":15}
{"action":"scroll","id":16}

When the task is fully complete, respond with:
{"action":"done"}

Rules:
- Only use element IDs that exist in the provided tokens
- "id" must be a number from the token list
- For "type" and "select" actions, always include "value"
- If the task cannot be completed, respond with {"action":"fail","reason":"..."}
- Respond with ONLY the JSON object, nothing else`;
}

function parseAction(text) {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj.action === 'string') return obj;
  } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj && typeof obj.action === 'string') return obj;
    } catch {}
  }
  return null;
}

async function capturePageTokens(mode, budget) {
  await injectAndRun(INJECT_IDS);
  const dom = await injectAndRun(COLLECT_DOM);
  const bbox = await injectAndRun(COLLECT_BBOX);
  const ir = build_ir_wasm(dom.html, new Float32Array(bbox));
  if (!ir || !Array.isArray(ir)) throw new Error('IR 构建失败');
  const irJson = JSON.stringify(ir);
  const tokens = compress_ir(irJson, mode, budget);
  return { ir, tokens };
}

async function callLLM(messages) {
  const settings = await getSettings();
  if (!settings.apiBase || !settings.apiKey) throw new Error('请先配置 API');
  const base = settings.apiBase.replace(/\/+$/, '');
  abortController = new AbortController();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: settings.apiModel, messages, temperature: 0, max_tokens: 1024 }),
    signal: abortController.signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`LLM API ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function getSettings() {
  const data = await chrome.storage.local.get(['apiBase', 'apiKey', 'apiModel', 'mode', 'maxSteps', 'budget']);
  return {
    apiBase: (data.apiBase || '').trim(),
    apiKey: (data.apiKey || '').trim(),
    apiModel: (data.apiModel || 'gpt-4o').trim(),
    mode: data.mode || 'normal',
    maxSteps: parseInt(data.maxSteps) || 10,
    budget: data.budget ? parseInt(data.budget) : null,
  };
}

async function loadTasks() {
  const data = await chrome.storage.local.get('tasks');
  return data.tasks || [];
}

async function saveTasks(tasks) {
  await chrome.storage.local.set({ tasks });
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function nodeDesc(node) {
  const t = NODE_TEMPLATES[node.type];
  if (!t) return '';
  switch (node.type) {
    case 'navigate': return node.params.url || '';
    case 'summarize': return (node.params.prompt || '').slice(0, 40);
    case 'action': return `${node.params.actionType} → ${node.params.actionId || node.params.selector || node.params.semanticText || '未指定'}`;
    case 'agent_loop': return (node.params.task || '').slice(0, 40);
    case 'export_data': return `${node.params.format} @ ${node.params.selector}`;
    case 'wait': return `${node.params.ms}ms`;
    case 'log': return node.params.message || '';
    default: return '';
  }
}

let currentTasks = [];
let editingTaskId = null;
let editingNodes = [];
let currentRunner = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));
}

function showNodeModal(editIndex) {
  const overlay = $('#modal-node');
  const typeSelect = $('#node-type');
  const paramsDiv = $('#node-params');
  const title = $('#modal-node-title');

  const existing = editIndex != null ? editingNodes[editIndex] : null;
  title.textContent = existing ? '编辑节点' : '添加节点';

  if (existing) {
    typeSelect.value = existing.type;
    typeSelect.disabled = true;
  } else {
    typeSelect.value = 'navigate';
    typeSelect.disabled = false;
  }

  function renderParams() {
    const type = typeSelect.value;
    const tpl = NODE_TEMPLATES[type];
    paramsDiv.innerHTML = '';
    tpl.fields.forEach(f => {
      const div = document.createElement('div');
      div.className = 'field';
      const lbl = document.createElement('label');
      lbl.textContent = f.label;
      div.appendChild(lbl);
      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        f.options.forEach(opt => {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          input.appendChild(o);
        });
      } else if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
      } else {
        input = document.createElement('input');
        input.type = f.type === 'number' ? 'number' : 'text';
      }
      input.dataset.key = f.key;
      if (f.placeholder) input.placeholder = f.placeholder;
      if (existing && existing.params[f.key] != null) {
        input.value = existing.params[f.key];
      } else if (f.default != null) {
        input.value = f.default;
      }
      if (f.required) input.dataset.required = '1';
      div.appendChild(input);
      paramsDiv.appendChild(div);
    });
  }

  renderParams();
  typeSelect.onchange = () => { if (!existing) renderParams(); };
  overlay._editIndex = editIndex;
  overlay.classList.add('show');
}

function hideNodeModal() {
  $('#modal-node').classList.remove('show');
}

function collectNodeParams() {
  const type = $('#node-type').value;
  const params = {};
  $$('#node-params [data-key]').forEach(input => {
    let val = input.value;
    if (input.type === 'number') val = val ? Number(val) : undefined;
    params[input.dataset.key] = val;
  });
  return { type, params };
}

function renderNodeList() {
  const list = $('#node-list');
  const empty = $('#node-empty');
  list.innerHTML = '';
  if (!editingNodes.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  editingNodes.forEach((node, idx) => {
    const tpl = NODE_TEMPLATES[node.type];
    const div = document.createElement('div');
    div.className = 'node-item';
    div.draggable = true;
    div.dataset.index = idx;
    div.innerHTML = `
      <span class="drag-handle">⠿</span>
      <span class="node-badge ${node.type}">${tpl?.label || node.type}</span>
      <div class="node-info">
        <div class="node-title">${nodeDesc(node)}</div>
        <div class="node-desc">#${idx + 1} ${node.type}</div>
      </div>
      <div class="node-actions">
        <button class="btn btn-secondary btn-sm" data-act="edit" data-idx="${idx}">✎</button>
        <button class="btn btn-secondary btn-sm" data-act="del" data-idx="${idx}">✕</button>
      </div>
    `;
    div.addEventListener('dragstart', onDragStart);
    div.addEventListener('dragover', onDragOver);
    div.addEventListener('dragleave', onDragLeave);
    div.addEventListener('drop', onDrop);
    div.addEventListener('dragend', onDragEnd);
    list.appendChild(div);
  });
}

let dragIdx = null;

function onDragStart(e) {
  dragIdx = Number(this.dataset.index);
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  this.classList.add('drag-over');
}

function onDragLeave() {
  this.classList.remove('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');
  const dropIdx = Number(this.dataset.index);
  if (dragIdx == null || dragIdx === dropIdx) return;
  const [moved] = editingNodes.splice(dragIdx, 1);
  editingNodes.splice(dropIdx, 0, moved);
  renderNodeList();
}

function onDragEnd() {
  this.classList.remove('dragging');
  dragIdx = null;
}

function renderTaskList() {
  const container = $('#task-list');
  container.innerHTML = '';
  if (!currentTasks.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">暂无任务，点击「新建」创建第一个任务</div></div>';
    return;
  }
  currentTasks.forEach(task => {
    const div = document.createElement('div');
    div.className = 'task-card' + (task.id === editingTaskId ? ' selected' : '');
    const nodeCount = task.nodes?.length || 0;
    const repeat = task.repeat || 1;
    const types = [...new Set((task.nodes || []).map(n => NODE_TEMPLATES[n.type]?.label || n.type))];
    div.innerHTML = `
      <div class="task-name">${task.name}</div>
      <div class="task-meta">${nodeCount} 个节点 · 重复 ${repeat} 次 · ${types.join(', ') || '空流程'}</div>
      <div class="task-actions">
        <button class="btn btn-primary btn-sm" data-act="edit-task" data-id="${task.id}">编辑</button>
        <button class="btn btn-secondary btn-sm" data-act="run-task" data-id="${task.id}">运行</button>
        <button class="btn btn-secondary btn-sm" data-act="dup-task" data-id="${task.id}">复制</button>
        <button class="btn btn-secondary btn-sm" data-act="export-task" data-id="${task.id}">导出</button>
        <button class="btn btn-danger btn-sm" data-act="del-task" data-id="${task.id}">删除</button>
      </div>
    `;
    container.appendChild(div);
  });
}

function renderRunSelect() {
  const sel = $('#run-task-select');
  sel.innerHTML = '';
  currentTasks.forEach(t => {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name;
    sel.appendChild(o);
  });
}

function openEditor(taskId) {
  editingTaskId = taskId;
  const task = currentTasks.find(t => t.id === taskId);
  if (task) {
    editingNodes = JSON.parse(JSON.stringify(task.nodes || []));
    $('#flow-name').value = task.name;
    $('#flow-repeat').value = task.repeat || 1;
    $('#editor-title').textContent = `编辑: ${task.name}`;
  }
  renderNodeList();
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
  await chrome.storage.local.set({
    apiBase: $('#set-api-base').value.trim(),
    apiKey: $('#set-api-key').value.trim(),
    apiModel: $('#set-api-model').value.trim() || 'gpt-4o',
    mode: $('#set-mode').value,
    maxSteps: $('#set-max-steps').value,
    budget: $('#set-budget').value || '',
  });
  const el = $('#settings-status');
  el.textContent = '✓ 已保存';
  setTimeout(() => { el.textContent = ''; }, 2000);
}

class TaskRunner {
  constructor(task, logEl, progressEl, summaryEl) {
    this.task = task;
    this.logEl = logEl;
    this.progressEl = progressEl;
    this.summaryEl = summaryEl;
    this.stopped = false;
    this.startTime = 0;
    this.stats = { totalNodes: 0, success: 0, fail: 0, outputs: [] };
  }

  stop() {
    this.stopped = true;
    if (abortController) abortController.abort();
  }

  log(type, msg) {
    const div = document.createElement('div');
    div.className = `log-line ${type}`;
    const ts = new Date().toLocaleTimeString();
    div.textContent = `[${ts}] ${msg}`;
    this.logEl.appendChild(div);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  setProgress(pct) {
    this.progressEl.style.width = `${Math.min(pct, 100)}%`;
  }

  async run() {
    this.startTime = Date.now();
    const nodes = this.task.nodes || [];
    const repeat = this.task.repeat || 1;
    this.stats.totalNodes = nodes.length * repeat;
    this.logEl.innerHTML = '';
    this.summaryEl.style.display = 'none';
    this.log('info', `▶ 开始任务「${this.task.name}」· ${nodes.length} 个节点 · 重复 ${repeat} 次`);

    let step = 0;
    const total = nodes.length * repeat;
    const settings = await getSettings();

    for (let round = 1; round <= repeat; round++) {
      if (this.stopped) break;
      if (repeat > 1) this.log('info', `--- 第 ${round}/${repeat} 轮 ---`);

      for (let i = 0; i < nodes.length; i++) {
        if (this.stopped) break;
        step++;
        this.setProgress((step / total) * 100);
        const node = nodes[i];
        const tpl = NODE_TEMPLATES[node.type];
        this.log('info', `[${step}/${total}] ${tpl?.label || node.type}: ${nodeDesc(node)}`);

        try {
          const output = await this.executeNode(node, settings);
          if (output != null) {
            this.stats.outputs.push({ round, node: i, type: node.type, data: output });
          }
          this.stats.success++;
          this.log('result', `✓ 完成`);
        } catch (e) {
          this.stats.fail++;
          this.log('error', `✗ 失败: ${e.message}`);
        }
      }
    }

    this.finish();
  }

  async executeNode(node, settings) {
    switch (node.type) {
      case 'navigate': {
        if (!node.params.url) throw new Error('URL 为空');
        await navigateTo(node.params.url);
        const wait = node.params.waitMs || 2000;
        await new Promise(r => setTimeout(r, wait));
        return null;
      }

      case 'summarize': {
        await ensureWasm();
        const maxChars = node.params.maxChars || 8000;
        await injectAndRun(INJECT_IDS);
        const pageText = await injectAndRun(COLLECT_TEXT_CONTENT, [maxChars]);
        if (!pageText) throw new Error('页面内容为空');
        const prompt = node.params.prompt || '请总结以下内容：';
        const messages = [
          { role: 'system', content: 'You are a helpful assistant that summarizes web page content. Always respond in the same language as the user.' },
          { role: 'user', content: `${prompt}\n\n---\n${pageText}` },
        ];
        const summary = await callLLM(messages);
        this.log('result', `📝 总结:\n${summary}`);
        return summary;
      }

      case 'action': {
        await ensureWasm();
        const { actionType, actionId, selector, semanticText, actionValue } = node.params;
        if (!actionType) throw new Error('操作类型为空');
        await injectAndRun(INJECT_IDS);

        if (actionId) {
          const actionObj = { action: actionType, id: parseInt(actionId), value: actionValue || undefined };
          const { ir } = await capturePageTokens(settings.mode, settings.budget);
          const strategy = resolve_action(JSON.stringify(actionObj), JSON.stringify(ir));
          const result = await injectAndRun(EXECUTE_ACTION_DOM, [strategy, actionType, actionValue || '']);
          if (!result?.success) throw new Error(result?.error || '操作失败');
          this.log('action', `→ ${actionType} #${actionId} via ${result.strategy?.strategy}`);
          return result;
        }

        if (selector) {
          const strategy = { strategy: 'Selector', value: selector };
          const result = await injectAndRun(EXECUTE_ACTION_DOM, [strategy, actionType, actionValue || '']);
          if (!result?.success) throw new Error(`选择器 "${selector}" 未找到元素`);
          this.log('action', `→ ${actionType} "${selector}" via Selector`);
          return result;
        }

        if (semanticText) {
          const { ir, tokens } = await capturePageTokens(settings.mode, settings.budget);
          this.log('info', `语义匹配: 捕获 ${ir.length} 节点`);
          const taskHint = actionType !== 'click' && actionValue
            ? `${actionType} "${semanticText}" (value: "${actionValue}")`
            : `${actionType} "${semanticText}"`;
          const llmMessages = [
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: `Page tokens:\n${tokens}\n\nTask: ${taskHint}\nStep: 1` },
          ];
          let llmResp;
          try {
            llmResp = await callLLM(llmMessages);
          } catch (e) {
            throw new Error(`LLM 调用失败: ${e.message}`);
          }
          const action = parseAction(llmResp);
          if (!action || action.action === 'fail') {
            throw new Error(`LLM 无法定位 "${semanticText}": ${action?.reason || llmResp.slice(0, 100)}`);
          }
          if (action.action === 'done') {
            this.log('result', `语义匹配: LLM 认为 "${semanticText}" 已完成`);
            return { done: true };
          }
          const strategy = resolve_action(JSON.stringify(action), JSON.stringify(ir));
          await injectAndRun(INJECT_IDS);
          const result = await injectAndRun(EXECUTE_ACTION_DOM, [strategy, action.action, action.value || '']);
          if (!result?.success) throw new Error(`执行失败: ${result?.error || '元素未找到'}`);
          this.log('action', `→ LLM 选择: ${action.action}(${action.id}${action.value ? ', "' + action.value + '"' : ''}) via ${result.strategy?.strategy}`);
          return result;
        }

        throw new Error('需要提供元素ID、CSS选择器或语义文本');
      }

      case 'agent_loop': {
        await ensureWasm();
        const task = node.params.task;
        if (!task) throw new Error('任务描述为空');
        const maxSteps = node.params.maxSteps || settings.maxSteps || 10;
        const messages = [{ role: 'system', content: buildSystemPrompt() }];

        for (let step = 1; step <= maxSteps; step++) {
          if (this.stopped) break;
          this.log('info', `  Agent 步骤 ${step}/${maxSteps}`);

          const { ir, tokens } = await capturePageTokens(settings.mode, settings.budget);
          this.log('info', `  捕获 ${ir.length} 节点`);
          messages.push({ role: 'user', content: `Page tokens:\n${tokens}\n\nTask: ${task}\nStep: ${step}` });

          let llmResp;
          try {
            llmResp = await callLLM(messages);
          } catch (e) {
            this.log('error', `  LLM 失败: ${e.message}`);
            throw e;
          }
          messages.push({ role: 'assistant', content: llmResp });

          const action = parseAction(llmResp);
          if (!action) {
            this.log('error', `  无法解析 LLM 响应: ${llmResp.slice(0, 100)}`);
            throw new Error('LLM 返回了无效的 action');
          }

          if (action.action === 'done') {
            this.log('result', `  ✓ Agent 任务完成 (${step} 步)`);
            return { done: true, steps: step };
          }
          if (action.action === 'fail') {
            throw new Error(`Agent 报告失败: ${action.reason || '未知'}`);
          }

          const desc = action.value ? `${action.action}(${action.id}, "${action.value}")` : `${action.action}(${action.id})`;
          this.log('action', `  → 执行: ${desc}`);

          try {
            const strategy = resolve_action(JSON.stringify(action), JSON.stringify(ir));
            await injectAndRun(INJECT_IDS);
            const result = await injectAndRun(EXECUTE_ACTION_DOM, [strategy, action.action, action.value || '']);
            if (result?.success) {
              this.log('result', `  ✓ ${result.tag || '?'} "${result.text || ''}"`);
            } else {
              this.log('error', `  ✗ 元素未找到`);
              messages.push({ role: 'user', content: `Element not found. Try different id.` });
            }
          } catch (e) {
            this.log('error', `  执行失败: ${e.message}`);
          }
          await new Promise(r => setTimeout(r, 500));
        }
        this.log('warn', `  Agent 达到最大步数 ${maxSteps}`);
        return { done: false, steps: maxSteps };
      }

      case 'export_data': {
        const selector = node.params.selector || 'body';
        const format = node.params.format || 'text';
        await injectAndRun(INJECT_IDS);

        const data = await injectAndRun((sel, fmt) => {
          const root = document.querySelector(sel);
          if (!root) return null;
          if (fmt === 'html') return root.innerHTML;
          if (fmt === 'table') {
            const tables = root.querySelectorAll('table');
            const result = [];
            tables.forEach(t => {
              const rows = [];
              t.querySelectorAll('tr').forEach(r => {
                rows.push(Array.from(r.querySelectorAll('th,td')).map(c => c.innerText.trim()));
              });
              result.push(rows);
            });
            return JSON.stringify(result);
          }
          if (fmt === 'links') {
            const links = [];
            root.querySelectorAll('a[href]').forEach(a => {
              links.push({ text: a.innerText.trim(), href: a.href });
            });
            return JSON.stringify(links);
          }
          return root.innerText;
        }, [selector, format]);

        if (!data) throw new Error('选择器未匹配到元素');
        this.log('result', `📦 导出 (${format}):\n${data.slice(0, 500)}${data.length > 500 ? '...' : ''}`);
        return data;
      }

      case 'wait': {
        const ms = node.params.ms || 1000;
        this.log('info', `⏱ 等待 ${ms}ms`);
        await new Promise(r => setTimeout(r, ms));
        return null;
      }

      case 'log': {
        this.log('warn', `📋 ${node.params.message || ''}`);
        return null;
      }

      default:
        throw new Error(`未知节点类型: ${node.type}`);
    }
  }

  finish() {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const { totalNodes, success, fail, outputs } = this.stats;
    const stopped = this.stopped;

    this.setProgress(100);
    this.summaryEl.style.display = 'block';
    const hasError = fail > 0 || stopped;
    this.summaryEl.className = 'summary-box' + (hasError ? ' error' : '');
    this.summaryEl.innerHTML = `
      <div class="summary-row"><span class="summary-label">状态</span><span class="summary-value">${stopped ? '⏹ 已停止' : (fail > 0 ? '⚠ 有错误' : '✓ 完成')}</span></div>
      <div class="summary-row"><span class="summary-label">耗时</span><span class="summary-value">${elapsed}s</span></div>
      <div class="summary-row"><span class="summary-label">节点</span><span class="summary-value">${success} 成功 / ${fail} 失败 / ${totalNodes} 总计</span></div>
      ${outputs.length ? `<div class="summary-row"><span class="summary-label">输出</span><span class="summary-value">${outputs.length} 项</span></div>` : ''}
    `;

    $('#btn-start-run').disabled = false;
    $('#btn-stop-run').disabled = true;
    currentRunner = null;
  }
}

$('#btn-new-task').onclick = () => {
  $('#new-task-name').value = '';
  $('#modal-task-name').classList.add('show');
  setTimeout(() => $('#new-task-name').focus(), 100);
};

$('#btn-tn-cancel').onclick = () => $('#modal-task-name').classList.remove('show');

$('#btn-tn-confirm').onclick = async () => {
  const name = $('#new-task-name').value.trim();
  if (!name) return;
  const task = { id: genId(), name, nodes: [], repeat: 1, createdAt: Date.now() };
  currentTasks.push(task);
  await saveTasks(currentTasks);
  $('#modal-task-name').classList.remove('show');
  renderTaskList();
  renderRunSelect();
  openEditor(task.id);
};

$('#btn-import-task').onclick = () => {
  const input = $('#file-import');
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      const tasks = Array.isArray(imported) ? imported : [imported];
      tasks.forEach(t => {
        if (!t.id) t.id = genId();
        t.createdAt = t.createdAt || Date.now();
        currentTasks.push(t);
      });
      await saveTasks(currentTasks);
      renderTaskList();
      renderRunSelect();
    } catch (err) {
      alert('导入失败: ' + err.message);
    }
    input.value = '';
  };
  input.click();
};

$('#task-list').onclick = async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;

  if (act === 'edit-task') {
    openEditor(id);
  } else if (act === 'run-task') {
    $('#run-task-select').value = id;
    switchTab('run');
    $('#btn-start-run').click();
  } else if (act === 'dup-task') {
    const task = currentTasks.find(t => t.id === id);
    if (!task) return;
    const dup = JSON.parse(JSON.stringify(task));
    dup.id = genId();
    dup.name = task.name + ' (副本)';
    dup.createdAt = Date.now();
    currentTasks.push(dup);
    await saveTasks(currentTasks);
    renderTaskList();
    renderRunSelect();
  } else if (act === 'export-task') {
    const task = currentTasks.find(t => t.id === id);
    if (!task) return;
    const blob = new Blob([JSON.stringify(task, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${task.name}.json`; a.click();
    URL.revokeObjectURL(url);
  } else if (act === 'del-task') {
    if (!confirm('确定删除此任务？')) return;
    currentTasks = currentTasks.filter(t => t.id !== id);
    if (editingTaskId === id) editingTaskId = null;
    await saveTasks(currentTasks);
    renderTaskList();
    renderRunSelect();
  }
};

$('#btn-add-node').onclick = () => {
  if (!editingTaskId) {
    alert('请先在任务列表中选择一个任务');
    return;
  }
  showNodeModal(null);
};

$('#node-list').onclick = (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const idx = Number(btn.dataset.idx);
  if (act === 'edit') {
    showNodeModal(idx);
  } else if (act === 'del') {
    editingNodes.splice(idx, 1);
    renderNodeList();
  }
};

$('#btn-modal-cancel').onclick = hideNodeModal;

$('#btn-modal-confirm').onclick = () => {
  const { type, params } = collectNodeParams();
  const tpl = NODE_TEMPLATES[type];
  for (const f of tpl.fields) {
    if (f.required && (params[f.key] == null || params[f.key] === '')) {
      alert(`请填写「${f.label}」`);
      return;
    }
  }
  const overlay = $('#modal-node');
  const editIdx = overlay._editIndex;
  if (editIdx != null) {
    editingNodes[editIdx].type = type;
    editingNodes[editIdx].params = params;
  } else {
    editingNodes.push({ id: genId(), type, params });
  }
  hideNodeModal();
  renderNodeList();
};

$('#btn-save-flow').onclick = async () => {
  if (!editingTaskId) return;
  const task = currentTasks.find(t => t.id === editingTaskId);
  if (!task) return;
  task.name = $('#flow-name').value.trim() || task.name;
  task.repeat = parseInt($('#flow-repeat').value) || 1;
  task.nodes = JSON.parse(JSON.stringify(editingNodes));
  task.updatedAt = Date.now();
  await saveTasks(currentTasks);
  renderTaskList();
  renderRunSelect();
  const status = $('#editor-title');
  const orig = status.textContent;
  status.textContent = '✓ 已保存';
  setTimeout(() => { status.textContent = `编辑: ${task.name}`; }, 1500);
};

$('#btn-start-run').onclick = async () => {
  const taskId = $('#run-task-select').value;
  const task = currentTasks.find(t => t.id === taskId);
  if (!task || !task.nodes?.length) {
    alert('任务为空或未选择');
    return;
  }

  const settings = await getSettings();
  if (!settings.apiBase || !settings.apiKey) {
    const hasAgent = task.nodes.some(n => n.type === 'agent_loop' || n.type === 'summarize');
    if (hasAgent) {
      alert('请先在设置中配置 API');
      return;
    }
  }

  await ensureWasm();

  const logEl = $('#run-log');
  const progressEl = $('#run-progress');
  const summaryEl = $('#run-summary');
  progressEl.style.width = '0';
  summaryEl.style.display = 'none';

  $('#btn-start-run').disabled = true;
  $('#btn-stop-run').disabled = false;
  $('#run-title').textContent = `运行: ${task.name}`;

  currentRunner = new TaskRunner(task, logEl, progressEl, summaryEl);
  await currentRunner.run();
};

$('#btn-stop-run').onclick = () => {
  if (currentRunner) currentRunner.stop();
};

$('#btn-save-settings').onclick = saveSettings;

$('#btn-export-all').onclick = () => {
  if (!currentTasks.length) { alert('暂无任务'); return; }
  const blob = new Blob([JSON.stringify(currentTasks, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'web-agent-tasks.json'; a.click();
  URL.revokeObjectURL(url);
};

$('#btn-import-all').onclick = () => {
  const input = $('#file-import');
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      const tasks = Array.isArray(imported) ? imported : [imported];
      tasks.forEach(t => {
        if (!t.id) t.id = genId();
        t.createdAt = t.createdAt || Date.now();
        currentTasks.push(t);
      });
      await saveTasks(currentTasks);
      renderTaskList();
      renderRunSelect();
    } catch (err) {
      alert('导入失败: ' + err.message);
    }
    input.value = '';
  };
  input.click();
};

$('#btn-clear-all').onclick = async () => {
  if (!confirm('确定清空所有任务数据？此操作不可撤销。')) return;
  currentTasks = [];
  await saveTasks(currentTasks);
  renderTaskList();
  renderRunSelect();
};

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

async function bootstrap() {
  currentTasks = await loadTasks();
  renderTaskList();
  renderRunSelect();
  await loadSettings();
}

bootstrap();
