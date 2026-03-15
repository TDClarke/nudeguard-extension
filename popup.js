// NudeGuard – Popup Script

const enabledToggle  = document.getElementById('enabledToggle');
const blurSlider     = document.getElementById('blurIntensity');
const sensSlider     = document.getElementById('sensitivity');
const blurVal        = document.getElementById('blurVal');
const sensVal        = document.getElementById('sensVal');
const statBlurred    = document.getElementById('statBlurred');
const statScanned    = document.getElementById('statScanned');
const statusPill     = document.getElementById('statusPill');
const statusText     = document.getElementById('statusText');
const resetBtn       = document.getElementById('resetStats');

// ── Load saved settings ──────────────────────────────────────────────────────
chrome.storage.sync.get(['enabled', 'blurIntensity', 'sensitivity', 'stats'], (data) => {
  enabledToggle.checked = data.enabled !== false;
  blurSlider.value      = data.blurIntensity || 20;
  sensSlider.value      = Math.round((data.sensitivity || 0.7) * 100);

  blurVal.textContent = `${blurSlider.value}px`;
  sensVal.textContent = `${sensSlider.value}%`;

  const stats = data.stats || { blurred: 0, scanned: 0 };
  statBlurred.textContent = stats.blurred;
  statScanned.textContent = stats.scanned;

  updateStatusPill(enabledToggle.checked);
});

// ── Listeners ────────────────────────────────────────────────────────────────
enabledToggle.addEventListener('change', () => {
  const val = enabledToggle.checked;
  chrome.storage.sync.set({ enabled: val });
  updateStatusPill(val);
});

blurSlider.addEventListener('input', () => {
  const val = parseInt(blurSlider.value);
  blurVal.textContent = `${val}px`;
  chrome.storage.sync.set({ blurIntensity: val });
});

sensSlider.addEventListener('input', () => {
  const pct = parseInt(sensSlider.value);
  sensVal.textContent = `${pct}%`;
  chrome.storage.sync.set({ sensitivity: pct / 100 });
});

resetBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESET_STATS' }, () => {
    statBlurred.textContent = '0';
    statScanned.textContent = '0';
    // Brief flash animation
    [statBlurred, statScanned].forEach(el => {
      el.style.transition = 'opacity .15s';
      el.style.opacity = '0.2';
      setTimeout(() => (el.style.opacity = '1'), 200);
    });
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function updateStatusPill(active) {
  statusPill.className = `status-pill ${active ? 'on' : 'off'}`;
  statusText.textContent = active ? 'ACTIVE' : 'PAUSED';
}

// ── Live stat refresh every second ───────────────────────────────────────────
setInterval(() => {
  chrome.storage.sync.get(['stats'], (data) => {
    const stats = data.stats || { blurred: 0, scanned: 0 };
    animateCount(statBlurred, stats.blurred);
    animateCount(statScanned, stats.scanned);
  });
}, 1500);

function animateCount(el, newVal) {
  const cur = parseInt(el.textContent) || 0;
  if (cur === newVal) return;
  el.textContent = newVal;
}
