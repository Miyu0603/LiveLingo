// background.js — MV3 service worker
// Responsibilities:
//  1. Get a tabCapture media stream id for the active tab (requires user gesture, called from popup)
//  2. Create/manage the offscreen document that actually captures & processes audio
//  3. Relay transcript/translation results from the offscreen doc to the right tab's content script

const OFFSCREEN_URL = 'offscreen.html';

// Service workers are killed after ~30s idle and lose plain JS variables,
// but the offscreen document (and its live tab capture) keeps running.
// Session state must survive that restart, so it lives in chrome.storage.session
// instead of a local variable — otherwise the popup can think nothing is
// capturing while a stale capture is still holding the tab, causing
// "Cannot capture a tab with an active stream" on the next start attempt.
async function getActiveSession() {
  const { activeSession } = await chrome.storage.session.get('activeSession');
  return activeSession || null;
}

async function setActiveSession(session) {
  if (session) {
    await chrome.storage.session.set({ activeSession: session });
  } else {
    await chrome.storage.session.remove('activeSession');
  }
}

async function hasOffscreenDocument() {
  const clients = await self.clients.matchAll();
  return clients.some((c) => c.url.endsWith(OFFSCREEN_URL));
}

// Recreates the offscreen document from scratch and waits for its
// 'OFFSCREEN_READY' handshake so we never race sendMessage against a
// document that hasn't finished registering its listener yet.
async function recreateOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }

  const ready = new Promise((resolve) => {
    function onReady(message) {
      if (message.type === 'OFFSCREEN_READY') {
        chrome.runtime.onMessage.removeListener(onReady);
        resolve();
      }
    }
    chrome.runtime.onMessage.addListener(onReady);
    // Safety net in case the ready ping is ever missed
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(onReady);
      resolve();
    }, 3000);
  });

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: '擷取分頁音訊並串流至 Deepgram 進行即時逐字稿辨識'
  });

  await ready;
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

// Unconditionally tears down any previous capture (offscreen doc + its
// MediaStream tracks) before we ask Chrome for a new stream id. This is what
// actually prevents "Cannot capture a tab with an active stream": that error
// means Chrome still thinks a capture is live, regardless of what our own
// in-memory/session state believes.
async function forceReleaseAnyCapture() {
  if (await hasOffscreenDocument()) {
    // Ask the offscreen doc to stop its tracks cleanly first (best effort),
    // then close the document outright as a hard guarantee.
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP', target: 'offscreen' }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await closeOffscreenDocument();
    // Give Chrome a moment to release the OS-level capture lock on the tab.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

// Content scripts declared in the manifest are only auto-injected when a page
// loads. Tabs that were already open before the extension was installed/reloaded
// have no overlay script, so SHOW_OVERLAY would be sent to nobody. Inject it
// programmatically here so the floating subtitle UI works regardless of when the
// tab was opened. content.js is re-entrant and retires any previous instance via
// window.__lctCleanup, so re-injecting an already-injected tab is safe.
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content.css']
    });
  } catch (e) { /* CSS may already be present */ }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch (e) {
    // Fails on restricted pages (chrome://, Web Store, PDF viewer, etc.)
    throw new Error('無法在此分頁顯示字幕（可能是受限制的頁面，如 chrome:// 或應用程式商店）。請在一般網站（YouTube、Twitch 等）使用。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // keep the channel open for async sendResponse
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'START_CAPTURE': {
      try {
        const tabId = message.tabId;

        // Inject the overlay UI first — if this tab is a restricted page we
        // want to fail fast, before starting any audio capture.
        await ensureContentScript(tabId);

        await forceReleaseAnyCapture();

        const streamId = await new Promise((resolve, reject) => {
          chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
            if (chrome.runtime.lastError || !id) {
              reject(new Error(chrome.runtime.lastError?.message || '無法取得分頁音訊串流'));
            } else {
              resolve(id);
            }
          });
        });

        await recreateOffscreenDocument();

        // API keys live in sync storage (follow the Google account); UI prefs
        // stay in local storage (per-machine).
        const keys = await chrome.storage.sync.get([
          'deepgramApiKey', 'deeplApiKey', 'deeplPlan', 'glossaryId'
        ]);
        const prefs = await chrome.storage.local.get(['sourceLang', 'targetLang']);

        await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_START',
          target: 'offscreen',
          streamId,
          tabId,
          deepgramApiKey: keys.deepgramApiKey || '',
          deeplApiKey: keys.deeplApiKey || '',
          deeplPlan: keys.deeplPlan || 'free',
          sourceLang: message.sourceLang || prefs.sourceLang || 'auto',
          targetLang: message.targetLang || prefs.targetLang || 'ZH-HANT',
          // Applied only when the chosen pair is covered by the glossary (en↔zh).
          glossaryId: keys.glossaryId || null
        });

        await setActiveSession({ tabId });
        await chrome.tabs.sendMessage(tabId, { type: 'SHOW_OVERLAY' }).catch(() => {});
        return { ok: true };
      } catch (err) {
        // We already force-release our own captures above, so if Chrome still
        // reports this, something outside our control (e.g. another
        // capture/recording tool, or a stream that hasn't been released yet)
        // is holding the tab — reloading the tab clears Chrome's lock on it.
        if (/active stream/i.test(err.message)) {
          return {
            ok: false,
            error: '此分頁已被其他錄音/擷取功能佔用。請重新整理該分頁後再試一次。'
          };
        }
        return { ok: false, error: err.message };
      }
    }

    case 'STOP_CAPTURE': {
      const session = await getActiveSession();
      const tabId = message.tabId || session?.tabId;
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP', target: 'offscreen' }).catch(() => {});
      await closeOffscreenDocument();
      if (tabId) {
        await chrome.tabs.sendMessage(tabId, { type: 'HIDE_OVERLAY' }).catch(() => {});
      }
      await setActiveSession(null);
      return { ok: true };
    }

    case 'GET_STATUS': {
      const session = await getActiveSession();
      return { ok: true, capturing: !!session, tabId: session?.tabId };
    }

    // Relayed from offscreen.js -> forward to the content script of the captured tab
    case 'TRANSCRIPT_RESULT': {
      const session = await getActiveSession();
      if (session?.tabId) {
        chrome.tabs.sendMessage(session.tabId, {
          type: 'TRANSCRIPT_UPDATE',
          original: message.original,
          translated: message.translated,
          isFinal: message.isFinal
        }).catch(() => {});
      }
      return { ok: true };
    }

    case 'OFFSCREEN_ERROR': {
      const session = await getActiveSession();
      if (session?.tabId) {
        chrome.tabs.sendMessage(session.tabId, {
          type: 'CAPTION_ERROR',
          error: message.error
        }).catch(() => {});
      }
      return { ok: true };
    }

    default:
      return undefined;
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getActiveSession();
  if (session?.tabId === tabId) {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP', target: 'offscreen' }).catch(() => {});
    await closeOffscreenDocument();
    await setActiveSession(null);
  }
});
