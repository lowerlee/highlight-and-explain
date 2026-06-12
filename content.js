(function () {
  'use strict';

  // Don't run inside iframes from other origins or extension pages
  if (window.self !== window.top) return;

  // ── Constants ──────────────────────────────────────────────────────────────

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CANVAS']);
  const CONTEXT_CHARS = 32;
  // Fallback widget width for viewport-edge clamping when the element hasn't
  // been measured yet.
  const WIDGET_MAX_WIDTH = 360;

  // ── State ──────────────────────────────────────────────────────────────────

  const annotations = new Map(); // id → annotation
  let pendingRange = null;
  let extensionEnabled = true;
  let sidebarEnabled = true;
  let tooltipEnabled = true;

  // ── Selection-widget configuration ───────────────────────────────────────────
  // The built-in actions. `run` is invoked when the action is chosen; the
  // referenced functions are hoisted declarations defined later in this file.
  // Keep icons/labels/order in sync with ACTION_META in popup.js.
  const BUILTIN_DEFS = {
    explain: { icon: '✦', label: 'Explain', run: () => annotate() },
    cite:    { icon: '⚖', label: 'Cite',    run: () => annotateCite() },
    note:    { icon: '✏', label: 'Note',    run: () => showNoteInput() }
  };
  const DEFAULT_ACTION_ORDER = ['explain', 'cite', 'note'];
  // Color classes (wa-action-<key>) the carousel applies to the widget; custom
  // prompts share the 'custom' accent.
  const ACTION_COLOR_KEYS = ['explain', 'cite', 'note', 'custom'];

  // Which built-in actions (in order) are enabled, plus user-defined custom
  // prompts. Overwritten by stored settings on init and live via UPDATE_SETTINGS.
  let actionConfig = DEFAULT_ACTION_ORDER.map(id => ({ id, enabled: true }));
  let customPrompts = []; // { id, label, prompt, enabled }
  let carouselIndex = 0;  // current pill index in the scroll wheel

  // Reconcile stored config with the known built-ins: keep stored order/enabled
  // for recognized ids, drop unknowns, and append any built-in the user hasn't
  // seen (so a previously-stored 'custom' action is silently dropped).
  function normalizeActionConfig(stored) {
    const result = [];
    const seen = new Set();
    if (Array.isArray(stored)) {
      for (const item of stored) {
        if (item && BUILTIN_DEFS[item.id] && !seen.has(item.id)) {
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

  function normalizeCustomPrompts(stored) {
    if (!Array.isArray(stored)) return [];
    return stored
      .filter(p => p && typeof p.prompt === 'string')
      .map(p => ({
        id: p.id || crypto.randomUUID(),
        label: (p.label || '').trim(),
        prompt: p.prompt,
        enabled: p.enabled !== false
      }));
  }

  // The ordered list of actions shown in the wheel: enabled built-ins (in their
  // configured order) followed by enabled custom prompts. Each entry resolves to
  // { key, colorKey, icon, label, run }.
  function resolvedActions() {
    const list = [];
    for (const a of actionConfig) {
      if (a.enabled && BUILTIN_DEFS[a.id]) {
        list.push({ key: a.id, colorKey: a.id, ...BUILTIN_DEFS[a.id] });
      }
    }
    for (const p of customPrompts) {
      if (p.enabled && p.prompt.trim()) {
        list.push({
          key: 'custom:' + p.id,
          colorKey: 'custom',
          icon: '✎',
          label: p.label || 'Custom',
          run: () => annotate(p.prompt)
        });
      }
    }
    return list;
  }

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

  function highlightRangeSafe(range, id, type = null) {
    const textNodes = getTextNodesInRange(range);
    if (!textNodes.length) return;

    textNodes.forEach((node, i) => {
      try {
        const nr = document.createRange();
        nr.setStart(node, i === 0 ? range.startOffset : 0);
        nr.setEnd(node, i === textNodes.length - 1 ? range.endOffset : node.textContent.length);

        if (nr.collapsed) return;

        const mark = document.createElement('mark');
        mark.className = 'wa-highlight' + (type === 'note' ? ' wa-note-highlight' : '');
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
    // Selection-action widget (scroll wheel) — contents are rendered dynamically
    // from the enabled actions + custom prompts (see renderAnnotateWidget).
    const btn = document.createElement('div');
    btn.id = 'wa-annotate-btn';
    document.body.appendChild(btn);

    // Wheel cycles through the available actions.
    btn.addEventListener('wheel', e => {
      e.preventDefault();
      cycleCarousel(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });

    renderAnnotateWidget();

    // Note input
    const noteInput = document.createElement('div');
    noteInput.id = 'wa-note-input';
    noteInput.innerHTML = `
      <input type="text" id="wa-note-text" placeholder="Write your note…" autocomplete="off" spellcheck="false">
      <button id="wa-note-submit" title="Save note (Enter)">↵</button>
    `;
    document.body.appendChild(noteInput);

    document.getElementById('wa-note-submit').addEventListener('click', e => {
      e.stopPropagation();
      submitNote();
    });
    document.getElementById('wa-note-text').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.stopPropagation(); submitNote(); }
      if (e.key === 'Escape') { e.stopPropagation(); hideNoteInput(); }
    });

    // Sidebar
    const sidebar = document.createElement('div');
    sidebar.id = 'wa-sidebar';
    sidebar.innerHTML = `
      <div id="wa-sidebar-tab" title="Toggle annotations">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path d="M8 1L3 6l5 5"/>
        </svg>
        <span id="wa-tab-count"></span>
      </div>
      <div id="wa-sidebar-inner">
        <div id="wa-sidebar-header">
          <div class="wa-header-titles">
            <span id="wa-sidebar-title">Annotations</span>
            <span id="wa-cost-total" class="wa-cost-total" title="Estimated Gemini usage for this page"></span>
          </div>
          <button id="wa-sidebar-close" title="Close">✕</button>
        </div>
        <div id="wa-annotations-list">
          <p id="wa-empty-msg">Highlight text and click <strong>✦ Explain</strong> to get AI explanations.</p>
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

  // ── Selection-widget rendering (scroll wheel) ─────────────────────────────────

  // Inner markup (icon + label) for the carousel stage.
  function pillInner(action) {
    return `<span class="wa-btn-icon">${esc(action.icon)}</span><span class="wa-btn-label">${esc(action.label)}</span>`;
  }

  // (Re)render the widget: one action "stage" pill plus position dots.
  function renderAnnotateWidget() {
    const btn = document.getElementById('wa-annotate-btn');
    if (!btn) return;
    btn.innerHTML = '';
    ACTION_COLOR_KEYS.forEach(c => btn.classList.remove('wa-action-' + c));

    const actions = resolvedActions();
    if (!actions.length) return;
    if (carouselIndex >= actions.length) carouselIndex = 0;

    const stage = document.createElement('div');
    stage.className = 'wa-carousel-stage';
    stage.addEventListener('click', e => {
      e.stopPropagation();
      resolvedActions()[carouselIndex]?.run();
    });

    // Dots are a position indicator and a click-to-jump control; the wheel cycles.
    const dots = document.createElement('div');
    dots.className = 'wa-carousel-dots';
    dots.addEventListener('click', e => {
      e.stopPropagation();
      const dot = e.target.closest('.wa-dot');
      if (!dot) return;
      const idx = Number(dot.dataset.i);
      if (Number.isNaN(idx) || idx >= resolvedActions().length) return;
      carouselIndex = idx;
      updateCarousel();
    });

    btn.append(stage, dots);
    updateCarousel();
  }

  function cycleCarousel(dir) {
    const n = resolvedActions().length;
    if (!n) return;
    carouselIndex = (carouselIndex + dir + n) % n;
    updateCarousel();
  }

  function updateCarousel() {
    const btn = document.getElementById('wa-annotate-btn');
    if (!btn) return;
    const actions = resolvedActions();
    if (!actions.length) return;
    if (carouselIndex >= actions.length) carouselIndex = 0;
    const action = actions[carouselIndex];

    // Color the whole widget by the active action so it reads as one pill.
    ACTION_COLOR_KEYS.forEach(c => btn.classList.remove('wa-action-' + c));
    btn.classList.add('wa-action-' + action.colorKey);

    const stage = btn.querySelector('.wa-carousel-stage');
    if (stage) stage.innerHTML = pillInner(action);

    const dots = btn.querySelector('.wa-carousel-dots');
    if (dots) {
      dots.innerHTML = actions
        .map((_, i) => `<span class="wa-dot${i === carouselIndex ? ' wa-dot-active' : ''}" data-i="${i}"></span>`)
        .join('');
    }
  }

  // ── Sidebar control ────────────────────────────────────────────────────────

  function applySettings({ extensionEnabled: ee, sidebarEnabled: se, tooltipEnabled: te, actionConfig: ac, customPrompts: cp }) {
    if (ee !== undefined) {
      extensionEnabled = ee;
      if (!extensionEnabled) { hideAnnotateBtn(); pendingRange = null; }
    }
    if (se !== undefined) sidebarEnabled = se;
    if (te !== undefined) tooltipEnabled = te;

    let widgetDirty = false;
    if (ac !== undefined) { actionConfig = normalizeActionConfig(ac); widgetDirty = true; }
    if (cp !== undefined) { customPrompts = normalizeCustomPrompts(cp); widgetDirty = true; }
    if (widgetDirty) { carouselIndex = 0; renderAnnotateWidget(); }

    const sidebar = document.getElementById('wa-sidebar');
    if (sidebar) sidebar.classList.toggle('wa-hidden', !(extensionEnabled && sidebarEnabled));

    if (!(extensionEnabled && tooltipEnabled)) hideTooltip();
  }

  function openSidebar() {
    if (!extensionEnabled || !sidebarEnabled) return;
    const sidebar = document.getElementById('wa-sidebar');
    if (!sidebar) return;
    sidebar.classList.add('wa-open');
  }

  function closeSidebar() {
    const sidebar = document.getElementById('wa-sidebar');
    if (!sidebar) return;
    sidebar.classList.remove('wa-open');
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
    updatePageCost();
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

  // ── Markdown (notes) ─────────────────────────────────────────────────────────

  // Only http(s) and mailto links are allowed, to block javascript:/data: URIs.
  // The href is already HTML-escaped by esc(), so it can't break out of the
  // attribute; this just rejects dangerous schemes.
  function mdSafeUrl(href) {
    const v = href.trim();
    return /^(https?:\/\/|mailto:)/i.test(v) ? v : null;
  }

  // Minimal, XSS-safe Markdown for personal notes. The whole input is
  // HTML-escaped first, then a small set of tokens is rewritten into a fixed
  // allow-list of tags — so raw HTML in a note can never execute. Supports
  // #/##/### headings, **bold**, *italic*, `code`, [text](url), - / 1. lists,
  // > blockquotes, and paragraphs (single newline → <br>, blank line → new block).
  function renderMarkdown(src) {
    const lines = esc(src || '').split('\n');

    const inline = (s) => {
      // Protect code spans so emphasis/link rules don't touch their contents.
      // The sentinel is a NUL char built at runtime (never present in note
      // text), so placeholders can't collide with content like "3 apples".
      const SENTINEL = String.fromCharCode(0);
      const codes = [];
      s = s.replace(/`([^`]+)`/g, (_m, c) => SENTINEL + (codes.push(c) - 1) + SENTINEL);
      s = s
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/_([^_]+)_/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
          const safe = mdSafeUrl(href);
          return safe ? `<a href="${safe}" target="_blank" rel="noopener">${text}</a>` : m;
        });
      return s.replace(new RegExp(SENTINEL + '(\\d+)' + SENTINEL, 'g'), (_m, n) => `<code>${codes[Number(n)]}</code>`);
    };

    const isSpecial = (l) =>
      /^#{1,3}\s+/.test(l) || /^>\s?/.test(l) || /^[-*+]\s+/.test(l) || /^\d+\.\s+/.test(l);

    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i++; continue; }

      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        out.push(`<div class="wa-md-h wa-md-h${h[1].length}">${inline(h[2].trim())}</div>`);
        i++;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(inline(lines[i].replace(/^>\s?/, ''))); i++; }
        out.push(`<blockquote class="wa-md-quote">${buf.join('<br>')}</blockquote>`);
        continue;
      }

      if (/^[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^[-*+]\s+/, ''))}</li>`); i++; }
        out.push(`<ul class="wa-md-list">${items.join('')}</ul>`);
        continue;
      }

      if (/^\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`); i++; }
        out.push(`<ol class="wa-md-list">${items.join('')}</ol>`);
        continue;
      }

      const buf = [];
      while (i < lines.length && lines[i].trim() && !isSpecial(lines[i])) { buf.push(inline(lines[i])); i++; }
      out.push(`<p class="wa-md-p">${buf.join('<br>')}</p>`);
    }

    return out.join('');
  }

  // The note-body markup, shared by the card template and the edit re-render so
  // the wrapper/class can't drift between them.
  function noteBodyHtml(annotation) {
    return `<div class="wa-note-body">${renderMarkdown(annotation.noteText)}</div>`;
  }

  // The same body as a DOM element (for swapping back in after an edit).
  function renderNoteBodyEl(annotation) {
    const wrap = document.createElement('div');
    wrap.innerHTML = noteBodyHtml(annotation);
    return wrap.firstElementChild;
  }

  // ── Cost formatting ──────────────────────────────────────────────────────────

  // Keep in sync with fmtUsd in popup.js (no shared module across contexts).
  function fmtUsd(usd) {
    if (!usd) return '$0';
    // Sub-cent costs need more precision to be meaningful.
    return usd < 0.01 ? '$' + usd.toFixed(4) : '$' + usd.toFixed(2);
  }

  function fmtTokens(n) {
    return (n || 0).toLocaleString();
  }

  function costHtml(cost) {
    if (!cost || !cost.totalTokens) return '';
    const detail = `${fmtTokens(cost.promptTokens)} in + ${fmtTokens(cost.outputTokens)} out`
      + (cost.calls > 1 ? ` · ${cost.calls} model calls` : '')
      + (cost.searchRequests ? ` · ${cost.searchRequests} search${cost.searchRequests > 1 ? 'es' : ''}` : '');
    return `<div class="wa-cost" title="${esc(detail)}">`
      + `<span class="wa-cost-tokens">${fmtTokens(cost.totalTokens)} tokens</span>`
      + `<span class="wa-cost-sep">·</span>`
      + `<span class="wa-cost-usd">${fmtUsd(cost.usd)}</span></div>`;
  }

  function computePageCost() {
    let usd = 0, tokens = 0;
    for (const a of annotations.values()) {
      if (a.cost) { usd += a.cost.usd || 0; tokens += a.cost.totalTokens || 0; }
    }
    return { usd, tokens };
  }

  function updatePageCost() {
    const el = document.getElementById('wa-cost-total');
    if (!el) return;
    const { usd, tokens } = computePageCost();
    el.textContent = tokens > 0 ? `${fmtTokens(tokens)} tokens · ${fmtUsd(usd)}` : '';
  }

  function sourcesHtml(sources) {
    if (!sources?.length) return '';
    const links = sources.map(s => {
      const label = s.title || new URL(s.uri).hostname;
      return `<a class="wa-source-link" href="${esc(s.uri)}" target="_blank" rel="noopener" title="${esc(s.uri)}">${esc(label)}</a>`;
    }).join('');
    return `<div class="wa-sources">${links}</div>`;
  }

  const STANCE_ORDER = ['supporting', 'contradicting', 'contextualizing'];
  const STANCE_LABELS = {
    supporting: 'Supporting',
    contradicting: 'Contradicting',
    contextualizing: 'Context'
  };
  const SOURCE_TYPE_LABELS = {
    peer_reviewed: 'Peer-reviewed',
    government: 'Government',
    established_outlet: 'Established outlet',
    blog: 'Blog',
    other: 'Other'
  };

  function citationsHtml(citations) {
    if (!citations?.length) return '<p class="wa-empty-stance">No citations.</p>';

    const grouped = { supporting: [], contradicting: [], contextualizing: [] };
    for (const c of citations) {
      if (grouped[c.stance]) grouped[c.stance].push(c);
    }

    return STANCE_ORDER.map(stance => {
      const items = grouped[stance];
      if (!items.length) return '';
      const rows = items.map(c => {
        const hostname = (() => { try { return new URL(c.uri).hostname; } catch { return ''; } })();
        const title = c.title || hostname || 'Untitled';
        const badgeLabel = SOURCE_TYPE_LABELS[c.sourceType] || 'Other';
        return `
          <div class="wa-cite-row">
            <a class="wa-cite-link" href="${esc(c.uri)}" target="_blank" rel="noopener" title="${esc(c.uri)}">${esc(title)}</a>
            <span class="wa-source-badge wa-badge-${esc(c.sourceType || 'other')}">${esc(badgeLabel)}</span>
            <p class="wa-cite-rationale">${esc(c.rationale || '')}</p>
          </div>
        `;
      }).join('');
      return `
        <div class="wa-cite-group wa-stance-${esc(stance)}">
          <div class="wa-stance-label">${esc(STANCE_LABELS[stance])} <span class="wa-stance-count">${items.length}</span></div>
          ${rows}
        </div>
      `;
    }).join('');
  }

  function citeCountSummary(citations) {
    const counts = { supporting: 0, contradicting: 0, contextualizing: 0 };
    for (const c of citations || []) {
      if (counts[c.stance] !== undefined) counts[c.stance]++;
    }
    const parts = [];
    if (counts.supporting) parts.push(`${counts.supporting} supporting`);
    if (counts.contradicting) parts.push(`${counts.contradicting} contradicting`);
    if (counts.contextualizing) parts.push(`${counts.contextualizing} context`);
    return parts.join(' · ') || 'No citations';
  }

  function addAnnotationCard(annotation, { orphaned = false, loading = false } = {}) {
    const list = document.getElementById('wa-annotations-list');
    if (!list) return null;

    const isNote = annotation.type === 'note';
    const isCite = annotation.type === 'cite';
    const card = document.createElement('div');
    card.className = 'wa-card'
      + (isNote ? ' wa-note-card' : '')
      + (isCite ? ' wa-card-cite' : '')
      + (orphaned ? ' wa-orphaned' : '')
      + (loading ? ' wa-loading' : '');
    card.dataset.annotationId = annotation.id;

    const quote = annotation.selectedText.length > 120
      ? annotation.selectedText.slice(0, 120) + '…'
      : annotation.selectedText;

    if (isNote) {
      // Keep the action buttons in the note's header row (next to the "Personal
      // note" label) rather than absolutely positioned over the quoted highlight.
      card.innerHTML = `
        <blockquote class="wa-quote wa-quote-note">${esc(quote)}</blockquote>
        <div class="wa-note-header">
          <span class="wa-note-indicator">✏ Personal note</span>
          <div class="wa-note-actions">
            <button class="wa-edit-btn" title="Edit note">✎</button>
            <button class="wa-delete-btn" title="Delete note">✕</button>
          </div>
        </div>
        ${noteBodyHtml(annotation)}
        ${orphaned ? '<p class="wa-orphan-note">⚠ Text not found on this page</p>' : ''}
      `;
    } else {
      const loadingText = isCite ? 'Searching and classifying sources…' : 'Analyzing with Gemini…';
      const verdictHtml = isCite && annotation.verdict
        ? `<p class="wa-verdict">${esc(annotation.verdict)}</p>`
        : '';
      const bodyHtml = loading
        ? `<p class="wa-explanation"><span class="wa-spinner"></span><span class="wa-loading-text">${loadingText}</span></p>`
        : (isCite
            ? `${verdictHtml}<div class="wa-citations">${citationsHtml(annotation.citations)}</div>`
            : `<p class="wa-explanation">${esc(annotation.explanation)}</p>${sourcesHtml(annotation.sources)}`);

      card.innerHTML = `
        <blockquote class="wa-quote">${esc(quote)}</blockquote>
        ${annotation.customPrompt ? `<p class="wa-custom-tag">✎ ${esc(annotation.customPrompt)}</p>` : ''}
        ${bodyHtml}
        ${!loading ? costHtml(annotation.cost) : ''}
        ${orphaned ? '<p class="wa-orphan-note">⚠ Text not found on this page</p>' : ''}
        ${!loading ? '<button class="wa-delete-btn" title="Delete annotation">✕</button>' : ''}
      `;
    }

    if (!loading) {
      card.querySelector('.wa-delete-btn').addEventListener('click', e => {
        e.stopPropagation();
        deleteAnnotation(annotation.id);
      });
      card.querySelector('.wa-edit-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        startNoteEdit(annotation.id);
      });
      // Don't intercept clicks on citation links — let them open normally.
      card.addEventListener('click', e => {
        if (e.target.closest('a')) return;
        scrollToHighlight(annotation.id);
      });
    }

    list.prepend(card);
    return card;
  }

  function finalizeCard(card, annotation) {
    if (!card) return;
    card.classList.remove('wa-loading');
    card.dataset.annotationId = annotation.id;

    const isCite = annotation.type === 'cite';
    if (isCite) card.classList.add('wa-card-cite');

    if (isCite) {
      // Replace the loading <p class="wa-explanation"> with verdict + citations.
      const loadingEl = card.querySelector('.wa-explanation');
      const frag = document.createDocumentFragment();
      if (annotation.verdict) {
        const verdictEl = document.createElement('p');
        verdictEl.className = 'wa-verdict';
        verdictEl.textContent = annotation.verdict;
        frag.appendChild(verdictEl);
      }
      const citationsWrap = document.createElement('div');
      citationsWrap.className = 'wa-citations';
      citationsWrap.innerHTML = citationsHtml(annotation.citations);
      frag.appendChild(citationsWrap);
      if (loadingEl) {
        loadingEl.replaceWith(frag);
      } else {
        card.appendChild(frag);
      }
    } else {
      const explanationEl = card.querySelector('.wa-explanation');
      if (explanationEl) explanationEl.textContent = annotation.explanation;

      if (annotation.customPrompt) {
        const tag = card.querySelector('.wa-custom-tag');
        if (!tag) {
          const t = document.createElement('p');
          t.className = 'wa-custom-tag';
          t.textContent = '✎ ' + annotation.customPrompt;
          card.querySelector('.wa-quote')?.insertAdjacentElement('afterend', t);
        }
      }

      const srcs = sourcesHtml(annotation.sources);
      if (srcs) {
        const srcEl = document.createElement('div');
        srcEl.innerHTML = srcs;
        explanationEl?.insertAdjacentElement('afterend', srcEl.firstElementChild);
      }
    }

    const costMarkup = costHtml(annotation.cost);
    if (costMarkup) {
      const wrap = document.createElement('div');
      wrap.innerHTML = costMarkup;
      card.appendChild(wrap.firstElementChild);
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

    card.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      scrollToHighlight(annotation.id);
    });
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
    if (!extensionEnabled || !tooltipEnabled) return;
    const annotation = annotations.get(mark.dataset.annotationId);
    if (!annotation) return;

    const tooltipText = annotation.type === 'note'
      ? annotation.noteText
      : annotation.type === 'cite'
        ? citeCountSummary(annotation.citations)
        : annotation.explanation;
    if (!tooltipText) return;

    const tooltip = document.getElementById('wa-tooltip');
    if (!tooltip) return;

    tooltip.textContent = tooltipText;

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
    if (!resolvedActions().length) return; // nothing to show
    const btn = document.getElementById('wa-annotate-btn');
    if (!btn) return;
    // Reset the wheel to the first action and re-sync the visible pill/dots; the
    // widget is reused across selections, so a stale render would otherwise show
    // one action while clicking it runs another.
    carouselIndex = 0;
    updateCarousel();
    btn.style.display = 'flex';
    const bw = btn.offsetWidth || WIDGET_MAX_WIDTH;
    btn.style.left = Math.min(x, window.innerWidth - bw - 8) + 'px';
    btn.style.top = Math.max(8, y - btn.offsetHeight - 8) + 'px';
  }

  function hideAnnotateBtn() {
    const btn = document.getElementById('wa-annotate-btn');
    if (btn) btn.style.display = 'none';
    hideNoteInput(false);
  }

  function showNoteInput() {
    const btn = document.getElementById('wa-annotate-btn');
    const input = document.getElementById('wa-note-input');
    if (!btn || !input) return;
    input.style.left = btn.style.left;
    input.style.top = btn.style.top;
    btn.style.display = 'none';
    input.style.display = 'flex';
    const textEl = document.getElementById('wa-note-text');
    if (textEl) { textEl.value = ''; textEl.focus(); }
  }

  function hideNoteInput(restoreBtn = true) {
    const input = document.getElementById('wa-note-input');
    if (input) input.style.display = 'none';
    if (restoreBtn) {
      const btn = document.getElementById('wa-annotate-btn');
      if (btn && pendingRange) btn.style.display = 'flex';
    }
  }

  function submitNote() {
    const textEl = document.getElementById('wa-note-text');
    const noteText = textEl?.value.trim();
    if (!noteText) { textEl?.focus(); return; }
    hideNoteInput(false);
    saveNoteAnnotation(noteText);
  }

  // ── Event listeners ────────────────────────────────────────────────────────

  // True if the event target lies within one of our own floating UI elements
  // (the action widget or the note input) — used to ignore page mouse events
  // that land on our own chrome.
  function isInsideOwnUI(target) {
    return ['wa-annotate-btn', 'wa-note-input']
      .some(id => document.getElementById(id)?.contains(target));
  }

  document.addEventListener('mouseup', e => {
    if (!extensionEnabled) return;

    // Ignore mouseups on our own widget/inputs: they aren't new selections, and
    // re-running showAnnotateBtn here would reposition the widget out from under
    // the cursor and swallow the click. (mousedown guards the same way.)
    if (isInsideOwnUI(e.target)) return;

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
    if (!isInsideOwnUI(e.target)) {
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

  async function annotate(customPrompt = null) {
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
    const loadingCard = addAnnotationCard({ id: tempId, selectedText, explanation: '', customPrompt }, { loading: true });
    updateEmptyMsg();

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'EXPLAIN',
        payload: {
          selectedText,
          pageTitle: document.title,
          surroundingContext: anchor.prefix + selectedText + anchor.suffix,
          customPrompt
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
      type: 'explain',
      explanation: response.explanation,
      sources: response.sources || [],
      cost: response.cost,
      selectedText,
      customPrompt
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

  async function annotateCite() {
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
    const loadingCard = addAnnotationCard(
      { id: tempId, selectedText, type: 'cite', citations: [] },
      { loading: true }
    );
    updateEmptyMsg();

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'CITE',
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
      type: 'cite',
      claim: response.claim,
      citations: response.citations,
      cost: response.cost,
      selectedText,
      ...(response.verdict ? { verdict: response.verdict } : {})
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

  function saveNoteAnnotation(noteText) {
    if (!pendingRange) return;

    const range = pendingRange.cloneRange();
    const selectedText = range.toString().trim();
    if (!selectedText) return;

    hideAnnotateBtn();
    pendingRange = null;

    const anchor = computeAnchor(range);
    if (!anchor) return;

    openSidebar();
    const id = crypto.randomUUID();
    const annotation = {
      id,
      type: 'note',
      createdAt: Date.now(),
      anchor,
      selectedText,
      noteText
    };

    highlightRangeSafe(range, id, 'note');
    addAnnotationCard(annotation);
    annotations.set(id, annotation);
    updateTabCount();
    updateEmptyMsg();

    chrome.runtime.sendMessage({
      type: 'SAVE_ANNOTATION',
      payload: { url: window.location.href, annotation }
    }).catch(() => {});
  }

  // ── Note editing ─────────────────────────────────────────────────────────────

  // Swap a note card's rendered body for an inline textarea editor.
  function startNoteEdit(id) {
    const card = document.querySelector(`.wa-card[data-annotation-id="${id}"]`);
    const annotation = annotations.get(id);
    if (!card || annotation?.type !== 'note') return;
    const body = card.querySelector('.wa-note-body');
    if (!body || card.querySelector('.wa-note-edit')) return; // already editing

    card.classList.add('wa-editing');

    const editor = document.createElement('div');
    editor.className = 'wa-note-edit';
    editor.addEventListener('click', e => e.stopPropagation()); // don't trigger scroll-to-highlight

    const ta = document.createElement('textarea');
    ta.className = 'wa-note-textarea';
    ta.value = annotation.noteText;
    ta.rows = Math.min(12, Math.max(3, annotation.noteText.split('\n').length + 1));
    ta.spellcheck = false;

    const actions = document.createElement('div');
    actions.className = 'wa-note-edit-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'wa-note-save';
    saveBtn.textContent = 'Save';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'wa-note-cancel';
    cancelBtn.textContent = 'Cancel';
    actions.append(saveBtn, cancelBtn);

    editor.append(ta, actions);
    body.replaceWith(editor);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    saveBtn.addEventListener('click', e => { e.stopPropagation(); commitNoteEdit(id, ta.value); });
    cancelBtn.addEventListener('click', e => { e.stopPropagation(); finishNoteEdit(id); }); // discard edits
    ta.addEventListener('keydown', e => {
      e.stopPropagation(); // keep page/global keys from firing while typing
      if (e.key === 'Escape') { e.preventDefault(); finishNoteEdit(id); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitNoteEdit(id, ta.value); }
    });
  }

  // Replace the editor with a freshly rendered note body and exit edit mode.
  // Re-reads from the map, so it doubles as "discard edits" (Cancel/Esc).
  function finishNoteEdit(id) {
    const card = document.querySelector(`.wa-card[data-annotation-id="${id}"]`);
    const annotation = annotations.get(id);
    if (!card || !annotation) return;
    card.querySelector('.wa-note-edit')?.replaceWith(renderNoteBodyEl(annotation));
    card.classList.remove('wa-editing');
  }

  function commitNoteEdit(id, rawText) {
    const annotation = annotations.get(id);
    if (!annotation) return;
    const newText = rawText.trim();
    if (!newText || newText === annotation.noteText) { finishNoteEdit(id); return; }

    annotation.noteText = newText;
    finishNoteEdit(id);

    chrome.runtime.sendMessage({
      type: 'UPDATE_ANNOTATION',
      payload: { url: window.location.href, id, changes: { noteText: newText } }
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
        highlightRangeSafe(range, annotation.id, annotation.type);
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
      const { usd, tokens } = computePageCost();
      sendResponse({ count: annotations.size, totalCost: usd, totalTokens: tokens });
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

  chrome.storage.sync.get(['extensionEnabled', 'sidebarEnabled', 'tooltipEnabled', 'actionConfig', 'customPrompts'], result => {
    applySettings({
      extensionEnabled: result.extensionEnabled ?? true,
      sidebarEnabled: result.sidebarEnabled ?? true,
      tooltipEnabled: result.tooltipEnabled ?? true,
      actionConfig: normalizeActionConfig(result.actionConfig),
      customPrompts: normalizeCustomPrompts(result.customPrompts)
    });
  });

  restoreAnnotations();
})();
