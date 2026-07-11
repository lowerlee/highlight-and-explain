# highlight-and-explain

*Working title.*

A Chrome extension that turns any webpage into an annotatable reader. Highlight a phrase to **explain** what it means, or **cite** it — surfacing evidence that supports and contradicts the claim, drawn from the web and academic sources.

Not a fact-checker site. Not a chatbot you query after the fact. Explanations and evidence live in the margins of the page itself, so understanding and verification happen in the same motion as reading.

---

## Why

Two things slow down honest reading: words you don't know, and claims you can't check. Both have the same fix in principle — look it up — and the same friction in practice: switch tabs, frame the query, skim results, judge sources, come back. Multiply by every paragraph and nobody does it.

Existing tools split the work in ways that don't match how people read:

- **Dictionaries and AI chatbots** can define a term or answer "is this claim true?" — but only if you remember to ask, copy the text out, and trust the answer without sources.
- **Fact-checker sites** verify a small set of high-profile claims after the fact. They don't help you with the article in front of you.
- **Read-it-later tools** archive pages but don't engage with their content.

highlight-and-explain compresses both operations — *understand this* and *verify this* — into the reading experience. Highlight any span on any page; pick what you want; the result anchors back to the text and stays there next time you visit.

The goal isn't to tell you what to believe. It's to make the cost of looking things up low enough that you actually do.

## What it does

Two actions, one gesture.

**✦ Explain** *(shipped)* — A short prose explanation of the highlighted text in the context of the page. Powered by Gemini with Google Search grounding, so explanations come with source links. There's also a **✎ Custom** mode for asking your own question about the selection.

**⚖ Cite** *(planned)* — Treats the highlighted text as a claim and retrieves evidence:

- **Live web search** for current data, official figures, and reporting from other outlets.
- **Academic / scientific databases** (PubMed, bioRxiv, etc.) for medical, scientific, and empirical claims.

Each piece of evidence is classified as **supporting**, **contradicting**, or **contextualizing** the claim, and ranked by source credibility. The reader sees both sides; the extension's job is to present, not adjudicate.

Both actions produce annotations that:

- Highlight the original span on the page.
- Open in a sidebar card with the result, sources, and a delete control.
- Persist per-URL across reloads via `chrome.storage`, with prefix/suffix anchoring so highlights survive minor page changes.
- Show a tooltip on hover.

## How it works

```
   ┌──────────────┐     ┌──────────────────┐     ┌────────────────────┐     ┌──────────────┐
   │  User        │ ──▶ │   Choose mode    │ ──▶ │  Retrieval /       │ ──▶ │   Sidebar    │
   │  highlight   │     │ Explain │ Cite   │     │  generation        │     │  + inline    │
   └──────────────┘     └──────────────────┘     └─────────┬──────────┘     │  highlight   │
                                                           │                └──────────────┘
                                              ┌────────────┴─────────────┐
                                              │ Explain → prose + links  │
                                              │ Cite → for / against /   │
                                              │ ranked by credibility    │
                                              └──────────────────────────┘
```

**1. Selection & anchoring.** The content script captures the selection range, computes a `{prefix, exact, suffix, textPosition}` anchor against the page's text nodes, and shows a floating action button. The anchor survives DOM reflow and is what makes annotations restore correctly on revisit.

**2a. Explain.** The selection plus surrounding context is sent to Gemini via the background service worker. The system prompt asks for 2–4 sentences of plain prose; Google Search grounding returns citation chunks that become source links on the card.

**2b. Cite.** *(planned)* The selection is treated as a checkable claim. The pipeline:

- runs a retrieval pass over web + academic indexes,
- classifies each result as supporting / contradicting / contextualizing,
- filters and deduplicates,
- returns a structured card grouped by stance, with each source labeled by type (peer-reviewed, government data, established outlet, blog, etc.).

