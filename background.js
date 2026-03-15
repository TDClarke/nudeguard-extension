// NudeGuard – Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({
    enabled: true,
    blurIntensity: 20,
    sensitivity: 0.7,
    stats: { blurred: 0, scanned: 0 }
  });
  console.log('[NudeGuard] Extension installed.');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Privileged image fetch ─────────────────────────────────────────────────
  // Content scripts are bound by CORS. Service workers are not — they run in
  // an extension context that can fetch any URL the extension has host_permissions
  // for. We fetch the image, base64-encode it, and send it back so the content
  // script can load it as a data-URI (same-origin to itself → no canvas taint).
  if (message.type === 'FETCH_IMAGE') {
    fetch(message.url, { credentials: 'omit' })
      .then(async (resp) => {
        if (!resp.ok) { sendResponse({ error: `HTTP ${resp.status}` }); return; }
        const contentType = resp.headers.get('content-type') || 'image/jpeg';
        const buffer = await resp.arrayBuffer();
        // Convert ArrayBuffer → base64 string
        const bytes = new Uint8Array(buffer);
        let binary = '';
        // Process in chunks to avoid call-stack overflow on large images
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        const b64 = btoa(binary);
        sendResponse({ dataUrl: `data:${contentType};base64,${b64}` });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true; // keep message channel open for async response
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  if (message.type === 'UPDATE_STATS') {
    chrome.storage.sync.get(['stats'], (result) => {
      const stats = result.stats || { blurred: 0, scanned: 0 };
      stats.blurred += message.blurred || 0;
      stats.scanned += message.scanned || 0;
      chrome.storage.sync.set({ stats });
      sendResponse({ success: true, stats });
    });
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    chrome.storage.sync.get(['enabled', 'blurIntensity', 'sensitivity', 'stats'], sendResponse);
    return true;
  }

  if (message.type === 'RESET_STATS') {
    chrome.storage.sync.set({ stats: { blurred: 0, scanned: 0 } }, () => sendResponse({ success: true }));
    return true;
  }
});
