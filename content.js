// NudeGuard – Content Script v1.3 (hold-until-scanned)

(function () {
  'use strict';

  const LOG  = (...a) => console.log('[NudeGuard]', ...a);
  const WARN = (...a) => console.warn('[NudeGuard]', ...a);

  let settings = { enabled: true, blurIntensity: 20, sensitivity: 0.7 };
  let sessionStats = { blurred: 0, scanned: 0, skipped: 0 };
  const processedImages = new WeakSet();
  const QUEUE_DELAY = 80;
  let queue = [];
  let processing = false;

  // ── Boot ──────────────────────────────────────────────────────────────────────
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
    if (chrome.runtime.lastError) { WARN('Settings error:', chrome.runtime.lastError.message); return; }
    if (resp) settings = { ...settings, ...resp };
    LOG(`Booted. enabled=${settings.enabled} sensitivity=${settings.sensitivity} blur=${settings.blurIntensity}px`);
    if (settings.enabled) init();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled !== undefined) {
      settings.enabled = changes.enabled.newValue;
      if (!settings.enabled) removeAllBlurs(); else scanAllImages();
    }
    if (changes.blurIntensity) settings.blurIntensity = changes.blurIntensity.newValue;
    if (changes.sensitivity)   settings.sensitivity   = changes.sensitivity.newValue;
    updateExistingBlurs();
  });

  // ── Init ──────────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    const imgs = document.querySelectorAll('img');
    LOG(`Page loaded. Found ${imgs.length} images.`);
    imgs.forEach(enqueue);
    observeDOM();
  }

  function scanAllImages() { document.querySelectorAll('img').forEach(enqueue); }

  function observeDOM() {
    const mo = new MutationObserver((mutations) => {
      if (!settings.enabled) return;
      for (const m of mutations)
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'IMG') enqueue(node);
          node.querySelectorAll && node.querySelectorAll('img').forEach(enqueue);
        }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ── Shimmer styles (injected once) ───────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('nudeguard-styles')) return;
    const s = document.createElement('style');
    s.id = 'nudeguard-styles';
    s.textContent = `
      @keyframes ng-shimmer {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      .nudeguard-shimmer {
        position: absolute;
        inset: 0;
        border-radius: 4px;
        background: linear-gradient(90deg, #1c1c2e 25%, #2e2e50 50%, #1c1c2e 75%);
        background-size: 200% 100%;
        animation: ng-shimmer 1.4s linear infinite;
        z-index: 1;
        pointer-events: none;
      }
      .nudeguard-scanning-icon {
        position: absolute;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        font-size: 1.2em;
        z-index: 2;
        pointer-events: none;
        animation: ng-pulse 1.2s ease-in-out infinite;
      }
      @keyframes ng-pulse {
        0%, 100% { opacity: 0.5; transform: translate(-50%,-50%) scale(0.9); }
        50%       { opacity: 1;   transform: translate(-50%,-50%) scale(1.1); }
      }
    `;
    document.head.appendChild(s);
  }

  // ── Hold / release ────────────────────────────────────────────────────────────
  function holdImage(img) {
    if (!img.src || img.getAttribute('data-nudeguard')) return;
    if (img.naturalWidth < 100 || img.naturalHeight < 100) return;
    if (img.parentElement && img.parentElement.classList.contains('nudeguard-wrap')) return;

    img.setAttribute('data-nudeguard', 'pending');
    img.style.opacity = '0';
    img.style.transition = 'opacity 0.35s ease';

    const wrap = document.createElement('div');
    wrap.className = 'nudeguard-wrap';
    Object.assign(wrap.style, {
      position: 'relative', display: 'inline-block',
      lineHeight: '0', maxWidth: '100%',
      // Match the image's rendered size so layout doesn't shift
      width:  img.offsetWidth  ? img.offsetWidth  + 'px' : 'auto',
      height: img.offsetHeight ? img.offsetHeight + 'px' : 'auto',
    });

    const shimmer = document.createElement('div');
    shimmer.className = 'nudeguard-shimmer';

    const icon = document.createElement('div');
    icon.className = 'nudeguard-scanning-icon';
    icon.textContent = '🛡️';

    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(shimmer);
    wrap.appendChild(icon);
    wrap.appendChild(img);
  }

  function releaseImage(img) {
    // Clean image: remove shimmer + scanning icon, fade in
    const wrap = img.parentElement;
    if (wrap && wrap.classList.contains('nudeguard-wrap')) {
      wrap.querySelector('.nudeguard-shimmer')?.remove();
      wrap.querySelector('.nudeguard-scanning-icon')?.remove();
    }
    img.style.opacity = '1';
    img.removeAttribute('data-nudeguard');
  }

  // ── Queue ─────────────────────────────────────────────────────────────────────
  function enqueue(img) {
    if (processedImages.has(img)) return;
    processedImages.add(img);
    if (!img.complete || !img.naturalWidth) {
      img.addEventListener('load', () => {
        holdImage(img);
        queue.push(img);
        if (!processing) processNext();
      }, { once: true });
    } else {
      holdImage(img);
      queue.push(img);
      if (!processing) processNext();
    }
  }

  function processNext() {
    if (!queue.length) {
      processing = false;
      LOG(`Done. Scanned: ${sessionStats.scanned} Blurred: ${sessionStats.blurred} Skipped: ${sessionStats.skipped}`);
      return;
    }
    processing = true;
    const img = queue.shift();
    analyzeImage(img).finally(() => setTimeout(processNext, QUEUE_DELAY));
  }

  // ── Analysis ──────────────────────────────────────────────────────────────────
  const SKIP_EXTS = /\.(ico|svg|gif|cur|bmp)(\?|#|$)/i;

  async function analyzeImage(img) {
    if (!img.src || img.src.startsWith('chrome-extension://')) { releaseImage(img); return; }
    if (SKIP_EXTS.test(img.src)) { LOG(`Skip (type): ${shortUrl(img.src)}`); releaseImage(img); return; }
    if (img.naturalWidth < 100 || img.naturalHeight < 100) { releaseImage(img); return; }

    // Attempt 1: same-origin direct read
    let pixels = tryGetPixels(img);
    if (pixels) {
      LOG(`✓ Same-origin: ${shortUrl(img.src)}`);
      return judge(pixels, img);
    }

    // Attempt 2: CORS fetch
    LOG(`CORS fetch: ${shortUrl(img.src)}`);
    try {
      const resp = await fetch(img.src, { mode: 'cors', credentials: 'omit' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      pixels = await blobToPixels(await resp.blob());
      if (pixels) { LOG(`✓ CORS: ${shortUrl(img.src)}`); return judge(pixels, img); }
    } catch (_) { /* fall through */ }

    // Attempt 3: background service worker fetch (bypasses CORS entirely)
    LOG(`SW fetch: ${shortUrl(img.src)}`);
    try {
      const dataUrl = await fetchViaBackground(img.src);
      pixels = await blobToPixels(dataUrlToBlob(dataUrl));
      if (pixels) { LOG(`✓ SW: ${shortUrl(img.src)}`); return judge(pixels, img); }
    } catch (err) {
      WARN(`All attempts failed (${err.message}): ${shortUrl(img.src)}`);
      sessionStats.skipped++;
    }

    // If we reach here we couldn't scan it — release so the image is still visible
    releaseImage(img);
  }

  function fetchViaBackground(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (resp?.dataUrl) return resolve(resp.dataUrl);
        reject(new Error(resp?.error || 'no dataUrl'));
      });
    });
  }

  function blobToPixels(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const probe = new Image();
      probe.onload = () => { const px = tryGetPixels(probe); URL.revokeObjectURL(url); resolve(px); };
      probe.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      probe.src = url;
    });
  }

  function dataUrlToBlob(dataUrl) {
    const [header, b64] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function tryGetPixels(imgEl) {
    try {
      const MAX = 200;
      const w = imgEl.naturalWidth, h = imgEl.naturalHeight;
      const scale = Math.min(1, MAX / Math.max(w, h));
      const sw = Math.max(1, Math.floor(w * scale));
      const sh = Math.max(1, Math.floor(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = sw; canvas.height = sh;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgEl, 0, 0, sw, sh);
      return ctx.getImageData(0, 0, sw, sh).data;
    } catch (_) { return null; }
  }

  // ── Judge ─────────────────────────────────────────────────────────────────────
  function judge(pixels, img) {
    sessionStats.scanned++;
    const ratio = skinRatio(pixels);
    const hit = ratio >= settings.sensitivity;
    LOG(`Skin ${(ratio * 100).toFixed(1)}% ${hit ? '→ BLUR' : '→ clean'}: ${shortUrl(img.src)}`);
    if (hit) {
      applyBlur(img);   // keeps image hidden, adds overlay
      sessionStats.blurred++;
      syncStats();
    } else {
      releaseImage(img); // fade in
    }
  }

  // ── Skin detection ────────────────────────────────────────────────────────────
  function skinRatio(data) {
    let skin = 0, total = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
      if (a < 30) continue;
      total++;
      if (r > 95 && g > 40 && b > 20 &&
          Math.max(r,g,b) - Math.min(r,g,b) > 15 &&
          Math.abs(r-g) > 15 && r > g && r > b) skin++;
    }
    return total ? skin / total : 0;
  }

  // ── Blur / overlay ────────────────────────────────────────────────────────────
  function blurValue() { return `blur(${settings.blurIntensity}px)`; }

  function applyBlur(img) {
    // Remove shimmer/icon, but keep opacity 0 — the blur filter handles the reveal
    const wrap = img.parentElement;
    if (wrap && wrap.classList.contains('nudeguard-wrap')) {
      wrap.querySelector('.nudeguard-shimmer')?.remove();
      wrap.querySelector('.nudeguard-scanning-icon')?.remove();
    }
    img.setAttribute('data-nudeguard', 'blurred');
    img.style.opacity = '1';
    img.style.filter = blurValue();
    img.style.transition = 'opacity 0.3s ease, filter 0.4s ease';
    addRevealOverlay(img);
  }

  function addRevealOverlay(img) {
    const wrap = img.parentElement;
    if (!wrap || !wrap.classList.contains('nudeguard-wrap')) return;
    if (wrap.querySelector('.nudeguard-badge')) return;

    const badge = document.createElement('div');
    badge.className = 'nudeguard-badge';
    badge.innerHTML = `
      <span style="font-size:1.4em">🛡️</span>
      <span style="font-size:11px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.8);font-family:system-ui,sans-serif">Protected by NudeGuard</span>
    `;
    Object.assign(badge.style, {
      position:'absolute', inset:'0', display:'flex', flexDirection:'column',
      alignItems:'center', justifyContent:'center', gap:'5px',
      zIndex:'2147483647', pointerEvents:'none'
    });

    wrap.appendChild(badge);
  }

  function removeAllBlurs() {
    document.querySelectorAll('[data-nudeguard]').forEach((img) => {
      img.style.filter = '';
      img.style.opacity = '1';
      img.removeAttribute('data-nudeguard');
      const wrap = img.parentElement;
      if (wrap?.classList.contains('nudeguard-wrap')) {
        wrap.querySelector('.nudeguard-shimmer')?.remove();
        wrap.querySelector('.nudeguard-scanning-icon')?.remove();
        wrap.querySelector('.nudeguard-badge')?.remove();
      }
    });
  }

  function updateExistingBlurs() {
    document.querySelectorAll('[data-nudeguard="blurred"]').forEach((img) => {
      img.style.filter = blurValue();
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function shortUrl(u) { try { return new URL(u).pathname.slice(-40); } catch(_) { return String(u).slice(-40); } }

  let syncTimer;
  function syncStats() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type:'UPDATE_STATS', blurred:sessionStats.blurred, scanned:sessionStats.scanned });
      sessionStats.blurred = 0; sessionStats.scanned = 0;
    }, 2000);
  }

})();
