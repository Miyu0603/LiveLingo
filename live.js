// live.js — full-screen projection page for live talks.
// Captures a mic/mixer input, transcribes + translates, and shows results in two
// columns: left = English→Chinese (always), right = Chinese→English (QA mode only).
// Both directions share ONE audio capture; PCM is fanned out to both Deepgram
// sockets. Bidirectional mode can be toggled live without restarting capture.

const el = (id) => document.getElementById(id);
const deviceEl = el('device');
const sentenceModeEl = el('sentenceMode');
const subtitlePosEl = el('subtitlePos');
const fontStyleEl = el('fontStyle');
const fontSizeEl = el('fontSize');
const showOriginalEl = el('showOriginal');
const bidirEl = el('bidir');
const toggleBtn = el('toggleBtn');
const fullscreenBtn = el('fullscreenBtn');
const hideBarBtn = el('hideBarBtn');
const barEl = el('bar');
const statusEl = el('status');
const stageEl = el('stage');
const colEn = el('colEn');
const colZh = el('colZh');
const bodyEn = el('bodyEn');
const bodyZh = el('bodyZh');
const linesEn = el('linesEn');
const linesZh = el('linesZh');
const interimEnEl = el('interimEn');
const interimZhEl = el('interimZh');
const pauseEnBtn = el('pauseEn');
const pauseZhBtn = el('pauseZh');

// Empty space left below the newest line. More space = subtitles sit higher.
// Capped at the middle of the screen, which is as high as it should ever go.
// Values calibrated by measuring where the newest line's centre actually lands
// at the default font size (1280x720): 6vh≈87%, 18vh≈75%, 26vh≈67%, 43vh≈50%.
const SUBTITLE_POSITIONS = {
  low: '6vh',
  q3:  '18vh',
  q23: '26vh',
  mid: '43vh'
};

// Typeface + weight as a few ready-made combinations, so the operator has ONE
// control instead of separate font and weight pickers.
//
// 明體 is what 細明體 belongs to — a Chinese serif family, NOT a light weight.
// The serif stack lists the better-rendering serifs first because MingLiU itself
// was designed for small screen sizes and looks rough blown up on a projector;
// on Windows without Noto Serif it still lands on 細明體 / 新細明體 as asked.
const SANS_STACK  = '-apple-system, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
const SERIF_STACK = '"Noto Serif TC", "Songti TC", "Songti SC", "MingLiU", "PMingLiU", "SimSun", Georgia, serif';

const FONT_STYLES = {
  'sans-bold':  { font: SANS_STACK,  weight: '600' },
  'sans-light': { font: SANS_STACK,  weight: '300' },
  'serif':      { font: SERIF_STACK, weight: '400' },
  'serif-bold': { font: SERIF_STACK, weight: '600' }
};

// Sized for a projector viewed from the back of a room. The top two steps were
// tuned by eye on real projected output rather than by a strict ratio.
const FONT_SIZES = {
  sm:  { orig: '21px', trans: '35px' },
  md:  { orig: '26px', trans: '45px' },
  lg:  { orig: '32px', trans: '56px' },
  xl:  { orig: '48px', trans: '84px' },   // 特大  (was 40 / 72)
  xxl: { orig: '56px', trans: '90px' }    // 極大
};

// In bidirectional mode, the "off-direction" stream occasionally misfires on the
// other language. Drop finalized results below this confidence to keep the screen clean.
const BIDIR_MIN_CONFIDENCE = 0.6;

let running = false;
let bidirectional = false;
let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let workletNode = null;
let apiKeys = null;               // { deepgramApiKey, deeplApiKey, deeplPlan }
const sockets = { en2zh: null, zh2en: null };
const reconnecting = { en2zh: false, zh2en: false };
const bodyHasContent = { en2zh: false, zh2en: false };

