const SIDECAR_BASE = "http://127.0.0.1:27384";
const STORAGE_KEY = "workbench_token";

async function getToken() {
  const { [STORAGE_KEY]: token } = await chrome.storage.local.get(STORAGE_KEY);
  return token || null;
}

async function setToken(token) {
  await chrome.storage.local.set({ [STORAGE_KEY]: token });
}

async function clearToken() {
  await chrome.storage.local.remove(STORAGE_KEY);
}

async function sidecarFetch(
  path,
  { method = "GET", body = null, requireAuth = true } = {},
) {
  const headers = {};
  if (body && !(body instanceof ArrayBuffer) && !(body instanceof Blob)) {
    headers["Content-Type"] = "application/json";
  }
  if (requireAuth) {
    const token = await getToken();
    if (!token) return { ok: false, status: 401, error: "not_paired" };
    headers["X-Workbench-Auth"] = token;
  }
  let res;
  try {
    res = await fetch(SIDECAR_BASE + path, {
      method,
      headers,
      body:
        body &&
        typeof body === "object" &&
        !(body instanceof ArrayBuffer) &&
        !(body instanceof Blob)
          ? JSON.stringify(body)
          : body,
    });
  } catch (err) {
    return { ok: false, status: 0, error: "unreachable", detail: String(err) };
  }
  return res;
}

async function beginHandshake() {
  const res = await sidecarFetch("/restore/handshake", {
    method: "POST",
    requireAuth: false,
  });
  if (res.ok === false) return res;
  if (!res.ok)
    return { ok: false, status: res.status, error: "handshake_failed" };
  const data = await res.json();
  return { ok: true, handshake_id: data.handshake_id, token: data.token };
}

async function pollHandshakeStatus(handshake_id) {
  const res = await sidecarFetch(
    `/restore/handshake-status?handshake_id=${encodeURIComponent(handshake_id)}`,
    { requireAuth: false },
  );
  if (res.ok === false) return res;
  if (!res.ok) return { ok: false, status: res.status, error: "poll_failed" };
  return { ok: true, ...(await res.json()) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "get_token_status": {
          const token = await getToken();
          sendResponse({ paired: !!token });
          return;
        }
        case "begin_pairing": {
          const begun = await beginHandshake();
          if (!begun.ok) {
            sendResponse(begun);
            return;
          }
          await setToken(begun.token);
          sendResponse({ ok: true, handshake_id: begun.handshake_id });
          return;
        }
        case "poll_pairing": {
          const status = await pollHandshakeStatus(msg.handshake_id);
          if (status.ok && status.status === "rejected") {
            await clearToken();
          }
          sendResponse(status);
          return;
        }
        case "list_snapshots": {
          const res = await sidecarFetch(
            `/restore/snapshots?character=${encodeURIComponent(msg.character)}`,
          );
          if (res.ok === false) {
            sendResponse(res);
            return;
          }
          if (res.status === 401) {
            await clearToken();
            sendResponse({ ok: false, status: 401, error: "not_paired" });
            return;
          }
          if (!res.ok) {
            sendResponse({
              ok: false,
              status: res.status,
              error: "list_failed",
            });
            return;
          }
          sendResponse({ ok: true, snapshots: await res.json() });
          return;
        }
        case "fetch_snapshot": {
          const res = await sidecarFetch(
            `/restore/snapshot/${encodeURIComponent(msg.snapshot_id)}?character=${encodeURIComponent(msg.character)}`,
          );
          if (res.ok === false) {
            sendResponse(res);
            return;
          }
          if (!res.ok) {
            sendResponse({
              ok: false,
              status: res.status,
              error: "fetch_failed",
            });
            return;
          }
          const buf = await res.arrayBuffer();
          sendResponse({ ok: true, bytes: Array.from(new Uint8Array(buf)) });
          return;
        }
        case "snapshot_form_state": {
          const res = await sidecarFetch("/restore/snapshot/fresh", {
            method: "POST",
            body: { character: msg.character, payload: msg.payload },
          });
          if (res.ok === false) {
            sendResponse(res);
            return;
          }
          if (!res.ok) {
            sendResponse({
              ok: false,
              status: res.status,
              error: "snapshot_failed",
            });
            return;
          }
          sendResponse({ ok: true, ...(await res.json()) });
          return;
        }
        case "restore_done": {
          await sidecarFetch("/restore/done", {
            method: "POST",
            body: { character: msg.character },
          });
          sendResponse({ ok: true });
          return;
        }
        case "unpair": {
          await clearToken();
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: "unknown_message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: "exception", detail: String(err) });
    }
  })();
  return true;
});
