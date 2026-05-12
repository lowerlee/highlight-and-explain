'use strict';

const GEMINI_MODEL_FLASH = 'gemini-2.5-flash';
const GEMINI_MODEL_PRO = 'gemini-2.5-pro';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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
    case 'DELETE_ANNOTATION':
      deleteAnnotation(message.payload).then(sendResponse);
      return true;
    case 'CLEAR_PAGE_ANNOTATIONS':
      clearPageAnnotations(message.payload.url).then(sendResponse);
      return true;
  }
});

async function handleExplain({ selectedText, pageTitle, surroundingContext, customPrompt }) {
  const { geminiApiKey } = await chrome.storage.sync.get('geminiApiKey');
  if (!geminiApiKey) {
    return { error: 'No API key configured. Click the extension icon to add your Gemini API key.' };
  }

  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL_FLASH}:generateContent?key=${geminiApiKey}`;

  const userMessage = customPrompt
    ? `This is the text I highlighted on a webpage:\n\n"${selectedText}"\n\nMy question: ${customPrompt}`
    : `Please explain this highlighted text:\n\n"${selectedText}"\n\nSurrounding context: ...${surroundingContext}...`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: `You are a knowledgeable assistant helping users understand text they've highlighted on a webpage. ${customPrompt ? 'Answer the user\'s specific question about the text.' : 'Provide clear, concise explanations (2-4 sentences). Focus on what the text means, key concepts, and why it matters.'} The user is reading: "${pageTitle}". Write in plain prose — no markdown, no bullet points, no bold or italic markers.`
          }]
        },
        contents: [{
          role: 'user',
          parts: [{ text: userMessage }]
        }],
        generationConfig: { maxOutputTokens: 512 },
        tools: [{ google_search: {} }]
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { error: err.error?.message || `API error ${res.status}` };
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;
    if (!text) return { error: 'Empty response from Gemini.' };

    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    const sources = chunks
      .map(c => ({ uri: c.web?.uri, title: c.web?.title }))
      .filter(s => s.uri);

    return { explanation: text, sources };
  } catch (e) {
    return { error: `Network error: ${e.message}` };
  }
}

// Call 0 of the cite pipeline. Returns a short prose note flagging ambiguous
// terms, hidden assumptions, and definitional choices that would change the
// claim's verdict — fed into retrieval and classification so they target the
// right framings. Internal only; not rendered. Returns null on failure so the
// pipeline can proceed with no decomposition rather than failing the cite.
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
      return null;
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text?.trim() || null;
  } catch (e) {
    console.warn('[CITE] decomposition network error', e);
    return null;
  }
}

// Call 3 of the cite pipeline. Produces a 2–3 sentence verdict paragraph that
// commits to a position (true / partially true / false / unverifiable) and
// explains the definitional choice driving it, when relevant. Returns null on
// failure — the card renders without a verdict rather than erroring.
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
      return null;
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text?.trim() || null;
  } catch (e) {
    console.warn('[CITE] synthesis network error', e);
    return null;
  }
}

async function handleCite({ selectedText, pageTitle, surroundingContext }) {
  const { geminiApiKey } = await chrome.storage.sync.get('geminiApiKey');
  if (!geminiApiKey) {
    return { error: 'No API key configured. Click the extension icon to add your Gemini API key.' };
  }

  console.group('[CITE] claim:', selectedText);
  console.log('[CITE] page title:', pageTitle);

  // ── Call 0: claim decomposition ────────────────────────────────────────────

  const decomposition = await decomposeClaim({ selectedText, pageTitle, surroundingContext, geminiApiKey });
  console.log('[CITE] Call 0 decomposition:\n', decomposition || '(none)');

  // ── Call 1: grounded retrieval ─────────────────────────────────────────────

  const retrievalUrl = `${GEMINI_API_BASE}/${GEMINI_MODEL_FLASH}:generateContent?key=${geminiApiKey}`;
  const retrievalSystem = `You are a research assistant. The user has highlighted a claim on a webpage and wants evidence that addresses it. Search the web and return a concise list of sources that directly support, contradict, or contextualize the claim. The user is reading: "${pageTitle}". Aim for source diversity (different outlets, not multiple pages from the same site). For each source, write a 1–2 sentence excerpt describing what that source actually says about the claim. Return prose — a numbered list is fine. Do not editorialize.`;
  const retrievalUser = `Claim:\n"${selectedText}"\n\nSurrounding context from the page: ...${surroundingContext}...\n\n${decomposition ? `Definitional notes about the claim (use these to target your search angles, especially toward authoritative primary sources that resolve the ambiguities):\n${decomposition}\n\n` : ''}Find 4–8 sources that address this claim. If the claim depends on a definitional choice, include sources that take each side of that choice.`;

  let retrievalText, groundingChunks;
  try {
    const res = await fetch(retrievalUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: retrievalSystem }] },
        contents: [{ role: 'user', parts: [{ text: retrievalUser }] }],
        generationConfig: { maxOutputTokens: 1024 },
        tools: [{ google_search: {} }]
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[CITE] retrieval HTTP error', res.status, err);
      console.groupEnd();
      return { error: err.error?.message || `Retrieval error ${res.status}` };
    }
    const data = await res.json();
    const candidate = data.candidates?.[0];
    retrievalText = candidate?.content?.parts?.[0]?.text;
    groundingChunks = candidate?.groundingMetadata?.groundingChunks || [];
    if (!retrievalText) {
      console.warn('[CITE] retrieval returned empty text');
      console.groupEnd();
      return { error: 'No sources returned from retrieval step.' };
    }
  } catch (e) {
    console.error('[CITE] retrieval network error', e);
    console.groupEnd();
    return { error: `Network error during retrieval: ${e.message}` };
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

  console.log('[CITE] Call 1 prose:\n', retrievalText);
  console.log('[CITE] Call 1 grounding chunks:', groundingChunks.length, 'resolved:', groundingSources.length, groundingSources);

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
      console.groupEnd();
      return { error: err.error?.message || `Classification error ${res.status}` };
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const finishReason = data.candidates?.[0]?.finishReason;
    console.log('[CITE] Call 2 finishReason:', finishReason);
    console.log('[CITE] Call 2 raw text:\n', text);

    if (!text) {
      console.warn('[CITE] Call 2 returned empty text. Full response:', data);
      console.groupEnd();
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
        console.groupEnd();
        return { error: 'Could not parse classification response as JSON.' };
      }
    }

    console.log('[CITE] Call 2 parsed:', parsed);

    if (!Array.isArray(parsed.citations) || parsed.citations.length === 0) {
      console.warn('[CITE] Call 2 parsed citations array is empty');
      console.groupEnd();
      return { error: 'No citations found for this claim.' };
    }

    // ── Call 3: synthesis (verdict paragraph) ────────────────────────────────

    const verdict = await synthesizeVerdict({
      selectedText,
      decomposition,
      citations: parsed.citations,
      geminiApiKey
    });
    console.log('[CITE] Call 3 verdict:\n', verdict || '(none)');

    console.log('[CITE] returning', parsed.citations.length, 'citations');
    console.groupEnd();
    return {
      claim: parsed.claim || selectedText,
      citations: parsed.citations,
      ...(verdict ? { verdict } : {})
    };
  } catch (e) {
    console.error('[CITE] classification network error', e);
    console.groupEnd();
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