// Operator can pause either direction independently (e.g. mute 中→English while
// the speaker is presenting). Pausing stops feeding audio to that socket — so
// Deepgram bills nothing for it — but the socket is held open with KeepAlive
// pings so resuming is instant and doesn't clip the first words.
const paused = { en2zh: false, zh2en: false };
const keepAliveTimers = { en2zh: null, zh2en: null };
const KEEPALIVE_MS = 5000; // Deepgram drops an audio-less socket after ~10s

// ---- Sentence assembly ----
// Deepgram's `is_final` only means "this CHUNK of text is settled" — not "the
// sentence ended". Committing on is_final produced fragments like "The humans" /
// "have input." / "that", each translated in isolation (which also wrecks the
// translation). So finalized chunks are buffered and only flushed as one
// sentence when Deepgram reports an actual endpoint (`speech_final` /
// `UtteranceEnd`). Bonus: far fewer DeepL calls.
const pendingParts = { en2zh: [], zh2en: [] };
const flushTimers = { en2zh: null, zh2en: null };
// Serialize per direction so translations always render in spoken order.
const flushChain = { en2zh: Promise.resolve(), zh2en: Promise.resolve() };

// The last few SOURCE sentences per direction, sent to DeepL as `context` so a
// sentence isn't translated in isolation (pronouns, continuations). Context is
// not translated and not billed, so this is free quality.
const CONTEXT_SENTENCES = 2;
const recentSource = { en2zh: [], zh2en: [] };

// One multilingual glossary (en→zh + zh→en) built from the options page.
let glossaryId = null;

// How long Deepgram waits for a pause before declaring the sentence over, and
// how long we let a buffer grow if the speaker never pauses.
//
// `maxChars` is measured on the SOURCE text, and Chinese packs far more meaning
// per character than English — 100 Chinese characters can translate to 150-200
// English words. So a Chinese source gets a much lower cap (`maxCharsCjk`),
// otherwise the 中文→English column produces walls of text.
const SENTENCE_PRESETS = {
  short:  { endpointing: 350,  utteranceEndMs: 1000, maxChars: 60,  maxCharsCjk: 28, maxMs: 2500 },
  normal: { endpointing: 800,  utteranceEndMs: 1200, maxChars: 100, maxCharsCjk: 45, maxMs: 4000 },
  long:   { endpointing: 1500, utteranceEndMs: 2000, maxChars: 160, maxCharsCjk: 70, maxMs: 6000 }
};
function sentencePreset() {
  return SENTENCE_PRESETS[sentenceModeEl.value] || SENTENCE_PRESETS.normal;
}

function otherDir(dir) {
  return dir === 'en2zh' ? 'zh2en' : 'en2zh';
}

// True when a result is probably the idle direction mis-hearing the other
// language rather than real speech in this direction's language.
function lowConfidence(alt) {
  return typeof alt.confidence === 'number' && alt.confidence < BIDIR_MIN_CONFIDENCE;
}

