// offscreen.js — runs in the hidden offscreen document.
// Captures the target tab's audio stream, keeps it audible through speakers,
// downsamples it to 16k PCM, streams it to Deepgram for live transcription,
// and sends finalized sentences to DeepL for translation.

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let workletNode = null;
let deepgramSocket = null;
let currentConfig = null;
let reconnecting = false;

// ---- Sentence assembly ----
// Deepgram's `is_final` only means "this CHUNK of text is settled" — not "the
// sentence ended". Committing on is_final yields fragments ("The humans" /
// "have input." / "that") that each get translated in isolation, which also
// wrecks translation quality. So chunks are buffered and flushed as one sentence
// when Deepgram reports a real endpoint (`speech_final` / `UtteranceEnd`).
// maxChars is measured on the SOURCE text. Chinese packs far more meaning per
// character than English (100 Chinese characters can become 150-200 English
// words), so a CJK source gets a much lower cap or the output becomes a wall.
const SENTENCE = { endpointing: 800, utteranceEndMs: 1200, maxChars: 100, maxCharsCjk: 45, maxMs: 4000 };
const HAS_CJK = /[㐀-䶿一-鿿]/;
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

// Push the sentence-in-progress to the overlay as an interim (untranslated) line.
function renderPending(liveTail) {
  const text = joinParts([joinParts(pendingParts), liveTail]);
  chrome.runtime.sendMessage({
    type: 'TRANSCRIPT_RESULT',
    original: text,
    translated: '',
    isFinal: false
  });
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

// Queues one finished sentence. Chained so lines render in spoken order.
function emitSentence(sentence) {
  if (!sentence) return;
  const config = currentConfig;
  if (!config) return;
  flushChain = flushChain
    .then(async () => {
      const translated = await translateText(sentence, config);
      chrome.runtime.sendMessage({
        type: 'TRANSCRIPT_RESULT',
        original: sentence,
        translated,
        isFinal: true
      });
      // Record AFTER translating, so a sentence is never its own context.
      recentSource.push(sentence);
      if (recentSource.length > CONTEXT_SENTENCES) recentSource.shift();
    })
    .catch(() => { /* translateText already reported the error */ });
}

function appendPending(chunk) {
  pendingParts.push(chunk.trim());

  // Break on real sentence punctuation first. Deepgram's endpoint detection
  // regularly lands mid-sentence, so emit every complete sentence and keep only
  // the trailing fragment buffered — it joins onto whatever is said next.
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
  emitSentence(sentence);
}

function discardPending() {
  clearTimeout(flushTimer);
  flushTimer = null;
  pendingParts = [];
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'offscreen') return;
  if (message.type === 'OFFSCREEN_START') {
    startPipeline(message).catch((err) => reportError(err.message));
  } else if (message.type === 'OFFSCREEN_STOP') {
    stopPipeline();
  }
});

// Tell the service worker we've finished loading and are ready to receive
// OFFSCREEN_START — avoids a race where the start message arrives before
// this listener above is registered.
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });

async function startPipeline(config) {
  stopPipeline(); // clean up any previous session
  currentConfig = config;
  recentSource = [];   // a new session starts with no prior context

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: config.streamId
      }
    },
    video: false
  });

  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  // Keep the tab's audio audible — capturing via getUserMedia mutes normal output
  // unless we explicitly reconnect the stream to the destination.
  const passthroughGain = audioContext.createGain();
  passthroughGain.gain.value = 1.0;
  sourceNode.connect(passthroughGain);
  passthroughGain.connect(audioContext.destination);

  await audioContext.audioWorklet.addModule('pcm-worklet.js');
  workletNode = new AudioWorkletNode(audioContext, 'pcm-downsampler', {
    processorOptions: { targetSampleRate: 16000 }
  });
  sourceNode.connect(workletNode);

  connectDeepgram(config);

  workletNode.port.onmessage = (event) => {
    if (deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN) {
      deepgramSocket.send(event.data);
    }
  };
}

function connectDeepgram(config) {
  if (!config.deepgramApiKey) {
    reportError('尚未設定 Deepgram API Key，請至外掛設定頁面輸入。');
    return;
  }

  const params = new URLSearchParams({
    model: 'nova-2',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    // Wait for a real pause before declaring the sentence over, plus an explicit
    // UtteranceEnd event as a backstop.
    endpointing: String(SENTENCE.endpointing),
    utterance_end_ms: String(SENTENCE.utteranceEndMs)
  });

  // Deepgram's language detection (detect_language) only works for pre-recorded
  // audio, NOT live streaming — passing it here yields empty transcripts. So we
  // always send an explicit language, falling back to English if none was chosen.
  params.set('language', config.sourceLang && config.sourceLang !== 'auto'
    ? config.sourceLang
    : 'en');

  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  deepgramSocket = new WebSocket(url, ['token', config.deepgramApiKey]);

  deepgramSocket.onopen = () => {
    reconnecting = false;
  };

  deepgramSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      // Backstop endpoint signal, sent as its own message type.
      if (data.type === 'UtteranceEnd') { flushPending(); return; }

      const alt = data.channel?.alternatives?.[0];
      const transcript = alt?.transcript;
      if (!transcript || !transcript.trim()) {
        // An empty speech_final still means "the sentence ended here".
        if (data.speech_final) flushPending();
        return;
      }

      if (data.is_final) {
        // Note: we deliberately do NOT flush on speech_final. Deepgram raises it
        // on any sufficient pause, including mid-sentence breaths, which produced
        // odd splits. Punctuation (in appendPending) decides sentence boundaries;
        // UtteranceEnd above covers "the speaker stopped".
        appendPending(transcript);
      } else {
        renderPending(transcript);
      }
    } catch (err) {
      // ignore malformed frames
    }
  };

  deepgramSocket.onerror = () => {
    reportError('Deepgram 連線發生錯誤，請確認 API Key 是否有效。');
  };

  deepgramSocket.onclose = (event) => {
    // Deepgram closes idle/expired sockets; auto-reconnect while the pipeline is still active.
    if (currentConfig && !reconnecting && event.code !== 1000) {
      reconnecting = true;
      setTimeout(() => {
        if (currentConfig) connectDeepgram(currentConfig);
      }, 1000);
    }
  };
}

async function translateText(text, config) {
  if (!config.deeplApiKey) {
    reportError('尚未設定 DeepL API Key，請至外掛設定頁面輸入。');
    return '';
  }
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
    reportError(`翻譯失敗：${err.message}`);
    return '';
  }
}

function reportError(errorMessage) {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: errorMessage });
}

function stopPipeline() {
  // Commit the last partial sentence before clearing config (flushPending needs
  // currentConfig for the DeepL call), otherwise the final words are dropped.
  flushPending();
  discardPending();
  currentConfig = null;
  reconnecting = false;

  if (deepgramSocket) {
    try { deepgramSocket.close(1000); } catch (e) { /* noop */ }
    deepgramSocket = null;
  }
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
}
