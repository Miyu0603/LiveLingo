// options.js
// API keys live in chrome.storage.sync so they follow the user's Google account
// across their computers (Chrome must be signed in with sync enabled).

const KEY_FIELDS = ['deepgramApiKey', 'deeplApiKey', 'deeplPlan'];

const deepgramInput = document.getElementById('deepgramApiKey');
const deeplInput = document.getElementById('deeplApiKey');
const saveBtn = document.getElementById('saveBtn');
const savedLabel = document.getElementById('saved');
const planRadios = document.getElementsByName('deeplPlan');

// One-time migration: if keys were previously saved in local storage (older
// version) but not yet in sync, copy them up so this machine keeps working
// without re-entering anything.
async function migrateLocalToSync() {
  const sync = await chrome.storage.sync.get(KEY_FIELDS);
  if (sync.deepgramApiKey || sync.deeplApiKey) return; // already have synced keys
  const local = await chrome.storage.local.get(KEY_FIELDS);
  if (local.deepgramApiKey || local.deeplApiKey) {
    await chrome.storage.sync.set({
      deepgramApiKey: local.deepgramApiKey || '',
      deeplApiKey: local.deeplApiKey || '',
      deeplPlan: local.deeplPlan || 'free'
    });
  }
}

async function load() {
  await migrateLocalToSync();
  const data = await chrome.storage.sync.get(KEY_FIELDS);
  if (data.deepgramApiKey) deepgramInput.value = data.deepgramApiKey;
  if (data.deeplApiKey) deeplInput.value = data.deeplApiKey;
  const plan = data.deeplPlan || 'free';
  for (const radio of planRadios) {
    radio.checked = radio.value === plan;
  }
}

saveBtn.addEventListener('click', async () => {
  let plan = 'free';
  for (const radio of planRadios) {
    if (radio.checked) plan = radio.value;
  }
  await chrome.storage.sync.set({
    deepgramApiKey: deepgramInput.value.trim(),
    deeplApiKey: deeplInput.value.trim(),
    deeplPlan: plan
  });
  // Clean up any stale copy left in local storage from older versions.
  await chrome.storage.local.remove(KEY_FIELDS).catch(() => {});
  savedLabel.classList.add('show');
  setTimeout(() => savedLabel.classList.remove('show'), 1800);
});

// ---- Glossary ----
// A DeepL glossary is bound to one language pair, so two are built from the same
// term list: en→zh and the reversed zh→en, for bidirectional mode. Glossaries
// use the BASE language code (zh, not ZH-HANT).

const glossaryTermsEl = document.getElementById('glossaryTerms');
const buildGlossaryBtn = document.getElementById('buildGlossaryBtn');
const clearGlossaryBtn = document.getElementById('clearGlossaryBtn');
const listGlossaryBtn = document.getElementById('listGlossaryBtn');
const glossaryStatusEl = document.getElementById('glossaryStatus');
const glossaryListEl = document.getElementById('glossaryList');

const DEFAULT_TERMS = 'udn=聯合報';
// DeepL Free allows a single glossary with at most this many entries per
// language pair; Pro is effectively unlimited.
const FREE_MAX_ENTRIES = 5;

function setGlossaryStatus(text, kind) {
  glossaryStatusEl.textContent = text;
  glossaryStatusEl.className = 'hint' + (kind ? ' ' + kind : '');
}

async function loadGlossary() {
  const g = await chrome.storage.sync.get(['glossaryTerms', 'glossaryId']);
  glossaryTermsEl.value = typeof g.glossaryTerms === 'string' ? g.glossaryTerms : DEFAULT_TERMS;
  if (g.glossaryId) {
    setGlossaryStatus('目前已啟用詞彙表。', 'ok');
  } else {
    setGlossaryStatus('尚未建立詞彙表，翻譯目前不套用固定譯法。');
  }
}

function currentPlan() {
  for (const radio of planRadios) if (radio.checked) return radio.value;
  return 'free';
}

