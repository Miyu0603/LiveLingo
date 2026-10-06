// popup.js

const sourceLangEl = document.getElementById('sourceLang');
const targetLangEl = document.getElementById('targetLang');
const maxLinesEl = document.getElementById('maxLines');
const fontSizeEl = document.getElementById('fontSize');
const statusEl = document.getElementById('status');
const toggleBtn = document.getElementById('toggleBtn');
const openOptionsLink = document.getElementById('openOptions');

let currentTab = null;
let capturing = false;

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

function renderToggleButton() {
  if (capturing) {
    toggleBtn.textContent = '停止聆聽';
    toggleBtn.classList.add('stop');
  } else {
    toggleBtn.textContent = '開始聆聽並翻譯';
    toggleBtn.classList.remove('stop');
  }
}

async function init() {
  currentTab = await getCurrentTab();

  const stored = await chrome.storage.local.get([
    'sourceLang', 'targetLang', 'maxLines', 'lctSizeIndex'
  ]);
  const keys = await chrome.storage.sync.get(['deepgramApiKey', 'deeplApiKey']);
  if (stored.sourceLang) sourceLangEl.value = stored.sourceLang;
  if (stored.targetLang) targetLangEl.value = stored.targetLang;
  if (stored.maxLines) maxLinesEl.value = String(stored.maxLines);
  if (typeof stored.lctSizeIndex === 'number') fontSizeEl.value = String(stored.lctSizeIndex);

  if (!keys.deepgramApiKey || !keys.deeplApiKey) {
    setStatus('請先至「設定 API Key」輸入 Deepgram / DeepL 金鑰', 'error');
  }

  // Persist the line-count immediately so the overlay picks it up live,
  // even while capturing.
  maxLinesEl.addEventListener('change', () => {
    chrome.storage.local.set({
      maxLines: parseInt(maxLinesEl.value, 10),
      lctMaxLines: parseInt(maxLinesEl.value, 10)
    });
  });

  // Font size — content.js reacts to lctSizeIndex live via storage.onChanged.
  fontSizeEl.addEventListener('change', () => {
    chrome.storage.local.set({ lctSizeIndex: parseInt(fontSizeEl.value, 10) });
  });

  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  capturing = !!(status?.capturing && status.tabId === currentTab?.id);
  renderToggleButton();
  if (capturing) setStatus('聆聽中，字幕翻譯進行中…', 'active');
}

toggleBtn.addEventListener('click', async () => {
  if (!currentTab) return;
  toggleBtn.disabled = true;

  if (!capturing) {
    const lines = parseInt(maxLinesEl.value, 10);
    await chrome.storage.local.set({
      sourceLang: sourceLangEl.value,
      targetLang: targetLangEl.value,
      maxLines: lines,
      lctMaxLines: lines
    });
    setStatus('連線中…');
    const res = await chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      tabId: currentTab.id,
      sourceLang: sourceLangEl.value,
      targetLang: targetLangEl.value
    });
    if (res?.ok) {
      capturing = true;
      setStatus('聆聽中，字幕翻譯進行中…', 'active');
    } else {
      setStatus(`啟動失敗：${res?.error || '未知錯誤'}`, 'error');
    }
  } else {
    await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', tabId: currentTab.id });
    capturing = false;
    setStatus('已停止');
  }

  renderToggleButton();
  toggleBtn.disabled = false;
});

openOptionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById('micPageBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
  window.close();
});

document.getElementById('livePageBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('live.html') });
  window.close();
});

init();