// zh2en listens to Chinese, so it uses the CJK cap; en2zh listens to English.
function maxCharsFor(dir) {
  const preset = sentencePreset();
  return dir === 'zh2en' ? preset.maxCharsCjk : preset.maxChars;
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

// Only Traditional Chinese is used for this deployment.
const ZH_SOURCE = 'zh-TW';
const ZH_TARGET = 'ZH-HANT';

// Each direction's language config. en2zh: listen English, translate to Chinese.
// zh2en: listen Chinese, translate to English.
function directionConfig(dir) {
  if (dir === 'en2zh') {
    return { dgLanguage: 'en', deeplTarget: ZH_TARGET, body: bodyEn, lines: linesEn, interim: interimEnEl, col: colEn, pauseBtn: pauseEnBtn, hotkey: 'L' };
  }
  return { dgLanguage: ZH_SOURCE, deeplTarget: 'EN-US', body: bodyZh, lines: linesZh, interim: interimZhEl, col: colZh, pauseBtn: pauseZhBtn, hotkey: 'R' };
}

function applyFontSize() {
  const s = FONT_SIZES[fontSizeEl.value] || FONT_SIZES.md;
  document.documentElement.style.setProperty('--orig-size', s.orig);
  document.documentElement.style.setProperty('--trans-size', s.trans);
}

function applySubtitlePos() {
  const v = SUBTITLE_POSITIONS[subtitlePosEl.value] || SUBTITLE_POSITIONS.q3;
  document.documentElement.style.setProperty('--bottom-space', v);
}

async function loadGlossaryIds() {
  const g = await chrome.storage.sync.get(['glossaryId']);
  glossaryId = g.glossaryId || null;
}

function applyFontStyle() {
  const s = FONT_STYLES[fontStyleEl.value] || FONT_STYLES['sans-bold'];
  document.documentElement.style.setProperty('--subtitle-font', s.font);
  document.documentElement.style.setProperty('--trans-weight', s.weight);
}

// ---- Auto-scroll ----
// Each column follows the newest line only while it is "pinned" to the bottom.
// The flag is updated ONLY by real user scrolling — never recomputed at append
// time — because enlarging the font suddenly increases the distance to the
// bottom, which would otherwise look like "the user scrolled up" and silently
// stop the auto-follow.
const pinned = { en2zh: true, zh2en: true };
let suppressScrollTracking = false;

function scrollToBottom(body) {
  suppressScrollTracking = true;
  body.scrollTop = body.scrollHeight;
  requestAnimationFrame(() => { suppressScrollTracking = false; });
}

function wireScrollTracking(dir) {
  const body = directionConfig(dir).body;
  body.addEventListener('scroll', () => {
    if (suppressScrollTracking) return;
    // Slack scales with the translated font size so one tall line near the
    // bottom still counts as "at the bottom".
    const transSize = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--trans-size')
    ) || 34;
    const slack = transSize * 2.5;
    pinned[dir] = body.scrollHeight - body.scrollTop - body.clientHeight <= slack;
  }, { passive: true });
}
wireScrollTracking('en2zh');
wireScrollTracking('zh2en');

// Re-anchor every still-pinned column after a layout change (font size, split
// toggle, hiding the bar, window resize). Pin state is captured before the
// reflow so the taller/shorter content can't be mistaken for a user scroll.
function reanchorAfterLayoutChange(applyChange) {
  const wasPinned = { en2zh: pinned.en2zh, zh2en: pinned.zh2en };
  suppressScrollTracking = true;
  if (applyChange) applyChange();
  requestAnimationFrame(() => {
    for (const dir of ['en2zh', 'zh2en']) {
      if (!wasPinned[dir]) continue;
      const body = directionConfig(dir).body;
      pinned[dir] = true;
      body.scrollTop = body.scrollHeight;
    }
    requestAnimationFrame(() => { suppressScrollTracking = false; });
  });
}

// ---- Settings persistence (local; API keys come from sync) ----
async function init() {
  apiKeys = await chrome.storage.sync.get(['deepgramApiKey', 'deeplApiKey', 'deeplPlan']);
  await loadGlossaryIds();
  const s = await chrome.storage.local.get([
    'liveDevice', 'liveFontSize', 'liveBidir', 'liveSentenceMode', 'liveShowOriginal',
    'liveSubtitlePos', 'liveFontStyle'
  ]);
  if (s.liveFontSize) fontSizeEl.value = s.liveFontSize;
  if (s.liveSentenceMode) sentenceModeEl.value = s.liveSentenceMode;
  if (s.liveSubtitlePos) subtitlePosEl.value = s.liveSubtitlePos;
  if (s.liveFontStyle) fontStyleEl.value = s.liveFontStyle;
  applySubtitlePos();
  applyFontStyle();
  if (s.liveBidir) { bidirEl.checked = true; bidirectional = true; }
  // Defaults to OFF: the projected screen should be translation-only unless
  // someone deliberately turns the source text back on.
  showOriginalEl.checked = s.liveShowOriginal === true;
  refreshOriginalUI();
  refreshBidirUI();
  applyFontSize();
  renderPauseUI('en2zh');
  renderPauseUI('zh2en');

  if (!apiKeys.deepgramApiKey || !apiKeys.deeplApiKey) {
    setStatus('尚未設定 API Key。請開啟外掛的「設定」頁輸入 Deepgram / DeepL 金鑰後再回到本頁。', 'error');
  }
  await populateDeviceList(s.liveDevice);
}

