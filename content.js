// NudeGuard – Content Script v1.4 (nude.js integrated)

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
    LOG(`Booted. enabled=${settings.enabled} blur=${settings.blurIntensity}px`);
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

  // ── Shimmer styles ───────────────────────────────────────────────────────────
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

  // ── Analysis using nude.js ───────────────────────────────────────────────────
  const SKIP_EXTS = /\.(ico|svg|gif|cur|bmp)(\?|#|$)/i;

  async function analyzeImage(img) {
    if (!img.src || img.src.startsWith('chrome-extension://')) { releaseImage(img); return; }
    if (SKIP_EXTS.test(img.src)) { LOG(`Skip (type): ${shortUrl(img.src)}`); releaseImage(img); return; }
    if (img.naturalWidth < 100 || img.naturalHeight < 100) { releaseImage(img); return; }

    // Attempt 1: direct scan via nude.js
    let isNude = await scanWithNude(img);
    if (isNude !== null) {
      LOG(`✓ Direct nude.js scan: ${shortUrl(img.src)}`);
      return judge(isNude, img);
    }

    // Attempt 2: CORS fetch -> Probe Image
    LOG(`CORS fetch: ${shortUrl(img.src)}`);
    try {
      const resp = await fetch(img.src, { mode: 'cors', credentials: 'omit' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const probeImg = await blobToImage(await resp.blob());
      if (probeImg) {
        isNude = await scanWithNude(probeImg);
        if (isNude !== null) { LOG(`✓ CORS nude.js scan: ${shortUrl(img.src)}`); return judge(isNude, img); }
      }
    } catch (_) { /* fall through */ }

    // Attempt 3: Background Service Worker fetch -> Probe Image
    LOG(`SW fetch: ${shortUrl(img.src)}`);
    try {
      const dataUrl = await fetchViaBackground(img.src);
      const probeImg = await blobToImage(dataUrlToBlob(dataUrl));
      if (probeImg) {
        isNude = await scanWithNude(probeImg);
        if (isNude !== null) { LOG(`✓ SW nude.js scan: ${shortUrl(img.src)}`); return judge(isNude, img); }
      }
    } catch (err) {
      WARN(`All attempts failed (${err.message}): ${shortUrl(img.src)}`);
      sessionStats.skipped++;
    }

    // If unreadable, release to keep visible
    releaseImage(img);
  }

  function scanWithNude(imgEl) {
    return new Promise((resolve) => {
      try {
        if (!window.nude) return resolve(null);
        window.nude.load(imgEl);
        window.nude.scan((result) => {
          resolve(result); // boolean true / false
        });
      } catch (_) {
        // Tainted canvas or empty dimensions
        resolve(null);
      }
    });
  }

  function blobToImage(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const probe = new Image();
      probe.onload = () => { URL.revokeObjectURL(url); resolve(probe); };
      probe.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      probe.src = url;
    });
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

  function dataUrlToBlob(dataUrl) {
    const [header, b64] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  // ── Judge ─────────────────────────────────────────────────────────────────────
  function judge(isNude, img) {
    sessionStats.scanned++;
    LOG(`nude.js evaluation: ${isNude ? 'Nude → BLUR' : 'Clean'} (${shortUrl(img.src)})`);
    if (isNude) {
      applyBlur(img);
      sessionStats.blurred++;
      syncStats();
    } else {
      releaseImage(img);
    }
  }

  // ── Blur / overlay ────────────────────────────────────────────────────────────
  function blurValue() { return `blur(${settings.blurIntensity}px)`; }

  function applyBlur(img) {
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