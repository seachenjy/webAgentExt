import init, { compress_html, build_ir_wasm, compress_ir, resolve_action } from '../pkg/web_agent_ir.js';

let wasmReady = false;

export async function initialize(wasmUrl) {
  await init(wasmUrl);
  wasmReady = true;
}

export function injectAgentIds(root = document.body) {
  const interactiveSelectors = 'button, input, textarea, select, a, [role="button"], [onclick]';
  const elements = root.querySelectorAll(interactiveSelectors);
  let id = 0;
  elements.forEach((el) => {
    el.setAttribute('data-agent-id', String(id));
    id++;
  });
  return id;
}

export function collectBBox(root = document.body) {
  const elements = root.querySelectorAll('[data-agent-id]');
  const data = new Float32Array(elements.length * 4);
  elements.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    const base = i * 4;
    data[base] = rect.x;
    data[base + 1] = rect.y;
    data[base + 2] = rect.width;
    data[base + 3] = rect.height;
  });
  return data;
}

export function compressPage(root = document.body) {
  if (!wasmReady) throw new Error('WASM not initialized');
  return compress_html(root.innerHTML);
}

export function buildPageIR(root = document.body) {
  if (!wasmReady) throw new Error('WASM not initialized');
  const bbox = collectBBox(root);
  return build_ir_wasm(root.innerHTML, bbox);
}

export function executeAction(actionJson, irJson) {
  if (!wasmReady) throw new Error('WASM not initialized');
  const strategy = resolve_action(actionJson, irJson);

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

  if (!el) return null;

  const action = JSON.parse(actionJson);
  switch (action.action) {
    case 'click':
      el.click();
      break;
    case 'type':
      el.focus();
      el.value = action.value || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      break;
    case 'select':
      el.value = action.value || '';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    case 'hover':
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      break;
    case 'scroll':
      el.scrollIntoView({ behavior: 'smooth' });
      break;
  }

  return el;
}
