// NudeGuard – Content Script v1.6 (Stack Overflow & Crash Fix)

(function () {
  'use strict';

  const LOG  = (...a) => console.log('[NudeGuard]', ...a);
  const WARN = (...a) => console.warn('[NudeGuard]', ...a);

  let settings = { enabled: true, blurIntensity: 20, sensitivity: 0.7 };
  let sessionStats = { blurred: 0, scanned: 0, skipped: 0 };
  const processedMedia = new WeakSet();
  const videoIntervals = new WeakMap();
  const QUEUE_DELAY = 100;
  let queue = [];
  let processing = false;

  // Max dimension for nude.js scan canvas (Prevents recursion stack overflow)
  const MAX_SCAN_DIM = 250;

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
      if (!settings.enabled) removeAllBlurs(); else scanAllMedia();
    }
    if (changes.blurIntensity) settings.blurIntensity = changes.blurIntensity.newValue;
    if (changes.sensitivity)   settings.sensitivity   = changes.sensitivity.newValue;
    updateExistingBlurs();
  });

  // ── Init ──────────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    scanAllMedia();
    observeDOM();
  }

  function scanAllMedia() {
    const elements = document.querySelectorAll('img, video');
    elements.forEach(enqueue);
  }

  function observeDOM() {
    const mo = new MutationObserver((mutations) => {
      if (!settings.enabled) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          // Skip NudeGuard's own injected UI elements to prevent MutationObserver loops
          if (node.classList?.contains('nudeguard-wrap') || node.classList?.contains('nudeguard-shimmer')) continue;

          if (node.tagName === 'IMG' || node.tagName === 'VIDEO') enqueue(node);
          if (node.querySelectorAll) {
            node.querySelectorAll('img:not([data-nudeguard]), video:not([data-nudeguard])').forEach(enqueue);
          }
        }
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
  function holdMedia(el) {
    if (el.getAttribute('data-nudeguard')) return;

    const width = el.naturalWidth || el.videoWidth || el.offsetWidth;
    const height = el.naturalHeight || el.videoHeight || el.offsetHeight;
    if (width < 80 || height < 80) return;

    if (el.parentElement && el.parentElement.classList.contains('nudeguard-wrap')) return;

    el.setAttribute('data-nudeguard', 'pending');
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.35s ease';

    const wrap = document.createElement('div');
    wrap.className = 'nudeguard-wrap';
    Object.assign(wrap.style, {
      position: 'relative',
      display: 'inline-block',
      lineHeight: '0',
      maxWidth: '100%',
      width:  el.offsetWidth  ? el.offsetWidth  + 'px' : 'auto',
      height: el.offsetHeight ? el.offsetHeight + 'px' : 'auto',
    });

    const shimmer = document.createElement('div');
    shimmer.className = 'nudeguard-shimmer';

    const icon = document.createElement('div');
    icon.className = 'nudeguard-scanning-icon';
    icon.textContent = '🛡️';

    el.parentNode?.insertBefore(wrap, el);
    wrap.appendChild(shimmer);
    wrap.appendChild(icon);
    wrap.appendChild(el);
  }

  function releaseMedia(el) {
    const wrap = el.parentElement;
    if (wrap && wrap.classList.contains('nudeguard-wrap')) {
      wrap.querySelector('.nudeguard-shimmer')?.remove();
      wrap.querySelector('.nudeguard-scanning-icon')?.remove();
    }
    el.style.opacity = '1';
    if (el.getAttribute('data-nudeguard') === 'pending') {
      el.removeAttribute('data-nudeguard');
    }
  }

  // ── Queue ─────────────────────────────────────────────────────────────────────
  function enqueue(el) {
    if (processedMedia.has(el)) return;
    processedMedia.add(el);

    if (el.tagName === 'VIDEO') {
      setupVideoListeners(el);
      if (el.readyState >= 2 && el.videoWidth > 0) {
        holdMedia(el);
        queue.push(el);
        if (!processing) processNext();
      } else {
        el.addEventListener('loadeddata', () => {
          holdMedia(el);
          queue.push(el);
          if (!processing) processNext();
        }, { once: true });
      }
    } else {
      if (!el.complete || !el.naturalWidth) {
        el.addEventListener('load', () => {
          holdMedia(el);
          queue.push(el);
          if (!processing) processNext();
        }, { once: true });
      } else {
        holdMedia(el);
        queue.push(el);
        if (!processing) processNext();
      }
    }
  }

  function processNext() {
    if (!queue.length) {
      processing = false;
      return;
    }
    processing = true;
    const el = queue.shift();
    analyzeMedia(el).finally(() => setTimeout(processNext, QUEUE_DELAY));
  }

  // ── Video Continuous Sampling ────────────────────────────────────────────────
  function setupVideoListeners(video) {
    let seekDebounce;
    video.addEventListener('seeked', () => {
      clearTimeout(seekDebounce);
      seekDebounce = setTimeout(() => analyzeMedia(video), 200);
    });

    video.addEventListener('play', () => {
      if (videoIntervals.has(video)) clearInterval(videoIntervals.get(video));
      const timer = setInterval(() => {
        if (video.paused || video.ended) {
          clearInterval(timer);
          videoIntervals.delete(video);
        } else {
          analyzeMedia(video);
        }
      }, 2000);
      videoIntervals.set(video, timer);
    });

    video.addEventListener('pause', () => {
      if (videoIntervals.has(video)) {
        clearInterval(videoIntervals.get(video));
        videoIntervals.delete(video);
      }
    });
  }

  // ── Downscaling Offscreen Canvas Helper (Fixes Stack Overflow) ───────────────
  function createDownscaledCanvas(mediaEl) {
    const origWidth = mediaEl.naturalWidth || mediaEl.videoWidth || mediaEl.width || mediaEl.offsetWidth;
    const origHeight = mediaEl.naturalHeight || mediaEl.videoHeight || mediaEl.height || mediaEl.offsetHeight;

    if (!origWidth || !origHeight) return null;

    let scale = 1;
    if (origWidth > MAX_SCAN_DIM || origHeight > MAX_SCAN_DIM) {
      scale = Math.min(MAX_SCAN_DIM / origWidth, MAX_SCAN_DIM / origHeight);
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(origWidth * scale));
    canvas.height = Math.max(1, Math.floor(origHeight * scale));

    const ctx = canvas.getContext('2d');
    try {
      ctx.drawImage(mediaEl, 0, 0, canvas.width, canvas.height);
      return canvas;
    } catch (_) {
      return null;
    }
  }

  // ── Analysis using nude.js ───────────────────────────────────────────────────
  const SKIP_EXTS = /\.(ico|svg|cur|bmp)(\?|#|$)/i;

  async function analyzeMedia(el) {
    const src = el.src || el.currentSrc;
    if (SKIP_EXTS.test(src)) { releaseMedia(el); return; }

    const width = el.naturalWidth || el.videoWidth || el.offsetWidth;
    const height = el.naturalHeight || el.videoHeight || el.offsetHeight;
    if (width < 80 || height < 80) { releaseMedia(el); return; }

    // Attempt 1: Safe Downscaled Canvas Scan
    const scaledCanvas = createDownscaledCanvas(el);
    if (scaledCanvas) {
      const isNude = await scanWithNude(scaledCanvas);
      if (isNude !== null) {
        return judge(isNude, el);
      }
    }

    // Attempt 2: CORS fetch -> Probe Image -> Downscaled Canvas
    if (el.tagName === 'IMG' && src && !src.startsWith('chrome-extension://')) {
      try {
        const resp = await fetch(src, { mode: 'cors', credentials: 'omit' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const probeImg = await blobToImage(await resp.blob());
        if (probeImg) {
          const probeCanvas = createDownscaledCanvas(probeImg);
          if (probeCanvas) {
            const isNude = await scanWithNude(probeCanvas);
            if (isNude !== null) return judge(isNude, el);
          }
        }
      } catch (_) { /* fall through */ }

      // Attempt 3: Service Worker fetch -> Probe Image -> Downscaled Canvas
      try {
        const dataUrl = await fetchViaBackground(src);
        const probeImg = await blobToImage(dataUrlToBlob(dataUrl));
        if (probeImg) {
          const probeCanvas = createDownscaledCanvas(probeImg);
          if (probeCanvas) {
            const isNude = await scanWithNude(probeCanvas);
            if (isNude !== null) return judge(isNude, el);
          }
        }
      } catch (err) {
        sessionStats.skipped++;
      }
    }

    releaseMedia(el);
  }

  function scanWithNude(canvasEl) {
    return new Promise((resolve) => {
      try {
        if (!window.nude) return resolve(null);
        window.nude.load(canvasEl);
        window.nude.scan((result) => {
          resolve(result);
        });
      } catch (_) {
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
  function judge(isNude, el) {
    sessionStats.scanned++;
    if (isNude) {
      applyBlur(el);
      sessionStats.blurred++;
      syncStats();
    } else if (el.getAttribute('data-nudeguard') !== 'blurred') {
      releaseMedia(el);
    }
  }

  // ── Blur / Overlay ────────────────────────────────────────────────────────────
  function blurValue() { return `blur(${settings.blurIntensity}px)`; }

  function applyBlur(el) {
    const wrap = el.parentElement;
    if (wrap && wrap.classList.contains('nudeguard-wrap')) {
      wrap.querySelector('.nudeguard-shimmer')?.remove();
      wrap.querySelector('.nudeguard-scanning-icon')?.remove();
    }
    el.setAttribute('data-nudeguard', 'blurred');
    el.style.opacity = '1';
    el.style.filter = blurValue();
    el.style.transition = 'opacity 0.3s ease, filter 0.4s ease';
    addRevealOverlay(el);
  }

  function addRevealOverlay(el) {
    const wrap = el.parentElement;
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
    document.querySelectorAll('[data-nudeguard]').forEach((el) => {
      el.style.filter = '';
      el.style.opacity = '1';
      el.removeAttribute('data-nudeguard');
      const wrap = el.parentElement;
      if (wrap?.classList.contains('nudeguard-wrap')) {
        wrap.querySelector('.nudeguard-shimmer')?.remove();
        wrap.querySelector('.nudeguard-scanning-icon')?.remove();
        wrap.querySelector('.nudeguard-badge')?.remove();
      }
    });
  }

  function updateExistingBlurs() {
    document.querySelectorAll('[data-nudeguard="blurred"]').forEach((el) => {
      el.style.filter = blurValue();
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  let syncTimer;
  function syncStats() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type:'UPDATE_STATS', blurred:sessionStats.blurred, scanned:sessionStats.scanned });
      sessionStats.blurred = 0; sessionStats.scanned = 0;
    }, 2000);
  }

})();