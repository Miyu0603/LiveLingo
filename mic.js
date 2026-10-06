// mic.js — standalone microphone transcription + translation page.
// Runs entirely in this extension page: captures the mic, downsamples to 16k PCM
// with the shared AudioWorklet, streams to Deepgram, and translates finals via DeepL.

const sourceLangEl = document.getElementById('sourceLang');
const targetLangEl = document.getElementById('targetLang');
const micSelectEl = document.getElementById('micSelect');
const fontSizeEl = document.getElementById('fontSize');
const showOriginalEl = document.getElementById('showOriginal');
const toggleBtn = document.getElementById('toggleBtn');
const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const linesEl = document.getElementById('lines');
const interimEl = document.getElementById('interim');

const FONT_SIZES = {
  sm: { orig: '13px', trans: '18px' },
  md: { orig: '15px', trans: '24px' },
  lg: { orig: '18px', trans: '30px' }
};

let running = false;
let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let workletNode = null;
let deepgramSocket = null;
let config = null;
let reconnecting = false;
let hasContent = false;

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

function applyFontSize() {
  const size = FONT_SIZES[fontSizeEl.value] || FONT_SIZES.md;
  document.documentElement.style.setProperty('--orig-size', size.orig);
  document.documentElement.style.setProperty('--trans-size', size.trans);
}

// --- Auto-scroll ---
// The transcript follows the newest line only while it is "pinned" to the bottom.
// The flag is updated ONLY by real user scrolling — never recomputed at append
// time — because enlarging the font suddenly increases the distance to the
// bottom, which would otherwise look like "the user scrolled up" and silently
// stop the auto-follow.
let pinned = true;
let suppressScrollTracking = false;

function scrollToBottom() {
  suppressScrollTracking = true;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  requestAnimationFrame(() => { suppressScrollTracking = false; });
}

transcriptEl.addEventListener('scroll', () => {
  if (suppressScrollTracking) return;
  // Slack scales with the translated font size so one tall line near the bottom
  // still counts as "at the bottom".
  const transSize = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--trans-size')
  ) || 24;
  const slack = transSize * 2.5;
  pinned = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight <= slack;
}, { passive: true });

// Re-anchor after a layout change (font size, window resize). Pin state is read
// before the reflow so taller content can't be mistaken for a user scroll.
function reanchorAfterLayoutChange(applyChange) {
  const wasPinned = pinned;
  suppressScrollTracking = true;
  if (applyChange) applyChange();
  requestAnimationFrame(() => {
    if (wasPinned) {
      pinned = true;
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }
    requestAnimationFrame(() => { suppressScrollTracking = false; });
  });
}

fontSizeEl.addEventListener('change', () => {
  reanchorAfterLayoutChange(() => {
    applyFontSize();
    chrome.storage.local.set({ micFontSize: fontSizeEl.value });
  });
});

window.addEventListener('resize', () => reanchorAfterLayoutChange());

function refreshOriginalUI() {
  document.body.classList.toggle('hide-original', !showOriginalEl.checked);
}

showOriginalEl.addEventListener('change', () => {
  chrome.storage.local.set({ micShowOriginal: showOriginalEl.checked });
  // Hiding/showing a line per subtitle changes the content height a lot.
  reanchorAfterLayoutChange(refreshOriginalUI);
});

// --- Load stored prefs + API keys, enumerate microphones ---
async function init() {
  // API keys come from sync storage; UI prefs from local.
  const keys = await chrome.storage.sync.get(['deepgramApiKey', 'deeplApiKey']);
  const stored = await chrome.storage.local.get([
    'micSourceLang', 'micTargetLang', 'micFontSize', 'micDeviceId', 'micShowOriginal'
  ]);
  if (stored.micSourceLang) sourceLangEl.value = stored.micSourceLang;
  if (stored.micTargetLang) targetLangEl.value = stored.micTargetLang;
  if (stored.micFontSize) fontSizeEl.value = stored.micFontSize;
  // Defaults to ON here: this page doubles as the operator's own monitor, where
  // seeing the recognised source text is how you tell recognition is working.
  showOriginalEl.checked = stored.micShowOriginal !== false;
  refreshOriginalUI();
  applyFontSize();

  if (!keys.deepgramApiKey || !keys.deeplApiKey) {
    setStatus('尚未設定 API Key。請開啟外掛的「設定」頁輸入 Deepgram / DeepL 金鑰後再回來。', 'error');
  }

  await populateMicList(stored.micDeviceId);
}

