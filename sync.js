'use strict';

// ── Google Drive annotation sync ─────────────────────────────────────────────
// Mirrors the whole annotation store (all page keys in chrome.storage.local) to
// a single JSON file in the Drive appDataFolder — a hidden, per-app area of the
// user's own Google account — so any machine signed into the same Chrome
// profile sees the same annotations. Loaded into background.js via
// importScripts; setup steps live in README → "Cross-device sync".
//
// Sync model: pull → merge → push, all in syncNow().
//  - Annotations merge per-id; the copy with the newest updatedAt wins.
//  - Deletes propagate via tombstones (pageKey → id → deletedAt); without them
//    a delete on machine A would resurrect from machine B's copy. GC'd after
//    TOMBSTONE_TTL_MS.
//  - Triggers: service-worker spin-up, the first LOAD_ANNOTATIONS after
//    PULL_MIN_INTERVAL_MS, and a debounced push after every mutation. A push
//    lost to the SW dying mid-debounce self-heals at the next sync, because
//    every sync pushes local-only changes too.
//
// The on/off flag (driveSyncEnabled) lives in chrome.storage.sync, so it roams
// with the Chrome profile: once consent is granted on one machine, another
// machine gets a token non-interactively and starts syncing on its own.

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SYNC_FILE_NAME = 'annotations.json';
const SYNC_META_KEY = '__syncMeta'; // reserved storage.local key (never a URL)
const NON_PAGE_KEYS = new Set([SYNC_META_KEY, 'debugBuffer']);
const PUSH_DEBOUNCE_MS = 4000;
const PULL_MIN_INTERVAL_MS = 5 * 60 * 1000;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let syncInFlight = null; // promise of the running sync, if any
let syncQueued = false;  // a mutation landed mid-sync; run once more after
let pushTimer = null;
let lastSyncError = null; // in-memory only; cleared by SW restarts, which is fine

function syncConfigured() {
  const id = chrome.runtime.getManifest().oauth2?.client_id || '';
  return !!id && !id.startsWith('REPLACE');
}

async function isSyncEnabled() {
  const { driveSyncEnabled } = await chrome.storage.sync.get('driveSyncEnabled');
  return !!driveSyncEnabled;
}

// interactive:true pops the Google consent window (user-initiated connect
// only); false mints tokens silently from the signed-in Chrome profile.
function getToken(interactive) {
  return new Promise(resolve => {
    try {
      chrome.identity.getAuthToken({ interactive }, token => {
        resolve({ token: token || null, error: chrome.runtime.lastError?.message || null });
      });
    } catch (e) {
      resolve({ token: null, error: e.message });
    }
  });
}

// storage.local mixes page keys (normalized URLs) with internal keys; a page
// key is anything URL-shaped that isn't reserved.
function isPageKey(key) {
  return !NON_PAGE_KEYS.has(key) && key.includes('://');
}

async function readLocalStore() {
  const all = await chrome.storage.local.get(null);
  const pages = {};
  for (const [key, value] of Object.entries(all)) {
    if (isPageKey(key) && Array.isArray(value) && value.length) pages[key] = value;
  }
  return { pages, meta: all[SYNC_META_KEY] || {} };
}

function annTime(a) {
  return a.updatedAt || a.createdAt || 0;
}

// Record deletions so they win over stale copies during merge. Called by the
// storage CRUD in background.js with the already-normalized page key.
async function recordTombstones(pageKey, ids) {
  if (!ids.length) return;
  const { [SYNC_META_KEY]: meta = {} } = await chrome.storage.local.get(SYNC_META_KEY);
  const tombstones = meta.tombstones || {};
  const forPage = { ...(tombstones[pageKey] || {}) };
  const now = Date.now();
  for (const id of ids) forPage[id] = now;
  await chrome.storage.local.set({
    [SYNC_META_KEY]: { ...meta, tombstones: { ...tombstones, [pageKey]: forPage } }
  });
}

// Objects below are built with sorted keys so that identical states serialize
// identically — the "did anything change" checks are JSON string comparisons.
function mergeTombstones(a = {}, b = {}) {
  const out = {};
  const urls = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const url of urls) {
    const ids = [...new Set([...Object.keys(a[url] || {}), ...Object.keys(b[url] || {})])].sort();
    out[url] = {};
    for (const id of ids) out[url][id] = Math.max(a[url]?.[id] || 0, b[url]?.[id] || 0);
  }
  return out;
}