**3. Persistence.** Annotations are keyed by normalized URL in `chrome.storage.local`. On page load, the content script re-anchors each saved annotation; if the text moved, it falls back from exact-position → context window → exact-string search. Annotations that can't be relocated are shown in the sidebar as orphaned rather than dropped.

## Status

The **Explain** path is shipped and working: floating Explain/Custom button on selection, sidebar with cards, hover tooltip, per-URL persistence, settings toggles in the popup.

The **Cite** path is the design target — not built yet. The first milestone is wiring a single retrieval backend (web search + one academic source) behind a second action on the same selection button, and rendering a stance-grouped card in the existing sidebar.

This README replaces the planned standalone *article-explorer* project: the same verification idea, delivered through the highlight-and-explain extension instead of a separate reader app. Highlighting in-place beats running a pipeline over a curated `articles/` folder — the user picks what to check, and it works on anything they're already reading.

## Repo layout

```
manifest.json      MV3 manifest, host_permissions: <all_urls>, pinned extension ID
background.js      Service worker: API calls, storage CRUD
sync.js            Google Drive cross-device sync (pull/merge/push engine)
content.js         Injected UI: selection capture, anchoring, sidebar, highlights
content.css        Styles for the injected UI
popup.html/.js/.css  Toolbar popup: API key, toggles, sync, per-page controls
icons/             Extension icons
extension-key.pem  Private signing key (gitignored; public half lives in manifest.json)
```

## Setup

1. `chrome://extensions` → Developer mode → Load unpacked → select this folder.
2. Click the extension icon and paste a Gemini API key. (The Cite path will need additional credentials once built — search API, academic index access.)
3. Highlight text on any page.

## Cross-device sync

Annotations can sync between computers through a private app folder in your own
Google Drive (`appDataFolder` — invisible in the normal Drive UI, readable only
by this extension). Settings and API keys already roam via `chrome.storage.sync`;
this covers the annotations themselves.

How it works: `sync.js` mirrors the whole annotation store to a single
`annotations.json` in the app folder. Every sync is pull → merge → push:
annotations merge per-id (newest `updatedAt` wins) and deletions propagate via
tombstones, so a delete on one machine doesn't resurrect from another. Syncs
run on service-worker spin-up, on the first page load after 5 minutes, and
debounced a few seconds after every annotation change.

### One-time OAuth setup