async function populateDeviceList(preferredId) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    deviceEl.innerHTML = '<option value="">預設裝置</option>';
    mics.forEach((mic, i) => {
      const opt = document.createElement('option');
      opt.value = mic.deviceId;
      opt.textContent = mic.label || `音訊輸入 ${i + 1}`;
      deviceEl.appendChild(opt);
    });
    if (preferredId) deviceEl.value = preferredId;
  } catch (e) { /* labels appear after permission granted */ }
}

deviceEl.addEventListener('change', () => chrome.storage.local.set({ liveDevice: deviceEl.value }));

// Endpointing lives in the Deepgram connection URL, so an active session has to
// reconnect for a new setting to take effect.
sentenceModeEl.addEventListener('change', () => {
  chrome.storage.local.set({ liveSentenceMode: sentenceModeEl.value });
  if (!running) return;
  for (const dir of ['en2zh', 'zh2en']) {
    if (dir === 'zh2en' && !bidirectional) continue;
    flushPending(dir);          // don't lose what's already buffered
    closeSocket(dir);
    openSocket(dir);
  }
  setStatus('已套用新的斷句長度（重新連線中）…', 'active');
});
fontSizeEl.addEventListener('change', () => {
  reanchorAfterLayoutChange(() => {
    applyFontSize();
    chrome.storage.local.set({ liveFontSize: fontSizeEl.value });
  });
});

subtitlePosEl.addEventListener('change', () => {
  // Changing the reserved space changes the scroll height, so re-anchor to keep
  // following the newest line.
  reanchorAfterLayoutChange(() => {
    applySubtitlePos();
    chrome.storage.local.set({ liveSubtitlePos: subtitlePosEl.value });
  });
});

fontStyleEl.addEventListener('change', () => {
  // A different typeface/weight changes text metrics, so lines can re-wrap and
  // the content height shifts — re-anchor as with a font-size change.
  reanchorAfterLayoutChange(() => {
    applyFontStyle();
    chrome.storage.local.set({ liveFontStyle: fontStyleEl.value });
  });
});

// ---- Rendering ----
function addLine(dir, original, translated) {
  const cfg = directionConfig(dir);
  if (!bodyHasContent[dir]) { cfg.lines.innerHTML = ''; bodyHasContent[dir] = true; }
  const block = document.createElement('div');
  block.className = 'line';
  const o = document.createElement('div');
  o.className = 'line-original';
  o.textContent = original || '';
  const t = document.createElement('div');
  t.className = 'line-translated';
  t.textContent = translated || '…';
  block.appendChild(o);
  block.appendChild(t);
  cfg.lines.appendChild(block);
  if (pinned[dir]) scrollToBottom(cfg.body);
}

// Interim text sits inside the scroll area, directly below the last finalized
// line, so in-progress speech reads as a continuation instead of floating at
// the very bottom of the window.
function setInterim(dir, text) {
  const cfg = directionConfig(dir);
  cfg.interim.textContent = text;
  if (text && pinned[dir]) scrollToBottom(cfg.body);
}

function refreshOriginalUI() {
  stageEl.classList.toggle('hide-original', !showOriginalEl.checked);
}

