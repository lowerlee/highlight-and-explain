'use strict';

const apiKeyInput = document.getElementById('api-key');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');
const annotationCount = document.getElementById('annotation-count');
const pageCost = document.getElementById('page-cost');
const clearBtn = document.getElementById('clear-btn');
const clearStatus = document.getElementById('clear-status');
const enabledToggle = document.getElementById('enabled-toggle');
const sidebarToggle = document.getElementById('sidebar-toggle');
const tooltipToggle = document.getElementById('tooltip-toggle');
const actionsConfigEl = document.getElementById('actions-config');
const customPromptsEl = document.getElementById('custom-prompts');
const addPromptBtn = document.getElementById('add-prompt-btn');

// ── Load saved API key ───────────────────────────────────────────────────────

chrome.storage.sync.get('geminiApiKey', ({ geminiApiKey }) => {
  if (geminiApiKey) apiKeyInput.value = geminiApiKey;
});

// ── Load display settings ────────────────────────────────────────────────────

// Remembered sub-toggle preferences. The checkboxes mirror these only while the
// master toggle is on; when it's off the sub-toggles show off but these retain
// the user's last choice so re-enabling restores it.
const prefs = { sidebarEnabled: true, tooltipEnabled: true };

chrome.storage.sync.get(['extensionEnabled', 'sidebarEnabled', 'tooltipEnabled'], result => {
  prefs.sidebarEnabled = result.sidebarEnabled ?? true;
  prefs.tooltipEnabled = result.tooltipEnabled ?? true;
  enabledToggle.checked = result.extensionEnabled ?? true;
  syncSubToggles();
});

// Reflect the master toggle onto the sub-toggles: when off, show them off and
// disabled; when on, restore the remembered preferences.
function syncSubToggles() {
  const on = enabledToggle.checked;
  sidebarToggle.disabled = !on;
  tooltipToggle.disabled = !on;
  sidebarToggle.checked = on && prefs.sidebarEnabled;
  tooltipToggle.checked = on && prefs.tooltipEnabled;
}

// ── Load annotation count for active tab ─────────────────────────────────────

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab?.id) return;

  // Ask content script for live count
  chrome.tabs.sendMessage(tab.id, { type: 'GET_STATS' }, response => {
    if (chrome.runtime.lastError) {
      // Content script not ready (e.g. chrome:// page); fall back to storage
      chrome.runtime.sendMessage(
        { type: 'LOAD_ANNOTATIONS', payload: { url: tab.url } },
        r => {
          const anns = r?.annotations ?? [];
          annotationCount.textContent = anns.length;
          pageCost.textContent = fmtUsd(anns.reduce((s, a) => s + (a.cost?.usd || 0), 0));
        }
      );
      return;
    }
    annotationCount.textContent = response?.count ?? 0;
    pageCost.textContent = fmtUsd(response?.totalCost || 0);
  });
});

// Keep in sync with fmtUsd in content.js (no shared module across contexts).
function fmtUsd(usd) {
  if (!usd) return '$0';
  // Sub-cent costs need more precision to be meaningful.
  return usd < 0.01 ? '$' + usd.toFixed(4) : '$' + usd.toFixed(2);
}

// ── Save API key ─────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  chrome.storage.sync.set({ geminiApiKey: key }, () => {
    showStatus(saveStatus, key ? 'Saved!' : 'Key cleared.', false);
  });
});

apiKeyInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveBtn.click();
});

// ── Clear annotations ────────────────────────────────────────────────────────

clearBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return;

    // Clear storage
    chrome.runtime.sendMessage(
      { type: 'CLEAR_PAGE_ANNOTATIONS', payload: { url: tab.url } },
      () => {
        // Also clear live highlights via content script
        chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_PAGE' }, () => {
          chrome.runtime.lastError; // suppress error if content script not available
        });
        annotationCount.textContent = '0';
        pageCost.textContent = '$0';
        showStatus(clearStatus, 'Annotations cleared.', false);
      }
    );
  });
});

// ── Display toggles ──────────────────────────────────────────────────────────

function persistAndApply() {
  // Always persist the remembered preferences so they survive the master toggle.
  const settings = {
    extensionEnabled: enabledToggle.checked,
    sidebarEnabled: prefs.sidebarEnabled,
    tooltipEnabled: prefs.tooltipEnabled
  };
  chrome.storage.sync.set(settings);
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'UPDATE_SETTINGS', payload: settings }, () => {
      chrome.runtime.lastError; // suppress if content script unavailable
    });
  });
}

// Master toggle: cascades on/off to the sub-toggles, restoring prior state.
enabledToggle.addEventListener('change', () => {
  syncSubToggles();
  persistAndApply();
});

// Sub-toggles: only changeable while the master toggle is on; update remembered prefs.
function onSubToggleChange() {
  prefs.sidebarEnabled = sidebarToggle.checked;
  prefs.tooltipEnabled = tooltipToggle.checked;
  persistAndApply();
}

sidebarToggle.addEventListener('change', onSubToggleChange);
tooltipToggle.addEventListener('change', onSubToggleChange);

// ── Selection-widget configuration ───────────────────────────────────────────

// Keep ACTION_META and DEFAULT_ACTION_ORDER in sync with content.js (no shared
// module across the popup and content-script contexts).
const ACTION_META = {
  explain: { icon: '✦', label: 'Explain' },
  cite:    { icon: '⚖', label: 'Cite' },
  note:    { icon: '✏', label: 'Note' }
};
const DEFAULT_ACTION_ORDER = ['explain', 'cite', 'note'];