async function populateMicList(preferredId) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    // Labels are only exposed after mic permission has been granted once.
    micSelectEl.innerHTML = '<option value="">預設裝置</option>';
    mics.forEach((mic, i) => {
      const opt = document.createElement('option');
      opt.value = mic.deviceId;
      opt.textContent = mic.label || `麥克風 ${i + 1}`;
      micSelectEl.appendChild(opt);
    });
    if (preferredId) micSelectEl.value = preferredId;
  } catch (e) {
    // ignore — will fall back to default device
  }
}

micSelectEl.addEventListener('change', () => {
  chrome.storage.local.set({ micDeviceId: micSelectEl.value });
});

// --- Transcript rendering ---
// Chinese needs extra tracking/leading to be readable, but which side is Chinese
// depends on the languages the user picked, so detect it from the text itself.
const HAS_CJK = /[㐀-䶿一-鿿]/;
function applyCjkSpacing(el, text) {
  el.classList.toggle('cjk', HAS_CJK.test(text || ''));
}

function addFinalizedLine(original, translated) {
  if (!hasContent) {
    linesEl.innerHTML = '';
    hasContent = true;
  }
  const block = document.createElement('div');
  block.className = 'line';
  const orig = document.createElement('div');
  orig.className = 'line-original';
  orig.textContent = original || '';
  applyCjkSpacing(orig, original);
  const trans = document.createElement('div');
  trans.className = 'line-translated';
  trans.textContent = translated || '…';
  applyCjkSpacing(trans, translated);
  block.appendChild(orig);
  block.appendChild(trans);
  linesEl.appendChild(block);
  if (pinned) scrollToBottom();
}

// Interim text sits inside the scroll area, directly below the last finalized
// line, so in-progress speech reads as a continuation instead of floating at
// the very bottom of the window.
function setInterim(text) {
  interimEl.textContent = text;
  applyCjkSpacing(interimEl, text);
  if (text && pinned) scrollToBottom();
}

// --- Sentence assembly ---
// Deepgram's `is_final` only means "this CHUNK of text is settled" — not "the
// sentence ended". Committing on is_final produced fragments like "The humans" /
// "have input." / "that", each translated in isolation (which also wrecks the
// translation). So finalized chunks are buffered and only flushed as one
// sentence when Deepgram reports a real endpoint (`speech_final`/`UtteranceEnd`).
// maxChars is measured on the SOURCE text. Chinese packs far more meaning per
// character than English (100 Chinese characters can become 150-200 English
// words), so a CJK source gets a much lower cap or the output becomes a wall.
const SENTENCE = { endpointing: 800, utteranceEndMs: 1200, maxChars: 100, maxCharsCjk: 45, maxMs: 4000 };
let pendingParts = [];
let flushTimer = null;
let flushChain = Promise.resolve();

// The last few SOURCE sentences, sent to DeepL as `context` so a sentence isn't
// translated in isolation. Context is not translated and not billed.
const CONTEXT_SENTENCES = 2;
let recentSource = [];

// English chunks need spaces between them; Chinese must not gain any. Dropping
// the space only when CJK sits on BOTH sides preserves the customary spacing
// around Latin words embedded in Chinese ("我們用 AI 處理…").
const CJK = '\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uff00-\\uffef';
function joinParts(parts) {
  let s = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ');
  s = s.replace(new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, 'g'), '');
  s = s.replace(/\s+([,.!?;:])/g, '$1');
  return s.trim();
}