function gcTombstones(tombstones) {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const out = {};
  for (const [url, ids] of Object.entries(tombstones)) {
    const kept = Object.entries(ids).filter(([, t]) => t > cutoff);
    if (kept.length) out[url] = Object.fromEntries(kept);
  }
  return out;
}

// Per-annotation merge: union by id, newest updatedAt wins, tombstones drop an
// annotation unless it was edited after the deletion (edit-vs-delete race →
// keep the edit).
function mergePages(localPages, remotePages, tombstones) {
  const pages = {};
  const urls = [...new Set([...Object.keys(localPages), ...Object.keys(remotePages)])].sort();
  for (const url of urls) {
    const byId = new Map();
    for (const a of [...(remotePages[url] || []), ...(localPages[url] || [])]) {
      if (!a || !a.id) continue;
      const cur = byId.get(a.id);
      if (!cur || annTime(a) >= annTime(cur)) byId.set(a.id, a);
    }
    const tombs = tombstones[url] || {};
    const anns = [...byId.values()].filter(a => !(tombs[a.id] >= annTime(a)));
    if (anns.length) pages[url] = anns.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  }
  return pages;
}

// ── Drive REST helpers (plain fetch, no SDK) ─────────────────────────────────

async function driveFetch(token, url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }
  });
}

async function findRemoteFile(token) {
  const q = encodeURIComponent(`name = '${SYNC_FILE_NAME}'`);
  const res = await driveFetch(token, `${DRIVE_FILES}?spaces=appDataFolder&q=${q}&fields=files(id)`);
  if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
  return (await res.json()).files?.[0]?.id || null;
}

