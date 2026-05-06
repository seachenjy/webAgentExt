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

const INJECT_IDS = () => {
  // 扩展选择器，确保与 Rust 的 NodeKind 判定逻辑同步
  const interactiveSelectors = [
    'button', 'input:not([type="hidden"])', 'textarea', 'select', 'a', 
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="menuitem"]',
    '[onclick]', '[data-agent-id]'
  ].join(',');
  
  const elements = document.body.querySelectorAll(interactiveSelectors);
  let id = 0;
  elements.forEach((el) => {
    el.setAttribute('data-agent-id', String(id));
    id++;
  });
  return id;
};

const COLLECT_DOM = () => {
  return { html: document.body.innerHTML };
};

const COLLECT_BBOX = () => {
  const elements = document.body.querySelectorAll('[data-agent-id]');
  const bboxes = [];
  elements.forEach((el) => {
    const rect = el.getBoundingClientRect();
    bboxes.push(rect.x, rect.y, rect.width, rect.height);
  });
  return bboxes;
};

const EXECUTE_ACTION_DOM = (strategy, actionType, actionValue) => {
  let el = null;

  if (strategy.strategy === 'AgentId') {
    el = document.querySelector(`[data-agent-id="${strategy.value}"]`);
  } else if (strategy.strategy === 'Selector') {
    el = document.querySelector(strategy.value);
  } else if (strategy.strategy === 'SemanticText') {
    const { text, tag } = strategy.value;
    const selector = tag || '*';
    const candidates = document.querySelectorAll(selector);
    el = Array.from(candidates).find((e) => e.innerText && e.innerText.includes(text));
  }

  if (!el) return { success: false, error: 'Element not found', strategy };

  switch (actionType) {
    case 'click':
      el.click();
      break;
    case 'type':
      el.focus();
      el.value = actionValue || '';
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

async function loadSettings() {
  const data = await chrome.storage.local.get([
    'apiBase', 'apiKey', 'apiModel', 'mode', 'maxSteps', 'budget',
  ]);
  document.getElementById('api-base').value = data.apiBase || '';
  document.getElementById('api-key').value = data.apiKey || '';
  document.getElementById('api-model').value = data.apiModel || 'gpt-4o';
  if (data.mode) document.getElementById('mode').value = data.mode;
  if (data.maxSteps) document.getElementById('max-steps').value = data.maxSteps;
  if (data.budget) document.getElementById('budget').value = data.budget;
}

async function saveSettings() {
  const settings = {
    apiBase: document.getElementById('api-base').value.trim(),
    apiKey: document.getElementById('api-key').value.trim(),
    apiModel: document.getElementById('api-model').value.trim() || 'gpt-4o',
    mode: document.getElementById('mode').value,
    maxSteps: document.getElementById('max-steps').value,
    budget: document.getElementById('budget').value,
  };
  await chrome.storage.local.set(settings);
  return settings;
}

async function getSettings() {
  const data = await chrome.storage.local.get(['apiBase', 'apiKey', 'apiModel']);
  return {
    apiBase: (data.apiBase || '').trim(),
    apiKey: (data.apiKey || '').trim(),
    apiModel: (data.apiModel || 'gpt-4o').trim(),
  };
}

async function callLLM(messages) {
  const settings = await getSettings();
  if (!settings.apiBase || !settings.apiKey) {
    throw new Error('请先在设置中配置 API Base URL 和 API Key');
  }

  const base = settings.apiBase.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;

  abortController = new AbortController();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.apiModel,
      messages,
      temperature: 0,
      max_tokens: 1024,
    }),
    signal: abortController.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM API 错误 ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

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

function buildUserPrompt(tokens, task, stepNum) {
  return `Page tokens:\n${tokens}\n\nTask: ${task}\nStep: ${stepNum}`;
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

async function executeStep(ir, actionObj) {
  const actionJson = JSON.stringify(actionObj);
  const irJson = JSON.stringify(ir);
  const strategy = resolve_action(actionJson, irJson);

  await injectAndRun(INJECT_IDS);
  const result = await injectAndRun(EXECUTE_ACTION_DOM, [
    strategy,
    actionObj.action,
    actionObj.value || '',
  ]);
  return result;
}

class AgentRunner {
  constructor({ mode, maxSteps, task, onLog, onProgress, onDone }) {
    this.mode = mode;
    this.maxSteps = maxSteps;
    this.task = task;
    this.onLog = onLog;
    this.onProgress = onProgress;
    this.onDone = onDone;
    this.stopped = false;
    this.messages = [];
  }

  stop() {
    this.stopped = true;
    if (abortController) abortController.abort();
  }

  async run() {
    this.messages = [
      { role: 'system', content: buildSystemPrompt() },
    ];

    for (let step = 1; step <= this.maxSteps; step++) {
      if (this.stopped) {
        this.onLog('info', `[停止] Agent 在步骤 ${step} 被手动停止`);
        this.onDone(false, 'Agent 已停止');
        return;
      }

      this.onProgress(step / this.maxSteps * 100);
      this.onLog('info', `--- 步骤 ${step}/${this.maxSteps} ---`);

      let tokens, ir;
      try {
        const captured = await capturePageTokens(this.mode, null);
        ir = captured.ir;
        tokens = captured.tokens;
      } catch (e) {
        this.onLog('error', `页面捕获失败: ${e.message}`);
        this.onDone(false, `页面捕获失败: ${e.message}`);
        return;
      }

      this.onLog('info', `捕获 ${ir.length} 个节点`);
      if (tokens) {
        const preview = tokens.length > 200 ? tokens.slice(0, 200) + '...' : tokens;
        this.onLog('info', `Tokens: ${preview}`);
      }

      const userMsg = buildUserPrompt(tokens, this.task, step);
      this.messages.push({ role: 'user', content: userMsg });

      let llmResponse;
      try {
        llmResponse = await callLLM(this.messages);
      } catch (e) {
        this.onLog('error', `LLM 调用失败: ${e.message}`);
        this.onDone(false, `LLM 调用失败: ${e.message}`);
        return;
      }

      this.messages.push({ role: 'assistant', content: llmResponse });

      const action = parseAction(llmResponse);
      if (!action) {
        this.onLog('error', `LLM 返回了无法解析的响应: ${llmResponse.slice(0, 100)}`);
        this.onDone(false, 'LLM 返回了无效的 action JSON');
        return;
      }

      if (action.action === 'done') {
        this.onLog('result', `✓ 任务完成 (共 ${step} 步)`);
        this.onDone(true, `任务完成，共执行 ${step} 步`);
        return;
      }

      if (action.action === 'fail') {
        this.onLog('error', `✗ Agent 报告失败: ${action.reason || '未知原因'}`);
        this.onDone(false, `Agent 报告失败: ${action.reason || '未知原因'}`);
        return;
      }

      const actionDesc = action.value
        ? `${action.action}(${action.id}, "${action.value}")`
        : `${action.action}(${action.id})`;
      this.onLog('action', `→ 执行: ${actionDesc}`);

      let execResult;
      try {
        execResult = await executeStep(ir, action);
      } catch (e) {
        this.onLog('error', `执行失败: ${e.message}`);
        this.messages.push({
          role: 'user',
          content: `Action execution failed: ${e.message}. Try a different approach.`,
        });
        continue;
      }

      if (execResult?.success) {
        const tag = execResult.tag || '?';
        const text = execResult.text || '';
        this.onLog('result', `✓ 成功: <${tag}> "${text}" via ${execResult.strategy?.strategy}`);
      } else {
        this.onLog('error', `✗ 元素未找到: ${execResult?.error || 'unknown'}`);
        this.messages.push({
          role: 'user',
          content: `Element not found on page. The element with id ${action.id} could not be located. Try a different element id.`,
        });
      }

      await new Promise(r => setTimeout(r, 500));
    }

    this.onLog('info', `达到最大步数 ${this.maxSteps}，任务未完成`);
    this.onDone(false, `达到最大步数 ${this.maxSteps}`);
  }
}

function setupSectionToggles() {
  document.querySelectorAll('.section-title[data-toggle]').forEach(title => {
    title.addEventListener('click', () => {
      const targetId = title.getAttribute('data-toggle');
      const body = document.getElementById(targetId);
      if (body) {
        title.classList.toggle('open');
        body.classList.toggle('open');
      }
    });
  });
}

const output = document.getElementById('output');
const stats = document.getElementById('stats');
const agentLog = document.getElementById('agent-log');
const agentProgress = document.getElementById('agent-progress');
const actionResult = document.getElementById('action-result');
const btnRunAgent = document.getElementById('btn-run-agent');
const btnStopAgent = document.getElementById('btn-stop-agent');

let lastIR = null;
let currentAgent = null;

loadSettings();
setupSectionToggles();

['mode', 'max-steps', 'budget'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => saveSettings());
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  await saveSettings();
  const el = document.getElementById('settings-status');
  el.textContent = '✓ 已保存';
  setTimeout(() => { el.textContent = ''; }, 2000);
});