showOriginalEl.addEventListener('change', () => {
  chrome.storage.local.set({ liveShowOriginal: showOriginalEl.checked });
  // Hiding/showing a line per subtitle changes the content height a lot.
  reanchorAfterLayoutChange(refreshOriginalUI);
});

function refreshBidirUI() {
  colZh.classList.toggle('inactive', !bidirectional);
  // Single-direction mode collapses the split into one centered column.
  stageEl.classList.toggle('single', !bidirectional);
}

// ---- Audio + sockets ----
async function start() {
  apiKeys = await chrome.storage.sync.get(['deepgramApiKey', 'deeplApiKey', 'deeplPlan']);
  // Re-read in case the glossary was rebuilt in the options page since load.
  await loadGlossaryIds();
  if (!apiKeys.deepgramApiKey || !apiKeys.deeplApiKey) {
    setStatus('尚未設定 API Key，無法開始。請先到「設定」頁輸入金鑰。', 'error');
    return;
  }
  // A new session starts with no prior context.
  recentSource.en2zh = [];
  recentSource.zh2en = [];

  setStatus('要求音訊權限中…');
  const constraints = { echoCancellation: true, noiseSuppression: true };
  if (deviceEl.value) constraints.deviceId = { exact: deviceEl.value };
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
  } catch (err) {
    setStatus(`無法存取音訊來源：${err.message}`, 'error');
    return;
  }
  await populateDeviceList(deviceEl.value);

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

  // Fan out the same PCM to every open, non-paused Deepgram socket.
  workletNode.port.onmessage = (event) => {
    for (const dir of ['en2zh', 'zh2en']) {
      if (paused[dir]) continue;
      const sock = sockets[dir];
      if (sock && sock.readyState === WebSocket.OPEN) sock.send(event.data);
    }
  };

  running = true;
  openSocket('en2zh');
  if (bidirectional) openSocket('zh2en');
  renderToggle();
  setStatus(bidirectional ? '聆聽中（雙向模式）…' : '聆聽中（英文 → 中文）…', 'active');
}