buildGlossaryBtn.addEventListener('click', async () => {
  const apiKey = deeplInput.value.trim();
  if (!apiKey) {
    setGlossaryStatus('請先填入 DeepL API Key。', 'error');
    return;
  }

  const { terms, errors } = LiveLingoDeepL.parseTerms(glossaryTermsEl.value);
  if (errors.length) {
    setGlossaryStatus(`格式有誤：${errors.join('；')}`, 'error');
    return;
  }
  if (!terms.length) {
    setGlossaryStatus('沒有任何詞彙，請至少輸入一組。', 'error');
    return;
  }

  const plan = currentPlan();
  if (plan === 'free' && terms.length > FREE_MAX_ENTRIES) {
    setGlossaryStatus(
      `DeepL Free 方案每個語言對最多 ${FREE_MAX_ENTRIES} 組詞彙，目前有 ${terms.length} 組。` +
      '請刪減，或改用 Pro 方案。',
      'error'
    );
    return;
  }
  buildGlossaryBtn.disabled = true;

  try {
    // Persist the keys first so the rest of the extension uses the same ones.
    await chrome.storage.sync.set({ deeplApiKey: apiKey, deeplPlan: plan });

    // Sweep our previous glossaries BEFORE creating the new ones. Creating first
    // and deleting after briefly doubles the count, which is exactly what hit the
    // account's "Too many glossaries" limit — and once it is hit, nothing can be
    // created again. This also clears orphans left behind by earlier failed runs.
    setGlossaryStatus('清理舊的詞彙表…');
    let existing = [];
    try {
      existing = await LiveLingoDeepL.listGlossaries({ apiKey, plan });
    } catch (e) {
      // Listing is only an optimisation; fall back to the stored id below.
    }
    const ours = existing.filter(LiveLingoDeepL.isOurs);
    for (const g of ours) {
      await LiveLingoDeepL.deleteGlossary({ glossaryId: g.glossary_id, apiKey, plan });
    }
    const stored = await chrome.storage.sync.get(['glossaryId']);
    if (stored.glossaryId && !ours.some(g => g.glossary_id === stored.glossaryId)) {
      await LiveLingoDeepL.deleteGlossary({ glossaryId: stored.glossaryId, apiKey, plan });
    }
    await chrome.storage.sync.remove(['glossaryId']);

    // ONE glossary holding both directions. A v3 glossary with several
    // dictionaries still counts as a single glossary, which is the only way this
    // fits the Free plan's limit of one.
    setGlossaryStatus('建立中…');
    const reversed = terms.map(t => ({ source: t.target, target: t.source }));
    const glossary = await LiveLingoDeepL.createGlossary({
      name: 'LiveLingo 詞彙表',
      dictionaries: [
        { sourceLang: 'en', targetLang: 'zh', entries: LiveLingoDeepL.toTsv(terms) },
        { sourceLang: 'zh', targetLang: 'en', entries: LiveLingoDeepL.toTsv(reversed) }
      ],
      apiKey,
      plan
    });

    await chrome.storage.sync.set({
      glossaryTerms: glossaryTermsEl.value,
      glossaryId: glossary.glossary_id
    });

    setGlossaryStatus(`已建立並啟用，共 ${terms.length} 組詞彙。`, 'ok');
  } catch (err) {
    if (/too many glossaries/i.test(err.message)) {
      setGlossaryStatus(
        '建立失敗：DeepL 帳號的詞彙表數量已達上限。本外掛建立的已自動清除，' +
        '代表額度是被其他詞彙表佔用 — 請按「查看帳號詞彙表」刪除不需要的，再試一次。',
        'error'
      );
    } else {
      setGlossaryStatus(`建立失敗：${err.message}`, 'error');
    }
  } finally {
    buildGlossaryBtn.disabled = false;
  }
});

