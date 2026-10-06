// content.js — injects the draggable floating subtitle overlay into the page.

(() => {
  // Re-entrant guard: if a previous instance is still attached (e.g. the manifest
  // auto-injected one, or an orphan left behind after the extension was reloaded),
  // tear it down first so we never stack duplicate overlays or leak listeners.
  if (typeof window.__lctCleanup === 'function') {
    try { window.__lctCleanup(); } catch (e) { /* orphaned context, ignore */ }
  }

  // All DOM listeners are registered against this signal so a single abort()
  // removes every one of them during cleanup.
  const ac = new AbortController();
  const signal = ac.signal;

  const SIZES = ['lct-size-sm', '', 'lct-size-lg'];
  let sizeIndex = 1;
  let maxLines = 2; // how many finalized sentences to keep on screen at once
  let errorTimer = null;

  // Width bounds for edge-dragging. The default width itself lives in content.css.
  const MIN_WIDTH = 260;
  function maxWidth() { return Math.max(MIN_WIDTH, window.innerWidth - 24); }

  // --- Safe chrome.* wrappers -------------------------------------------------
  // After the extension is reloaded/updated, an orphaned content script still has
  // its listeners firing, but chrome.runtime.id becomes undefined and any chrome.*
  // call throws "Extension context invalidated". These helpers swallow that so a
  // stale instance fails silently instead of spamming the console with red errors.
  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function safeStorageGet(keys, cb) {
    if (!contextAlive()) return;
    try {
      chrome.storage.local.get(keys, (data) => {
        if (chrome.runtime.lastError) return;
        cb(data || {});
      });
    } catch (e) { /* context died mid-call */ }
  }

  function safeStorageSet(obj) {
    if (!contextAlive()) return;
    try {
      chrome.storage.local.set(obj, () => { void chrome.runtime.lastError; });
    } catch (e) { /* context died mid-call */ }
  }

  function safeSendMessage(message) {
    if (!contextAlive()) return;
    try {
      chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; });
    } catch (e) { /* context died mid-call */ }
  }

  // --- Build overlay ----------------------------------------------------------
  const existing = document.getElementById('lct-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'lct-overlay';
  overlay.innerHTML = `
    <div id="lct-drag-handle">
      <span id="lct-drag-dots">⠿⠿⠿</span>
      <div id="lct-controls">
        <button class="lct-btn" id="lct-size-btn" title="調整字體大小">A±</button>
        <button class="lct-btn" id="lct-hide-btn" title="停止聆聽並關閉字幕">✕</button>
      </div>
    </div>
    <div id="lct-lines"></div>
    <div id="lct-interim"></div>
    <div id="lct-error"></div>
    <div class="lct-resize-handle" id="lct-resize-left" title="拖曳調整寬度（雙擊還原預設）"></div>
    <div class="lct-resize-handle" id="lct-resize-right" title="拖曳調整寬度（雙擊還原預設）"></div>
  `;
  document.documentElement.appendChild(overlay);

  const linesEl = overlay.querySelector('#lct-lines');
  const interimEl = overlay.querySelector('#lct-interim');
  const errorEl = overlay.querySelector('#lct-error');
  const dragHandle = overlay.querySelector('#lct-drag-handle');
  const sizeBtn = overlay.querySelector('#lct-size-btn');
  const hideBtn = overlay.querySelector('#lct-hide-btn');
  const resizeLeft = overlay.querySelector('#lct-resize-left');
  const resizeRight = overlay.querySelector('#lct-resize-right');

  // Rolling buffer of the most recent finalized sentences.
  // The newest sits at the bottom (full opacity); older ones fade out but linger
  // so a slow-to-arrive translation stays readable a moment longer.
  let finalizedLines = [];

  // Chinese needs extra tracking/leading to be readable, but which of the two
  // lines is Chinese depends on the languages chosen, so detect it from the text.
  const HAS_CJK = /[㐀-䶿一-鿿]/;
  function cjkClass(text) {
    return HAS_CJK.test(text || '') ? ' lct-cjk' : '';
  }

  function renderLines() {
    linesEl.innerHTML = '';
    finalizedLines.forEach((line, idx) => {
      const isNewest = idx === finalizedLines.length - 1;
      const block = document.createElement('div');
      block.className = 'lct-line' + (isNewest ? ' lct-line-current' : ' lct-line-prev');
      const orig = document.createElement('div');
      orig.className = 'lct-line-original' + cjkClass(line.original);
      orig.textContent = line.original || '';
      const trans = document.createElement('div');
      trans.className = 'lct-line-translated' + cjkClass(line.translated);
      trans.textContent = line.translated || '…';
      block.appendChild(orig);
      block.appendChild(trans);
      linesEl.appendChild(block);
    });
  }

  function trimLines() {
    if (finalizedLines.length > maxLines) {
      finalizedLines = finalizedLines.slice(-maxLines);
    }
  }

  function pushFinalizedLine(original, translated) {
    finalizedLines.push({ original, translated });
    trimLines();
    renderLines();
  }

  function applySize() {
    overlay.classList.remove('lct-size-sm', 'lct-size-lg');
    const cls = SIZES[sizeIndex];
    if (cls) overlay.classList.add(cls);
  }

  // Restore saved position / size / line-count / width
  safeStorageGet(['lctPosition', 'lctSizeIndex', 'lctMaxLines', 'lctWidth'], (data) => {
    if (data.lctPosition && data.lctPosition.top && data.lctPosition.left) {
      overlay.style.left = data.lctPosition.left;
      overlay.style.top = data.lctPosition.top;
      overlay.style.bottom = 'auto';
      overlay.style.transform = 'none';
    }
    if (typeof data.lctWidth === 'number' && data.lctWidth >= MIN_WIDTH) {
      overlay.style.width = `${Math.min(data.lctWidth, maxWidth())}px`;
    }
    if (typeof data.lctSizeIndex === 'number') {
      sizeIndex = data.lctSizeIndex;
      applySize();
    }
    if (typeof data.lctMaxLines === 'number' && data.lctMaxLines >= 1) {
      maxLines = data.lctMaxLines;
      trimLines();
      renderLines();
    }
  });

  // React live to the line-count / font-size settings changing in the popup.
  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes.lctMaxLines) {
      const val = changes.lctMaxLines.newValue;
      if (typeof val === 'number' && val >= 1) {
        maxLines = val;
        trimLines();
        renderLines();
      }
    }
    if (changes.lctSizeIndex) {
      const val = changes.lctSizeIndex.newValue;
      if (typeof val === 'number' && val >= 0 && val < SIZES.length) {
        sizeIndex = val;
        applySize();
      }
    }
  }
  if (contextAlive()) {
    try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (e) { /* ignore */ }
  }

  sizeBtn.addEventListener('click', () => {
    sizeIndex = (sizeIndex + 1) % SIZES.length;
    applySize();
    safeStorageSet({ lctSizeIndex: sizeIndex });
  }, { signal });

  // ✕ ends the whole session, not just the overlay — otherwise capture and the
  // paid Deepgram/DeepL calls would keep running invisibly.
  // The flag also guards the gap before capture actually stops: a result already
  // in flight must not pop the overlay back open.
  let userHidden = false;

  hideBtn.addEventListener('click', () => {
    userHidden = true;
    overlay.classList.remove('lct-visible');
    // Background falls back to the active session's tab, so no tabId needed here.
    safeSendMessage({ type: 'STOP_CAPTURE' });
  }, { signal });

  // Clicking a control should never also begin a drag.
  [sizeBtn, hideBtn].forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.stopPropagation(), { signal });
  });

  // --- Drag handling ---
  let dragging = false;
  let startX, startY, startLeft, startTop;

  dragHandle.addEventListener('mousedown', (e) => {
    dragging = true;
    overlay.classList.add('lct-dragging');
    const rect = overlay.getBoundingClientRect();
    // Lock in explicit left/top so dragging is stable regardless of prior centering transform
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.bottom = 'auto';
    overlay.style.transform = 'none';
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    e.preventDefault();
  }, { signal });

  // --- Resize handling ---
  // The box keeps a FIXED default width (so the ✕ / A± buttons never wander with
  // subtitle length), but either side edge can be dragged to widen or narrow it.
  let resizing = null; // { edge, startX, startWidth, startRight }

  function beginResize(edge, e) {
    // Convert the centering transform into an explicit left, so changing the
    // width can't make the box drift sideways. Vertical anchoring (bottom) is
    // deliberately left alone.
    const rect = overlay.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.transform = 'none';
    resizing = {
      edge,
      startX: e.clientX,
      startWidth: rect.width,
      startLeft: rect.left,
      startRight: rect.left + rect.width
    };
    overlay.classList.add('lct-resizing');
    e.preventDefault();
    e.stopPropagation(); // don't also start a drag
  }

  resizeLeft.addEventListener('mousedown', (e) => beginResize('left', e), { signal });
  resizeRight.addEventListener('mousedown', (e) => beginResize('right', e), { signal });

  // Double-click either edge to go back to the default width.
  function resetWidth(e) {
    e.preventDefault();
    e.stopPropagation();
    overlay.style.width = '';           // fall back to the stylesheet default
    safeStorageSet({ lctWidth: null });
  }
  resizeLeft.addEventListener('dblclick', resetWidth, { signal });
  resizeRight.addEventListener('dblclick', resetWidth, { signal });

  window.addEventListener('mousemove', (e) => {
    if (resizing) {
      const dx = e.clientX - resizing.startX;
      const limit = maxWidth();
      if (resizing.edge === 'right') {
        const w = Math.min(Math.max(MIN_WIDTH, resizing.startWidth + dx), limit);
        overlay.style.width = `${w}px`;
      } else {
        // Dragging the left edge keeps the right edge pinned in place.
        const w = Math.min(Math.max(MIN_WIDTH, resizing.startWidth - dx), limit);
        overlay.style.width = `${w}px`;
        overlay.style.left = `${Math.max(0, resizing.startRight - w)}px`;
      }
      return;
    }

    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const maxLeft = window.innerWidth - overlay.offsetWidth;
    const maxTop = window.innerHeight - overlay.offsetHeight;
    const newLeft = Math.min(Math.max(0, startLeft + dx), Math.max(0, maxLeft));
    const newTop = Math.min(Math.max(0, startTop + dy), Math.max(0, maxTop));
    overlay.style.left = `${newLeft}px`;
    overlay.style.top = `${newTop}px`;
  }, { signal });

  window.addEventListener('mouseup', () => {
    if (resizing) {
      resizing = null;
      overlay.classList.remove('lct-resizing');
      const toSave = { lctWidth: Math.round(overlay.getBoundingClientRect().width) };
      // Resizing only ever sets `left` — the box stays bottom-anchored unless it
      // has been dragged, so don't persist a position with an empty `top`.
      if (overlay.style.top) {
        toSave.lctPosition = { left: overlay.style.left, top: overlay.style.top };
      }
      safeStorageSet(toSave);
      return;
    }
    if (!dragging) return;
    dragging = false;
    overlay.classList.remove('lct-dragging');
    safeStorageSet({
      lctPosition: { left: overlay.style.left, top: overlay.style.top }
    });
  }, { signal });

  // --- Message handling from background ---
  function onRuntimeMessage(message) {
    switch (message.type) {
      case 'SHOW_OVERLAY':
        // A fresh capture is an explicit request to show subtitles again.
        userHidden = false;
        overlay.classList.add('lct-visible');
        finalizedLines = [];
        renderLines();
        interimEl.textContent = '正在連線…';
        errorEl.classList.remove('lct-visible');
        break;
      case 'HIDE_OVERLAY':
        overlay.classList.remove('lct-visible');
        break;
      case 'TRANSCRIPT_UPDATE':
        // Respect a manual dismissal — keep processing text, just don't reappear.
        if (userHidden) return;
        overlay.classList.add('lct-visible');
        if (message.isFinal) {
          // A sentence is finalized: commit it to the rolling buffer (keeping the
          // previous one visible) and clear the live preview line.
          pushFinalizedLine(message.original || '', message.translated || '');
          interimEl.textContent = '';
        } else {
          // Interim original text — shown live below the finalized lines so the
          // user sees speech arriving before its translation lands.
          interimEl.textContent = message.original || '';
        }
        break;
      case 'CAPTION_ERROR':
        errorEl.textContent = message.error;
        errorEl.classList.add('lct-visible');
        clearTimeout(errorTimer);
        errorTimer = setTimeout(() => errorEl.classList.remove('lct-visible'), 6000);
        break;
    }
  }

  if (contextAlive()) {
    try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch (e) { /* ignore */ }
  }

  // Expose a cleanup hook so a future (re)injection can cleanly retire this
  // instance: abort all DOM listeners and remove the overlay element. It does NOT
  // touch chrome.* APIs, so it stays safe to call even from an invalidated context.
  window.__lctCleanup = () => {
    try { ac.abort(); } catch (e) { /* noop */ }
    clearTimeout(errorTimer);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (e) { /* noop */ }
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (e) { /* noop */ }
    delete window.__lctCleanup;
  };
})();
