// Runs in the PAGE'S MAIN WORLD on character_edit.php (manifest
// content_scripts entry with "world": "MAIN"). This file has direct
// access to F-list's own globals — uploadImage, deleteImage, FList.* —
// which the isolated-world content.js cannot reach. F-list's CSP
// forbids inline <script> tags, so dynamic <script> injection from
// the isolated world silently no-ops. Bridging via window.postMessage
// works regardless of CSP because no string-to-code evaluation happens.
//
// The isolated content.js sends:
//   window.postMessage({ type: 'flist-wb-rpc', id, action, args }, '*')
// We respond with:
//   window.postMessage({ type: 'flist-wb-rpc-result', id, ok, error? }, '*')

(() => {
  'use strict';

  function handle(action, args) {
    switch (action) {
      case 'uploadImage':
        if (typeof window.uploadImage === 'function') {
          window.uploadImage();
          return { ok: true };
        }
        return { ok: false, error: 'uploadImage not on page' };

      case 'uploadAvatar':
        // F-list's avatar upload path varies. Common entry points:
        // window.uploadAvatar, window.submitAvatar, or just relying on
        // the file input change event. Try a few.
        if (typeof window.uploadAvatar === 'function') {
          window.uploadAvatar();
          return { ok: true };
        }
        if (typeof window.submitAvatar === 'function') {
          window.submitAvatar();
          return { ok: true };
        }
        return { ok: true, note: 'no upload function found; file input set, page will pick up on Save' };

      case 'deleteImage':
        if (typeof window.deleteImage === 'function') {
          window.deleteImage(String(args.id));
          return { ok: true };
        }
        return { ok: false, error: 'deleteImage not on page' };

      case 'addCustomKink':
        if (window.FList && typeof window.FList.CharEditor_addKink === 'function') {
          window.FList.CharEditor_addKink();
          return { ok: true };
        }
        return { ok: false, error: 'FList.CharEditor_addKink not available' };

      case 'removeCustomKink':
        if (
          window.FList &&
          window.FList.Subfetish &&
          window.FList.Subfetish.Data &&
          typeof window.FList.Subfetish.Data.removeCustom === 'function'
        ) {
          window.FList.Subfetish.Data.removeCustom(String(args.id));
          return { ok: true };
        }
        return { ok: false, error: 'FList.Subfetish.Data.removeCustom not available' };

      case 'jqueryRemove':
        // Custom-kink container removal — F-list's UI is jQuery-driven
        // so $('#x').remove() also fires teardown handlers a bare
        // .remove() on a DOM node would skip.
        if (window.$ && typeof window.$ === 'function') {
          try { window.$('#' + args.selector).remove(); return { ok: true }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        }
        try {
          const node = document.getElementById(args.selector);
          if (node) node.remove();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }

      case 'selectFetish':
        // F-list's own per-kink chooser. Mirrors what its click handlers
        // call: updates #FetishSelect<id>.val + toggles
        // .FetishLink<id> / .FetishImage<id> CSS classes so the visible
        // picker chip flips and the underlying hidden input ends up
        // with the right value, in lockstep. The 3rd arg "force" makes
        // the function take the apply branch unconditionally; without
        // it, calling with the same choice the kink already has would
        // toggle it back to "undecided" (the click handler's normal
        // "click-the-active-chip-to-clear" behaviour). For 'undecided'
        // target the apply branch still does the right thing — the
        // #FetishLink<undecided><id> selector silently no-ops and
        // FetishChoicePicked is removed from all chips of that id.
        try {
          if (
            window.FList &&
            typeof window.FList.CharEditor_selectFetish === 'function'
          ) {
            window.FList.CharEditor_selectFetish(
              String(args.id),
              String(args.choice),
              true
            );
            return { ok: true };
          }
          return { ok: false, error: 'FList.CharEditor_selectFetish not available' };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }

      case 'moveImage':
        // F-list exposes window.moveImageToFrontBack(imageId, toFront)
        // — the same function the per-row arrow `onclick` handlers call.
        // toFront=true moves to the head of the list; toFront=false
        // moves to the tail. There's no adjacent-swap primitive, so to
        // converge an arbitrary permutation the caller iterates the
        // desired order in REVERSE and calls toFront=true on each id —
        // N calls regardless of starting order. The function uses a
        // 100ms fadeOut animation, so the caller should pause ~150ms
        // between calls to let each fade settle before the next runs.
        try {
          if (typeof window.moveImageToFrontBack === 'function') {
            window.moveImageToFrontBack(
              Number(args.id),
              !!args.toFront
            );
            return { ok: true };
          }
          return { ok: false, error: 'moveImageToFrontBack not on page' };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }

      case 'setSelectVal':
        // F-list wraps infotag selects with Select2-style widgets. Native
        // `.value = x` updates the underlying <select> but the visible
        // widget stays on the old option. jQuery's `.val(x).trigger('change')`
        // updates both. Fall back to native if jQuery isn't loaded.
        try {
          if (window.$ && typeof window.$ === 'function') {
            const $el = window.$('[name="' + args.name.replace(/"/g, '\\"') + '"]');
            $el.val(args.value);
            $el.trigger('change');
            return { ok: true };
          }
          const el = document.querySelector('[name="' + args.name.replace(/"/g, '\\"') + '"]');
          if (el) {
            el.value = args.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          }
          return { ok: false, error: 'select not found: ' + args.name };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }

      case 'setCustomKinkRows':
        // Populate the N visible CustomKink<N> rows from a payload of
        // [{name, description, choice}, ...]. The earlier version
        // queried [name="customkinkname[]"] across the form which also
        // matched CustomKink_TEMPLATE_'s hidden input — writing to
        // that triggered F-list's setCustomName onchange handler which
        // throws because the template has no kink data backing it.
        // jQuery 1.7's trigger() re-throws synchronous handler errors,
        // aborting the loop after row 0. Filter to real containers.
        try {
          const realRows = Array.from(document.querySelectorAll(
            '[id^="CustomKink"]:not([id="CustomKinksList"]):not([id*="TEMPLATE"]):not([id*="template"])'
          ));
          const rows = args.rows || [];
          const filled = [];
          const errors = [];
          // Setting input.value alone is enough — F-list reads the
          // form fields at submit time. Firing 'change' triggers F-list's
          // setCustomName onchange handler which expects an entry in
          // FList.Subfetish.Data.customs keyed by input.dataset.id; that
          // mapping is lazy-initialized on first user interaction and
          // doesn't exist yet for freshly-added rows. Skipping the
          // change event keeps the values correct on Save and avoids
          // the uncaught TypeError noise in console.
          rows.forEach((row, i) => {
            const container = realRows[i];
            if (!container) {
              errors.push(`row ${i}: no container at index ${i} (have ${realRows.length})`);
              return;
            }
            const nameInput = container.querySelector('[name="customkinkname[]"]');
            const descInput = container.querySelector('[name="customkinkdescription[]"]');
            const choiceInput = container.querySelector('[name="customkinkchoice[]"]');
            if (nameInput) nameInput.value = row.name || '';
            if (descInput) descInput.value = row.description || '';
            if (choiceInput) choiceInput.value = row.choice || 'undecided';
            filled.push(i);
          });
          return { ok: true, filled: filled.length, total: rows.length, errors };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }

      case 'ping':
        return { ok: true, world: 'main' };

      default:
        return { ok: false, error: 'unknown action ' + action };
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.type !== 'flist-wb-rpc') return;
    let res;
    try { res = handle(m.action, m.args || {}); }
    catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
    window.postMessage({
      type: 'flist-wb-rpc-result',
      id: m.id,
      ok: !!res.ok,
      error: res.error || null,
      note: res.note || null,
    }, '*');
  });

  // Hello-handshake so the isolated world can detect that the page-world
  // bridge is present without round-tripping a real RPC.
  window.postMessage({ type: 'flist-wb-rpc-ready' }, '*');
})();