// Lets the user see what is consuming the account's glossary quota, and delete
// individual entries. Deletion is per-row and explicit — this touches glossaries
// the extension did not create, so it is never done automatically.
async function renderGlossaryList() {
  const apiKey = deeplInput.value.trim();
  if (!apiKey) {
    setGlossaryStatus('請先填入 DeepL API Key。', 'error');
    return;
  }
  const plan = currentPlan();
  glossaryListEl.innerHTML = '';
  setGlossaryStatus('讀取中…');

  let glossaries;
  try {
    glossaries = await LiveLingoDeepL.listGlossaries({ apiKey, plan });
  } catch (err) {
    setGlossaryStatus(`讀取失敗：${err.message}`, 'error');
    return;
  }

  if (!glossaries.length) {
    setGlossaryStatus('這個 DeepL 帳號目前沒有任何詞彙表。', 'ok');
    return;
  }

  setGlossaryStatus(`這個帳號目前有 ${glossaries.length} 份詞彙表：`);
  for (const g of glossaries) {
    const row = document.createElement('div');
    row.className = 'gl-row';

    const name = document.createElement('span');
    name.className = 'gl-name';
    name.textContent = g.name + (LiveLingoDeepL.isOurs(g) ? '（本外掛建立）' : '');

    // A v3 glossary holds several dictionaries, so summarise each pair.
    const dicts = Array.isArray(g.dictionaries) && g.dictionaries.length
      ? g.dictionaries
      : [{ source_lang: g.source_lang, target_lang: g.target_lang, entry_count: g.entry_count }];

    const meta = document.createElement('span');
    meta.className = 'gl-meta';
    meta.textContent = dicts
      .map(d => `${d.source_lang}→${d.target_lang} · ${d.entry_count ?? '?'} 組`)
      .join('，');

    // The list alone doesn't say what is actually IN a glossary, which makes it
    // impossible to judge whether it is safe to delete. Fetch the terms on demand.
    const show = document.createElement('button');
    show.className = 'gl-del';
    show.style.cssText = 'background:#23252e;border-color:#343743;color:#cfcfe0';
    show.textContent = '看內容';
    show.addEventListener('click', async () => {
      show.disabled = true;
      show.textContent = '讀取中…';
      const box = document.createElement('div');
      box.className = 'gl-entries';
      try {
        for (const d of dicts) {
          const entries = await LiveLingoDeepL.getGlossaryEntries({
            glossaryId: g.glossary_id,
            sourceLang: d.source_lang,
            targetLang: d.target_lang,
            apiKey, plan
          });
          const head = document.createElement('div');
          head.className = 'gl-entries-head';
          head.textContent = `${d.source_lang} → ${d.target_lang}`;
          box.appendChild(head);
          entries.forEach(({ source, target }) => {
            const line = document.createElement('div');
            line.textContent = `${source} → ${target}`;
            box.appendChild(line);
          });
        }
        row.after(box);
        show.textContent = '已顯示';
      } catch (err) {
        show.disabled = false;
        show.textContent = '看內容';
        setGlossaryStatus(`讀取內容失敗：${err.message}`, 'error');
      }
    });

    const del = document.createElement('button');
    del.className = 'gl-del';
    del.textContent = '刪除';
    del.addEventListener('click', async () => {
      del.disabled = true;
      del.textContent = '刪除中…';
      await LiveLingoDeepL.deleteGlossary({ glossaryId: g.glossary_id, apiKey, plan });
      row.remove();
    });

    row.append(name, meta, show, del);
    glossaryListEl.appendChild(row);
  }
}

listGlossaryBtn.addEventListener('click', renderGlossaryList);

clearGlossaryBtn.addEventListener('click', async () => {
  const apiKey = deeplInput.value.trim();
  const plan = currentPlan();
  const previous = await chrome.storage.sync.get(['glossaryId']);
  await chrome.storage.sync.remove(['glossaryId']);
  if (apiKey) {
    await LiveLingoDeepL.deleteGlossary({ glossaryId: previous.glossaryId, apiKey, plan });
  }
  setGlossaryStatus('已停用詞彙表（詞彙內容仍保留，可隨時重新建立）。');
});

load();
loadGlossary();
