'use strict';

const GEMINI_MODEL_FLASH = 'gemini-2.5-flash';
const GEMINI_MODEL_PRO = 'gemini-2.5-pro';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ── Cost estimation ──────────────────────────────────────────────────────────
// Gemini paid-tier pricing in USD per 1M tokens. See:
// https://ai.google.dev/gemini-api/docs/pricing
// Pro has a higher tier above a 200k-token prompt; our prompts are far smaller,
// so the standard rates apply.
// Supported model providers. Each provider lists its selectable models with
// per-1M-token pricing (USD) for cost estimation, the storage key holding its
// API key, and a `call` adapter (defined below) that takes a normalized
// {system, user, maxTokens} request and returns {text, usage:{prompt,output}}.
// Gemini keeps a bespoke grounded path for Explain/Cite (see handleExplain*),
// so it has no `call` adapter — the others share the plain-text path.
// NOTE: pricing is a best-effort estimate; verify against each provider's
// current pricing page if exact figures matter.
const PROVIDERS = {
  google: {
    label: 'Google Gemini',
    keyName: 'geminiApiKey',
    keyHelp: { text: 'aistudio.google.com', url: 'https://aistudio.google.com/app/apikey' },
    // Text/reasoning models only (the generateContent path) — newest first.
    // Excludes image/TTS/audio/video/embedding/agent variants. Gemini 3.x
    // pricing is an estimate pending official figures.
    models: [
      { id: 'gemini-3.5-flash',       label: 'Gemini 3.5 Flash',         input: 0.30, output: 2.50 },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', input: 2.00, output: 12.00 },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)', input: 0.30, output: 2.50 },
      { id: 'gemini-3.1-flash-lite',  label: 'Gemini 3.1 Flash-Lite',    input: 0.10, output: 0.40 },
      { id: 'gemini-2.5-pro',         label: 'Gemini 2.5 Pro',           input: 1.25, output: 10.00 },
      { id: 'gemini-2.5-flash',       label: 'Gemini 2.5 Flash',         input: 0.30, output: 2.50 },
      { id: 'gemini-2.5-flash-lite',  label: 'Gemini 2.5 Flash-Lite',    input: 0.10, output: 0.40 }
    ]
  },
  anthropic: {
    label: 'Anthropic Claude',
    keyName: 'anthropicApiKey',
    keyHelp: { text: 'console.anthropic.com', url: 'https://console.anthropic.com/settings/keys' },
    models: [
      { id: 'claude-opus-4-8',   label: 'Claude Opus 4.8',   input: 5.00, output: 25.00 },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', input: 3.00, output: 15.00 },
      { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  input: 1.00, output: 5.00 }
    ],
    call: callAnthropic
  },
  openai: {
    label: 'OpenAI',
    keyName: 'openaiApiKey',
    keyHelp: { text: 'platform.openai.com', url: 'https://platform.openai.com/api-keys' },
    models: [
      { id: 'gpt-4o',      label: 'GPT-4o',      input: 2.50, output: 10.00 },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', input: 0.15, output: 0.60 }
    ],
    call: callOpenAI
  }
};

const DEFAULT_PROVIDER = 'google';

// Flat model-id → pricing / label lookups, derived from PROVIDERS. Model ids are
// unique across providers, so a single map per concern suffices.
const MODEL_PRICING = {};
const MODEL_LABELS = {};
for (const p of Object.values(PROVIDERS)) {
  for (const m of p.models) {
    MODEL_PRICING[m.id] = { input: m.input, output: m.output };
    MODEL_LABELS[m.id] = m.label;
  }
}

// Google Search grounding: free up to 1,500 requests/day, then $35 per 1,000.
// We include the paid rate as an upper-bound estimate; under the daily free
// quota the real cost is $0.
const SEARCH_COST_PER_REQUEST = 35 / 1000;

// ── Developer logging ────────────────────────────────────────────────────────
// Gated by the `debugLogging` setting (popup toggle). Cached in a module var and
// kept in sync, so logging calls stay synchronous. Re-initialized from storage
// on each service-worker spin-up.
let DEBUG = false;
chrome.storage.sync.get('debugLogging', ({ debugLogging }) => { DEBUG = !!debugLogging; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.debugLogging) DEBUG = !!changes.debugLogging.newValue;
});