btnRunAgent.addEventListener('click', async () => {
  const task = document.getElementById('task-input').value.trim();
  if (!task) return;

  const settings = await getSettings();
  if (!settings.apiBase || !settings.apiKey) {
    agentLog.innerHTML = '<span class="step step-error">请先配置 API 设置</span>';
    return;
  }

  await ensureWasm();

  const mode = document.getElementById('mode').value;
  const maxSteps = parseInt(document.getElementById('max-steps').value) || 10;

  agentLog.innerHTML = '';
  agentProgress.style.width = '0%';
  btnRunAgent.disabled = true;
  btnStopAgent.disabled = false;

  let success = false;
  currentAgent = new AgentRunner({
    mode,
    maxSteps,
    task,
    onLog(type, msg) {
      const div = document.createElement('div');
      div.className = `step step-${type}`;
      div.textContent = msg;
      agentLog.appendChild(div);
      agentLog.scrollTop = agentLog.scrollHeight;
    },
    onProgress(pct) {
      agentProgress.style.width = `${Math.min(pct, 100)}%`;
    },
    onDone(s, msg) {
      success = s;
      const div = document.createElement('div');
      div.className = `step ${s ? 'step-result' : 'step-error'}`;
      div.textContent = msg;
      agentLog.appendChild(div);
      agentProgress.style.width = '100%';
      btnRunAgent.disabled = false;
      btnStopAgent.disabled = true;
      currentAgent = null;
    },
  });

  await currentAgent.run();
});