The manifest pins the extension ID to `eohbhbchpmjmnefklgojfkelnmgibelh` (via
the `"key"` field), so every machine that loads this folder gets the same ID —
required for Google OAuth. Setup, once, in [Google Cloud
Console](https://console.cloud.google.com):

1. Create a project (any name).
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: External, fill in the app name
   and your email, and add your own Google account as a **test user**. (Testing
   mode is fine forever for personal use — no verification needed.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   application type **Chrome extension** → Item ID:
   `eohbhbchpmjmnefklgojfkelnmgibelh`.
5. Copy the client ID into `manifest.json` → `oauth2.client_id`, replacing the
   `REPLACE_WITH_OAUTH_CLIENT_ID` placeholder.
6. Reload the extension, open the popup, and click **Connect Google Drive**.

On a second computer: clone this repo (with the client ID in the manifest),
load unpacked, sign into the same Chrome profile — sync connects on its own,
since the consent granted in step 6 applies account-wide.

To undo everything: **Disconnect** in the popup (turns sync off on all
machines and revokes the token), then optionally Drive → Settings → Manage
apps → delete the stored data. Local annotations are never touched.

### Migrating from a copy loaded before the ID was pinned

Chrome keys `chrome.storage` to the extension ID, and adding `"key"` to the
manifest changed that ID — so a copy loaded before the pin holds its
annotations and API keys under the old ID. To carry them over, **before**
reloading the new manifest: open the old extension's service-worker console
(chrome://extensions → "service worker") and dump both stores:

```js
chrome.storage.local.get(null, d => console.log(JSON.stringify(d)));
chrome.storage.sync.get(null, d => console.log(JSON.stringify(d)));
```

Save each JSON blob, reload the extension (it re-registers under the pinned
ID), then in the new service-worker console:

```js
chrome.storage.local.set(JSON.parse(`<local blob>`));
chrome.storage.sync.set(JSON.parse(`<sync blob>`));
```

Skipping this loses nothing on disk — the old data just sits under the retired
ID — but annotations and API keys start empty under the new one.

## Open questions

Decisions still being worked through, in rough order of urgency for the **Cite** path:

- **Retrieval backend** — Gemini's Google Search grounding already provides web results for Explain. Cite likely needs a dedicated search API for finer control over stance classification and source typing; academic retrieval is a separate adapter (PubMed E-utilities, bioRxiv API).
- **Stance classification** — single LLM pass over `(claim, source excerpt)` pairs is the obvious first cut. Whether that's reliable enough, or whether each stance label needs its own short rationale on the card, is the open UX question.
- **Credibility ranking** — how to score sources without baking in a political lean. Likely a mix of source-type heuristics (peer-reviewed, government data, established outlet) and transparency about each evidence card's provenance, rather than a single opaque score.
- **Cost & latency** — Explain is one LLM call. Cite is retrieval + classification across N sources, so it's slower and more expensive per click. Worth caching results per `(url, anchor)` so a re-visit is free.
- **Model / provider** — currently Gemini for Explain. Cite may want a different model (or local) for the classification step; undecided.

## Optimizing Cite

The current Cite pipeline is two passes: a Gemini Flash grounded search that returns prose + grounding URLs, then a second Flash call that reclassifies those into a fixed `supporting / contradicting / contextualizing` schema. It buckets sources by stance but doesn't reason about *why* they disagree — which is where most of the perceived quality gap to a frontier model's output lives. A claim like *"flooding is the costliest natural disaster in the U.S."* is true under FEMA's framing (which bundles storm-surge damage into flooding) and false under NOAA's (which separates tropical cyclones from inland flooding); the current pipeline has nowhere to surface that.

Five directions for closing that gap, ordered from least to most invasive:

**1. Claim-decomposition preflight.** Add a Call 0 that asks the model: *what ambiguous terms or definitional choices in this claim could change whether it's true?* Feed the decomposition into both the retrieval and classification prompts. Cheapest move (~1 extra Flash call) and the biggest qualitative lever — most nuance is downstream of recognizing the claim is definitionally fragile.

**2. Query fan-out for retrieval.** Replace the single grounded search with N parallel grounded calls along deliberately divergent framings (authoritative datasets, contradicting evidence, definitional sources, recent updates). Merge and dedupe grounding chunks before classification. A single retrieval prompt tends to collapse onto whatever framing dominates the open web; fan-out is how you surface heterogeneous primary sources.

**3. Stronger classifier + a synthesis pass.** Swap `gemini-2.5-flash` for `gemini-2.5-pro` on Call 2, or route just that call to Claude. Then add a Call 3 that produces a short verdict-and-caveat paragraph above the stance columns — the one piece of UI a frontier model's output has and the current cite card doesn't.

**4. Fetch primary-source content, not just search snippets.** Currently Call 2 reasons over a Flash summary of search snippets — two layers removed from the source. After Call 1, take the top ~3 highest-authority grounding URLs (`.gov`, `.edu`, peer-reviewed) and pull actual page text into Call 2 via Gemini's URL-context tool or a `fetch()` + readability extract. This is how specific numbers and definitions make it into the output instead of getting flattened by snippet summarization.

**5. Adversarial critique loop.** After classification, run a critique call: *what's missing, what stance is underrepresented, what definitional choice would change the verdict?* If it flags a gap, loop back to retrieval with a targeted follow-up. Cap at one round to bound latency. Most expensive method, most qualitative payoff — this is what produces "the FEMA framing is defensible but understates wind"-style insight.

Rough ROI: **#1 + #3** together get most of the quality jump for the least added complexity. **#2** is the next lever. **#4** and **#5** are worth doing once #1–3 are validated.