// Verbose request tracing for Explain/Cite, gated by the toggle. Lines go both
// to the service-worker console AND to a capped, persisted buffer the popup can
// export to a file (so logs can be read outside the SW console). dlog lines are
// always emitted inside a dgroup, so they carry no prefix of their own. Error
// diagnostics use console.warn/error directly so they surface even when off.
const DEBUG_BUFFER_MAX = 1000;
let debugBuffer = [];
chrome.storage.local.get('debugBuffer', ({ debugBuffer: b }) => { if (Array.isArray(b)) debugBuffer = b; });

function bufPush(line) {
  debugBuffer.push(line);
  if (debugBuffer.length > DEBUG_BUFFER_MAX) debugBuffer.splice(0, debugBuffer.length - DEBUG_BUFFER_MAX);
}
// Render mixed log args to a single string for the buffer (objects → JSON).
function bufFmt(args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

function dgroup(label) {
  if (!DEBUG) return;
  console.groupCollapsed('[WA-DEBUG] ' + label);
  bufPush(`${new Date().toISOString()}  ▼ ${label}`);
}
function dlog(...args) {
  if (!DEBUG) return;
  console.log(...args);
  bufPush('    ' + bufFmt(args));
}
function dgroupEnd() {
  if (!DEBUG) return;
  console.groupEnd();
  // Persist at the end of each request group so the buffer survives a
  // service-worker restart between the request and an export.
  chrome.storage.local.set({ debugBuffer });
}

// Resolve the active provider/model/key from synced settings, falling back to
// the default provider's first model when unset or invalid.
async function getModelSelection() {
  const { selectedProvider, selectedModel } = await chrome.storage.sync.get(['selectedProvider', 'selectedModel']);
  const provider = PROVIDERS[selectedProvider] ? selectedProvider : DEFAULT_PROVIDER;
  const models = PROVIDERS[provider].models;
  const model = models.some(m => m.id === selectedModel) ? selectedModel : models[0].id;
  const { keyName, label } = PROVIDERS[provider];
  const { [keyName]: apiKey } = await chrome.storage.sync.get(keyName);
  return { provider, model, apiKey, providerLabel: label };
}

// Friendly display label for a model id (e.g. "Gemini 3.5 Flash"), for showing
// on annotation cards. Falls back to the raw id if not in the registry.
function modelLabel(modelId) {
  return MODEL_LABELS[modelId] || modelId;
}

// Provider/model metadata for the popup UI (no secrets, no functions).
function serializeProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    keyName: p.keyName,
    keyHelp: p.keyHelp,
    models: p.models.map(m => ({ id: m.id, label: m.label }))
  }));
}

// Gemini's grounding-support offsets are UTF-8 *byte* offsets into the answer
// text. JS strings are UTF-16, so convert a byte offset to a string (char)
// index by decoding the leading byte slice and measuring its length.
const _textEncoder = new TextEncoder();
const _textDecoder = new TextDecoder();
function byteToCharIndex(text, byteOffset) {
  if (byteOffset <= 0) return 0;
  const bytes = _textEncoder.encode(text);
  if (byteOffset >= bytes.length) return text.length;
  return _textDecoder.decode(bytes.subarray(0, byteOffset)).length;
}

// Pull billable token counts out of a Gemini response. thoughtsTokenCount
// (thinking tokens) is billed at the output rate, so fold it into output.
function usageFrom(data) {
  const u = data?.usageMetadata || {};
  return {
    prompt: u.promptTokenCount || 0,
    output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)
  };
}

function costFor(model, prompt, output) {
  const p = MODEL_PRICING[model];
  if (!p) {
    // Surfaces a renamed/typo'd model id during testing instead of a silent $0.
    console.warn(`[cost] no pricing for model "${model}" — estimating $0`);
    return 0;
  }
  return (prompt / 1e6) * p.input + (output / 1e6) * p.output;
}

function makeCostAcc() {
  return { promptTokens: 0, outputTokens: 0, totalTokens: 0, usd: 0, calls: 0, searchRequests: 0 };
}

// Fold one call's usage into a running cost accumulator. `usage` is the
// normalized {prompt, output} token counts (use usageFrom(data) for Gemini).
function addCall(acc, model, usage, { search = false } = {}) {
  const prompt = usage.prompt || 0;
  const output = usage.output || 0;
  acc.promptTokens += prompt;
  acc.outputTokens += output;
  acc.totalTokens += prompt + output;
  acc.usd += costFor(model, prompt, output);
  acc.calls += 1;
  if (search) {
    acc.searchRequests += 1;
    acc.usd += SEARCH_COST_PER_REQUEST;
  }
}