btnStopAgent.addEventListener('click', () => {
  if (currentAgent) currentAgent.stop();
});

document.getElementById('btn-compress').addEventListener('click', async () => {
  try {
    await ensureWasm();
    const count = await injectAndRun(INJECT_IDS);
    const dom = await injectAndRun(COLLECT_DOM);

    const mode = document.getElementById('mode').value;
    const budgetVal = document.getElementById('budget').value;
    const budget = budgetVal ? parseInt(budgetVal) : null;

    const t0 = performance.now();
    const ir = build_ir_wasm(dom.html);
    if (!ir || !Array.isArray(ir)) throw new Error('IR 构建失败，未解析到有效节点');
    lastIR = ir;
    const irJson = JSON.stringify(ir);
    const result = compress_ir(irJson, mode, budget);
    const elapsed = (performance.now() - t0).toFixed(1);

    output.textContent = result;
    stats.textContent = `节点: ${ir.length} | 耗时: ${elapsed}ms | 字符: ${result.length}`;
  } catch (e) {
    output.textContent = `错误: ${e.message}`;
    stats.textContent = '';
  }
});

document.getElementById('btn-ir').addEventListener('click', async () => {
  try {
    await ensureWasm();
    await injectAndRun(INJECT_IDS);
    const dom = await injectAndRun(COLLECT_DOM);
    const bbox = await injectAndRun(COLLECT_BBOX);

    const t0 = performance.now();
    const ir = build_ir_wasm(dom.html, new Float32Array(bbox));
    const elapsed = (performance.now() - t0).toFixed(1);

    if (!ir || !Array.isArray(ir)) throw new Error('IR 构建失败，未解析到有效节点');
    lastIR = ir;

    output.textContent = JSON.stringify(ir, null, 2);
    stats.textContent = `节点: ${ir.length} | 耗时: ${elapsed}ms`;
  } catch (e) {
    output.textContent = `错误: ${e.message}`;
    stats.textContent = '';
  }
});

document.getElementById('btn-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(output.textContent);
  stats.textContent = '已复制到剪贴板';
});

document.getElementById('btn-execute').addEventListener('click', async () => {
  try {
    await ensureWasm();

    if (!lastIR) {
      actionResult.innerHTML = '<span class="error">请先生成 IR</span>';
      return;
    }

    const actionType = document.getElementById('action-type').value;
    const actionId = document.getElementById('action-id').value;
    const actionValue = document.getElementById('action-value').value;

    if (!actionId) {
      actionResult.innerHTML = '<span class="error">请输入元素 ID</span>';
      return;
    }

    const actionJson = JSON.stringify({ action: actionType, id: parseInt(actionId), value: actionValue || undefined });
    const irJson = JSON.stringify(lastIR);

    const strategy = resolve_action(actionJson, irJson);

    await injectAndRun(INJECT_IDS);

    const r = await injectAndRun(EXECUTE_ACTION_DOM, [strategy, actionType, actionValue]);

    if (r?.success) {
      actionResult.innerHTML = `<span class="success">✓ 成功</span> | 策略: ${r.strategy.strategy} | 元素: &lt;${r.tag}&gt; "${r.text || ''}"`;
    } else {
      actionResult.innerHTML = `<span class="error">✗ 失败</span> | 策略: ${r?.strategy?.strategy || 'unknown'} | ${r?.error || '未知错误'}`;
    }
  } catch (e) {
    actionResult.innerHTML = `<span class="error">错误: ${e.message}</span>`;
  }
});