// Joins chunks into one sentence. English chunks need spaces between them;
// Chinese must not gain spaces, so any space touching a CJK character is removed.
const CJK = '\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uff00-\\uffef';
function joinParts(parts) {
  let s = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ');
  // Drop the space only when CJK sits on BOTH sides — that keeps the customary
  // spacing around Latin words embedded in Chinese ("我們用 AI 處理…").
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
function renderPending(dir, liveTail) {
  const buffered = joinParts(pendingParts[dir]);
  setInterim(dir, joinParts([buffered, liveTail]));
}

// Queues one finished sentence for translation. Chained per direction so lines
// always render in the order they were spoken.
function emitSentence(dir, sentence) {
  if (!sentence) return;
  const target = directionConfig(dir).deeplTarget;
  flushChain[dir] = flushChain[dir]
    .then(async () => {
      const translated = await translateText(sentence, target, dir);
      addLine(dir, sentence, translated);
      // Record AFTER translating, so a sentence is never its own context.
      recentSource[dir].push(sentence);
      if (recentSource[dir].length > CONTEXT_SENTENCES) recentSource[dir].shift();
    })
    .catch(() => { /* translateText already surfaced the error */ });
}

function appendPending(dir, chunk) {
  pendingParts[dir].push(chunk.trim());

  // Break on real sentence punctuation first. Deepgram's endpoint detection
  // regularly lands mid-sentence ("So those" | "two are memorable."), so emit
  // every complete sentence and keep only the trailing fragment buffered — it
  // then joins onto whatever is said next.
  const { complete, rest } = splitAtLastSentenceEnd(joinParts(pendingParts[dir]));
  if (complete) {
    pendingParts[dir] = rest ? [rest] : [];
    emitSentence(dir, complete);
  }
  renderPending(dir, '');

  if (!pendingParts[dir].length) {
    clearTimeout(flushTimers[dir]);
    flushTimers[dir] = null;
    return;
  }

  // Safety valves so a speaker who never pauses (or whose speech never gets
  // punctuated) still gets subtitles.
  if (joinParts(pendingParts[dir]).length >= maxCharsFor(dir)) {
    flushPending(dir);
    return;
  }
  clearTimeout(flushTimers[dir]);
  flushTimers[dir] = setTimeout(() => flushPending(dir), sentencePreset().maxMs);
}

function flushPending(dir) {
  clearTimeout(flushTimers[dir]);
  flushTimers[dir] = null;
  if (!pendingParts[dir].length) return;
  const sentence = joinParts(pendingParts[dir]);
  pendingParts[dir] = [];
  setInterim(dir, '');
  emitSentence(dir, sentence);
}

function discardPending(dir) {
  clearTimeout(flushTimers[dir]);
  flushTimers[dir] = null;
  pendingParts[dir] = [];
}

// ---- Pause / resume ----
function startKeepAlive(dir) {
  stopKeepAlive(dir);
  keepAliveTimers[dir] = setInterval(() => {
    const sock = sockets[dir];
    if (sock && sock.readyState === WebSocket.OPEN) {
      try { sock.send(JSON.stringify({ type: 'KeepAlive' })); } catch (e) { /* noop */ }
    }
  }, KEEPALIVE_MS);
}

function stopKeepAlive(dir) {
  if (keepAliveTimers[dir]) {
    clearInterval(keepAliveTimers[dir]);
    keepAliveTimers[dir] = null;
  }
}

function renderPauseUI(dir) {
  const cfg = directionConfig(dir);
  cfg.col.classList.toggle('paused', paused[dir]);
  if (cfg.pauseBtn) {
    cfg.pauseBtn.textContent = `${paused[dir] ? '▶' : '⏸'} (${cfg.hotkey})`;
    cfg.pauseBtn.title = paused[dir]
      ? `恢復這個翻譯方向（快捷鍵 ${cfg.hotkey}）`
      : `暫停這個翻譯方向（快捷鍵 ${cfg.hotkey}）`;
  }
}

function setPaused(dir, value) {
  paused[dir] = value;
  renderPauseUI(dir);
  if (value) {
    // Commit whatever was already said, then drop any in-flight partial text so
    // nothing stale is left on screen.
    flushPending(dir);
    setInterim(dir, '');
    startKeepAlive(dir);
  } else {
    stopKeepAlive(dir);
  }
}

function openSocket(dir) {
  const cfg = directionConfig(dir);
  const preset = sentencePreset();
  const params = new URLSearchParams({
    model: 'nova-2',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    language: cfg.dgLanguage,
    // Wait for a real pause before calling the sentence finished, and ask for an
    // explicit UtteranceEnd event as a backstop.
    endpointing: String(preset.endpointing),
    utterance_end_ms: String(preset.utteranceEndMs)
  });
  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  const sock = new WebSocket(url, ['token', apiKeys.deepgramApiKey]);
  sockets[dir] = sock;

  sock.onopen = () => {
    reconnecting[dir] = false;
    cfg.col.classList.add('live');
    // A socket that (re)opens while paused still needs its keep-alive heartbeat.
    if (paused[dir]) startKeepAlive(dir);
  };

  sock.onmessage = (event) => {
    try {
      // Results already in flight when the operator hit pause must not land.
      if (paused[dir]) return;
      const data = JSON.parse(event.data);

      // Backstop endpoint signal, sent as its own message type.
      if (data.type === 'UtteranceEnd') { flushPending(dir); return; }

      const alt = data.channel?.alternatives?.[0];
      const transcript = alt?.transcript;
      if (!transcript || !transcript.trim()) {
        // An empty speech_final still means "the sentence ended here".
        if (data.speech_final) flushPending(dir);
        return;
      }

      if (data.is_final) {
        // In bidirectional mode, suppress low-confidence chunks — these are usually
        // the "wrong" stream mishearing the other language.
        if (bidirectional && lowConfidence(alt)) {
          renderPending(dir, '');
          return;
        }
        // A genuine sentence on this side means the other side's preview text is
        // stale mis-hearing — clear it so only one column ever shows text.
        if (bidirectional) setInterim(otherDir(dir), '');
        // Note: we deliberately do NOT flush on speech_final. Deepgram raises it
        // on any sufficient pause, including mid-sentence breaths, which is what
        // produced the odd splits. Punctuation (handled in appendPending) decides
        // sentence boundaries; UtteranceEnd below covers "the speaker stopped".
        appendPending(dir, transcript);
      } else {
        // The idle direction constantly mis-hears the other language. Those
        // results were already kept out of the finalized lines, but they still
        // flickered through the grey preview line, so gate previews by the same
        // confidence bar.
        if (bidirectional && lowConfidence(alt)) return;
        renderPending(dir, transcript);
      }
    } catch (e) { /* ignore malformed frame */ }
  };

  sock.onerror = () => setStatus('Deepgram 連線發生錯誤，請確認 API Key 是否有效。', 'error');

  sock.onclose = (evt) => {
    cfg.col.classList.remove('live');
    const shouldRun = running && (dir === 'en2zh' || bidirectional);
    if (shouldRun && !reconnecting[dir] && evt.code !== 1000) {
      reconnecting[dir] = true;
      setTimeout(() => { if (running && (dir === 'en2zh' || bidirectional)) openSocket(dir); }, 1000);
    }
  };
}

function closeSocket(dir) {
  stopKeepAlive(dir);
  discardPending(dir);
  const sock = sockets[dir];
  if (sock) {
    try { sock.close(1000); } catch (e) { /* noop */ }
    sockets[dir] = null;
  }
  directionConfig(dir).col.classList.remove('live');
  setInterim(dir, '');
}

async function translateText(text, targetLang, dir) {
  const cfg = directionConfig(dir);
  try {
    return await LiveLingoDeepL.translate({
      text,
      targetLang,
      sourceLang: cfg.dgLanguage,
      // Previous sentences steer pronouns and continuations. Not translated,
      // and not billed by DeepL.
      context: recentSource[dir].join(' '),
      apiKey: apiKeys.deeplApiKey,
      plan: apiKeys.deeplPlan,
      glossaryId
    });
  } catch (err) {
    setStatus(`翻譯失敗：${err.message}`, 'error');
    return '';
  }
}

function stop() {
  running = false;
  reconnecting.en2zh = false;
  reconnecting.zh2en = false;
  // Commit the last partial sentence before tearing down (translation doesn't
  // need the socket), otherwise the final words are silently dropped.
  flushPending('en2zh');
  flushPending('zh2en');
  closeSocket('en2zh');
  closeSocket('zh2en');
  if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); workletNode = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  // Start clean next time rather than silently inheriting a paused direction.
  setPaused('en2zh', false);
  setPaused('zh2en', false);
  renderToggle();
  if (statusEl.className !== 'error') setStatus('已停止');
}