// null means "no usable remote state" (deleted file or corrupt JSON) — the
// caller treats it as empty and the next push overwrites it.
async function downloadRemote(token, fileId) {
  const res = await driveFetch(token, `${DRIVE_FILES}/${fileId}?alt=media`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Drive download failed: ${res.status}`);
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function uploadRemote(token, fileId, body) {
  const content = JSON.stringify(body);
  if (fileId) {
    const res = await driveFetch(token, `${DRIVE_UPLOAD}/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: content
    });
    if (res.status !== 404) {
      if (!res.ok) throw new Error(`Drive upload failed: ${res.status}`);
      return fileId;
    }
    // Remote file vanished under us — fall through and create a fresh one.
  }
  const metadata = JSON.stringify({ name: SYNC_FILE_NAME, parents: ['appDataFolder'] });
  const boundary = 'wa-sync-' + Math.random().toString(36).slice(2);
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await driveFetch(token, `${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart
  });
  if (!res.ok) throw new Error(`Drive create failed: ${res.status}`);
  return (await res.json()).id;
}

// ── Sync engine ──────────────────────────────────────────────────────────────

async function syncNow({ interactive = false } = {}) {
  if (!syncConfigured()) return { ok: false, error: 'OAuth client ID not configured — see README → "Cross-device sync".' };
  if (!(await isSyncEnabled())) return { ok: false, error: 'Sync is off.' };
  if (syncInFlight) {
    syncQueued = true;
    return syncInFlight;
  }
  syncInFlight = doSync(interactive).finally(() => {
    syncInFlight = null;
    if (syncQueued) {
      syncQueued = false;
      syncNow();
    }
  });
  return syncInFlight;
}

async function doSync(interactive) {
  let { token } = await getToken(interactive);
  if (!token) {
    lastSyncError = 'Not signed in — open the popup and connect Google Drive.';
    return { ok: false, error: lastSyncError, authRequired: true };
  }
  try {
    return await doSyncWithToken(token);
  } catch (e) {
    // A 401 usually means the cached token expired — drop it and retry once.
    if (String(e.message).includes('401')) {
      await new Promise(r => chrome.identity.removeCachedAuthToken({ token }, r));
      ({ token } = await getToken(false));
      if (token) {
        try {
          return await doSyncWithToken(token);
        } catch (e2) {
          e = e2;
        }
      }
    }
    console.error('[SYNC] failed:', e);
    lastSyncError = e.message;
    return { ok: false, error: e.message };
  }
}

async function doSyncWithToken(token) {
  const { pages: localPages, meta } = await readLocalStore();

  let fileId = meta.fileId || await findRemoteFile(token);
  let remote = fileId ? await downloadRemote(token, fileId) : null;
  if (remote === null && meta.fileId) {
    // Cached file id may be stale (file deleted via Drive "Manage apps") —
    // re-resolve once before concluding there is no remote state.
    fileId = await findRemoteFile(token);
    remote = fileId ? await downloadRemote(token, fileId) : null;
  }

  const tombstones = gcTombstones(mergeTombstones(meta.tombstones, remote?.tombstones));
  const merged = mergePages(localPages, remote?.pages || {}, tombstones);

  const toSet = {};
  const toRemove = [];
  for (const [url, anns] of Object.entries(merged)) {
    if (JSON.stringify(localPages[url]) !== JSON.stringify(anns)) toSet[url] = anns;
  }
  for (const url of Object.keys(localPages)) {
    if (!merged[url]) toRemove.push(url);
  }
  const changedLocal = Object.keys(toSet).length > 0 || toRemove.length > 0;

  const remoteDiffers =
    !remote ||
    JSON.stringify(remote.pages || {}) !== JSON.stringify(merged) ||
    JSON.stringify(remote.tombstones || {}) !== JSON.stringify(tombstones);
  if (remoteDiffers) {
    fileId = await uploadRemote(token, fileId, {
      version: 1,
      updatedAt: Date.now(),
      pages: merged,
      tombstones
    });
  }

  toSet[SYNC_META_KEY] = { ...meta, fileId, tombstones, lastSyncAt: Date.now() };
  await chrome.storage.local.set(toSet);
  if (toRemove.length) await chrome.storage.local.remove(toRemove);

  lastSyncError = null;
  return { ok: true, changedLocal, pushed: remoteDiffers };
}

// ── Triggers (called from background.js) ─────────────────────────────────────

// Debounced full sync after a mutation; a full pull-merge-push is the safe
// push, since it can't clobber newer remote edits.
function scheduleSyncPush() {
  isSyncEnabled().then(on => {
    if (!on || !syncConfigured()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => syncNow(), PUSH_DEBOUNCE_MS);
  });
}

// Freshness check on page load / SW spin-up: sync at most once per interval.
async function maybeSyncPull() {
  if (!syncConfigured() || !(await isSyncEnabled())) return;
  const { [SYNC_META_KEY]: meta } = await chrome.storage.local.get(SYNC_META_KEY);
  if (Date.now() - (meta?.lastSyncAt || 0) < PULL_MIN_INTERVAL_MS) return;
  syncNow();
}

// ── Popup-facing API ─────────────────────────────────────────────────────────

async function getSyncStatus() {
  const configured = syncConfigured();
  const enabled = configured && (await isSyncEnabled());
  const { [SYNC_META_KEY]: meta } = await chrome.storage.local.get(SYNC_META_KEY);
  const email = await new Promise(resolve => {
    if (!chrome.identity?.getProfileUserInfo) return resolve('');
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, info => resolve(info?.email || ''));
  });
  return { configured, enabled, email, lastSyncAt: meta?.lastSyncAt || null, lastError: lastSyncError };
}

async function connectSync() {
  if (!syncConfigured()) {
    return { ok: false, error: 'Add your OAuth client ID to manifest.json first — see README → "Cross-device sync".' };
  }
  const { token, error } = await getToken(true);
  if (!token) return { ok: false, error: error || 'Google sign-in was cancelled.' };
  await chrome.storage.sync.set({ driveSyncEnabled: true });
  return syncNow({ interactive: true });
}

// Turns sync off everywhere (the flag roams via storage.sync) and revokes the
// grant. The annotations file stays in Drive; Drive → Settings → Manage apps
// can delete it. Local annotations are untouched.
async function disconnectSync() {
  await chrome.storage.sync.set({ driveSyncEnabled: false });
  const { token } = await getToken(false);
  if (token) {
    await new Promise(r => chrome.identity.removeCachedAuthToken({ token }, r));
    fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`).catch(() => {});
  }
  return { ok: true };
}

// Catch up whenever the service worker spins up (covers browser start too).
maybeSyncPull();