// ── Provider call adapters (non-Gemini) ──────────────────────────────────────
// Each returns { text, usage:{prompt,output} } on success, or { error } on
// failure. Network errors throw and are caught by the caller.

async function callAnthropic(apiKey, model, { system, user, maxTokens }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for direct calls from a browser/extension origin.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: err.error?.message || `API error ${res.status}` };
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
  const u = data.usage || {};
  return { text, usage: { prompt: u.input_tokens || 0, output: u.output_tokens || 0 } };
}

async function callOpenAI(apiKey, model, { system, user, maxTokens }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: err.error?.message || `API error ${res.status}` };
  }
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  const u = data.usage || {};
  return { text, usage: { prompt: u.prompt_tokens || 0, output: u.completion_tokens || 0 } };
}

function extractJsonObject(text) {
  if (!text) return null;
  let s = text.trim();

  // Strip ```json ... ``` or ``` ... ``` fences
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();

  // Fall back to first '{' through last '}'
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    return s.slice(first, last + 1);
  }
  return null;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

// Gemini's grounding returns short-lived redirect URLs under
// vertexaisearch.cloud.google.com/grounding-api-redirect/... that 404 once they
// expire. Resolve them to their final destination while they're still fresh.
async function resolveGroundingUrl(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    } catch {
      res = null;
    }
    if (!res || res.url === url) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    }
    return res.url && res.url !== url ? res.url : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'EXPLAIN':
      handleExplain(message.payload).then(sendResponse);
      return true;
    case 'CITE':
      handleCite(message.payload).then(sendResponse);
      return true;
    case 'SAVE_ANNOTATION':
      saveAnnotation(message.payload).then(sendResponse);
      return true;
    case 'LOAD_ANNOTATIONS':
      loadAnnotations(message.payload.url).then(sendResponse);
      return true;
    case 'UPDATE_ANNOTATION':
      updateAnnotation(message.payload).then(sendResponse);
      return true;
    case 'DELETE_ANNOTATION':
      deleteAnnotation(message.payload).then(sendResponse);
      return true;
    case 'CLEAR_PAGE_ANNOTATIONS':
      clearPageAnnotations(message.payload.url).then(sendResponse);
      return true;
    case 'GET_PROVIDERS':
      sendResponse({ providers: serializeProviders() });
      return false;
    case 'EXPORT_DEBUG_LOG':
      // Return the text only — the popup does the actual download. A service
      // worker can't build a downloadable URL (no URL.createObjectURL, and the
      // downloads API rejects data: URLs from the SW context).
      sendResponse({
        ok: true,
        lines: debugBuffer.length,
        text: debugBuffer.length
          ? debugBuffer.join('\n')
          : '(no debug log captured — enable Developer logging, then run an Explain or Cite)'
      });
      return false;
    case 'CLEAR_DEBUG_LOG':
      debugBuffer = [];
      chrome.storage.local.set({ debugBuffer }, () => sendResponse({ ok: true }));
      return true;
  }
});

// Route Explain to the selected provider. Gemini keeps its grounded path
// (web-search citations); other providers return plain explanations.
async function handleExplain({ selectedText, pageTitle, surroundingContext, customPrompt }) {
  const { provider, model, apiKey, providerLabel } = await getModelSelection();
  if (!apiKey) {
    return { error: `No API key configured for ${providerLabel}. Click the extension icon to add it.` };
  }
  if (provider === 'google') {
    return handleExplainGemini({ selectedText, pageTitle, surroundingContext, customPrompt, apiKey, model });
  }
  return handleExplainGeneric({ selectedText, pageTitle, surroundingContext, customPrompt, provider, model, apiKey });
}