function renderToggle() {
  toggleBtn.textContent = running ? '停止' : '開始';
  toggleBtn.classList.toggle('stop', running);
}

// ---- Controls ----
toggleBtn.addEventListener('click', async () => {
  toggleBtn.disabled = true;
  if (!running) await start(); else stop();
  toggleBtn.disabled = false;
});

// Per-column pause/resume for the operator (e.g. mute 中→English during the talk).
pauseEnBtn.addEventListener('click', () => setPaused('en2zh', !paused.en2zh));
pauseZhBtn.addEventListener('click', () => setPaused('zh2en', !paused.zh2en));

// Toggling bidirectional live: open/close the reverse stream without restarting.
bidirEl.addEventListener('change', () => {
  bidirectional = bidirEl.checked;
  chrome.storage.local.set({ liveBidir: bidirectional });
  // Switching between centered single view and split view reflows both columns.
  reanchorAfterLayoutChange(refreshBidirUI);
  if (running) {
    if (bidirectional) {
      openSocket('zh2en');
      setStatus('聆聽中（雙向模式）…', 'active');
    } else {
      closeSocket('zh2en');
      setStatus('聆聽中（英文 → 中文）…', 'active');
    }
  }
  if (!bidirectional) {
    // Column headers (and their pause buttons) are hidden in single mode, so
    // never leave a direction paused with no way to resume it.
    setPaused('en2zh', false);
    setPaused('zh2en', false);
  }
});