// Splits a buffer into complete sentences plus the trailing fragment.
// CJK terminators (。！？) stand alone; ASCII ones must be followed by whitespace
// or end-of-string so decimals ("3.5") and figures ("120.") aren't mistaken for
// sentence ends. Trailing quotes/brackets are kept with the sentence.
const SENTENCE_END_RE = /(?:[。！？…]["'”’)\]）」』]*|[.!?]["'”’)\]]*(?=\s|$))/g;

function splitAtLastSentenceEnd(text) {
  SENTENCE_END_RE.lastIndex = 0;
  let cut = -1;
  let m;
  while ((m = SENTENCE_END_RE.exec(text)) !== null) cut = m.index + m[0].length;
  if (cut <= 0) return { complete: '', rest: text };
  return { complete: text.slice(0, cut).trim(), rest: text.slice(cut).trim() };
}

// Shows the sentence as it forms: everything buffered so far plus the live partial.
function renderPending(liveTail) {
  setInterim(joinParts([joinParts(pendingParts), liveTail]));
}

// Queues one finished sentence. Chained so lines render in spoken order.
function emitSentence(sentence) {
  if (!sentence) return;
  flushChain = flushChain
    .then(async () => {
      const translated = await translateText(sentence);
      addFinalizedLine(sentence, translated);
      // Record AFTER translating, so a sentence is never its own context.
      recentSource.push(sentence);
      if (recentSource.length > CONTEXT_SENTENCES) recentSource.shift();
    })
    .catch(() => { /* translateText already surfaced the error */ });
}

function appendPending(chunk) {
  pendingParts.push(chunk.trim());

  // Break on real sentence punctuation first. Deepgram's endpoint detection
  // regularly lands mid-sentence ("So those" | "two are memorable."), so emit
  // every complete sentence and keep only the trailing fragment buffered — it
  // then joins onto whatever is said next.
  const { complete, rest } = splitAtLastSentenceEnd(joinParts(pendingParts));
  if (complete) {
    pendingParts = rest ? [rest] : [];
    emitSentence(complete);
  }
  renderPending('');

  if (!pendingParts.length) {
    clearTimeout(flushTimer);
    flushTimer = null;
    return;
  }

  // Safety valves so a speaker who never pauses (or whose speech never gets
  // punctuated) still gets subtitles.
  const buffered = joinParts(pendingParts);
  const cap = HAS_CJK.test(buffered) ? SENTENCE.maxCharsCjk : SENTENCE.maxChars;
  if (buffered.length >= cap) { flushPending(); return; }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushPending, SENTENCE.maxMs);
}

function flushPending() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!pendingParts.length) return;
  const sentence = joinParts(pendingParts);
  pendingParts = [];
  setInterim('');
  emitSentence(sentence);
}


// --- Pipeline ---
async function start() {
  const keys = await chrome.storage.sync.get(['deepgramApiKey', 'deeplApiKey', 'deeplPlan']);
  if (!keys.deepgramApiKey || !keys.deeplApiKey) {
    setStatus('尚未設定 API Key，無法開始。請先到「設定」頁輸入金鑰。', 'error');
    return;
  }
  const g = await chrome.storage.sync.get(['glossaryId']);
  config = {
    deepgramApiKey: keys.deepgramApiKey,
    deeplApiKey: keys.deeplApiKey,
    deeplPlan: keys.deeplPlan || 'free',
    sourceLang: sourceLangEl.value,
    targetLang: targetLangEl.value,
    // Only applied when the chosen pair is covered by the glossary (en↔zh).
    glossaryId: g.glossaryId || null
  };
  recentSource = [];   // a new session starts with no prior context

  await chrome.storage.local.set({
    micSourceLang: sourceLangEl.value,
    micTargetLang: targetLangEl.value
  });

  setStatus('要求麥克風權限中…');

  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true
  };
  const deviceId = micSelectEl.value;
  if (deviceId) audioConstraints.deviceId = { exact: deviceId };

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
  } catch (err) {
    setStatus(`無法存取麥克風：${err.message}`, 'error');
    return;
  }

  // Refresh device labels now that permission is granted.
  await populateMicList(deviceId);

  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  try {
    await audioContext.audioWorklet.addModule('pcm-worklet.js');
  } catch (err) {
    setStatus(`無法載入音訊處理模組：${err.message}`, 'error');
    stop();
    return;
  }

  workletNode = new AudioWorkletNode(audioContext, 'pcm-downsampler', {
    processorOptions: { targetSampleRate: 16000 }
  });
  sourceNode.connect(workletNode);
  // Note: we deliberately do NOT connect to destination — no need to hear your own mic.

  connectDeepgram();

  workletNode.port.onmessage = (event) => {
    if (deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN) {
      deepgramSocket.send(event.data);
    }
  };

  running = true;
  renderToggle();
  setStatus('聆聽中，逐字稿與翻譯進行中…', 'active');
}

