# 🛡️ NudeGuard – AI-Powered Safe Browsing Extension

A Chrome extension that automatically detects and blurs explicit images using the [nude.js](https://github.com/pa7/nude.js) nudity detection library.

---

## 📁 File Structure

```
nudeguard-extension/
├── manifest.json      # Extension manifest (MV3)
├── background.js      # Service worker – settings & stats persistence
├── content.js         # Page scanner – detects & blurs images
├── nude.js            # ⚠️ Placeholder – see Setup below
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## ⚙️ Setup (Required)

### 1. Download the real nude.js library

The `nude.js` file in this package is a **stub placeholder**. You must replace it with the real library:

```bash
curl -o nude.js https://raw.githubusercontent.com/pa7/nude.js/master/src/nude.js
```

Or via npm:
```bash
npm install nudejs
cp node_modules/nudejs/src/nude.js ./nude.js
```

### 2. Load the extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this `nudeguard-extension/` folder
5. The 🛡️ NudeGuard icon will appear in your toolbar

---

## 🎛️ Features

| Feature | Description |
|---|---|
| **Auto-blur** | Scans all images on a page and blurs explicit ones |
| **Hold to Reveal** | Users can hold the "reveal" button on blurred images for 0.8s to temporarily unblur |
| **Adjustable Blur Intensity** | Slider from 4px (subtle) to 40px (heavy) |
| **Adjustable Sensitivity** | Control the nudity score threshold (10%–95%) |
| **Toggle On/Off** | Instantly pause/resume protection |
| **Stats Tracking** | See how many images have been scanned and blurred |
| **DOM Observer** | Watches for dynamically loaded images (infinite scroll, SPAs) |

---

## 🔬 How It Works

1. **Content script** (`content.js`) injects into every page
2. All `<img>` elements are queued for analysis (throttled to avoid UI freezing)
3. Each image is loaded into an off-screen `Image` element with `crossOrigin = 'anonymous'`
4. `nude.js` performs skin-pixel analysis and returns a **score** (0–1)
5. If `score >= sensitivity`, a CSS `blur()` filter is applied and an overlay is added
6. Detected images get a "Hold to reveal" button for a 0.8-second hold-to-show gesture

---

## ⚠️ Limitations

- **CORS**: Images served without CORS headers cannot be analyzed (canvas tainting restriction). The extension skips these gracefully.
- **Accuracy**: nude.js uses skin-pixel heuristics, not deep learning. Expect some false positives and false negatives.
- **Performance**: Very image-heavy pages may see a slight slowdown; the queue throttle minimizes this.
- **HTTPS**: Works on both HTTP and HTTPS sites.

---

## 🔒 Privacy

- **No data leaves your browser.** All analysis is done locally via JavaScript.
- No images are uploaded to any server.
- Stats are stored locally in `chrome.storage.sync`.
