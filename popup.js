'use strict';

const apiKeyInput = document.getElementById('api-key');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');
const annotationCount = document.getElementById('annotation-count');
const clearBtn = document.getElementById('clear-btn');
const clearStatus = document.getElementById('clear-status');
const enabledToggle = document.getElementById('enabled-toggle');
const sidebarToggle = document.getElementById('sidebar-toggle');
const tooltipToggle = document.getElementById('tooltip-toggle');

// ── Load saved API key ───────────────────────────────────────────────────────

chrome.storage.sync.get('geminiApiKey', ({ geminiApiKey }) => {
  if (geminiApiKey) apiKeyInput.value = geminiApiKey;
});

// ── Load display settings ────────────────────────────────────────────────────

chrome.storage.sync.get(['extensionEnabled', 'sidebarEnabled', 'tooltipEnabled'], result => {
  enabledToggle.checked = result.extensionEnabled ?? true;
  sidebarToggle.checked = result.sidebarEnabled ?? true;
  tooltipToggle.checked = result.tooltipEnabled ?? true;
});

// ── Load annotation count for active tab ─────────────────────────────────────

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab?.id) return;

  // Ask content script for live count
  chrome.tabs.sendMessage(tab.id, { type: 'GET_STATS' }, response => {
    if (chrome.runtime.lastError) {
      // Content script not ready (e.g. chrome:// page); fall back to storage
      chrome.runtime.sendMessage(
        { type: 'LOAD_ANNOTATIONS', payload: { url: tab.url } },
        r => { annotationCount.textContent = r?.annotations?.length ?? 0; }
      );
      return;
    }
    annotationCount.textContent = response?.count ?? 0;
  });
});

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
        showStatus(clearStatus, 'Annotations cleared.', false);
      }
    );
  });
});

// ── Display toggles ──────────────────────────────────────────────────────────

function onToggleChange() {
  const settings = {
    extensionEnabled: enabledToggle.checked,
    sidebarEnabled: sidebarToggle.checked,
    tooltipEnabled: tooltipToggle.checked
  };
  chrome.storage.sync.set(settings);
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'UPDATE_SETTINGS', payload: settings }, () => {
      chrome.runtime.lastError; // suppress if content script unavailable
    });
  });
}

enabledToggle.addEventListener('change', onToggleChange);
sidebarToggle.addEventListener('change', onToggleChange);
tooltipToggle.addEventListener('change', onToggleChange);

// ── Helpers ──────────────────────────────────────────────────────────────────

function showStatus(el, msg, isError) {
  el.textContent = msg;
  el.className = 'status-msg' + (isError ? ' status-error' : ' status-ok');
  setTimeout(() => { el.textContent = ''; el.className = 'status-msg'; }, 2500);
}