function connectDeepgram() {
  const params = new URLSearchParams({
    model: 'nova-2',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    language: config.sourceLang || 'en',
    // Wait for a real pause before declaring the sentence over, plus an explicit
    // UtteranceEnd event as a backstop.
    endpointing: String(SENTENCE.endpointing),
    utterance_end_ms: String(SENTENCE.utteranceEndMs)
  });

  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  deepgramSocket = new WebSocket(url, ['token', config.deepgramApiKey]);

  deepgramSocket.onopen = () => { reconnecting = false; };

  deepgramSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      // Backstop endpoint signal, sent as its own message type.
      if (data.type === 'UtteranceEnd') { flushPending(); return; }

      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (!transcript || !transcript.trim()) {
        // An empty speech_final still means "the sentence ended here".
        if (data.speech_final) flushPending();
        return;
      }

      if (data.is_final) {
        // Note: we deliberately do NOT flush on speech_final. Deepgram raises it
        // on any sufficient pause, including mid-sentence breaths, which is what
        // produced the odd splits. Punctuation (handled in appendPending) decides
        // sentence boundaries; UtteranceEnd above covers "the speaker stopped".
        appendPending(transcript);
      } else {
        renderPending(transcript);
      }
    } catch (e) { /* ignore malformed frame */ }
  };

  deepgramSocket.onerror = () => {
    setStatus('Deepgram 連線發生錯誤，請確認 API Key 是否有效。', 'error');
  };

  deepgramSocket.onclose = (event) => {
    if (running && !reconnecting && event.code !== 1000) {
      reconnecting = true;
      setStatus('連線中斷，重新連線中…');
      setTimeout(() => { if (running) { connectDeepgram(); } }, 1000);
    }
  };
}

async function translateText(text) {
  try {
    return await LiveLingoDeepL.translate({
      text,
      targetLang: config.targetLang || 'ZH-HANT',
      sourceLang: config.sourceLang,
      // Previous sentences steer pronouns and continuations. Not translated,
      // and not billed by DeepL.
      context: recentSource.join(' '),
      apiKey: config.deeplApiKey,
      plan: config.deeplPlan,
      glossaryId: config.glossaryId
    });
  } catch (err) {
    setStatus(`翻譯失敗：${err.message}`, 'error');
    return '';
  }
}

function stop() {
  running = false;
  reconnecting = false;
  // Commit the last partial sentence before tearing down (translation doesn't
  // need the socket), otherwise the final words are silently dropped.
  flushPending();
  if (deepgramSocket) {
    try { deepgramSocket.close(1000); } catch (e) { /* noop */ }
    deepgramSocket = null;
  }
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  setInterim('');
  renderToggle();
  if (statusEl.className !== 'error') setStatus('已停止');
}

function renderToggle() {
  if (running) {
    toggleBtn.textContent = '停止聆聽';
    toggleBtn.classList.add('stop');
  } else {
    toggleBtn.textContent = '開始聆聽';
    toggleBtn.classList.remove('stop');
  }
}

toggleBtn.addEventListener('click', async () => {
  toggleBtn.disabled = true;
  if (!running) {
    await start();
  } else {
    stop();
  }
  toggleBtn.disabled = false;
});

window.addEventListener('beforeunload', () => { if (running) stop(); });

init();