function normalizeActionConfig(stored) {
  const result = [];
  const seen = new Set();
  if (Array.isArray(stored)) {
    for (const item of stored) {
      if (item && ACTION_META[item.id] && !seen.has(item.id)) {
        result.push({ id: item.id, enabled: item.enabled !== false });
        seen.add(item.id);
      }
    }
  }
  for (const id of DEFAULT_ACTION_ORDER) {
    if (!seen.has(id)) result.push({ id, enabled: true });
  }
  return result;
}

// Mirrors normalizeCustomPrompts in content.js. The popup keeps the label raw
// (un-trimmed) so editing feels natural; content.js trims it for display.
function normalizeCustomPrompts(stored) {
  if (!Array.isArray(stored)) return [];
  return stored
    .filter(p => p && typeof p.prompt === 'string')
    .map(p => ({
      id: p.id || crypto.randomUUID(),
      label: typeof p.label === 'string' ? p.label : '',
      prompt: p.prompt,
      enabled: p.enabled !== false
    }));
}

let actionConfig = normalizeActionConfig(null);
let customPrompts = [];

chrome.storage.sync.get(['actionConfig', 'customPrompts'], result => {
  actionConfig = normalizeActionConfig(result.actionConfig);
  customPrompts = normalizeCustomPrompts(result.customPrompts);
  renderActionsConfig();
  renderCustomPrompts();
});

function renderActionsConfig() {
  actionsConfigEl.innerHTML = '';
  actionConfig.forEach((a, i) => {
    const meta = ACTION_META[a.id];
    const row = document.createElement('div');
    row.className = 'action-row';

    const label = document.createElement('label');
    label.className = 'action-check';
    label.innerHTML = `
      <input type="checkbox" ${a.enabled ? 'checked' : ''}>
      <span class="action-icon">${meta.icon}</span>
      <span class="action-name">${meta.label}</span>
    `;
    label.querySelector('input').addEventListener('change', e => {
      actionConfig[i].enabled = e.target.checked;
      persistWidget();
    });

    const reorder = document.createElement('div');
    reorder.className = 'action-reorder';
    const upBtn = document.createElement('button');
    upBtn.className = 'reorder-btn';
    upBtn.textContent = '↑';
    upBtn.disabled = i === 0;
    upBtn.addEventListener('click', () => moveAction(i, -1));
    const downBtn = document.createElement('button');
    downBtn.className = 'reorder-btn';
    downBtn.textContent = '↓';
    downBtn.disabled = i === actionConfig.length - 1;
    downBtn.addEventListener('click', () => moveAction(i, 1));
    reorder.append(upBtn, downBtn);

    row.append(label, reorder);
    actionsConfigEl.appendChild(row);
  });
}

function moveAction(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= actionConfig.length) return;
  [actionConfig[i], actionConfig[j]] = [actionConfig[j], actionConfig[i]];
  renderActionsConfig();
  persistWidget();
}

// ── Custom prompts ────────────────────────────────────────────────────────────

function renderCustomPrompts() {
  customPromptsEl.innerHTML = '';
  if (!customPrompts.length) {
    const empty = document.createElement('p');
    empty.className = 'custom-empty';
    empty.textContent = 'No custom prompts yet.';
    customPromptsEl.appendChild(empty);
    return;
  }
  customPrompts.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'prompt-row';

    const head = document.createElement('div');
    head.className = 'prompt-head';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = p.enabled;
    toggle.title = 'Show in the scroll wheel';
    toggle.addEventListener('change', () => { customPrompts[i].enabled = toggle.checked; persistWidget(); });

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'prompt-label';
    labelInput.placeholder = 'Name (e.g. Summarize)';
    labelInput.value = p.label;
    labelInput.addEventListener('change', () => { customPrompts[i].label = labelInput.value.trim(); persistWidget(); });

    const delBtn = document.createElement('button');
    delBtn.className = 'prompt-delete';
    delBtn.title = 'Delete prompt';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => deleteCustomPrompt(i));

    head.append(toggle, labelInput, delBtn);

    const promptInput = document.createElement('textarea');
    promptInput.className = 'prompt-text';
    promptInput.rows = 2;
    promptInput.placeholder = 'Prompt to run on the highlighted text…';
    promptInput.spellcheck = false;
    promptInput.value = p.prompt;
    promptInput.addEventListener('change', () => { customPrompts[i].prompt = promptInput.value; persistWidget(); });

    row.append(head, promptInput);
    customPromptsEl.appendChild(row);
  });
}

function addCustomPrompt() {
  // Don't persist yet — an empty draft adds nothing to the wheel. It's saved
  // once the user fills in a field (the input change handlers call persistWidget).
  customPrompts.push({ id: crypto.randomUUID(), label: '', prompt: '', enabled: true });
  renderCustomPrompts();
  customPromptsEl.querySelector('.prompt-row:last-child .prompt-label')?.focus();
}

function deleteCustomPrompt(i) {
  customPrompts.splice(i, 1);
  renderCustomPrompts();
  persistWidget();
}

addPromptBtn.addEventListener('click', addCustomPrompt);

function persistWidget() {
  chrome.storage.sync.set({ actionConfig, customPrompts });
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, {
      type: 'UPDATE_SETTINGS',
      payload: { actionConfig, customPrompts }
    }, () => { chrome.runtime.lastError; }); // suppress if content script unavailable
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function showStatus(el, msg, isError) {
  el.textContent = msg;
  el.className = 'status-msg' + (isError ? ' status-error' : ' status-ok');
  setTimeout(() => { el.textContent = ''; el.className = 'status-msg'; }, 2500);
}