// Build the system + user prompt for an Explain request. The grounded (Gemini)
// path instructs the model to actually search the web rather than answer from
// memory — the built-in google_search tool fires at the model's discretion, so
// without this newer models often skip it (no grounding metadata → no
// citations). It also tells the model not to emit its own citation markers,
// since sources are rendered separately from grounding metadata.
function explainPrompts({ selectedText, pageTitle, surroundingContext, customPrompt }, { grounded = false } = {}) {
  const system = `You are a knowledgeable assistant helping users understand text they've highlighted on a webpage. ${customPrompt ? 'Answer the user\'s specific question about the text.' : 'Provide clear, concise explanations (2-4 sentences). Focus on what the text means, key concepts, and why it matters.'} The user is reading: "${pageTitle}". Write in plain prose — no markdown, no bullet points, no bold or italic markers.`
    + (grounded ? ' You MUST use the Google Search tool to ground every explanation in current, authoritative web sources. Always search before answering — even when you are confident you already know the answer — and base your explanation only on what the retrieved sources actually say, not on prior knowledge; this is required to minimize hallucination. If the searches return nothing relevant, say so plainly rather than guessing. Do not include inline citation markers, footnotes, or bracketed references such as [cite: ...], [1], or (source); any sources are shown separately.' : '');
  const user = customPrompt
    ? `This is the text I highlighted on a webpage:\n\n"${selectedText}"\n\nMy question: ${customPrompt}`
    : `Please explain this highlighted text:\n\n"${selectedText}"\n\nSurrounding context: ...${surroundingContext}...`;
  return { system, user };
}

// Plain-text Explain for non-Gemini providers (no web grounding / citations).
async function handleExplainGeneric({ selectedText, pageTitle, surroundingContext, customPrompt, provider, model, apiKey }) {
  const { system, user } = explainPrompts({ selectedText, pageTitle, surroundingContext, customPrompt });

  try {
    const result = await PROVIDERS[provider].call(apiKey, model, { system, user, maxTokens: 1024 });
    if (result.error) return { error: result.error };
    if (!result.text) return { error: 'Empty response from the model.' };

    const cost = makeCostAcc();
    addCall(cost, model, result.usage);

    dgroup(`EXPLAIN ${provider}/${model}`);
    dlog('system prompt:', system);
    dlog('user prompt:', user);
    dlog('answer chars:', result.text.length, '| no web search (non-Gemini provider)');
    dlog('usage/cost:', cost);
    dgroupEnd();

    // Non-Gemini providers don't perform web search here, so always ungrounded.
    return { explanation: result.text, sources: [], citationMarks: [], cost, grounded: false, modelName: modelLabel(model) };
  } catch (e) {
    return { error: `Network error: ${e.message}` };
  }
}

// The built-in google_search tool fires at the model's discretion, and the API
// exposes no flag to force it (no functionCallingConfig: ANY for built-in tools,
// no dynamicRetrievalConfig for 2.5/3.x). Thinking models (2.5 Pro, 3.x) are more
// confident and frequently skip the search, answering from memory with no
// grounding metadata. Appended to the system prompt on a retry when that happens.
const FORCE_SEARCH_DIRECTIVE = ' CRITICAL: your previous attempt answered without searching, which is not allowed. You MUST call the Google Search tool and run at least one query BEFORE writing anything, even if you believe you already know the answer. Base the response only on the retrieved results — never on prior knowledge.';

// True when the model actually ran a web search this turn (vs. answering from its
// own knowledge): either it returned usable sources or it issued search queries.
function isGrounded(candidate) {
  const meta = candidate?.groundingMetadata || {};
  const hasSources = (meta.groundingChunks || []).some(c => c.web?.uri);
  return hasSources || (meta.webSearchQueries?.length || 0) > 0;
}

// True when the candidate carries any visible answer text (excludes thought-only
// parts). Used to avoid preferring a grounded-but-truncated retry over a complete
// first answer.
function hasAnswerText(candidate) {
  return (candidate?.content?.parts || []).some(p => p.text && !p.thought);
}

// One grounded generateContent call with the google_search tool enabled.
// Returns { data, candidate } on success or { error } on HTTP/network failure.
async function geminiGenerateGrounded(url, { system, user, maxOutputTokens }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens },
        tools: [{ google_search: {} }]
      })
    });
  } catch (e) {
    return { error: `Network error: ${e.message}` };
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: err.error?.message || `API error ${res.status}` };
  }
  const data = await res.json();
  return { data, candidate: data.candidates?.[0] };
}