// ---- Fullscreen ----
function renderFullscreenBtn() {
  const on = !!document.fullscreenElement;
  fullscreenBtn.textContent = on ? '⛶ 結束全螢幕' : '⛶ 全螢幕';
  fullscreenBtn.title = on ? '結束全螢幕（也可按 Esc）' : '切換全螢幕';
}

fullscreenBtn.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (err) {
    setStatus(`無法切換全螢幕：${err.message}`, 'error');
  }
});

// Covers Esc and the browser's own fullscreen shortcuts too, not just our button.
document.addEventListener('fullscreenchange', () => {
  renderFullscreenBtn();
  // The viewport just changed size, so keep following the newest line.
  reanchorAfterLayoutChange();
});
renderFullscreenBtn();

// How far down from the top counts as "reaching for the settings bar".
// Kept clear of the very top edge on purpose: in fullscreen the browser reveals
// its OWN toolbar when the pointer touches y≈0, and that would land on the
// projected screen.
const BAR_REVEAL_ZONE_PX = 30;

// The hover-reveal must be re-armed by moving away from the top first. Without
// this, hiding left the cursor sitting inside the reveal zone (it was just on the
// hide button), so the next pixel of movement popped the bar straight back open
// and it could never actually stay hidden.
let barRevealArmed = false;

function setBarHidden(hidden) {
  // Hiding always disarms the reveal; moving the pointer away re-arms it.
  if (hidden) barRevealArmed = false;
  // Showing/hiding the bar changes the columns' height, so re-anchor too.
  reanchorAfterLayoutChange(() => {
    barEl.classList.toggle('hidden', hidden);
    statusEl.classList.toggle('hidden', hidden);
  });
}

hideBarBtn.addEventListener('click', () => setBarHidden(true));

document.addEventListener('mousemove', (e) => {
  if (!barEl.classList.contains('hidden')) return;
  if (e.clientY > BAR_REVEAL_ZONE_PX) {
    barRevealArmed = true;   // moved away — a later move to the top may reveal
  } else if (barRevealArmed) {
    setBarHidden(false);
  }
});

// Operator shortcuts. H summons the settings bar without moving the mouse near
// the top (Esc is unreliable in fullscreen — the browser takes it to exit).
// L / R pause the left / right direction, matching the labels on the buttons.
document.addEventListener('keydown', (e) => {
  // Don't hijack typing in a control (e.g. while a dropdown has focus).
  const t = e.target;
  if (t && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(t.tagName)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;   // leave browser shortcuts alone

  const key = e.key.toLowerCase();
  if (key === 'h') {
    setBarHidden(!barEl.classList.contains('hidden'));
  } else if (e.key === 'Escape') {
    setBarHidden(false);
  } else if (key === 'l' || key === 'r') {
    // Only in bidirectional mode: in single mode the pause buttons are hidden,
    // so a hotkey could silently mute the one column with no way to see why.
    if (!bidirectional) return;
    const dir = key === 'l' ? 'en2zh' : 'zh2en';
    setPaused(dir, !paused[dir]);
  }
});

// Window/projector resolution changes also reflow the transcript.
window.addEventListener('resize', () => reanchorAfterLayoutChange());

window.addEventListener('beforeunload', () => { if (running) stop(); });

init();
