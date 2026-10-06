// deepl.js — shared DeepL client for every page that translates.
//
// Loaded as a plain script (no bundler), so it exposes `LiveLingoDeepL` on the
// window. Included by live.html, mic.html and offscreen.html BEFORE their own
// script. It exists because the same request was previously duplicated in three
// files, and every improvement had to be made three times (DEV-05).

(() => {
  const FREE_ENDPOINT = 'https://api-free.deepl.com/v2';
  const PRO_ENDPOINT  = 'https://api.deepl.com/v2';

  function baseUrl(plan) {
    return plan === 'pro' ? PRO_ENDPOINT : FREE_ENDPOINT;
  }

  function authHeaders(apiKey) {
    return {
      'Authorization': `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/json'
    };
  }

  async function readError(res) {
    const body = await res.text().catch(() => '');
    return new Error(`DeepL ${res.status}: ${body}`);
  }

  // The glossary holds en→zh and zh→en dictionaries, so only attach it when the
  // request actually uses one of those pairs — sending it for, say, ja→zh would
  // make DeepL reject the request. Codes are compared loosely because translate
  // uses variants (EN-US / ZH-HANT) while glossaries use base codes (en / zh).
  function glossarySupportsPair(sourceLang, targetLang) {
    const from = String(sourceLang || '').toLowerCase();
    const to = String(targetLang || '').toLowerCase();
    return (from.startsWith('en') && to.startsWith('zh')) ||
           (from.startsWith('zh') && to.startsWith('en'));
  }

  /**
   * Translate one sentence.
   * Throws on failure so each caller can surface the error its own way.
   *
   * `context` is surrounding text that steers the translation but is NOT
   * translated and is NOT billed — ideal for feeding the previous sentences of a
   * live transcript so pronouns and continuations resolve correctly.
   */
  async function translate({ text, targetLang, sourceLang, context, apiKey, plan, glossaryId }) {
    if (!apiKey) throw new Error('尚未設定 DeepL API Key');
    if (!text) return '';

    const body = {
      text: [text],
      target_lang: targetLang || 'ZH-HANT'
    };
    if (context) body.context = context;

    if (glossaryId && glossarySupportsPair(sourceLang, targetLang)) {
      body.glossary_id = glossaryId;
      // A glossary request must state its source language explicitly, otherwise
      // DeepL cannot pick the matching dictionary inside the glossary.
      body.source_lang = String(sourceLang).split('-')[0].toUpperCase();
    }

    const res = await fetch(`${baseUrl(plan)}/translate`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(body)
    });
    if (!res.ok) throw await readError(res);

    const json = await res.json();
    return json.translations?.[0]?.text || '';
  }

  // ---- Glossary management (used by the options page) ----

  // Glossary management uses the v3 API because a v3 glossary can hold SEVERAL
  // dictionaries (en→zh and zh→en) while still counting as ONE glossary against
  // the account limit. That matters a lot: the DeepL Free plan allows only one
  // glossary, so the earlier "create one per direction" approach could never
  // succeed there.
  function v3Url(plan) {
    return baseUrl(plan).replace('/v2', '/v3');
  }

  async function createGlossary({ name, dictionaries, apiKey, plan }) {
    const res = await fetch(`${v3Url(plan)}/glossaries`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        name,
        dictionaries: dictionaries.map(d => ({
          source_lang: d.sourceLang,
          target_lang: d.targetLang,
          entries: d.entries,
          entries_format: 'tsv'
        }))
      })
    });
    if (!res.ok) throw await readError(res);
    return res.json();
  }

  async function listGlossaries({ apiKey, plan }) {
    const res = await fetch(`${v3Url(plan)}/glossaries`, {
      method: 'GET',
      headers: authHeaders(apiKey)
    });
    if (!res.ok) throw await readError(res);
    const json = await res.json();
    return Array.isArray(json) ? json : (json.glossaries || []);
  }

  // Entries come back as TSV, one `source<TAB>target` pair per line.
  async function getGlossaryEntries({ glossaryId, sourceLang, targetLang, apiKey, plan }) {
    const query = new URLSearchParams({ source_lang: sourceLang, target_lang: targetLang });
    const res = await fetch(`${v3Url(plan)}/glossaries/${glossaryId}/entries?${query}`, {
      method: 'GET',
      headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}`, 'Accept': 'text/tab-separated-values' }
    });
    if (!res.ok) throw await readError(res);
    const text = await res.text();
    return text
      .split('\n')
      .map(line => line.split('\t'))
      .filter(parts => parts.length >= 2)
      .map(([source, target]) => ({ source: source.trim(), target: target.trim() }));
  }

  // Every glossary this extension creates is named with this prefix, so they can
  // be found and swept up later — including orphans left by a failed run.
  const GLOSSARY_PREFIX = 'LiveLingo ';

  function isOurs(glossary) {
    return typeof glossary?.name === 'string' && glossary.name.startsWith(GLOSSARY_PREFIX);
  }

  async function deleteGlossary({ glossaryId, apiKey, plan }) {
    if (!glossaryId) return;
    // Best effort: a stale id that is already gone must not block re-creating.
    try {
      await fetch(`${v3Url(plan)}/glossaries/${glossaryId}`, {
        method: 'DELETE',
        headers: authHeaders(apiKey)
      });
    } catch (e) {
      // Ignore — the new glossary is what matters.
    }
  }

  /**
   * Parse the term list the user types in the options page.
   * One pair per line, `英文=中文` (an `=` or a tab separates the two sides).
   * Lines starting with # are comments.
   */
  function parseTerms(raw) {
    const terms = [];
    const errors = [];
    String(raw || '').split('\n').forEach((line, i) => {
      const text = line.trim();
      if (!text || text.startsWith('#')) return;
      const parts = text.split(/\t|=/);
      if (parts.length < 2) {
        errors.push(`第 ${i + 1} 行缺少「=」：${text}`);
        return;
      }
      const source = parts[0].trim();
      const target = parts.slice(1).join('=').trim();
      if (!source || !target) {
        errors.push(`第 ${i + 1} 行有空白的一側：${text}`);
        return;
      }
      terms.push({ source, target });
    });
    return { terms, errors };
  }

  // A glossary cannot map one source term to two targets, so keep the first
  // occurrence. This matters most for the REVERSED direction: several English
  // terms often share one Chinese rendering (udn / United Daily News → 聯合報),
  // which would otherwise be a duplicate source and make DeepL reject the whole
  // glossary.
  function dedupeBySource(pairs) {
    const seen = new Set();
    const out = [];
    for (const pair of pairs) {
      const key = pair.source.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pair);
    }
    return out;
  }

  // DeepL expects TSV, so a term containing a tab or newline would corrupt it.
  function toTsv(pairs) {
    return dedupeBySource(pairs)
      .map(({ source, target }) => `${source.replace(/[\t\n]/g, ' ')}\t${target.replace(/[\t\n]/g, ' ')}`)
      .join('\n');
  }

  window.LiveLingoDeepL = {
    translate,
    glossarySupportsPair,
    createGlossary,
    listGlossaries,
    getGlossaryEntries,
    deleteGlossary,
    isOurs,
    GLOSSARY_PREFIX,
    parseTerms,
    dedupeBySource,
    toTsv
  };
})();
