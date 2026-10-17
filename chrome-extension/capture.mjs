// Only these three headers leave Chrome, over a native pipe to the local helper.
// Request URLs, cookies, bodies, recordings and transcripts are never forwarded.
export function captureCredentials(details) {
  if (details.initiator !== 'https://web.plaud.ai' || details.tabId < 0) return null;
  let url;
  try { url = new URL(details.url); } catch { return null; }
  if (url.origin !== 'https://api.plaud.ai' || !url.pathname.startsWith('/file/')) return null;
  const headers = new Map((details.requestHeaders ?? []).map(h => [h.name.toLowerCase(), h.value]));
  const auth = headers.get('authorization');
  const userToken = headers.get('x-pld-user');
  const deviceId = headers.get('x-device-id');
  if (!auth || !userToken || !deviceId) return null;
  return { type: 'credentials', auth, userToken, deviceId };
}

// Coalesce bursts and serialize native processes. Only remember a credential
// after the helper acknowledges it, so installation/IO failures can be retried.
export function createSync(send, status) {
  let lastSaved;
  let pending;
  let running = false;
  return async function sync(credentials) {
    pending = credentials;
    if (running) return;
    running = true;
    try {
      while (pending) {
        const current = pending;
        pending = undefined;
        const identity = JSON.stringify(current);
        if (identity === lastSaved) continue;
        try {
          const reply = await send(current);
          if (reply?.ok !== true) throw new Error('sync failed');
          lastSaved = identity;
          status(true);
        } catch {
          // Never log native errors: they might contain sensitive input.
          status(false);
          pending = undefined;
        }
      }
    } finally { running = false; }
  };
}

// Safe diagnostics only: no URL, token value, request body or account identifier.
export function inspectRequest(details) {
  let url;
  try { url = new URL(details.url); } catch { return null; }
  if (url.origin !== 'https://api.plaud.ai') return null;
  const names = new Set((details.requestHeaders ?? []).filter(h => !!h.value).map(h => h.name.toLowerCase()));
  return {
    fromPlaud: details.initiator === 'https://web.plaud.ai' && details.tabId >= 0,
    fileApi: url.pathname.startsWith('/file/'),
    headers: Object.fromEntries(['authorization', 'x-pld-user', 'x-device-id'].map(name => [name, names.has(name)])),
  };
}


export function describeNativeFailure(error) {
  const text = String(error?.message ?? '');
  // Emit only fixed descriptions of recognized Chrome errors, never raw text.
  if (/not found|not registered|does not exist/i.test(text)) return 'HOST_NOT_FOUND: Chrome cannot find the installed native helper.';
  if (/forbidden|not allowed/i.test(text)) return 'HOST_FORBIDDEN: Chrome denied access to the registered helper.';
  if (/failed to start|could not start|failed to launch/i.test(text)) return 'HOST_START_FAILED: Chrome found the helper but could not launch its executable.';
  if (/native host has exited|host exited/i.test(text)) return 'HOST_EXITED: Chrome started the helper, but it exited before returning a message.';
  if (/communicating|communication/i.test(text)) return 'HOST_COMMUNICATION_FAILED: Chrome could not exchange a valid native message with the helper.';
  if (/disconnected|port.*closed/i.test(text)) return 'HOST_DISCONNECTED: The native messaging connection closed before a reply.';
  return 'HOST_UNKNOWN_ERROR: Chrome could not complete the native helper request.';
}
