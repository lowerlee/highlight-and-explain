'use strict';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'EXPLAIN':
      handleExplain(message.payload).then(sendResponse);
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

async function handleExplain({ selectedText, pageTitle, surroundingContext }) {
  const { geminiApiKey } = await chrome.storage.sync.get('geminiApiKey');
  if (!geminiApiKey) {
    return { error: 'No API key configured. Click the extension icon to add your Gemini API key.' };
  }

  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: `You are a knowledgeable assistant helping users understand text they've highlighted on a webpage. Provide clear, concise explanations (2-4 sentences). Focus on what the text means, key concepts, and why it matters. The user is reading: "${pageTitle}". Write in plain prose — no markdown, no bullet points, no bold or italic markers.`
          }]
        },
        contents: [{
          role: 'user',
          parts: [{
            text: `Please explain this highlighted text:\n\n"${selectedText}"\n\nSurrounding context: ...${surroundingContext}...`
          }]
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
