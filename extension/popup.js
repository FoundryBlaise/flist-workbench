const statusEl = document.getElementById('status');
const actionsEl = document.getElementById('actions');
const hintEl = document.getElementById('hint');

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: 'runtime', detail: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: 'no_response' });
      }
    });
  });
}

function explainError(res) {
  if (!res) return 'No response.';
  if (res.error === 'unreachable') return 'Workbench is not running. Start the F-list Workbench app and try again.';
  if (res.error === 'not_paired') return 'Extension is not paired with Workbench.';
  if (res.status === 401) return 'Token rejected. Re-pair via Workbench Settings → Security.';
  return `${res.error || 'Unknown error'}${res.detail ? ': ' + res.detail : ''}`;
}

function setStatus({ kind, text }) {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = text;
}

function clearActions() {
  actionsEl.innerHTML = '';
  hintEl.innerHTML = '';
}

function addButton({ label, onClick, kind }) {
  const b = document.createElement('button');
  if (kind) b.className = kind;
  b.textContent = label;
  b.addEventListener('click', onClick);
  actionsEl.appendChild(b);
  return b;
}

async function showPaired() {
  setStatus({ kind: 'paired', text: '● Paired with F-list Workbench. Open character_edit.php in F-list to begin a restore.' });
  clearActions();
  addButton({
    label: 'Unpair',
    kind: 'secondary',
    onClick: async () => {
      const res = await send({ type: 'unpair' });
      if (res.ok) await render();
    },
  });
  hintEl.textContent = 'Unpairing removes the local token. You can re-pair anytime — Workbench will prompt you to accept.';
}

async function showUnpaired() {
  setStatus({ kind: 'unpaired', text: '○ Not paired with Workbench. Start Workbench, then click Pair below — Workbench will ask you to accept this extension.' });
  clearActions();
  const pairBtn = addButton({
    label: 'Pair with Workbench',
    onClick: async () => {
      pairBtn.disabled = true;
      pairBtn.textContent = 'Asking Workbench…';
      const begun = await send({ type: 'begin_pairing' });
      if (!begun.ok) {
        setStatus({ kind: 'error', text: explainError(begun) });
        pairBtn.disabled = false;
        pairBtn.textContent = 'Pair with Workbench';
        return;
      }
      pairBtn.textContent = 'Waiting for you to accept in Workbench…';
      const handshakeId = begun.handshake_id;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const poll = await send({ type: 'poll_pairing', handshake_id: handshakeId });
        if (!poll.ok) {
          setStatus({ kind: 'error', text: explainError(poll) });
          break;
        }
        if (poll.status === 'accepted') { await render(); return; }
        if (poll.status === 'rejected') {
          setStatus({ kind: 'error', text: 'Pairing was rejected in Workbench.' });
          break;
        }
      }
      pairBtn.disabled = false;
      pairBtn.textContent = 'Pair with Workbench';
    },
  });
  hintEl.innerHTML = `Workbench sidecar lives at <code>127.0.0.1:27384</code>. If pairing fails, make sure Workbench is running.`;
}

async function render() {
  setStatus({ kind: '', text: 'Checking…' });
  const res = await send({ type: 'get_token_status' });
  if (res.paired) await showPaired();
  else await showUnpaired();
}

render();
