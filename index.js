// AutoCards-ST | index.js (v0.2.2)
// CHANGES: Approved-list persistence (per chat) using SillyTavern extensionSettings.
// Only APPROVED entries are saved and auto-restored on restart.
// Existing features:
// - Detects candidate terms from recent chat
// - Suggests short paragraph descriptions (configurable sentence target; default ~5)
// - Per-chat storage of APPROVED entries
// - Optional temporary injection on generate
// - One-click 'Commit to Lorebook' (tries public API, else exports current chat)
// - Config UI (scan depth, sentences, autoscan every N messages, toggles)
// - Per-chat export & all-chats export

(function () {
  'use strict';

  const MODULE_NAME = 'autocards_st';

  const ST = globalThis.SillyTavern?.getContext?.();
  if (!ST) {
    console.error('[AutoCards ST] SillyTavern context not available yet');
    return;
  }

  const { eventSource, event_types, extensionSettings, saveSettingsDebounced } = ST;
  const { lodash: _, DOMPurify } = SillyTavern.libs || {};

  // ---------- Utils ----------
  function save() { saveSettingsDebounced(); }

  function getChatKey() {
    const meta = ST.chat_metadata || {};
    const id = meta.chatId || meta.chat_id || ST.chatId || ST.selected_group || '';
    const char = ST?.character?.name || ST?.group_manager?.active_group?.name || 'default';
    return String(id || char);
  }

  // ---------- Settings / State ----------
  const defaults = Object.freeze({
    enabled: true,
    scanDepth: 20,
    minLen: 2,
    autoSuggest: true,
    injectOnGenerate: true,
    caseSensitive: false,

    sentenceTarget: 5,
    autoscanEnabled: false,
    autoscanEveryNMsgs: 20,

    // APPROVED entries are persisted here per-chat:
    perChat: {} // { [chatKey]: { entries: {term:{desc,keys,case_sensitive}}, seenCount:number } }
  });

  function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
      extensionSettings[MODULE_NAME] = structuredClone(defaults);
    }
    for (const k of Object.keys(defaults)) {
      if (!Object.hasOwn(extensionSettings[MODULE_NAME], k)) {
        extensionSettings[MODULE_NAME][k] = defaults[k];
      }
    }
    return extensionSettings[MODULE_NAME];
  }

  function ensureChatBucket() {
    const s = getSettings();
    const key = getChatKey();
    if (!s.perChat[key]) s.perChat[key] = { entries: {}, seenCount: 0 };
    return s.perChat[key];
  }

  // Approvals (only these persist)
  function entriesForThisChat() { return ensureChatBucket().entries; }
  function setEntry(term, obj) { ensureChatBucket().entries[term] = obj; save(); }
  function removeEntry(term) { delete ensureChatBucket().entries[term]; save(); }

  // ---------- UI ----------
  function addPanel() {
    if (document.getElementById('acst-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'acst-panel';
    panel.innerHTML = `
      <div class="acst-header">
        <span>AutoCards ST</span>
        <label class="acst-toggle">
          <input type="checkbox" id="acst-enabled">
          <span>Enabled</span>
        </label>
      </div>

      <div class="acst-row">
        <button id="acst-scan">Scan</button>
        <button id="acst-export-chat">Export This Chat</button>
        <button id="acst-export-all">Export All Chats</button>
        <button id="acst-commit">Commit to Lorebook</button>
        <button id="acst-clear" class="alt">Clear This Chat</button>
      </div>

      <div class="acst-row small">
        <label>Scan depth (messages):
          <input id="acst-depth" type="number" min="5" max="100" value="20" />
        </label>
      </div>

      <div class="acst-row small">
        <label>Target sentences:
          <input id="acst-sentences" type="number" min="1" max="10" value="5" />
        </label>
      </div>

      <div class="acst-row small">
        <label><input type="checkbox" id="acst-suggest" checked> Suggest descriptions with current model</label>
      </div>

      <div class="acst-row small">
        <label><input type="checkbox" id="acst-inject" checked> Inject approved entries during generation</label>
      </div>

      <div class="acst-row small">
        <label><input type="checkbox" id="acst-autoscan"> Auto-scan every
          <input id="acst-auton" type="number" min="5" max="100" value="20" style="width:66px;"> msgs
        </label>
      </div>

      <div class="acst-section">
        <h4>New Candidates</h4>
        <div id="acst-new"></div>
      </div>

      <div class="acst-section">
        <h4>Approved (per chat)</h4>
        <div class="acst-small">Chat key: <code id="acst-chatkey"></code></div>
        <div id="acst-approved"></div>
      </div>
    `;
    document.body.appendChild(panel);

    const s = getSettings();
    document.getElementById('acst-enabled').checked = !!s.enabled;
    document.getElementById('acst-depth').value = s.scanDepth;
    document.getElementById('acst-sentences').value = s.sentenceTarget;
    document.getElementById('acst-suggest').checked = !!s.autoSuggest;
    document.getElementById('acst-inject').checked = !!s.injectOnGenerate;
    document.getElementById('acst-autoscan').checked = !!s.autoscanEnabled;
    document.getElementById('acst-auton').value = s.autoscanEveryNMsgs;

    document.getElementById('acst-enabled').addEventListener('change', e => { s.enabled = e.target.checked; save(); });
    document.getElementById('acst-depth').addEventListener('change', e => { s.scanDepth = clampNum(e.target.value, 5, 100, 20); save(); });
    document.getElementById('acst-sentences').addEventListener('change', e => { s.sentenceTarget = clampNum(e.target.value, 1, 10, 5); save(); });
    document.getElementById('acst-suggest').addEventListener('change', e => { s.autoSuggest = e.target.checked; save(); });
    document.getElementById('acst-inject').addEventListener('change', e => { s.injectOnGenerate = e.target.checked; save(); });
    document.getElementById('acst-autoscan').addEventListener('change', e => { s.autoscanEnabled = e.target.checked; save(); });
    document.getElementById('acst-auton').addEventListener('change', e => { s.autoscanEveryNMsgs = clampNum(e.target.value, 5, 100, 20); save(); });

    document.getElementById('acst-clear').addEventListener('click', () => {
      ensureChatBucket().entries = {}; save(); renderApproved();
      document.getElementById('acst-new').innerHTML = `<div class="acst-empty">Cleared.</div>`;
    });

    document.getElementById('acst-export-chat').addEventListener('click', exportLorebookJSONForChat);
    document.getElementById('acst-export-all').addEventListener('click', exportLorebookJSONAll);
    document.getElementById('acst-commit').addEventListener('click', commitToLorebook);
    document.getElementById('acst-scan').addEventListener('click', async () => {
      const cands = detectFromRecent();
      await renderNewCandidates(cands);
      ST.toast?.('AutoCards ST: Scan complete.');
    });

    document.getElementById('acst-chatkey').textContent = getChatKey();
    renderApproved();
  }

  function clampNum(v, min, max, dflt) {
    const n = Number(v);
    if (Number.isNaN(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  }

  // ---------- Detection ----------
  function detectFromRecent() {
    const s = getSettings();
    const chat = ST.chat || [];
    const last = chat.slice(Math.max(0, chat.length - s.scanDepth));
    const text = last.map(x => (x?.mes ?? '')).join('\n');

    const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}|[A-Z]{2,})\b/g;
    const ignore = new Set(['You','The','A','An','And','But','He','She','They','We','I','It','Of','In','On','At','To','For','With','As','From','By','Or','Your','My']);
    const found = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      const term = m[1].trim();
      if (term.length < s.minLen) continue;
      if (ignore.has(term)) continue;
      if (entriesForThisChat()[term]) continue; // already approved
      found.add(term);
    }
    return Array.from(found).slice(0, 120);
  }

  // ---------- Suggestion via current model (configurable sentences) ----------
  async function suggestDescription(term) {
    try {
      const { generateQuietPrompt } = await import('../../../../script.js');
      const s = getSettings();
      const recent = (ST.chat || []).slice(-Math.max(8, s.scanDepth)).map(x => x?.mes || '').join('\n').slice(-5000);
      const prompt =
        `You are a concise world-info writer.\n` +
        `From the following conversation excerpts, write about ${s.sentenceTarget} sentences that neutrally define "${term}". ` +
        `Avoid second person; avoid commands; be compact but specific.\n\n` +
        `=== Conversation Context (may be partial) ===\n${recent}\n\n=== Output:===\n`;
      const out = await generateQuietPrompt({ quietPrompt: prompt });
      const text = (out?.trim?.() || out || '').replace(/\n{2,}/g, '\n').trim();
      return text || `${term}: A notable entity in the story.`;
    } catch (err) {
      console.warn('[AutoCards ST] suggestDescription failed, fallback:', err);
      return `${term}: A notable entity in the story.`;
    }
  }

  // ---------- UI renderers ----------
  async function renderNewCandidates(cands) {
    const wrap = document.getElementById('acst-new');
    wrap.innerHTML = '';
    if (!cands.length) {
      wrap.innerHTML = `<div class="acst-empty">No new candidates found. Send/receive more messages, then Scan.</div>`;
      return;
    }

    for (const term of cands) {
      const row = document.createElement('div');
      row.className = 'acst-item';
      row.innerHTML = `
        <div class="acst-term"><b>${DOMPurify?.sanitize(term) ?? term}</b></div>
        <textarea rows="4" placeholder="Short paragraph..." class="acst-desc"></textarea>
        <div class="acst-buttons">
          <button class="acst-suggest">Suggest</button>
          <button class="acst-approve">Approve</button>
          <button class="acst-ignore alt">Ignore</button>
        </div>
      `;
      const ta = row.querySelector('.acst-desc');

      row.querySelector('.acst-suggest').addEventListener('click', async () => {
        ta.value = 'Thinking…';
        const text = await suggestDescription(term);
        ta.value = text;
      });

      row.querySelector('.acst-approve').addEventListener('click', () => {
        setEntry(term, {
          desc: (ta.value || '').trim(),
          keys: [term],
          case_sensitive: !!getSettings().caseSensitive
        });
        renderApproved();
        row.remove();
      });

      row.querySelector('.acst-ignore').addEventListener('click', () => row.remove());
      wrap.appendChild(row);

      if (getSettings().autoSuggest) {
        suggestDescription(term).then(text => { if (!ta.value) ta.value = text; }).catch(()=>{});
      }
    }
  }

  function renderApproved() {
    const wrap = document.getElementById('acst-approved');
    const entries = entriesForThisChat();
    const terms = Object.keys(entries).sort((a,b)=>a.localeCompare(b));
    wrap.innerHTML = '';

    if (!terms.length) {
      wrap.innerHTML = `<div class="acst-empty">Nothing approved yet (for this chat).</div>`;
      return;
    }

    for (const term of terms) {
      const it = entries[term];
      const row = document.createElement('div');
      row.className = 'acst-item';
      row.innerHTML = `
        <div class="acst-term"><b>${DOMPurify?.sanitize(term) ?? term}</b></div>
        <div class="acst-small">Triggers: ${(it.keys||[]).join(', ')}</div>
        <textarea rows="4" class="acst-desc">${it.desc || ''}</textarea>
        <div class="acst-buttons">
          <button class="acst-remove alt">Remove</button>
        </div>
      `;
      const ta = row.querySelector('.acst-desc');
      ta.addEventListener('input', () => { it.desc = ta.value; save(); });
      row.querySelector('.acst-remove').addEventListener('click', () => { removeEntry(term); renderApproved(); });
      wrap.appendChild(row);
    }
  }

  // ---------- Export helpers ----------
  function listFromEntries(entriesObj) {
    return Object.entries(entriesObj).map(([key, obj]) => ({
      key,
      keys: obj.keys || [key],
      content: obj.desc || key,
      case_sensitive: !!obj.case_sensitive
    }));
  }

  function exportLorebookJSONForChat() {
    const list = listFromEntries(entriesForThisChat());
    const payload = { entries: list };
    const name = `AutoCards-ST_${getChatKey()}_lorebook.json`;
    downloadJSON(payload, name);
  }

  function exportLorebookJSONAll() {
    const s = getSettings();
    const merged = [];
    for (const [chatKey, bucket] of Object.entries(s.perChat || {})) {
      const list = listFromEntries(bucket.entries || {});
      merged.push(...list);
    }
    const payload = { entries: merged };
    const name = `AutoCards-ST_ALL_lorebook.json`;
    downloadJSON(payload, name);
  }

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Commit to Lorebook (current chat only) ----------
  async function commitToLorebook() {
    try {
      const api = ST.worldInfo || ST.world_info || {};
      const upsert = api.upsertEntries || api.addOrUpdate || api.addEntries;
      if (typeof upsert === 'function') {
        const list = listFromEntries(entriesForThisChat());
        await upsert(list);
        ST.toast?.(`AutoCards ST: committed ${list.length} entries to Lorebook (this chat).`);
        return;
      }
      ST.toast?.('AutoCards ST: direct Lorebook API not found; exporting This Chat instead.');
      exportLorebookJSONForChat();
    } catch (e) {
      console.warn('[AutoCards ST] commitToLorebook failed; exporting instead:', e);
      exportLorebookJSONForChat();
    }
  }

  // ---------- Prompt interceptor ----------
  // Minimal interceptor to prove the extension loads
globalThis.AutoCardsST_Interceptor = async function ({ injectionArray }) {
  try {
    // Optional: add a small marker into the prompt so you see it working
    if (Array.isArray(injectionArray)) {
      injectionArray.push({
        role: 'system',
        text: 'AutoCards ST interceptor is active.'
      });
    }
    // Optional toast so you see it on page load (if ST.toast exists)
    const ST = globalThis.SillyTavern?.getContext?.();
    ST?.toast?.('AutoCards ST: interceptor loaded');
  } catch (e) {
    console.warn('AutoCards ST: interceptor error', e);
  }
};


  // ---------- Auto-scan ----------
  function maybeAutoscan() {
    const s = getSettings();
    if (!s.autoscanEnabled) return;

    const bucket = ensureChatBucket();
    const currentCount = (ST.chat || []).length;
    const lastSeen = bucket.seenCount || 0;

    if (currentCount - lastSeen >= s.autoscanEveryNMsgs) {
      bucket.seenCount = currentCount; save();
      const cands = detectFromRecent();
      renderNewCandidates(cands).catch(()=>{});
      ST.toast?.('AutoCards ST: Auto-scan completed.');
    }
  }

  // ---------- Events ----------
  function onAppReady() {
    addPanel();
    const bucket = ensureChatBucket();
    bucket.seenCount = (ST.chat || []).length; save(); // initialize counter
    // Render approved entries persisted for this chat
    renderApproved();
  }

  eventSource.on(event_types.APP_READY, onAppReady);
  eventSource.on(event_types.CHAT_CHANGED, () => {
    const el = document.getElementById('acst-chatkey');
    if (el) el.textContent = getChatKey();
    renderApproved();
  });
  eventSource.on?.(event_types.MESSAGE_SENT, maybeAutoscan);
  eventSource.on?.(event_types.MESSAGE_RECEIVED, maybeAutoscan);
  setInterval(maybeAutoscan, 5000);
  setTimeout(onAppReady, 1500);
})();
