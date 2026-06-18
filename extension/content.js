(() => {
  'use strict';

  const LOG_PREFIX = '[F-list Workbench]';
  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);
  const err = (...args) => console.error(LOG_PREFIX, ...args);

  function getCharacterName() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('character');
    if (fromUrl) return fromUrl;
    const heading = document.querySelector('h2')?.textContent || '';
    return heading.replace(/^Editing\s+/, '').trim() || null;
  }

  function sendBg(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: 'runtime', detail: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: 'no_response' });
        }
      });
    });
  }

  function makeEl(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v);
    }
    children.forEach((c) => el.appendChild(c));
    return el;
  }

  function openModal({ title, body, footer }) {
    const overlay = makeEl('div', { class: 'flist-wb-overlay' });
    const modal = makeEl('div', { class: 'flist-wb-modal' });

    const header = makeEl('div', { class: 'flist-wb-modal-header' });
    header.appendChild(makeEl('div', { class: 'flist-wb-modal-title', text: title }));
    const close = makeEl('button', { class: 'flist-wb-modal-close', text: '×' });
    close.addEventListener('click', () => overlay.remove());
    header.appendChild(close);

    const bodyEl = makeEl('div', { class: 'flist-wb-modal-body' });
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);

    const footerEl = makeEl('div', { class: 'flist-wb-modal-footer' });
    if (footer) (Array.isArray(footer) ? footer : [footer]).forEach((b) => footerEl.appendChild(b));

    modal.appendChild(header);
    modal.appendChild(bodyEl);
    modal.appendChild(footerEl);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', esc);
      }
    });

    return { overlay, modal, body: bodyEl, footer: footerEl, close: () => overlay.remove() };
  }

  function toast({ title, message, kind = 'info', durationMs = 5000 }) {
    const el = makeEl('div', { class: `flist-wb-toast ${kind}` });
    if (title) el.appendChild(makeEl('div', { class: 'flist-wb-toast-title', text: title }));
    el.appendChild(makeEl('div', { text: message }));
    document.body.appendChild(el);
    if (durationMs > 0) setTimeout(() => el.remove(), durationMs);
    return el;
  }

  function extractImageData() {
    const images = [];
    document.querySelectorAll('.character_image').forEach((container) => {
      const preview = container.querySelector('.character_image_preview');
      const desc = container.querySelector('.character_image_description');
      const style = preview?.style.backgroundImage || '';
      const match = style.match(/url\(["']?(.*?)["']?\)/);
      const thumbUrl = match ? match[1] : null;
      const imageId = container.id.replace('image', '');
      if (thumbUrl && imageId) {
        images.push({
          id: imageId,
          thumbUrl,
          fullUrl: thumbUrl.replace('/charthumb/', '/charimage/'),
          description: desc?.value || '',
        });
      }
    });
    const avatarImg = document.querySelector('img[src*="/images/avatar/"]');
    return { images, avatar: avatarImg?.src || null };
  }

  function extractCharacterFormState() {
    const form = document.getElementById('CharacterForm');
    if (!form) throw new Error('Character form not found on page');

    const data = {
      meta: { extractedAt: new Date().toISOString(), source: 'extension' },
      character: {
        id: form.querySelector('[name="character_id"]')?.value || null,
        name: getCharacterName(),
        description: form.querySelector('[name="description"]')?.value || '',
        customTitle: form.querySelector('[name="custom_title"]')?.value || '',
      },
      settings: {},
      infotags: {},
      kinks: {},
      customKinks: [],
    };

    ['public', 'showtimezone', 'unbookmarkable', 'showbadges',
     'showfriends', 'customsfirst', 'moderate', 'showcharlist'].forEach((name) => {
      const el = form.querySelector(`[name="${name}"]`);
      if (el) data.settings[name] = el.type === 'checkbox' ? el.checked : el.value;
    });

    form.querySelectorAll('[name^="info_"]').forEach((el) => {
      if (el.value) data.infotags[el.name] = el.value;
    });

    form.querySelectorAll('[name^="fetish_"]').forEach((el) => {
      data.kinks[el.name] = el.value;
    });

    const names = form.querySelectorAll('[name="customkinkname[]"]');
    const descs = form.querySelectorAll('[name="customkinkdescription[]"]');
    const choices = form.querySelectorAll('[name="customkinkchoice[]"]');
    const ids = form.querySelectorAll('[name="customkinkid[]"]');
    for (let i = 0; i < names.length; i++) {
      if (names[i].value) {
        data.customKinks.push({
          id: ids[i]?.value || null,
          name: names[i].value,
          description: descs[i]?.value || '',
          choice: choices[i]?.value || '',
        });
      }
    }
    return data;
  }

  function fireChange(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setTextFieldValue(el, value) {
    el.value = value;
    fireChange(el);
  }

  function setCheckboxValue(el, value) {
    el.checked = !!value;
    fireChange(el);
  }

  // Selects are the tricky case: F-list overlays Select2 (or similar)
  // widgets on infotag and kink dropdowns, so changing .value natively
  // updates the underlying <select> but the visible widget keeps the
  // old label. We route through pageworld.js which calls
  // $(sel).val(x).trigger('change') — that updates both layers.
  async function setSelectValue(el, value) {
    el.value = value;
    fireChange(el);
    if (el.name) await callPage('setSelectVal', { name: el.name, value: String(value) }, 4_000);
  }

  // ===== DIAGNOSTIC BUILD =====
  // Heavy console logging behind a single prefix so the user can grab
  // the block with Ctrl+F. Does NOT change apply behavior.
  // Build identifier — updated on each push so the user can confirm in
  // console which commit they're actually running (browser cache, CDN
  // staleness, "did I really click Reload?" — all easier to rule out
  // when the hash is right there in the diag header).
  const EXT_BUILD = 'image-reorder';
  const DIAG_PREFIX = `[F-list Workbench DIAG @ ${EXT_BUILD}]`;
  function diag(...args) { console.log(DIAG_PREFIX, ...args); }
  function diagGroup(title) { console.group(DIAG_PREFIX + ' ' + title); }
  function diagGroupEnd() { console.groupEnd(); }

  function diagDumpFormShape() {
    diagGroup('FORM-SHAPE');
    const form = document.getElementById('CharacterForm');
    diag('CharacterForm present:', !!form);
    if (!form) { diagGroupEnd(); return; }

    const allInputs = Array.from(form.querySelectorAll('input, select, textarea'));
    diag('total form inputs/selects/textareas:', allInputs.length);

    // Group by tag + name-prefix.
    const byPrefix = {};
    for (const el of allInputs) {
      const name = el.getAttribute('name') || '';
      let pfx;
      if (!name) pfx = '(no-name id=' + (el.id || 'anon') + ')';
      else if (/^[0-9]+$/.test(name)) pfx = '<numeric>';
      else if (name.startsWith('info_')) pfx = 'info_*';
      else if (name.startsWith('infotag')) pfx = 'infotag*';
      else if (name.startsWith('fetish_')) pfx = 'fetish_*';
      else if (name.startsWith('kink_')) pfx = 'kink_*';
      else if (name.startsWith('customkink')) pfx = 'customkink*';
      else pfx = name;
      byPrefix[pfx] = (byPrefix[pfx] || 0) + 1;
    }
    diag('inputs grouped by name-prefix:', JSON.stringify(byPrefix, null, 2));

    // Sample of selects + their first option labels.
    const selects = Array.from(form.querySelectorAll('select'));
    diag('total <select> elements:', selects.length);
    diag('first 10 selects (name, id, current value, first 3 option values):',
      JSON.stringify(selects.slice(0, 10).map((s) => ({
        name: s.name, id: s.id, value: s.value,
        opt0: s.options[0]?.value, opt1: s.options[1]?.value, opt2: s.options[2]?.value,
      })), null, 2));

    // Custom kink containers + inputs.
    const customContainers = Array.from(document.querySelectorAll('[id^="CustomKink"]'));
    diag('CustomKink* containers:', customContainers.length,
      'IDs:', customContainers.slice(0, 8).map((c) => c.id));
    const customNames = Array.from(form.querySelectorAll('[name="customkinkname[]"]'));
    const altCustomNames = Array.from(form.querySelectorAll('[name^="customkinkname"]'));
    diag('selector [name="customkinkname[]"] matches:', customNames.length);
    diag('selector [name^="customkinkname"] matches:', altCustomNames.length);
    if (altCustomNames.length > 0) {
      diag('first 5 customkinkname* element names:',
        altCustomNames.slice(0, 5).map((e) => e.name));
    }

    // Widget detection.
    diag('jQuery present (window.$):', typeof window.$ === 'function');
    diag('window.FList present:', typeof window.FList === 'object');
    diag('Select2 widgets in DOM (.select2-container):',
      document.querySelectorAll('.select2-container, .select2, span.select2-selection').length);

    diagGroupEnd();
  }

  function diagDumpPayload(data) {
    diagGroup('PAYLOAD');
    diag('character.id:', data.character?.id);
    diag('character.name:', data.character?.name);
    diag('description length:', (data.character?.description || '').length);
    diag('customTitle:', JSON.stringify(data.character?.customTitle));
    diag('settings keys:', Object.keys(data.settings || {}));
    const infoKeys = Object.keys(data.infotags || {});
    diag('infotags count:', infoKeys.length, 'sample keys:', infoKeys.slice(0, 10));
    diag('first 5 infotag entries:', JSON.stringify(
      Object.fromEntries(Object.entries(data.infotags || {}).slice(0, 5))));
    const kinkKeys = Object.keys(data.kinks || {});
    diag('kinks count:', kinkKeys.length, 'sample keys:', kinkKeys.slice(0, 10));
    diag('first 5 kink entries:', JSON.stringify(
      Object.fromEntries(Object.entries(data.kinks || {}).slice(0, 5))));
    diag('customKinks count:', (data.customKinks || []).length);
    if (data.customKinks?.[0]) {
      diag('first customKink:', JSON.stringify(data.customKinks[0]));
    }
    diagGroupEnd();
  }

  async function applyCharacterData(data, selections = {}) {
    const form = document.getElementById('CharacterForm');
    if (!form) throw new Error('Character form not found on page');

    diag('===BEGIN APPLY DIAGNOSTICS=== copy from here to ===END===');
    diag('selections:', JSON.stringify(selections));
    diagDumpFormShape();
    diagDumpPayload(data);

    const result = { fields: 0, kinks: 0, customKinks: 0, warnings: [] };

    if (selections.description !== false) {
      const desc = form.querySelector('[name="description"]');
      diag('description: selector matched:', !!desc, '— before length:', desc?.value?.length);
      if (desc) { setTextFieldValue(desc, data.character?.description || ''); result.fields++; }
      diag('description: after length:', desc?.value?.length);

      const title = form.querySelector('[name="custom_title"]');
      diag('custom_title: selector matched:', !!title);
      if (title) { setTextFieldValue(title, data.character?.customTitle || ''); result.fields++; }
    } else {
      diag('description: skipped (unchecked)');
    }

    if (selections.settings !== false && data.settings) {
      diagGroup('SETTINGS');
      for (const [name, value] of Object.entries(data.settings)) {
        const el = form.querySelector(`[name="${name}"]`);
        diag(`setting [${name}] = ${JSON.stringify(value)}: matched=${!!el}${el ? ' tag=' + el.tagName + ' type=' + el.type : ''}`);
        if (!el) continue;
        if (el.type === 'checkbox') setCheckboxValue(el, value);
        else if (el.tagName === 'SELECT') await setSelectValue(el, value);
        else setTextFieldValue(el, value);
        result.fields++;
      }
      diagGroupEnd();
    }

    if (selections.infotags !== false) {
      diagGroup('INFOTAGS — clear all then apply');
      const allInfotagFields = Array.from(form.querySelectorAll('[name^="info_"]'));
      diag('clearing', allInfotagFields.length, 'info_* fields first');
      for (const el of allInfotagFields) {
        if (el.tagName === 'SELECT') {
          await setSelectValue(el, '');
        } else if (el.type === 'checkbox' || el.type === 'radio') {
          setCheckboxValue(el, false);
        } else {
          setTextFieldValue(el, '');
        }
      }
      if (data.infotags) {
        for (const [name, value] of Object.entries(data.infotags)) {
          const el = form.querySelector(`[name="info_${name}"]`);
          if (!el) {
            diag(`infotag[${name}] no element matched — skipping`);
            continue;
          }
          if (el.tagName === 'SELECT') await setSelectValue(el, value);
          else setTextFieldValue(el, value);
          result.fields++;
        }
      }
      diagGroupEnd();
    } else {
      diag('infotags: skipped (unchecked)');
    }

    if (selections.kinks !== false) {
      diagGroup('KINKS — diff-only apply via FList.CharEditor_selectFetish');
      // F-list's edit-page kink picker is a click-driven widget: each
      // kink has #FetishSelect<id> (hidden input, name="fetish_<id>")
      // plus .FetishLink<id> + .FetishImage<id> visual chips. The
      // function FList.CharEditor_selectFetish(id, choice, force) is
      // the same entry point the click handlers invoke — updates the
      // hidden input + toggles the chip CSS classes in lockstep, so
      // both layers stay in sync (no "form saves but picker doesn't
      // move" trust gap on restore).
      //
      // Diff-only: only emit calls where the kink's current page value
      // differs from the working-set target. Saves 500+ no-op redraws
      // on a typical restore where most standards are undecided on
      // both sides.
      const allKinkFields = Array.from(form.querySelectorAll('[name^="fetish_"]'));
      const targetMap = new Map();
      if (data.kinks) {
        for (const [k, v] of Object.entries(data.kinks)) {
          targetMap.set(String(k), String(v));
        }
      }
      let changes = 0, fails = 0, skipped = 0;
      for (const el of allKinkFields) {
        const id = el.name.replace(/^fetish_/, '');
        const current = el.value || 'undecided';
        const target = targetMap.get(id) || 'undecided';
        if (current === target) { skipped++; continue; }
        const r = await callPage('selectFetish', { id, choice: target }, 4_000);
        if (r.ok) {
          changes++;
          if (target !== 'undecided') result.kinks++;
        } else {
          fails++;
          if (fails <= 3) diag(`selectFetish fetish_${id} → ${target} failed:`, JSON.stringify(r));
        }
      }
      diag(`kinks: ${changes} changed, ${skipped} already-matching, ${fails} failed`);
      diagGroupEnd();
    } else {
      diag('kinks: skipped (unchecked)');
    }

    if (selections.customKinks !== false) {
      diagGroup('CUSTOM KINKS');
      const existingContainers = document.querySelectorAll(
        '[id^="CustomKink"]:not([id="CustomKinksList"]):not([id*="TEMPLATE"])'
      );
      diag('existing CustomKink containers before remove:', existingContainers.length,
        'IDs:', Array.from(existingContainers).slice(0, 10).map((c) => c.id));
      for (const container of existingContainers) {
        const match = container.id.match(/CustomKink(\d+)/);
        if (!match) continue;
        const r1 = await callPage('jqueryRemove', { selector: container.id });
        const r2 = await callPage('removeCustomKink', { id: match[1] });
        diag(`removed ${container.id}: jqueryRemove=${JSON.stringify(r1)} removeCustomKink=${JSON.stringify(r2)}`);
      }
      diag('CustomKink containers after remove:',
        document.querySelectorAll('[id^="CustomKink"]:not([id="CustomKinksList"]):not([id*="TEMPLATE"])').length);

      const customKinks = data.customKinks || [];
      if (customKinks.length > 0) {
        for (let i = 0; i < customKinks.length; i++) {
          const r = await callPage('addCustomKink');
          if (i === 0 || i === customKinks.length - 1) {
            diag(`addCustomKink #${i + 1}/${customKinks.length}:`, JSON.stringify(r));
          }
        }
        await new Promise((r) => setTimeout(r, 200));
        diag('after add-loop: CustomKink containers:',
          document.querySelectorAll('[id^="CustomKink"]:not([id="CustomKinksList"]):not([id*="TEMPLATE"])').length);
        diag('after add-loop: customkinkname[] inputs:',
          document.querySelectorAll('[name="customkinkname[]"]').length);
        diag('after add-loop: customkinkname* inputs:',
          document.querySelectorAll('[name^="customkinkname"]').length);
        const fillRes = await callPage('setCustomKinkRows', { rows: customKinks }, 8_000);
        diag('setCustomKinkRows result:', JSON.stringify(fillRes));
        result.customKinks = customKinks.length;
      }
      diagGroupEnd();
    } else {
      diag('customKinks: skipped (unchecked)');
    }

    diag('===END APPLY DIAGNOSTICS=== copy stops here');
    return result;
  }

  // RPC bridge to pageworld.js (manifest "world": "MAIN"). F-list's CSP
  // forbids inline <script> tags so direct text-injection silently
  // no-ops; extension content scripts with explicit world="MAIN" are
  // exempt from page CSP because they're extension code. Bridge is
  // window.postMessage with a small request/response protocol.
  let bridgeReady = false;
  let bridgeReadyResolvers = [];
  let rpcCounter = 0;
  const rpcPending = new Map();

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'flist-wb-rpc-ready') {
      bridgeReady = true;
      const resolvers = bridgeReadyResolvers;
      bridgeReadyResolvers = [];
      resolvers.forEach((r) => r());
      return;
    }
    if (m.type === 'flist-wb-rpc-result') {
      const pending = rpcPending.get(m.id);
      if (pending) {
        rpcPending.delete(m.id);
        pending(m);
      }
    }
  });

  function waitForBridge(timeoutMs = 4000) {
    if (bridgeReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        bridgeReadyResolvers = bridgeReadyResolvers.filter((r) => r !== onReady);
        resolve(false);
      }, timeoutMs);
      const onReady = () => { clearTimeout(timer); resolve(true); };
      bridgeReadyResolvers.push(onReady);
    });
  }

  function callPage(action, args = {}, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const id = ++rpcCounter;
      const timer = setTimeout(() => {
        if (rpcPending.has(id)) {
          rpcPending.delete(id);
          resolve({ ok: false, error: 'rpc_timeout', action });
        }
      }, timeoutMs);
      rpcPending.set(id, (msg) => {
        clearTimeout(timer);
        resolve({ ok: msg.ok, error: msg.error, note: msg.note });
      });
      window.postMessage({ type: 'flist-wb-rpc', id, action, args }, '*');
    });
  }

  async function uploadSingleImage(bytes, filename) {
    const fileInput = document.getElementById('imagefile');
    if (!fileInput) throw new Error('Image file input not found');

    const beforeCount = document.querySelectorAll('.character_image').length;
    const mime = filename.endsWith('.png') ? 'image/png'
               : filename.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
    const file = new File([new Blob([bytes], { type: mime })], filename, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;

    const callPromise = callPage('uploadImage', {}, 30_000);

    return new Promise((resolve, reject) => {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        const after = document.querySelectorAll('.character_image').length;
        if (after > beforeCount) {
          clearInterval(interval);
          const containers = document.querySelectorAll('.character_image');
          resolve(containers[containers.length - 1]?.id?.replace('image', '') || null);
        } else if (attempts >= 60) {
          clearInterval(interval);
          callPromise.then((r) => reject(new Error('Upload timeout' + (r && r.error ? ' (' + r.error + ')' : ''))));
        }
      }, 500);
    });
  }

  async function uploadAvatarBytes(bytes, filename) {
    diag('===BEGIN AVATAR DIAGNOSTICS=== copy from here to ===END AVATAR===');

    // Dump every plausible avatar-related element so we can see what
    // F-list actually exposes.
    const fileInputByName = document.querySelector('input[type="file"][name="avatar"]');
    const fileInputById = document.getElementById('avatar-file');
    const fileInputFuzzy = document.querySelector('input[type="file"][id*="avatar" i]');
    const avatarRelated = Array.from(document.querySelectorAll(
      '[id*="avatar" i], [name*="avatar" i], [class*="avatar" i]'
    )).slice(0, 30).map((e) => ({
      tag: e.tagName,
      id: e.id || null,
      name: e.getAttribute('name'),
      type: e.type || null,
      className: typeof e.className === 'string' ? e.className.slice(0, 80) : null,
      text: (e.textContent || '').trim().slice(0, 60),
    }));
    diag('avatar element scan:', JSON.stringify(avatarRelated, null, 2));

    // Also: anonymous-named inputs the form-shape diag flagged earlier.
    const anonInputs = Array.from(document.querySelectorAll(
      '#CharacterForm input:not([name]), #CharacterForm button:not([name])'
    )).slice(0, 12).map((e) => ({
      tag: e.tagName,
      id: e.id || null,
      type: e.type || null,
      value: e.value || null,
      text: (e.textContent || '').trim().slice(0, 60),
    }));
    diag('anonymous inputs/buttons in CharacterForm:', JSON.stringify(anonInputs, null, 2));

    const fileInput = fileInputByName || fileInputById || fileInputFuzzy;
    diag(`fileInput chosen: byName=${!!fileInputByName} byId=${!!fileInputById} fuzzy=${!!fileInputFuzzy}`,
      fileInput ? `(name="${fileInput.name}" id="${fileInput.id}")` : '(none)');
    if (!fileInput) {
      diag('===END AVATAR=== (no file input found)');
      throw new Error('Avatar file input not found');
    }

    const mime = filename.endsWith('.png') ? 'image/png'
               : filename.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
    const file = new File([new Blob([bytes], { type: mime })], filename, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;

    // Verify the assignment took.
    diag(`after set: fileInput.files.length = ${fileInput.files.length}`,
      fileInput.files[0] ? `file[0]={name:"${fileInput.files[0].name}", size:${fileInput.files[0].size}, type:"${fileInput.files[0].type}"}` : '');

    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Some F-list flows trigger upload via a JS helper rather than
    // form submission. Try the page-world hook for any of them.
    const r = await callPage('uploadAvatar', {}, 15_000);
    diag('uploadAvatar RPC result:', JSON.stringify(r));

    // Look for a button labelled like avatar-upload and click it as a
    // last resort. F-list's image gallery has a similar "Add Image"
    // button pattern.
    const clickCandidates = Array.from(document.querySelectorAll(
      'button, input[type="button"], input[type="submit"], a'
    )).filter((b) => {
      const t = ((b.value || '') + ' ' + (b.textContent || '')).trim().toLowerCase();
      return /upload\s*avatar|set\s*avatar|change\s*avatar|new\s*avatar|update\s*avatar/.test(t);
    });
    diag(`avatar-upload-like button candidates: ${clickCandidates.length}`,
      JSON.stringify(clickCandidates.slice(0, 5).map((b) => ({
        tag: b.tagName, text: (b.textContent || '').trim().slice(0, 40), value: b.value, id: b.id,
      }))));

    diag('===END AVATAR=== copy stops here');
    return true;
  }

  function deleteImageById(imageId) {
    const callPromise = callPage('deleteImage', { id: String(imageId) }, 15_000);
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (!document.getElementById(`image${imageId}`)) {
          clearInterval(interval);
          resolve();
        } else if (attempts >= 30) {
          clearInterval(interval);
          callPromise.then((r) => reject(new Error('Delete timeout' + (r && r.error ? ' (' + r.error + ')' : ''))));
        }
      }, 500);
    });
  }

  // Content-script-direct sidecar calls. Going through the service
  // worker would force chrome.runtime.sendMessage to serialise the ZIP
  // bytes as a JSON array, which both inflates ~4x and hits Chrome's
  // 64 MiB IPC ceiling. Direct fetch is cross-origin (page is on
  // f-list.net, sidecar on 127.0.0.1) but the sidecar's CORS middleware
  // is allow-all, so the response lands cleanly as an ArrayBuffer.
  const SIDECAR_BASE = 'http://127.0.0.1:27384';

  async function getStoredToken() {
    try {
      const { workbench_token } = await chrome.storage.local.get('workbench_token');
      return workbench_token || null;
    } catch {
      return null;
    }
  }

  async function sidecarGet(path) {
    const token = await getStoredToken();
    if (!token) return { ok: false, error: 'not_paired', status: 401 };
    try {
      const res = await fetch(SIDECAR_BASE + path, {
        headers: { 'X-Workbench-Auth': token },
      });
      return res;
    } catch (e) {
      return { ok: false, error: 'unreachable', detail: String(e) };
    }
  }

  async function snapshotsList(character) {
    const res = await sidecarGet('/restore/snapshots?character=' + encodeURIComponent(character));
    if (res.ok === false) return res;
    if (res.status === 401) return { ok: false, error: 'not_paired', status: 401 };
    if (!res.ok) return { ok: false, error: 'list_failed', status: res.status };
    return { ok: true, snapshots: await res.json() };
  }

  async function snapshotZipBytes(character, snapshotId) {
    const res = await sidecarGet(
      '/restore/snapshot/' + encodeURIComponent(snapshotId) +
        '?character=' + encodeURIComponent(character)
    );
    if (res.ok === false) return res;
    if (!res.ok) return { ok: false, error: 'fetch_failed', status: res.status };
    const buf = await res.arrayBuffer();
    return { ok: true, bytes: new Uint8Array(buf) };
  }

  async function archivedCharactersList() {
    const res = await sidecarGet('/restore/characters');
    if (res.ok === false) return res;
    if (!res.ok) return { ok: false, error: 'list_chars_failed', status: res.status };
    return { ok: true, characters: await res.json() };
  }

  // image_id resolution for backup entries: sidecar working-set ZIPs
  // emit only {position, filename, description}, where filename is
  // `images/<image_id>.<ext>`. Userscript-format exports may also have
  // image_id / id on the entry directly. Try both, parse from
  // filename last.
  function backupEntryImageId(entry) {
    if (!entry || typeof entry !== 'object') return '';
    if (entry.image_id) return String(entry.image_id);
    if (entry.id) return String(entry.id);
    const fn = entry.filename;
    if (typeof fn === 'string') {
      const base = fn.split('/').pop() || '';
      const dot = base.lastIndexOf('.');
      if (dot > 0) return base.slice(0, dot);
      return base;
    }
    return '';
  }

  function diffImageSets(currentImages, backupImageList) {
    const currentIds = new Set(currentImages.map((i) => i.id));
    const backupIds = new Set((backupImageList || []).map(backupEntryImageId).filter(Boolean));
    const willDelete = currentImages.filter((i) => !backupIds.has(i.id));
    const willAdd = (backupImageList || []).filter((b) => {
      const id = backupEntryImageId(b);
      return !id || !currentIds.has(id);
    });
    return { willDelete, willAdd };
  }

  // Count how many images currently on profile would end up at a
  // different gallery position once the restore runs (i.e. images that
  // exist on both sides but in different order). Newly-uploaded entries
  // and entries to be deleted don't contribute — they're handled by the
  // upload/delete pass. The metric counts mismatches comparing only the
  // subset of ids that survive the restore. Returns 0 when the order
  // already matches.
  function diffImageOrder(currentImages, backupImageList) {
    const list = backupImageList || [];
    if (list.length === 0) return 0;
    const currentIds = new Set(currentImages.map((i) => i.id));
    const backupIds = new Set(list.map(backupEntryImageId).filter(Boolean));
    const survivingBackup = list
      .map(backupEntryImageId)
      .filter((id) => id && currentIds.has(id));
    const survivingCurrent = currentImages
      .map((i) => i.id)
      .filter((id) => backupIds.has(id));
    let mismatches = 0;
    const limit = Math.min(survivingBackup.length, survivingCurrent.length);
    for (let i = 0; i < limit; i++) {
      if (survivingBackup[i] !== survivingCurrent[i]) mismatches++;
    }
    return mismatches;
  }

  // Diff the working-copy data against the current edit-form state so the
  // restore dialog can dim unchanged sections and show edit magnitudes.
  // current is whatever extractCharacterFormState() returns on the same page.
  function computeRestoreDiff(zipData, current) {
    const zd = zipData || {};
    const zDesc = zd.character?.description || '';
    const cDesc = current.character?.description || '';
    const zTitle = zd.character?.customTitle || '';
    const cTitle = current.character?.customTitle || '';

    const description = {
      changed: zDesc !== cDesc || zTitle !== cTitle,
      descChanged: zDesc !== cDesc,
      titleChanged: zTitle !== cTitle,
      newLen: zDesc.length,
      oldLen: cDesc.length,
      newTitle: zTitle,
      oldTitle: cTitle,
    };

    const zSettings = zd.settings || {};
    const cSettings = current.settings || {};
    const settingKeys = new Set([...Object.keys(zSettings), ...Object.keys(cSettings)]);
    let settingDiff = 0;
    settingKeys.forEach((k) => {
      if (String(zSettings[k] ?? '') !== String(cSettings[k] ?? '')) settingDiff += 1;
    });
    const settings = {
      changed: settingDiff > 0,
      total: Object.keys(zSettings).length,
      diff: settingDiff,
    };

    // Workbench-emitted ZIPs key infotags/kinks by bare numeric id ("3",
    // "580"), but extractCharacterFormState() keeps the full element
    // name ("info_3", "fetish_580"). Strip the prefix on the page side
    // so the diff lines up. We also tolerate legacy userscript ZIPs
    // that may already be prefixed.
    function stripPrefix(map, prefix) {
      const out = {};
      Object.entries(map || {}).forEach(([k, v]) => {
        const bare = k.startsWith(prefix) ? k.slice(prefix.length) : k;
        out[bare] = v;
      });
      return out;
    }

    function tagDiff(z, c) {
      const keys = new Set([...Object.keys(z || {}), ...Object.keys(c || {})]);
      let added = 0, removed = 0, modified = 0;
      keys.forEach((k) => {
        const zv = (z || {})[k];
        const cv = (c || {})[k];
        const zHas = zv !== undefined && zv !== '' && String(zv) !== 'undecided';
        const cHas = cv !== undefined && cv !== '' && String(cv) !== 'undecided';
        if (zHas && !cHas) added += 1;
        else if (!zHas && cHas) removed += 1;
        else if (zHas && cHas && String(zv) !== String(cv)) modified += 1;
      });
      return { added, removed, modified, changed: added + removed + modified > 0 };
    }
    const infotags = tagDiff(
      stripPrefix(zd.infotags, 'info_'),
      stripPrefix(current.infotags, 'info_'),
    );
    infotags.total = Object.keys(zd.infotags || {}).length;
    const kinks = tagDiff(
      stripPrefix(zd.kinks, 'fetish_'),
      stripPrefix(current.kinks, 'fetish_'),
    );
    kinks.total = Object.keys(zd.kinks || {}).length;

    const zCustom = zd.customKinks || [];
    const cCustom = current.customKinks || [];
    function ckKey(k) { return (k.name || '').trim().toLowerCase(); }
    // Page textareas emit CRLF; ZIPs are LF. Normalise both sides plus
    // trim trailing whitespace so the diff doesn't fire on cosmetic
    // line-ending differences alone.
    function normDesc(s) { return String(s || '').replace(/\r\n/g, '\n').trimEnd(); }
    function normChoice(s) { return String(s || '').trim() || 'undecided'; }
    const zMap = new Map(zCustom.map((k) => [ckKey(k), k]));
    const cMap = new Map(cCustom.map((k) => [ckKey(k), k]));
    let ckAdded = 0, ckRemoved = 0, ckModified = 0;
    zMap.forEach((zk, key) => {
      const ck = cMap.get(key);
      if (!ck) ckAdded += 1;
      else if (normDesc(zk.description) !== normDesc(ck.description) ||
               normChoice(zk.choice) !== normChoice(ck.choice)) ckModified += 1;
    });
    cMap.forEach((_, key) => { if (!zMap.has(key)) ckRemoved += 1; });
    const customKinks = {
      changed: ckAdded + ckRemoved + ckModified > 0,
      total: zCustom.length,
      added: ckAdded, removed: ckRemoved, modified: ckModified,
    };

    return { description, settings, infotags, kinks, customKinks };
  }

  function fmtRelative(iso) {
    if (!iso) return 'unknown';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const diff = (Date.now() - t) / 1000;
    if (diff < 60) return `${Math.round(diff)}s ago`;
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    return `${Math.round(diff / 86400)}d ago`;
  }

  async function showSafetyScreen({ data, zip, source, character, lastBackupIso, applyFn }) {
    const current = extractImageData();
    const backupImages = data?.images?.list || [];
    const { willDelete, willAdd } = diffImageSets(current.images, backupImages);

    // Form-side diff against current edit-page values so unchanged
    // sections render as "no changes" instead of looking like they'll
    // overwrite. extractCharacterFormState throws if the form is missing
    // — we already require the edit page for the rest of the flow, but
    // a try/catch keeps the dialog resilient.
    let formDiff = null;
    try { formDiff = computeRestoreDiff(data || {}, extractCharacterFormState()); }
    catch (e) { warn('restore diff failed:', e); }

    const customTitle = data?.character?.customTitle || '';
    const settingsCount = Object.keys(data?.settings || {}).length;
    const infotagsCount = Object.keys(data?.infotags || {}).length;
    const kinksCount = Object.keys(data?.kinks || {}).length;
    const customKinksCount = (data?.customKinks || []).length;
    const avatarInZip = !!(zip && zip.file && zip.file('avatar.png'));

    const body = makeEl('div');

    body.appendChild(makeEl('div', {
      class: 'flist-wb-info-box',
      html: `
        <div><strong>Restoring into:</strong> ${escapeHtml(character || 'unknown character')}</div>
        <div><strong>Source:</strong> ${escapeHtml(source)}</div>
        <div><strong>Last backup:</strong> ${lastBackupIso ? escapeHtml(fmtRelative(lastBackupIso)) : '<em>none on record</em>'}</div>
      `,
    }));

    const checklistTitle = makeEl('div', {
      class: 'flist-wb-checklist-title',
      html: 'Choose what to restore: <span class="flist-wb-hint" tabindex="0" aria-label="diff help" data-tip="Counts shown here are the diff vs the page you’re looking at. For a field-level diff with old/new values side by side, open the character in Workbench → Diff tab.">?</span>',
    });
    body.appendChild(checklistTitle);

    // Each row: checkbox + label + count/summary + optional warn pill.
    const checklist = makeEl('div', { class: 'flist-wb-checklist' });
    body.appendChild(checklist);

    const cbs = {};
    function row(id, label, summary, opts = {}) {
      const cls = ['flist-wb-check-row'];
      if (opts.warn) cls.push('warn');
      if (opts.unchanged) cls.push('unchanged');
      if (opts.indent) cls.push('indent');
      const wrapper = makeEl('label', { class: cls.join(' ') });
      const cb = makeEl('input', { type: 'checkbox', id: `flist-wb-restore-${id}` });
      cb.checked = !!opts.defaultChecked;
      if (opts.disabled || opts.unchanged) {
        cb.disabled = true;
        cb.checked = false;
      }
      cbs[id] = cb;
      wrapper.appendChild(cb);
      const text = makeEl('div', { class: 'flist-wb-check-text' });
      text.appendChild(makeEl('div', { class: 'flist-wb-check-label', text: label }));
      if (summary) text.appendChild(makeEl('div', { class: 'flist-wb-check-summary', html: summary }));
      wrapper.appendChild(text);
      checklist.appendChild(wrapper);
      return cb;
    }

    const noChangeSummary = 'no changes vs current page';

    // Description & custom title — show length delta when the body
    // differs so the magnitude of the edit is visible at a glance.
    {
      const d = formDiff?.description;
      let summary, unchanged = false;
      if (d && !d.changed) {
        summary = noChangeSummary;
        unchanged = true;
      } else if (d) {
        const parts = [];
        if (d.descChanged) {
          const delta = d.newLen - d.oldLen;
          const sign = delta > 0 ? '+' : '';
          parts.push(`description differs (${d.oldLen} → ${d.newLen} chars · Δ${sign}${delta})`);
        }
        if (d.titleChanged) {
          parts.push(d.newTitle ? `title → "${escapeHtml(d.newTitle)}"` : 'title cleared');
        }
        summary = parts.join(' · ');
      } else {
        // Diff unavailable — fall back to raw counts.
        const descChars = (data?.character?.description || '').length;
        summary = `${descChars} char${descChars === 1 ? '' : 's'}${customTitle ? ` · title "${escapeHtml(customTitle)}"` : ''}`;
      }
      row('description', 'Description & custom title', summary,
        { defaultChecked: !unchanged && (formDiff?.description?.changed ?? true), unchanged });
    }

    // Settings — count toggles whose values actually differ.
    {
      const s = formDiff?.settings;
      let summary, unchanged = false;
      if (s && !s.changed) { summary = noChangeSummary; unchanged = true; }
      else if (s) summary = `${s.diff} of ${s.total} toggle${s.total === 1 ? '' : 's'} differ`;
      else summary = `${settingsCount} toggle${settingsCount === 1 ? '' : 's'}`;
      row('settings', 'Settings', summary,
        { defaultChecked: !unchanged && (formDiff?.settings?.changed ?? true), unchanged });
    }

    // Empty-restore rows still warn about clearing the page even when
    // the ZIP itself is empty, but only when there's actually something
    // on the page to clear — otherwise mark as unchanged.
    function diffSummary(d, label, fallbackCount, emptyWarn) {
      if (!d) {
        return {
          summary: fallbackCount > 0
            ? `${fallbackCount} entries — ${label}`
            : `<strong style="color:#f0c8a0">⚠ ${emptyWarn}</strong>`,
          defaultChecked: true,
          unchanged: false,
        };
      }
      if (!d.changed) return { summary: noChangeSummary, defaultChecked: false, unchanged: true };
      const parts = [];
      if (d.added) parts.push(`${d.added} added`);
      if (d.modified) parts.push(`${d.modified} changed`);
      if (d.removed) parts.push(`${d.removed} cleared`);
      return { summary: parts.join(', '), defaultChecked: true, unchanged: false };
    }

    {
      const r = diffSummary(formDiff?.infotags, 'others on the page will be cleared first',
        infotagsCount, 'empty in this backup — leaving this checked will clear ALL profile fields on the page');
      row('infotags', 'Profile fields (infotags)', r.summary,
        { defaultChecked: r.defaultChecked, unchanged: r.unchanged });
    }
    {
      const r = diffSummary(formDiff?.kinks, 'others on the page will be reset to <em>undecided</em>',
        kinksCount, 'empty in this backup — leaving this checked will reset ALL 559 kinks to undecided');
      row('kinks', 'Default kinks', r.summary,
        { defaultChecked: r.defaultChecked, unchanged: r.unchanged });
    }
    {
      const r = diffSummary(formDiff?.customKinks, 'existing custom kinks on page will be replaced',
        customKinksCount, 'empty in this backup — leaving this checked will remove ALL existing custom kinks');
      row('customKinks', 'Custom kinks', r.summary,
        { defaultChecked: r.defaultChecked, unchanged: r.unchanged });
    }

    row('avatar', 'Avatar',
      avatarInZip
        ? '1 avatar in this backup — <em>cannot diff against current avatar, tick only if you want to replace it</em>'
        : '<em>no avatar bundled in this backup</em>',
      { defaultChecked: false, disabled: !avatarInZip });

    const galleryWarn = willDelete.length > 0 || willAdd.length > 0;
    row('images', 'Gallery images',
      galleryWarn
        ? `<strong style="color:#f0b8b8">⚠ ${willDelete.length} will be deleted, ${willAdd.length} will be uploaded — happens INSTANTLY, before Save</strong>`
        : (backupImages.length === 0
          ? '<em>no images in this backup — would delete every image currently on F-list</em>'
          : 'gallery already matches the backup — no changes'),
      { defaultChecked: backupImages.length > 0 && galleryWarn, warn: galleryWarn });

    // Reorder runs LAST, after upload + delete, so the sub-row sits
    // under "Gallery images" visually. Independent checkbox so the user
    // can apply a pure order shuffle (no upload, no delete) — useful
    // when the only delta is sort_order.
    const willReorder = diffImageOrder(current.images, backupImages);
    row('imageOrder', 'Image order',
      willReorder > 0
        ? `${willReorder} image${willReorder === 1 ? '' : 's'} will be moved to match the backup order — runs <em>after</em> upload + delete`
        : (backupImages.length === 0 ? '<em>nothing to reorder</em>' : 'order already matches the backup'),
      { defaultChecked: willReorder > 0, unchanged: willReorder === 0, indent: true });

    const confirmRow = makeEl('label', { class: 'flist-wb-confirm-row' });
    const confirmCb = makeEl('input', { type: 'checkbox', id: 'flist-wb-confirm-destructive' });
    confirmRow.appendChild(confirmCb);
    confirmRow.appendChild(makeEl('span', { text: 'I understand image changes happen instantly on F-list.' }));
    body.appendChild(confirmRow);

    body.appendChild(makeEl('div', {
      class: 'flist-wb-info-box',
      html: `
        <strong>Form fields persist on Save</strong>. The extension fills description / settings /
        infotags / kinks / custom kinks into the form — they only commit when you click F-list's
        Save button. Avatar and gallery image changes happen <strong>immediately</strong>.
      `,
    }));

    const backupFirstBtn = makeEl('button', {
      class: 'flist-wb-btn secondary',
      type: 'button',
      text: 'Back up current state first',
    });
    const cancelBtn = makeEl('button', { class: 'flist-wb-btn secondary', type: 'button', text: 'Cancel' });
    const applyBtn = makeEl('button', { class: 'flist-wb-btn', type: 'button', text: 'Apply restore' });

    function updateApplyState() {
      // Apply enabled if at least one category is checked AND, if images
      // is checked with destructive changes, the confirm box is ticked.
      const anyChecked = Object.values(cbs).some((cb) => cb.checked);
      const imagesChecked = cbs.images.checked;
      const needsConfirm = imagesChecked && galleryWarn;
      applyBtn.disabled = !anyChecked || (needsConfirm && !confirmCb.checked);
    }
    Object.values(cbs).forEach((cb) => cb.addEventListener('change', updateApplyState));
    confirmCb.addEventListener('change', updateApplyState);
    updateApplyState();

    const modal = openModal({
      title: 'Confirm restore',
      body,
      footer: [backupFirstBtn, cancelBtn, applyBtn],
    });

    cancelBtn.addEventListener('click', () => modal.close());

    backupFirstBtn.addEventListener('click', async () => {
      backupFirstBtn.disabled = true;
      backupFirstBtn.textContent = 'Backing up form state…';
      const payload = extractCharacterFormState();
      const res = await sendBg({ type: 'snapshot_form_state', character, payload });
      if (!res.ok) {
        backupFirstBtn.disabled = false;
        backupFirstBtn.textContent = 'Back up current state first';
        toast({ title: 'Backup failed', message: explainError(res), kind: 'error' });
        return;
      }
      backupFirstBtn.textContent = '✓ Backed up (form fields only — images not included)';
      toast({
        title: 'Backed up',
        message: 'Current form state stored in Workbench. Image bytes not included in this v1 backup.',
        kind: 'success',
      });
    });

    applyBtn.addEventListener('click', async () => {
      const selections = Object.fromEntries(
        Object.entries(cbs).map(([k, cb]) => [k, cb.checked])
      );
      modal.close();
      try {
        await applyFn(selections);
      } catch (e) {
        err(e);
        toast({ title: 'Restore failed', message: String(e.message || e), kind: 'error' });
      }
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function explainError(res) {
    if (!res) return 'No response.';
    if (res.error === 'unreachable') return 'Workbench sidecar is not reachable on 127.0.0.1:27384. Is Workbench running?';
    if (res.error === 'not_paired') return 'Extension is not paired with Workbench yet. Click the extension icon to pair.';
    if (res.status === 401) return 'Pairing token rejected. Re-pair the extension via Workbench Settings → Security.';
    return `${res.error || 'Unknown error'}${res.detail ? ': ' + res.detail : ''}`;
  }

  function findSaveButtons() {
    // Scan the whole document — F-list may have buttons outside the
    // CharacterForm element. Match anything that's structurally a
    // submit button OR has text suggesting it saves the profile.
    const candidates = new Set(
      document.querySelectorAll(
        'input[type="submit"], button[type="submit"], button:not([type])'
      )
    );
    document.querySelectorAll('button, input[type="button"]').forEach((b) => {
      const text = ((b.value || '') + ' ' + (b.textContent || '')).trim().toLowerCase();
      if (
        text.includes('update character') ||
        text.includes('save changes') ||
        text === 'save'
      ) {
        candidates.add(b);
      }
    });
    return Array.from(candidates);
  }

  function isInsideOurUi(target) {
    if (!target || !target.closest) return false;
    return !!target.closest(
      '#flist-wb-bar, .flist-wb-overlay, .flist-wb-toast, .flist-wb-save-notice'
    );
  }

  // Belt-and-braces save-blocking. `disabled` alone is insufficient
  // because F-list may submit via:
  //   - a JS onclick handler that calls form.submit() (bypasses disabled
  //     and doesn't fire the submit event)
  //   - a button labelled "Update Character" that isn't structurally a
  //     submit input
  //   - Enter pressed in any form input
  // So we intercept click / submit / Enter at the capture phase, on the
  // document, and drop them unless they target our own UI.
  function lockSaveButtons(reason) {
    const saves = findSaveButtons();
    const prior = saves.map((b) => ({
      el: b,
      disabled: b.disabled,
      title: b.getAttribute('title'),
    }));
    saves.forEach((b) => {
      b.disabled = true;
      b.classList.add('flist-wb-save-locked');
      b.setAttribute('title', reason);
    });

    const notices = [];
    saves.forEach((b) => {
      if (b.parentNode) {
        const notice = makeEl('div', { class: 'flist-wb-save-notice', text: reason });
        b.parentNode.insertBefore(notice, b);
        notices.push(notice);
      }
    });

    const blockClick = (e) => {
      if (isInsideOurUi(e.target)) return;
      const t = e.target.closest && e.target.closest(
        'input[type="submit"], button[type="submit"], button:not([type]), button, input[type="button"]'
      );
      if (!t) return;
      if (!saves.includes(t)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      toast({ title: 'Wait', message: reason, kind: 'warn', durationMs: 3000 });
    };

    const blockSubmit = (e) => {
      if (isInsideOurUi(e.target)) return;
      const form = e.target;
      if (form && form.id === 'CharacterForm') {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        toast({ title: 'Wait', message: reason, kind: 'warn', durationMs: 3000 });
      }
    };

    const blockEnter = (e) => {
      if (e.key !== 'Enter') return;
      if (isInsideOurUi(e.target)) return;
      if (!e.target.closest || !e.target.closest('#CharacterForm')) return;
      // Allow Enter inside textareas (BBCode editing) — they don't
      // submit the form anyway.
      if (e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    document.addEventListener('click', blockClick, { capture: true });
    document.addEventListener('submit', blockSubmit, { capture: true });
    document.addEventListener('keydown', blockEnter, { capture: true });

    return () => {
      document.removeEventListener('click', blockClick, { capture: true });
      document.removeEventListener('submit', blockSubmit, { capture: true });
      document.removeEventListener('keydown', blockEnter, { capture: true });
      prior.forEach(({ el, disabled, title }) => {
        el.disabled = disabled;
        el.classList.remove('flist-wb-save-locked');
        if (title === null) el.removeAttribute('title');
        else el.setAttribute('title', title);
      });
      notices.forEach((n) => n.remove());
    };
  }

  function enterBarProgressMode() {
    const bar = document.getElementById('flist-wb-bar');
    if (!bar) {
      // Standalone mode (e.g. on a stub page) — just return inert helpers.
      return {
        update: () => {},
        setRatio: () => {},
        restore: () => {},
        onCancel: () => {},
      };
    }
    const childSnapshot = Array.from(bar.children);
    childSnapshot.forEach((c) => (c.style.display = 'none'));

    const label = makeEl('span', { class: 'flist-wb-bar-label', text: 'F-list Workbench' });
    const status = makeEl('span', { class: 'flist-wb-progress-status', text: 'Applying restore…' });
    const bar1 = makeEl('div', { class: 'flist-wb-progress-bar' });
    const fill = makeEl('div', { class: 'flist-wb-progress-fill' });
    bar1.appendChild(fill);
    const cancelBtn = makeEl('button', { class: 'flist-wb-btn danger', type: 'button', text: 'Cancel' });

    bar.appendChild(label);
    bar.appendChild(status);
    bar.appendChild(bar1);
    bar.appendChild(cancelBtn);

    let cancelHandler = null;
    cancelBtn.addEventListener('click', () => {
      if (cancelHandler) cancelHandler();
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling…';
    });

    return {
      update: (text) => { status.textContent = text; },
      setRatio: (n) => {
        const pct = Math.max(0, Math.min(1, n)) * 100;
        fill.style.width = pct.toFixed(1) + '%';
      },
      onCancel: (fn) => { cancelHandler = fn; },
      restore: () => {
        [label, status, bar1, cancelBtn].forEach((el) => el.remove());
        childSnapshot.forEach((c) => (c.style.display = ''));
      },
    };
  }

  async function doApply(zip, data, selections = {}) {
    const cancelToken = { cancelled: false };
    const progress = enterBarProgressMode();
    progress.onCancel(() => { cancelToken.cancelled = true; });
    const unlockSave = lockSaveButtons('Workbench is restoring images. Save re-enables when finished.');

    // Auto-snapshot the current character state before applying anything.
    // Even if the user clicked "Back up first" already, this is a cheap
    // belt-and-braces safety net — every restore has a corresponding
    // pre-restore backup in Workbench with no user effort required.
    try {
      progress.update('Backing up current state…');
      const pre = extractCharacterFormState();
      const character = getCharacterName();
      const res = await sendBg({ type: 'snapshot_form_state', character, payload: pre });
      diag('auto pre-restore backup:', JSON.stringify(res));
    } catch (e) {
      diag('auto pre-restore backup failed:', String(e.message || e));
    }

    let outcome = 'completed';
    let counts = {
      deleted: 0, uploaded: 0, reordered: 0, reorderFails: 0,
      deletePlanned: 0, uploadPlanned: 0, reorderPlanned: 0,
    };
    let result = { fields: 0, kinks: 0, customKinks: 0, warnings: [] };

    // Treat skipImages as the inverse of selections.images to keep the
    // existing image-loop logic working with the new opt-in model.
    const skipImages = selections.images === false;

    try {
      progress.update('Filling form fields…');
      progress.setRatio(0);
      result = await applyCharacterData(data, selections);

      // Avatar processing runs regardless of skipImages — avatar is a
      // profile aspect (not a gallery change). Gated on selections.avatar
      // so users can opt out.
      diag('===BEGIN AVATAR DIAGNOSTICS===');
      diag('outcome=', outcome, 'selections.avatar=', selections.avatar);
      diag('data.images.avatar =', JSON.stringify(data?.images?.avatar));
      diag('zip present?', !!zip);
      if (zip) {
        const zipFileList = Object.keys(zip.files).slice(0, 20);
        diag('zip files (first 20):', JSON.stringify(zipFileList));
      }
      const avatarFn = data?.images?.avatar?.filename;
      const avatarFile = zip && avatarFn ? zip.file(avatarFn) : null;
      diag('avatar filename from payload:', avatarFn, 'found in zip?', !!avatarFile);
      if (selections.avatar === false) {
        diag('SKIP avatar: unchecked in safety screen');
      } else if (outcome === 'cancelled') {
        diag('SKIP avatar: cancelled');
      } else if (!avatarFn) {
        diag('SKIP avatar: no filename in payload');
      } else if (!zip) {
        diag('SKIP avatar: zip is null (JSON-only restore?)');
      } else if (!avatarFile) {
        diag('SKIP avatar: filename "' + avatarFn + '" not in ZIP — sidecar didn\'t bundle avatar bytes');
      } else {
        progress.update('Uploading avatar…');
        try {
          const bytes = await avatarFile.async('uint8array');
          diag('avatar bytes loaded:', bytes.length, 'bytes');
          await uploadAvatarBytes(bytes, avatarFn.split('/').pop());
        } catch (e) {
          diag('avatar processing threw:', String(e && e.message || e));
          warn('avatar upload failed', e);
        }
      }
      diag('===END AVATAR===');

      // backup-filename → final id once uploaded, so the reorder pass
      // below can place freshly-minted ids in the right slot. Kept at
      // method scope so the reorder block can read it even when uploads
      // were skipped (in which case it's just empty).
      const uploadedIdByFilename = new Map();
      const backupImages = data?.images?.list || [];

      if (!skipImages) {
        const current = extractImageData();
        const { willDelete } = diffImageSets(current.images, backupImages);
        counts.deletePlanned = willDelete.length;

        for (let i = 0; i < willDelete.length; i++) {
          if (cancelToken.cancelled) { outcome = 'cancelled'; break; }
          progress.update(`Deleting image ${i + 1}/${willDelete.length}`);
          progress.setRatio(i / Math.max(1, willDelete.length + 1 + backupImages.length));
          try {
            await deleteImageById(willDelete[i].id);
            counts.deleted++;
          } catch (e) { warn('delete failed', willDelete[i].id, e); }
        }

        if (outcome !== 'cancelled') {
          const { willAdd: toUpload } = diffImageSets(extractImageData().images, backupImages);
          counts.uploadPlanned = toUpload.length;
          if (zip && toUpload.length > 0) {
            for (let i = toUpload.length - 1; i >= 0; i--) {
              if (cancelToken.cancelled) { outcome = 'cancelled'; break; }
              const meta = toUpload[i];
              const idx = toUpload.length - i;
              progress.update(`Uploading image ${idx}/${toUpload.length}`);
              const denom = Math.max(1, counts.deletePlanned + 1 + toUpload.length);
              progress.setRatio((counts.deletePlanned + idx) / denom);
              const file = zip.file(meta.filename);
              if (!file) continue;
              try {
                const bytes = await file.async('uint8array');
                const filename = meta.filename.split('/').pop();
                const newId = await uploadSingleImage(bytes, filename);
                counts.uploaded++;
                if (newId) uploadedIdByFilename.set(meta.filename, String(newId));
                if (meta.description && newId) {
                  const descInput = document.querySelector(`#image${newId} .character_image_description`);
                  if (descInput) descInput.value = meta.description;
                }
              } catch (e) { warn('image upload failed', meta.filename, e); }
            }
          }
        }
      }

      // Image reorder runs after upload + delete (so freshly-minted ids
      // exist in uploadedIdByFilename) and is independently gated on
      // selections.imageOrder — the user can apply a pure order shuffle
      // even when neither uploading nor deleting. The only public
      // primitive is window.moveImageToFrontBack(id, toFront); to
      // converge an arbitrary permutation we iterate the desired order
      // in REVERSE and call toFront=true on each id — after N calls the
      // gallery ends front-to-back exactly matching desiredOrder.
      {
        const skipReorder = selections.imageOrder === false;
        if (outcome !== 'cancelled' && backupImages.length > 0 && !skipReorder) {
          const desiredOrder = backupImages
            .map((entry) => {
              const filenameId = uploadedIdByFilename.get(entry.filename);
              if (filenameId) return filenameId;
              const eid = backupEntryImageId(entry);
              return eid || null;
            })
            .filter(Boolean);
          const onProfileIds = new Set(
            Array.from(document.querySelectorAll('.character_image'))
              .map((c) => c.id.replace('image', ''))
          );
          const placeableOrder = desiredOrder.filter((id) => onProfileIds.has(id));
          counts.reorderPlanned = placeableOrder.length;
          diagGroup(`IMAGES — reorder ${placeableOrder.length} via moveImageToFrontBack`);
          for (let i = placeableOrder.length - 1; i >= 0; i--) {
            if (cancelToken.cancelled) { outcome = 'cancelled'; break; }
            const id = placeableOrder[i];
            progress.update(
              `Reordering image ${placeableOrder.length - i}/${placeableOrder.length}`
            );
            const r = await callPage('moveImage', { id, toFront: true }, 4_000);
            if (r.ok) counts.reordered++;
            else if (counts.reorderFails < 3) {
              diag(`moveImage ${id} → front failed:`, JSON.stringify(r));
              counts.reorderFails++;
            }
            await new Promise((res) => setTimeout(res, 140));
          }
          diag(
            `reorder: ${counts.reordered}/${counts.reorderPlanned} placed, ` +
            `${counts.reorderFails} failed`
          );
          diagGroupEnd();
        }
      }

      progress.setRatio(1);

      const character = getCharacterName();
      sendBg({ type: 'restore_done', character });

      if (outcome === 'completed') {
        const saveBtns = findSaveButtons();
        if (saveBtns[0]) saveBtns[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast({
          title: 'Ready to save',
          message:
            `Form filled: ${result.fields} fields, ${result.kinks} kinks, ${result.customKinks} custom kinks. ` +
            (skipImages
              ? ''
              : `Images: ${counts.uploaded} uploaded, ${counts.deleted} deleted, ${counts.reordered} reordered. `) +
            `Review every field above, then click F-list's Save button — the extension will NOT click it for you.`,
          kind: 'success',
          durationMs: 0,
        });
      } else {
        toast({
          title: 'Restore cancelled',
          message:
            `Stopped after ${counts.deleted}/${counts.deletePlanned} deletes and ` +
            `${counts.uploaded}/${counts.uploadPlanned} uploads. Form fields were filled. ` +
            `Image gallery is now in a partial state — re-run the import or fix manually on F-list.`,
          kind: 'warn',
          durationMs: 0,
        });
      }
    } finally {
      progress.restore();
      unlockSave();
    }
  }

  const KIND_LABEL = {
    live: 'From F-list',
    set: 'Working set',
    backup: 'Backup',
    'pre-restore': 'Pre-restore',
  };

  async function showSnapshotPicker(targetCharacter) {
    const modal = openModal({
      title: 'Restore from Workbench',
      body: makeEl('div', { text: 'Loading characters…' }),
      footer: [],
    });

    // The character we're editing (URL) is the target. The user can
    // pick a different "source" character whose snapshot they want to
    // load into the current edit form — useful for porting a profile
    // between throwaway characters or seeding a new char from an old.
    let sourceCharacter = targetCharacter;
    let selected = null;

    const cancelBtn = makeEl('button', { class: 'flist-wb-btn secondary', type: 'button', text: 'Cancel' });
    cancelBtn.addEventListener('click', () => modal.close());
    const loadBtn = makeEl('button', { class: 'flist-wb-btn', type: 'button', text: 'Load snapshot' });
    loadBtn.disabled = true;
    modal.footer.appendChild(cancelBtn);
    modal.footer.appendChild(loadBtn);

    const charsRes = await archivedCharactersList();
    modal.body.innerHTML = '';

    if (!charsRes.ok) {
      modal.body.appendChild(makeEl('div', { class: 'flist-wb-warn-box', text: explainError(charsRes) }));
      if (charsRes.error === 'not_paired') {
        modal.body.appendChild(makeEl('div', {
          text: 'Click the extension icon in the browser toolbar and press Pair to begin.',
        }));
      }
      return;
    }

    const archived = charsRes.characters || [];
    const sourceRow = makeEl('div', { class: 'flist-wb-source-row' });
    sourceRow.appendChild(makeEl('label', { text: 'Load from character:', for: 'flist-wb-source-select' }));
    const select = makeEl('select', { id: 'flist-wb-source-select' });

    if (archived.length === 0) {
      modal.body.appendChild(makeEl('div', {
        class: 'flist-wb-info-box',
        text: 'Workbench has no archived characters yet. Open a character in Workbench and pull it first.',
      }));
      return;
    }

    const hasTarget = archived.some((c) => c.name === targetCharacter);
    if (!hasTarget && targetCharacter) {
      const placeholder = makeEl('option', { value: '', text: `${targetCharacter} — no archive yet` });
      placeholder.disabled = true;
      select.appendChild(placeholder);
    }
    archived.forEach((c) => {
      const opt = makeEl('option', { value: c.name, text: c.name });
      if (c.name === targetCharacter) opt.selected = true;
      select.appendChild(opt);
    });

    if (!hasTarget && archived.length > 0) {
      sourceCharacter = archived[0].name;
      select.value = sourceCharacter;
    }

    sourceRow.appendChild(select);
    modal.body.appendChild(sourceRow);

    const warningSlot = makeEl('div');
    modal.body.appendChild(warningSlot);

    // Tab strip: Working Sets / Backups. Sets first because that's
    // what gets used most often. Switching between tabs re-renders
    // the row list from the cached snapshot response — one network
    // round-trip per character pick, not per tab click.
    const tabStrip = makeEl('div', { class: 'flist-wb-tabs', role: 'tablist' });
    const tabSets = makeEl('button', {
      class: 'flist-wb-tab flist-wb-tab-active',
      type: 'button',
      role: 'tab',
      text: 'Working sets',
    });
    const tabBackups = makeEl('button', {
      class: 'flist-wb-tab',
      type: 'button',
      role: 'tab',
      text: 'Backups',
    });
    tabStrip.appendChild(tabSets);
    tabStrip.appendChild(tabBackups);
    modal.body.appendChild(tabStrip);

    const listSlot = makeEl('div');
    modal.body.appendChild(listSlot);

    const switchTab = (next) => {
      if (next === activeTab) return;
      activeTab = next;
      tabSets.classList.toggle('flist-wb-tab-active', next === 'sets');
      tabBackups.classList.toggle('flist-wb-tab-active', next === 'backups');
      renderListContent();
    };
    tabSets.addEventListener('click', () => switchTab('sets'));
    tabBackups.addEventListener('click', () => switchTab('backups'));

    const renderWarning = () => {
      warningSlot.innerHTML = '';
      if (sourceCharacter && targetCharacter && sourceCharacter !== targetCharacter) {
        warningSlot.appendChild(makeEl('div', {
          class: 'flist-wb-source-warning',
          html: `⚠ You're loading data from <strong>${escapeHtml(sourceCharacter)}</strong> into the edit form for <strong>${escapeHtml(targetCharacter)}</strong>. Form fields will be overwritten — review every field before clicking Save.`,
        }));
      }
    };

    // Active tab — defaults to 'sets' because that's what the user
    // will pick most of the time (per the 2026-06-18 brief). Switch
    // to 'backups' is one click away and persisted only across this
    // dialog lifecycle.
    let activeTab = 'sets';
    let snapshotsCache = null;
    let charsCache = null;

    const renderRow = (s) => {
      const row = makeEl('div', { class: 'flist-wb-snapshot-row' });
      const kindClass = String(s.kind || '').replace(/[^a-z-]/gi, '');
      row.appendChild(makeEl('span', {
        class: `flist-wb-snapshot-kind ${kindClass}`,
        text: KIND_LABEL[s.kind] || s.kind || '?',
      }));
      row.appendChild(makeEl('span', { text: s.label || s.id }));
      row.appendChild(makeEl('span', {
        class: 'flist-wb-snapshot-meta',
        text: `${s.image_count || 0} images · ${fmtRelative(s.created_at)}`,
      }));
      row.addEventListener('click', () => {
        listSlot.querySelectorAll('.flist-wb-snapshot-row').forEach((r) => r.classList.remove('selected'));
        row.classList.add('selected');
        selected = s;
        loadBtn.disabled = false;
      });
      return row;
    };

    // Backups bucketed by their backup-meta kind. Mirrors the app's
    // sidebar Backups list. Always-present folders (even empty) keep
    // the taxonomy obvious; "Other" (unknown/pre-restore) only shows
    // when populated.
    const BACKUP_BUCKETS = [
      { id: 'manual', label: 'Manual backups', kinds: ['manual_single', 'manual_bulk'], alwaysShow: true },
      { id: 'automatic', label: 'Automatic backups', kinds: ['import'], alwaysShow: true },
      { id: 'scheduled', label: 'Scheduled backups', kinds: ['scheduled'], alwaysShow: true },
      { id: 'other', label: 'Other backups', kinds: ['unknown', null, undefined], alwaysShow: false },
    ];

    const renderListContent = () => {
      selected = null;
      loadBtn.disabled = true;
      listSlot.innerHTML = '';
      const snapshots = snapshotsCache || [];

      if (activeTab === 'sets') {
        const sets = snapshots.filter((s) => s.kind === 'set');
        // Also surface the live ("From F-list") entry on the Working
        // Sets tab — it lives next to the user's working sets in the
        // app's sidebar, so it belongs in the same tab here.
        const live = snapshots.find((s) => s.kind === 'live');
        if (live) listSlot.appendChild(renderRow(live));
        if (sets.length === 0 && !live) {
          listSlot.appendChild(makeEl('div', {
            class: 'flist-wb-info-box',
            text: `No working sets for "${sourceCharacter}" yet. Open the character in Workbench and click + New working set.`,
          }));
          return;
        }
        sets.forEach((s) => listSlot.appendChild(renderRow(s)));
        return;
      }

      // Backups tab — bucket by backup_kind into the three default
      // folders (Manual / Automatic / Scheduled), plus Pre-restore
      // and Other when present. Each bucket renders a header even
      // when empty so the taxonomy stays visible. Pre-restore stays
      // in its own bucket (legacy auto-backup taken right before a
      // restore action; useful for emergency undo).
      const backups = snapshots.filter((s) => s.kind === 'backup');
      const preRestores = snapshots.filter((s) => s.kind === 'pre-restore');
      if (backups.length === 0 && preRestores.length === 0) {
        listSlot.appendChild(makeEl('div', {
          class: 'flist-wb-info-box',
          text: `No backups for "${sourceCharacter}" yet. In Workbench: right-click the character → Back up now.`,
        }));
        return;
      }

      BACKUP_BUCKETS.forEach((bucket) => {
        const entries = backups.filter((s) => bucket.kinds.includes(s.backup_kind));
        if (!bucket.alwaysShow && entries.length === 0) return;
        const folder = makeEl('div', { class: 'flist-wb-backup-folder' });
        const head = makeEl('div', { class: 'flist-wb-backup-folder-h' });
        head.appendChild(makeEl('span', { class: 'flist-wb-backup-folder-title', text: bucket.label }));
        head.appendChild(makeEl('span', { class: 'flist-wb-backup-folder-count', text: String(entries.length) }));
        folder.appendChild(head);
        if (entries.length === 0) {
          folder.appendChild(makeEl('div', { class: 'flist-wb-backup-folder-empty', text: '—' }));
        } else {
          entries.forEach((s) => folder.appendChild(renderRow(s)));
        }
        listSlot.appendChild(folder);
      });
      if (preRestores.length > 0) {
        const folder = makeEl('div', { class: 'flist-wb-backup-folder' });
        const head = makeEl('div', { class: 'flist-wb-backup-folder-h' });
        head.appendChild(makeEl('span', { class: 'flist-wb-backup-folder-title', text: 'Pre-restore safety backups' }));
        head.appendChild(makeEl('span', { class: 'flist-wb-backup-folder-count', text: String(preRestores.length) }));
        folder.appendChild(head);
        preRestores.forEach((s) => folder.appendChild(renderRow(s)));
        listSlot.appendChild(folder);
      }
    };

    const renderSnapshots = async () => {
      selected = null;
      loadBtn.disabled = true;
      listSlot.innerHTML = '';
      listSlot.appendChild(makeEl('div', { text: 'Loading snapshots…', style: 'color:#8a93a8;padding:8px 0;' }));

      const res = await snapshotsList(sourceCharacter);
      if (!res.ok) {
        listSlot.innerHTML = '';
        listSlot.appendChild(makeEl('div', { class: 'flist-wb-warn-box', text: explainError(res) }));
        return;
      }
      snapshotsCache = res.snapshots || [];
      renderListContent();
    };

    select.addEventListener('change', () => {
      sourceCharacter = select.value || archived[0]?.name;
      snapshotsCache = null;
      renderWarning();
      renderSnapshots();
    });

    renderWarning();
    await renderSnapshots();

    loadBtn.addEventListener('click', async () => {
      if (!selected) return;
      loadBtn.disabled = true;
      loadBtn.textContent = 'Loading…';
      const fetched = await snapshotZipBytes(sourceCharacter, selected.id);
      if (!fetched.ok) {
        loadBtn.disabled = false;
        loadBtn.textContent = 'Load snapshot';
        toast({ title: 'Could not load snapshot', message: explainError(fetched), kind: 'error' });
        return;
      }
      modal.close();
      try {
        const zip = await window.JSZip.loadAsync(fetched.bytes);
        const jsonFile = zip.file('character.json');
        if (!jsonFile) throw new Error('character.json missing from snapshot ZIP');
        const data = JSON.parse(await jsonFile.async('string'));
        const sourceLabel = sourceCharacter === targetCharacter
          ? `Workbench · ${selected.label || selected.id}`
          : `Workbench · ${sourceCharacter} → ${targetCharacter} · ${selected.label || selected.id}`;
        await showSafetyScreen({
          data,
          zip,
          source: sourceLabel,
          character: targetCharacter,
          lastBackupIso: selected.created_at,
          applyFn: (selections) => doApply(zip, data, selections),
        });
      } catch (e) {
        toast({ title: 'Snapshot unreadable', message: String(e.message || e), kind: 'error' });
      }
    });
  }

  function importFromLocalZip() {
    const input = makeEl('input', { type: 'file', accept: '.zip,.json' });
    input.style.display = 'none';
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const character = getCharacterName();
      const isZip = file.name.toLowerCase().endsWith('.zip');
      try {
        if (isZip) {
          const zip = await window.JSZip.loadAsync(file);
          const jsonFile = zip.file('character.json');
          if (!jsonFile) throw new Error('character.json missing from ZIP');
          const data = JSON.parse(await jsonFile.async('string'));
          await showSafetyScreen({
            data,
            zip,
            source: `Local ZIP · ${file.name}`,
            character,
            lastBackupIso: data?.meta?.exportedAt || data?.meta?.extractedAt || null,
            applyFn: (selections) => doApply(zip, data, selections),
          });
        } else {
          const text = await file.text();
          const data = JSON.parse(text);
          await showSafetyScreen({
            data,
            zip: null,
            source: `Local JSON · ${file.name}`,
            character,
            lastBackupIso: data?.meta?.exportedAt || data?.meta?.extractedAt || null,
            applyFn: (selections) => doApply(null, data, { ...selections, images: false }),
          });
        }
      } catch (e) {
        toast({ title: 'Could not load file', message: String(e.message || e), kind: 'error' });
      } finally {
        input.remove();
      }
    });
    document.body.appendChild(input);
    input.click();
  }

  async function refreshStatus(statusEl) {
    const res = await sendBg({ type: 'get_token_status' });
    if (res.paired) {
      statusEl.className = 'flist-wb-status paired';
      statusEl.textContent = '● Paired with Workbench';
    } else {
      statusEl.className = 'flist-wb-status unpaired';
      statusEl.textContent = '○ Not paired — open the extension popup to pair';
    }
  }

  function injectBar() {
    if (document.getElementById('flist-wb-bar')) return;
    const form = document.getElementById('CharacterForm');
    if (!form) return;

    const bar = makeEl('div', { class: 'flist-wb-bar', id: 'flist-wb-bar' });
    bar.appendChild(makeEl('span', { class: 'flist-wb-bar-label', text: 'F-list Workbench' }));

    const importBtn = makeEl('button', { class: 'flist-wb-btn', type: 'button', text: 'Import from Workbench' });
    importBtn.addEventListener('click', () => {
      const character = getCharacterName();
      if (!character) {
        toast({ title: 'No character', message: 'Could not determine character name from URL.', kind: 'error' });
        return;
      }
      showSnapshotPicker(character);
    });
    bar.appendChild(importBtn);

    const zipBtn = makeEl('button', { class: 'flist-wb-btn secondary', type: 'button', text: 'Import from ZIP file' });
    zipBtn.addEventListener('click', importFromLocalZip);
    bar.appendChild(zipBtn);

    const statusEl = makeEl('span', { class: 'flist-wb-status', text: '…' });
    bar.appendChild(statusEl);

    form.parentNode.insertBefore(bar, form);
    refreshStatus(statusEl);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && 'workbench_token' in changes) refreshStatus(statusEl);
    });
  }

  injectBar();
})();
