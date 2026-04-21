(function () {
  'use strict';

  // Don't run inside iframes from other origins or extension pages
  if (window.self !== window.top) return;

  // ── Constants ──────────────────────────────────────────────────────────────

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CANVAS']);
  const CONTEXT_CHARS = 32;

  // ── State ──────────────────────────────────────────────────────────────────

  const annotations = new Map(); // id → annotation
  let pendingRange = null;
  let extensionEnabled = true;
  let sidebarEnabled = true;
  let tooltipEnabled = true;

  // ── Text utilities (anchoring) ─────────────────────────────────────────────

  function getTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const tag = node.parentElement?.tagName;
        if (!tag || SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function computeAnchor(range) {
    const exact = range.toString();
    if (!exact.trim()) return null;

    const nodes = getTextNodes(document.body);
    const bodyText = nodes.map(n => n.textContent).join('');

    let charCount = 0;
    let start = -1;

    for (const node of nodes) {
      if (node === range.startContainer) {
        start = charCount + range.startOffset;
        break;
      }
      charCount += node.textContent.length;
    }

    if (start === -1) {
      // startContainer not in our text nodes (edge case: inside a mark we injected)
      start = bodyText.indexOf(exact);
      if (start === -1) return null;
    }

    const end = start + exact.length;
    return {
      exact,
      prefix: bodyText.slice(Math.max(0, start - CONTEXT_CHARS), start),
      suffix: bodyText.slice(end, end + CONTEXT_CHARS),
      textPosition: { start, end }
    };
  }

  function findRangeFromAnchor(anchor) {
    const nodes = getTextNodes(document.body);
    const bodyText = nodes.map(n => n.textContent).join('');

    let start = -1;

    // Fast path: exact position still valid
    if (bodyText.slice(anchor.textPosition.start, anchor.textPosition.end) === anchor.exact) {
      start = anchor.textPosition.start;
    }

    // Context search (prefix + exact + suffix)
    if (start === -1) {
      const ctx = anchor.prefix + anchor.exact + anchor.suffix;
      const idx = bodyText.indexOf(ctx);
      if (idx !== -1) start = idx + anchor.prefix.length;
    }

    // Exact-text-only fallback
    if (start === -1) {
      const idx = bodyText.indexOf(anchor.exact);
      if (idx !== -1) start = idx;
    }

    if (start === -1) return null;

    return positionToRange(nodes, start, start + anchor.exact.length);
  }

  function positionToRange(nodes, start, end) {
    const range = document.createRange();
    let charCount = 0;
    let startSet = false;

    for (const node of nodes) {
      const len = node.textContent.length;

      if (!startSet && charCount + len > start) {
        range.setStart(node, start - charCount);
        startSet = true;
      }

      if (startSet && charCount + len >= end) {
        range.setEnd(node, end - charCount);
        return range;
      }

      charCount += len;
    }

    return startSet ? range : null;
  }

  // ── Highlight utilities ────────────────────────────────────────────────────

  function getTextNodesInRange(range) {
    const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const tag = node.parentElement?.tagName;
        if (!tag || SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function highlightRangeSafe(range, id) {
    const textNodes = getTextNodesInRange(range);
    if (!textNodes.length) return;

    textNodes.forEach((node, i) => {
      try {
        const nr = document.createRange();
        nr.setStart(node, i === 0 ? range.startOffset : 0);
        nr.setEnd(node, i === textNodes.length - 1 ? range.endOffset : node.textContent.length);

        if (nr.collapsed) return;

        const mark = document.createElement('mark');
        mark.className = 'wa-highlight';
        mark.dataset.annotationId = id;
        nr.surroundContents(mark);

        mark.addEventListener('click', () => scrollToAnnotationCard(id));
      } catch (_) {
        // Skip nodes that can't be wrapped (cross-element edge cases)
      }
    });
  }

  function removeHighlight(id) {
    document.querySelectorAll(`.wa-highlight[data-annotation-id="${id}"]`).forEach(mark => {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
  }

  // ── UI injection ───────────────────────────────────────────────────────────

  function injectUI() {
    // Annotate button
    const btn = document.createElement('button');
    btn.id = 'wa-annotate-btn';
    btn.textContent = '✦ Annotate';
    btn.style.display = 'none';
    document.body.appendChild(btn);
    btn.addEventListener('click', e => { e.stopPropagation(); annotate(); });

    // Sidebar
    const sidebar = document.createElement('div');
    sidebar.id = 'wa-sidebar';
    sidebar.innerHTML = `
      <div id="wa-sidebar-tab" title="Toggle annotations">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path id="wa-tab-arrow-path" d="M8 1L3 6l5 5"/>
        </svg>
        <span id="wa-tab-count"></span>
      </div>
      <div id="wa-sidebar-inner">
        <div id="wa-sidebar-header">
          <span id="wa-sidebar-title">Annotations</span>
          <button id="wa-sidebar-close" title="Close">✕</button>
        </div>
        <div id="wa-annotations-list">
          <p id="wa-empty-msg">Highlight text and click <strong>✦ Annotate</strong> to get AI explanations.</p>
        </div>
      </div>
    `;
    document.body.appendChild(sidebar);

    document.getElementById('wa-sidebar-tab').addEventListener('click', toggleSidebar);
    document.getElementById('wa-sidebar-close').addEventListener('click', closeSidebar);

    // Hover tooltip
    const tooltip = document.createElement('div');
    tooltip.id = 'wa-tooltip';
    document.body.appendChild(tooltip);
  }

  // ── Sidebar control ────────────────────────────────────────────────────────

  function applySettings({ extensionEnabled: ee, sidebarEnabled: se, tooltipEnabled: te }) {
    if (ee !== undefined) {
      extensionEnabled = ee;
      if (!extensionEnabled) { hideAnnotateBtn(); pendingRange = null; }
    }
    if (se !== undefined) sidebarEnabled = se;
    if (te !== undefined) tooltipEnabled = te;

    const sidebar = document.getElementById('wa-sidebar');
    if (sidebar) sidebar.classList.toggle('wa-hidden', !sidebarEnabled);

    if (!tooltipEnabled) hideTooltip();
  }

  function openSidebar() {
    if (!sidebarEnabled) return;
    const sidebar = document.getElementById('wa-sidebar');
    if (!sidebar) return;
    sidebar.classList.add('wa-open');
    const arrow = document.getElementById('wa-tab-arrow-path');
    if (arrow) arrow.setAttribute('d', 'M4 1l5 5-5 5');
  }

  function closeSidebar() {
    const sidebar = document.getElementById('wa-sidebar');
    if (!sidebar) return;
    sidebar.classList.remove('wa-open');
    const arrow = document.getElementById('wa-tab-arrow-path');
    if (arrow) arrow.setAttribute('d', 'M8 1L3 6l5 5');
  }

  function toggleSidebar() {
    const sidebar = document.getElementById('wa-sidebar');
    if (sidebar?.classList.contains('wa-open')) closeSidebar();
    else openSidebar();
  }

  function updateTabCount() {
    const el = document.getElementById('wa-tab-count');
    if (!el) return;
    const count = annotations.size;
    el.textContent = count > 0 ? String(count) : '';
  }

  function updateEmptyMsg() {
    const empty = document.getElementById('wa-empty-msg');
    if (empty) empty.style.display = annotations.size > 0 ? 'none' : '';
  }

  // ── Annotation cards ───────────────────────────────────────────────────────

  function esc(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sourcesHtml(sources) {
    if (!sources?.length) return '';
    const links = sources.map(s => {
      const label = s.title || new URL(s.uri).hostname;
      return `<a class="wa-source-link" href="${esc(s.uri)}" target="_blank" rel="noopener" title="${esc(s.uri)}">${esc(label)}</a>`;
    }).join('');
    return `<div class="wa-sources">${links}</div>`;
  }

  function addAnnotationCard(annotation, { orphaned = false, loading = false } = {}) {
    const list = document.getElementById('wa-annotations-list');
    if (!list) return null;

    const card = document.createElement('div');
    card.className = 'wa-card' + (orphaned ? ' wa-orphaned' : '') + (loading ? ' wa-loading' : '');
    card.dataset.annotationId = annotation.id;

    const quote = annotation.selectedText.length > 120
      ? annotation.selectedText.slice(0, 120) + '…'
      : annotation.selectedText;

    card.innerHTML = `
      <blockquote class="wa-quote">${esc(quote)}</blockquote>
      <p class="wa-explanation">${
        loading
          ? '<span class="wa-spinner"></span><span class="wa-loading-text">Analyzing with Gemini…</span>'
          : esc(annotation.explanation)
      }</p>
      ${!loading ? sourcesHtml(annotation.sources) : ''}
      ${orphaned ? '<p class="wa-orphan-note">⚠ Text not found on this page</p>' : ''}
      ${!loading ? '<button class="wa-delete-btn" title="Delete annotation">✕</button>' : ''}
    `;

    if (!loading) {
      card.querySelector('.wa-delete-btn').addEventListener('click', e => {
        e.stopPropagation();
        deleteAnnotation(annotation.id);
      });
      card.addEventListener('click', () => scrollToHighlight(annotation.id));
    }

    list.prepend(card);
    return card;
  }

  function finalizeCard(card, annotation) {
    if (!card) return;
    card.classList.remove('wa-loading');
    card.dataset.annotationId = annotation.id;

    const explanationEl = card.querySelector('.wa-explanation');
    if (explanationEl) explanationEl.textContent = annotation.explanation;

    const srcs = sourcesHtml(annotation.sources);
    if (srcs) {
      const srcEl = document.createElement('div');
      srcEl.innerHTML = srcs;
      // insert after explanation, before the delete button
      explanationEl?.insertAdjacentElement('afterend', srcEl.firstElementChild);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'wa-delete-btn';
    deleteBtn.title = 'Delete annotation';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', e => {
      e.stopPropagation();
      deleteAnnotation(annotation.id);
    });
    card.appendChild(deleteBtn);

    card.addEventListener('click', () => scrollToHighlight(annotation.id));
  }

  function showCardError(card, msg) {
    if (!card) return;
    card.classList.remove('wa-loading');
    card.classList.add('wa-error');
    const el = card.querySelector('.wa-explanation');
    if (el) el.innerHTML = `<span class="wa-error-icon">⚠</span> ${esc(msg)}`;

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'wa-delete-btn';
    dismissBtn.title = 'Dismiss';
    dismissBtn.textContent = '✕';
    dismissBtn.addEventListener('click', () => card.remove());
    card.appendChild(dismissBtn);
  }

  // ── Scroll helpers ─────────────────────────────────────────────────────────

  function scrollToAnnotationCard(id) {
    openSidebar();
    const card = document.querySelector(`.wa-card[data-annotation-id="${id}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    card.classList.add('wa-active');
    setTimeout(() => card.classList.remove('wa-active'), 1500);
  }

  function scrollToHighlight(id) {
    const mark = document.querySelector(`.wa-highlight[data-annotation-id="${id}"]`);
    if (!mark) return;
    mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mark.classList.add('wa-active');
    setTimeout(() => mark.classList.remove('wa-active'), 1500);
  }

  // ── Hover tooltip ─────────────────────────────────────────────────────────

  function showTooltip(mark) {
    if (!tooltipEnabled) return;
    const annotation = annotations.get(mark.dataset.annotationId);
    if (!annotation?.explanation) return;

    const tooltip = document.getElementById('wa-tooltip');
    if (!tooltip) return;

    tooltip.textContent = annotation.explanation;

    // Measure while invisible to compute position
    tooltip.style.visibility = 'hidden';
    tooltip.style.display = 'block';

    const rect = mark.getBoundingClientRect();
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    const gap = 10;

    // Prefer above; flip below if no room
    let top = rect.top - th - gap;
    if (top < 8) top = rect.bottom + gap;

    // Center horizontally on the mark, clamped to viewport
    let left = rect.left + rect.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));

    tooltip.style.top = top + 'px';
    tooltip.style.left = left + 'px';
    tooltip.style.visibility = 'visible';
  }

  function hideTooltip() {
    const tooltip = document.getElementById('wa-tooltip');
    if (tooltip) tooltip.style.display = 'none';
  }

  // ── Annotate button ────────────────────────────────────────────────────────

  function showAnnotateBtn(x, y) {
    const btn = document.getElementById('wa-annotate-btn');
    if (!btn) return;
    btn.style.display = 'block';
    const bw = 110;
    btn.style.left = Math.min(x, window.innerWidth - bw - 8) + 'px';
    btn.style.top = Math.max(8, y - 44) + 'px';
  }

  function hideAnnotateBtn() {
    const btn = document.getElementById('wa-annotate-btn');
    if (btn) btn.style.display = 'none';
  }

  // ── Event listeners ────────────────────────────────────────────────────────

  document.addEventListener('mouseup', e => {
    if (!extensionEnabled) return;

    const sel = window.getSelection();
    const text = sel?.toString().trim();

    if (!text || text.length < 2) {
      hideAnnotateBtn();
      pendingRange = null;
      return;
    }

    // Don't show button for selections inside our sidebar
    const sidebar = document.getElementById('wa-sidebar');
    if (sidebar?.contains(e.target)) {
      return;
    }

    pendingRange = sel.getRangeAt(0).cloneRange();
    showAnnotateBtn(e.clientX, e.clientY);
  });

  document.addEventListener('mousedown', e => {
    const btn = document.getElementById('wa-annotate-btn');
    if (btn && e.target !== btn && btn.style.display !== 'none') {
      hideAnnotateBtn();
      pendingRange = null;
    }
  });

  document.addEventListener('mouseover', e => {
    const mark = e.target.closest('.wa-highlight');
    if (mark) showTooltip(mark);
  });

  document.addEventListener('mouseout', e => {
    const mark = e.target.closest('.wa-highlight');
    if (mark && !mark.contains(e.relatedTarget)) hideTooltip();
  });

  // ── Annotation lifecycle ───────────────────────────────────────────────────

  async function annotate() {
    if (!pendingRange) return;

    const range = pendingRange.cloneRange();
    const selectedText = range.toString().trim();
    if (!selectedText) return;

    hideAnnotateBtn();
    pendingRange = null;

    const anchor = computeAnchor(range);
    if (!anchor) return;

    openSidebar();
    const tempId = 'loading-' + Date.now();
    const loadingCard = addAnnotationCard({ id: tempId, selectedText, explanation: '' }, { loading: true });
    updateEmptyMsg();

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'EXPLAIN',
        payload: {
          selectedText,
          pageTitle: document.title,
          surroundingContext: anchor.prefix + selectedText + anchor.suffix
        }
      });
    } catch (e) {
      showCardError(loadingCard, 'Extension error — try reloading the page.');
      return;
    }

    if (response?.error) {
      showCardError(loadingCard, response.error);
      return;
    }

    const id = crypto.randomUUID();
    const annotation = {
      id,
      createdAt: Date.now(),
      anchor,
      explanation: response.explanation,
      sources: response.sources || [],
      selectedText
    };

    highlightRangeSafe(range, id);
    finalizeCard(loadingCard, annotation);

    annotations.set(id, annotation);
    updateTabCount();
    updateEmptyMsg();

    chrome.runtime.sendMessage({
      type: 'SAVE_ANNOTATION',
      payload: { url: window.location.href, annotation }
    }).catch(() => {});
  }

  async function deleteAnnotation(id) {
    removeHighlight(id);

    const card = document.querySelector(`.wa-card[data-annotation-id="${id}"]`);
    if (card) card.remove();

    annotations.delete(id);
    updateTabCount();
    updateEmptyMsg();

    chrome.runtime.sendMessage({
      type: 'DELETE_ANNOTATION',
      payload: { url: window.location.href, id }
    }).catch(() => {});
  }

  // ── Restore on page load ───────────────────────────────────────────────────

  async function restoreAnnotations() {
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'LOAD_ANNOTATIONS',
        payload: { url: window.location.href }
      });
    } catch {
      return;
    }

    if (!response?.annotations?.length) return;

    const sorted = [...response.annotations].sort((a, b) => a.createdAt - b.createdAt);

    for (const annotation of sorted) {
      annotations.set(annotation.id, annotation);
      const range = findRangeFromAnchor(annotation.anchor);
      if (range) {
        highlightRangeSafe(range, annotation.id);
        addAnnotationCard(annotation);
      } else {
        addAnnotationCard(annotation, { orphaned: true });
      }
    }

    updateTabCount();
    updateEmptyMsg();
  }

  // ── Message listener (from popup) ─────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_STATS') {
      sendResponse({ count: annotations.size });
      return false;
    }
    if (msg.type === 'UPDATE_SETTINGS') {
      applySettings(msg.payload);
      sendResponse({ success: true });
      return false;
    }
    if (msg.type === 'CLEAR_PAGE') {
      for (const [id] of annotations) {
        removeHighlight(id);
        const card = document.querySelector(`.wa-card[data-annotation-id="${id}"]`);
        if (card) card.remove();
      }
      annotations.clear();
      updateTabCount();
      updateEmptyMsg();
      sendResponse({ success: true });
      return false;
    }
  });

  // ── Init ───────────────────────────────────────────────────────────────────

  injectUI();

  chrome.storage.sync.get(['extensionEnabled', 'sidebarEnabled', 'tooltipEnabled'], result => {
    applySettings({
      extensionEnabled: result.extensionEnabled ?? true,
      sidebarEnabled: result.sidebarEnabled ?? true,
      tooltipEnabled: result.tooltipEnabled ?? true
    });
  });

  restoreAnnotations();
})();