// Run a grounded call and, if the model answered from memory (no search), retry
// once with a hardened directive that requires it to search first. `onCall(data,
// grounded)` fires for every successful HTTP response so the caller can bill each
// attempt — `grounded` lets the caller charge the search surcharge only on
// attempts that actually searched. Returns the grounded attempt when one exists,
// else the first answer, or { error } if the first attempt failed outright.
async function geminiGroundedWithRetry(url, { system, user, maxOutputTokens }, onCall) {
  const first = await geminiGenerateGrounded(url, { system, user, maxOutputTokens });
  if (first.error) return first;
  const firstGrounded = isGrounded(first.candidate);
  onCall?.(first.data, firstGrounded);
  if (firstGrounded) return first;

  // Model skipped the search. Retry once, demanding it search before answering.
  dlog('grounding retry: first attempt answered from memory, retrying with force directive');
  const second = await geminiGenerateGrounded(url, {
    system: system + FORCE_SEARCH_DIRECTIVE, user, maxOutputTokens
  });
  if (second.error) return first; // retry failed — keep the first (usable) answer
  onCall?.(second.data, isGrounded(second.candidate));
  // Prefer the retry only when it both grounded and produced visible text; a
  // grounded-but-truncated retry shouldn't displace a complete first answer.
  // Otherwise keep the first, whose prompt wasn't distorted by the directive.
  return isGrounded(second.candidate) && hasAnswerText(second.candidate) ? second : first;
}

async function handleExplainGemini({ selectedText, pageTitle, surroundingContext, customPrompt, apiKey, model }) {
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

  const { system, user: userMessage } = explainPrompts({ selectedText, pageTitle, surroundingContext, customPrompt }, { grounded: true });

  const cost = makeCostAcc();

  try {
    // Force grounding: if a thinking model answers from memory, retry once
    // demanding it search. maxOutputTokens gives ample headroom for internal
    // reasoning (which counts against the budget) plus the short explanation;
    // too low a cap truncates the visible answer mid-sentence.
    const result = await geminiGroundedWithRetry(
      url,
      { system, user: userMessage, maxOutputTokens: 4096 },
      (data, searched) => addCall(cost, model, usageFrom(data), { search: searched })
    );
    if (result.error) return { error: result.error };

    const { data, candidate } = result;
    // Join all answer parts (skip thought parts); thinking models may split the
    // reply or precede it with a thought part, so parts[0] alone can be wrong.
    // Keep it raw (untrimmed) — the grounding offsets below are computed against
    // this exact text, with the leading-whitespace shift handled in-branch.
    const text = (candidate?.content?.parts || [])
      .filter(p => p.text && !p.thought)
      .map(p => p.text)
      .join('');
    if (!text.trim()) return { error: 'Empty response from Gemini.' };

    const meta = candidate?.groundingMetadata || {};
    const chunks = meta.groundingChunks || [];
    const sources = chunks
      .map(c => ({ uri: c.web?.uri, title: c.web?.title }))
      .filter(s => s.uri);
    // Whether the model actually ran a web search this turn (vs. answering from
    // its own knowledge). Surfaced to the user as a grounding badge. Same signal
    // the retry logic uses, so badge and retry decision can't drift.
    const grounded = isGrounded(candidate);

    // Gemini's grounding supports tell us which span of the answer each source
    // backs. Turn them into inline citation marks ({ index, sources:[chunkIdx] })
    // so the sidebar can render scientific-style superscripts instead of a
    // bare source dump. Fall back to clean prose when nothing is grounded.
    const supports = candidate?.groundingMetadata?.groundingSupports || [];
    let explanation, citationMarks;

    if (sources.length && supports.length) {
      explanation = text;
      // Trimming leading whitespace shifts every offset left by that amount;
      // trailing trim only drops indices past the end (clamped below).
      const lead = explanation.length - explanation.trimStart().length;
      explanation = explanation.trim();

      const byIndex = new Map();
      for (const sup of supports) {
        const endByte = sup.segment?.endIndex;
        if (typeof endByte !== 'number') continue;
        const idxs = (sup.groundingChunkIndices || []).filter(i => i >= 0 && i < sources.length);
        if (!idxs.length) continue;
        const index = Math.min(Math.max(0, byteToCharIndex(text, endByte) - lead), explanation.length);
        const merged = byIndex.get(index) || [];
        for (const i of idxs) if (!merged.includes(i)) merged.push(i);
        byIndex.set(index, merged);
      }
      citationMarks = [...byIndex.entries()]
        .map(([index, src]) => ({ index, sources: src.sort((a, b) => a - b) }))
        .sort((a, b) => a.index - b.index);
    } else {
      // No grounded segments — strip any stray citation fragments the model
      // emitted despite the instruction not to (incl. a truncated "[cite…").
      explanation = text
        .replace(/\[cite[^\]]*\]/gi, '')
        .replace(/\[cite[^\]]*$/i, '')
        .replace(/[ \t]+([.,;:])/g, '$1')
        .trim();
      citationMarks = [];
    }

    dgroup(`EXPLAIN ${model}`);
    dlog('system prompt:', system);
    dlog('user prompt:', userMessage);
    dlog('finishReason:', candidate?.finishReason);
    dlog('searched (webSearchQueries):', meta.webSearchQueries || []);
    dlog('groundingChunks (raw):', chunks);
    dlog('usable sources:', sources);
    dlog('groundingSupports:', supports.length, supports);
    dlog('searchEntryPoint present:', !!meta.searchEntryPoint);
    dlog('grounded badge:', grounded, '| answer chars:', text.length);
    dlog('usage/cost:', cost);
    dgroupEnd();

    return { explanation, sources, citationMarks, cost, grounded, modelName: modelLabel(model) };
  } catch (e) {
    return { error: `Network error: ${e.message}` };
  }
}

// Call 0 of the cite pipeline. Returns a short prose note flagging ambiguous
// terms, hidden assumptions, and definitional choices that would change the
// claim's verdict — fed into retrieval and classification so they target the
// right framings. Internal only; not rendered. Returns null on failure so the
// pipeline can proceed with no decomposition rather than failing the cite.
// Returns { text, data } so the caller can bill the call; text is null on failure.
async function decomposeClaim({ selectedText, pageTitle, surroundingContext, geminiApiKey }) {
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL_FLASH}:generateContent?key=${geminiApiKey}`;
  const system = `You analyze claims for definitional fragility. Given a claim, identify: (1) ambiguous terms whose definition would change whether the claim is true, (2) hidden assumptions the claim makes, (3) the main definitional or methodological choices that lead different authoritative sources to different answers. Be concrete and source-aware (name specific agencies, datasets, or conventions when relevant). Keep the whole response under 120 words. Return plain prose — no headings, no markdown.`;
  const user = `Claim:\n"${selectedText}"\n\nPage title: ${pageTitle}\nSurrounding context: ...${surroundingContext}...`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 512 }
      })
    });
    if (!res.ok) {
      console.warn('[CITE] decomposition HTTP error', res.status);
      return { text: null, data: null };
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return { text: text?.trim() || null, data };
  } catch (e) {
    console.warn('[CITE] decomposition network error', e);
    return { text: null, data: null };
  }
}

// Call 3 of the cite pipeline. Produces a 2–3 sentence verdict paragraph that
// commits to a position (true / partially true / false / unverifiable) and
// explains the definitional choice driving it, when relevant. Returns null on
// failure — the card renders without a verdict rather than erroring.
// Returns { text, data } so the caller can bill the call; text is null on failure.
async function synthesizeVerdict({ selectedText, decomposition, citations, geminiApiKey }) {
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL_PRO}:generateContent?key=${geminiApiKey}`;
  const system = `You write a short verdict paragraph about a claim, given evidence already classified as supporting, contradicting, or contextualizing it. Commit to a verdict — "true", "partially true", "false", or "unverifiable" — and explain in one or two further sentences what drives it. When the claim is definitionally fragile, name the definitional choice and which framing makes it true vs false. Cite agencies or datasets by name when they appear in the evidence. 2–3 sentences total, under 80 words. Plain prose, no markdown, no headings, no source list.`;
  const evidence = citations.map((c, i) => `${i + 1}. [${c.stance}] ${c.title || c.uri} — ${c.rationale || c.snippet || ''}`).join('\n');
  const user = `Claim:\n"${selectedText}"\n\n${decomposition ? `Definitional notes:\n${decomposition}\n\n` : ''}Classified evidence:\n${evidence}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 512 }
      })
    });
    if (!res.ok) {
      console.warn('[CITE] synthesis HTTP error', res.status);
      return { text: null, data: null };
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return { text: text?.trim() || null, data };
  } catch (e) {
    console.warn('[CITE] synthesis network error', e);
    return { text: null, data: null };
  }
}

async function handleCite({ selectedText, pageTitle, surroundingContext }) {
  const { geminiApiKey } = await chrome.storage.sync.get('geminiApiKey');
  if (!geminiApiKey) {
    return { error: 'Cite requires a Google Gemini API key (it uses Gemini\'s web-search grounding). Add one in the extension popup.' };
  }

  dgroup('CITE claim: ' + selectedText);
  dlog('page title:', pageTitle);

  const cost = makeCostAcc();

  // ── Call 0: claim decomposition ────────────────────────────────────────────

  const dec = await decomposeClaim({ selectedText, pageTitle, surroundingContext, geminiApiKey });
  const decomposition = dec.text;
  if (dec.data) addCall(cost, GEMINI_MODEL_FLASH, usageFrom(dec.data));
  dlog('Call 0 decomposition:\n', decomposition || '(none)');

  // ── Call 1: grounded retrieval ─────────────────────────────────────────────

  const retrievalUrl = `${GEMINI_API_BASE}/${GEMINI_MODEL_FLASH}:generateContent?key=${geminiApiKey}`;
  const retrievalSystem = `You are a research assistant. The user has highlighted a claim on a webpage and wants evidence that addresses it. Search the web and return a concise list of sources that directly support, contradict, or contextualize the claim. The user is reading: "${pageTitle}". Aim for source diversity (different outlets, not multiple pages from the same site). For each source, write a 1–2 sentence excerpt describing what that source actually says about the claim. Return prose — a numbered list is fine. Do not editorialize.`;
  const retrievalUser = `Claim:\n"${selectedText}"\n\nSurrounding context from the page: ...${surroundingContext}...\n\n${decomposition ? `Definitional notes about the claim (use these to target your search angles, especially toward authoritative primary sources that resolve the ambiguities):\n${decomposition}\n\n` : ''}Find 4–8 sources that address this claim. If the claim depends on a definitional choice, include sources that take each side of that choice.`;

  // Force grounding: retry once if the retrieval model answers without searching.
  const retrieval = await geminiGroundedWithRetry(
    retrievalUrl,
    { system: retrievalSystem, user: retrievalUser, maxOutputTokens: 1024 },
    (data, searched) => addCall(cost, GEMINI_MODEL_FLASH, usageFrom(data), { search: searched })
  );
  if (retrieval.error) {
    console.error('[CITE] retrieval error', retrieval.error);
    dgroupEnd();
    return { error: retrieval.error };
  }
  const retrievalText = retrieval.candidate?.content?.parts?.[0]?.text;
  const groundingChunks = retrieval.candidate?.groundingMetadata?.groundingChunks || [];
  if (!retrievalText) {
    console.warn('[CITE] retrieval returned empty text');
    dgroupEnd();
    return { error: 'No sources returned from retrieval step.' };
  }

  const rawGroundingSources = groundingChunks
    .map(c => ({ uri: c.web?.uri, title: c.web?.title }))
    .filter(s => s.uri);

  const groundingSources = (await Promise.all(
    rawGroundingSources.map(async s => {
      const resolved = await resolveGroundingUrl(s.uri);
      return resolved ? { ...s, uri: resolved } : null;
    })
  )).filter(Boolean);

  dlog('Call 1 prose:\n', retrievalText);
  dlog('Call 1 grounding chunks:', groundingChunks.length, 'resolved:', groundingSources.length, groundingSources);

  // ── Call 2: structured classification ──────────────────────────────────────

  const classifyUrl = `${GEMINI_API_BASE}/${GEMINI_MODEL_PRO}:generateContent?key=${geminiApiKey}`;
  const classifySystem = `You are classifying evidence about a claim. For each source in the retrieval notes, decide whether it supports, contradicts, or contextualizes the claim, and label the source type. Prefer URLs from the grounding list when available — those are authoritative. Drop any source whose stance you cannot justify from the excerpt. Be conservative: "supporting" means the source affirms the claim's factual content; "contradicting" means it disputes it; "contextualizing" means it provides relevant background without taking a side. When the claim is definitionally ambiguous, classify each source against the definition that source is actually using — and reflect that in the rationale. Keep rationales under 20 words.`;
  const classifyUser = `Claim:\n"${selectedText}"\n\n${decomposition ? `Definitional notes:\n${decomposition}\n\n` : ''}Retrieval notes:\n${retrievalText}\n\nGrounding URLs (authoritative):\n${groundingSources.map((s, i) => `${i + 1}. ${s.title || ''} — ${s.uri}`).join('\n') || '(none)'}`;

  const citationSchema = {
    type: 'OBJECT',
    properties: {
      claim: { type: 'STRING' },
      citations: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING' },
            uri: { type: 'STRING' },
            snippet: { type: 'STRING' },
            stance: { type: 'STRING', enum: ['supporting', 'contradicting', 'contextualizing'] },
            sourceType: { type: 'STRING', enum: ['peer_reviewed', 'government', 'established_outlet', 'blog', 'other'] },
            rationale: { type: 'STRING' }
          },
          required: ['title', 'uri', 'snippet', 'stance', 'sourceType', 'rationale']
        }
      }
    },
    required: ['claim', 'citations']
  };

  try {
    const res = await fetch(classifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: classifySystem }] },
        contents: [{ role: 'user', parts: [{ text: classifyUser }] }],
        generationConfig: {
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          responseSchema: citationSchema
        }
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[CITE] classification HTTP error', res.status, err);
      dgroupEnd();
      return { error: err.error?.message || `Classification error ${res.status}` };
    }
    const data = await res.json();
    addCall(cost, GEMINI_MODEL_PRO, usageFrom(data));
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const finishReason = data.candidates?.[0]?.finishReason;
    dlog('Call 2 finishReason:', finishReason);
    dlog('Call 2 raw text:\n', text);

    if (!text) {
      console.warn('[CITE] Call 2 returned empty text. Full response:', data);
      dgroupEnd();
      return { error: 'Empty classification response.' };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const recovered = extractJsonObject(text);
      if (recovered) {
        try {
          parsed = JSON.parse(recovered);
          console.warn('[CITE] Call 2 needed JSON recovery; original was not strictly parseable');
        } catch (e) {
          console.error('[CITE] Call 2 recovery also failed', e, '\nrecovered text:\n', recovered);
        }
      }
      if (!parsed) {
        console.error('[CITE] Call 2 JSON parse failed; raw text was:\n', text);
        dgroupEnd();
        return { error: 'Could not parse classification response as JSON.' };
      }
    }

    dlog('Call 2 parsed:', parsed);

    if (!Array.isArray(parsed.citations) || parsed.citations.length === 0) {
      console.warn('[CITE] Call 2 parsed citations array is empty');
      dgroupEnd();
      return { error: 'No citations found for this claim.' };
    }

    // ── Call 3: synthesis (verdict paragraph) ────────────────────────────────

    const synth = await synthesizeVerdict({
      selectedText,
      decomposition,
      citations: parsed.citations,
      geminiApiKey
    });
    const verdict = synth.text;
    if (synth.data) addCall(cost, GEMINI_MODEL_PRO, usageFrom(synth.data));
    dlog('Call 3 verdict:\n', verdict || '(none)');

    dlog('cost:', cost);
    dlog('returning', parsed.citations.length, 'citations');
    dgroupEnd();
    return {
      claim: parsed.claim || selectedText,
      citations: parsed.citations,
      cost,
      // Cite runs a multi-call Gemini pipeline (Flash for retrieval, Pro for
      // classification/synthesis), regardless of the selected Explain model.
      modelName: `${modelLabel(GEMINI_MODEL_FLASH)} + Pro`,
      ...(verdict ? { verdict } : {})
    };
  } catch (e) {
    console.error('[CITE] classification network error', e);
    dgroupEnd();
    return { error: `Network error during classification: ${e.message}` };
  }
}

async function saveAnnotation({ url, annotation }) {
  const key = normalizeUrl(url);
  const result = await chrome.storage.local.get(key);
  const existing = result[key] || [];
  existing.push(annotation);
  await chrome.storage.local.set({ [key]: existing });
  return { success: true };
}

async function loadAnnotations(url) {
  const key = normalizeUrl(url);
  const result = await chrome.storage.local.get(key);
  return { annotations: result[key] || [] };
}

async function updateAnnotation({ url, id, changes }) {
  const key = normalizeUrl(url);
  const result = await chrome.storage.local.get(key);
  const existing = result[key] || [];
  await chrome.storage.local.set({
    [key]: existing.map(a => (a.id === id ? { ...a, ...changes } : a))
  });
  return { success: true };
}

async function deleteAnnotation({ url, id }) {
  const key = normalizeUrl(url);
  const result = await chrome.storage.local.get(key);
  const existing = result[key] || [];
  await chrome.storage.local.set({ [key]: existing.filter(a => a.id !== id) });
  return { success: true };
}

async function clearPageAnnotations(url) {
  const key = normalizeUrl(url);
  await chrome.storage.local.remove(key);
  return { success: true };
}
