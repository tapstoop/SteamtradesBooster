# SteamTrades Booster

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-Install-4285F4?logo=google-chrome&logoColor=white)](https://chromewebstore.google.com/detail/steamtrades-booster/nonelebfpfibhlmajbejoilgiojalhba?authuser=0&hl=fr)
[![Firefox Add-on](https://img.shields.io/badge/Firefox_Add--on-Install-FF7139?logo=firefox&logoColor=white)](https://addons.mozilla.org/fr/firefox/addon/steamtrades-booster/)
[![GitHub Release](https://img.shields.io/github/v/release/tapstoop/SteamtradesBooster)](https://github.com/tapstoop/SteamtradesBooster/releases)

The essential trading companion for [steamtrades.com](https://www.steamtrades.com/). Easier trades in seconds.

<img width="1280" height="320" alt="logo" src="https://github.com/user-attachments/assets/1425bb0e-6dd1-4eb2-9dc7-5011d3275894" />

## Why SteamTrades Booster?

Trading on SteamTrades means juggling dozens of prices, spotting deals, and evaluating if a trade is actually worth your time. **SteamTrades Booster simplifies all of that**: real-time pricing from GG.deals, visual deal labels, and a powerful trade simulator to validate exchanges before you commit.

<img width="1078" height="633" alt="Capture d’écran du 2026-06-12 16-10-26" src="https://github.com/user-attachments/assets/741c716f-6d78-4237-a2f1-1c9c0f0aad29" />
<img width="260" height="421" alt="Capture d’écran du 2026-06-12 16-07-22" src="https://github.com/user-attachments/assets/48a2527e-a1bb-4332-8b7d-56a3ced2dcab" />
<img width="260" height="421" alt="Capture d’écran du 2026-06-12 16-06-54" src="https://github.com/user-attachments/assets/8038cc82-14f4-4c4f-945b-068892f3cb54" />
<img width="260" height="421" alt="Capture d’écran du 2026-06-12 16-06-43" src="https://github.com/user-attachments/assets/e02cad89-a664-4939-a27f-e08d8b3a800e" />

---

## What You Get

### Game Labels
Every game on a trade page gets a clear label:

- **WISH**: On your Steam wishlist.
- **DEAL**: Priced below historical average.
- **ATL**: At its all-time low price.
- **DELISTED**: No longer sold on key shops, potentially scarce.
- **TRADE**: In your tradables list, ready to offer.

Instantly see which games matter to you.

### Live Pricing
Current prices, all-time lows, and price history for every game. No more cross-referencing across multiple sites.

### Trade Simulator
A side panel workstation for evaluating trades:

- Add games to either side of the exchange.
- See total value and price breakdown instantly.
- Spot unbalanced trades before you commit.
- Compare side by side with live GG.deals data.

### Trading Dashboard

**Wishlist Tab**: Your wishlist games with current prices and deal ratings, so you know when to grab a deal.

**Tradables Tab**: Manage your inventory. Add or remove items, or bulk import your Steam library in one click.

**Price Trends**: Follow the price history of your tradable games in real time.

---

## Quick Start

1. Get a free API key at [https://gg.deals/api/](https://gg.deals/api/)
2. Activate your account through the confirmation email
3. Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/steamtrades-booster/nonelebfpfibhlmajbejoilgiojalhba?authuser=0&hl=fr), [Firefox Add-ons](https://addons.mozilla.org/fr/firefox/addon/steamtrades-booster/), or download the latest package from the [releases page](https://github.com/tapstoop/SteamtradesBooster/releases) and install manually (see below)
4. Open the popup → **Settings** → paste your API key and Steam profile URL
5. Visit any trade page on [steamtrades.com](https://www.steamtrades.com) — overlays and sidebar activate automatically

> **Note:** The Chrome Web Store version may be a few releases behind. The GitHub version is the latest nightly build — expect newer features but also potential rough edges.

### Installing from a Release

1. Go to the [releases page](https://github.com/tapstoop/SteamtradesBooster/releases)
2. Download the `steamtrades_booster_v<version>.zip` file from the latest release
3. Unzip it anywhere on your computer

**Chromium browsers** (Chrome, Brave, Edge, Opera, etc.):

4. Go to `chrome://extensions/`
5. Enable **Developer mode** (toggle in the top-right corner)
6. Click **Load unpacked** and select the unzipped folder
7. Click the puzzle piece icon in the toolbar, find SteamTrades Booster, and click the pin icon to keep it visible

**Firefox:**

4. Go to `about:debugging#/runtime/this-firefox`
5. Click **Load Temporary Add-on**
6. Select `manifest.json` inside the unzipped folder

---

## Development

Built with **Manifest V3**, **esbuild**, **Vitest**, and vanilla JavaScript.

### Prerequisites

- Node.js 18+
- Git

### Setup

```bash
git clone https://github.com/tapstoop/SteamtradesBooster.git
cd SteamtradesBooster
npm ci
```

### Build

```bash
npm run build          # Chrome package (default)
npm run build:chrome   # Chrome package (explicit)
npm run build:firefox  # Firefox package
```

Each produces a `steamtrades_booster_<browser>_v<version>/` folder and `.zip` package in the project root.

To test in Chrome:
1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `steamtrades_booster_chrome_v<version>/` folder

To test in Firefox:
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `steamtrades_booster_firefox_v<version>/manifest.json`

### Testing

```bash
npm test
```

All tests use Vitest with mocked Chrome APIs. Network-dependent tests use fixture data.

### Contributing

1. Fork the repo and create a branch from `main`.
2. Make your changes — keep them focused (one feature/fix per PR).
3. If implementing a new feature, add tests for it when existing coverage is insufficient.
4. Run `npm test` to verify nothing breaks.
5. Open a PR with a clear description of what changed and why.

Commits follow conventional commit format (`feat:`, `fix:`, `refactor:`, `docs:`, etc.).

---

## Under the Hood

- **Manifest V3** — Modern, secure extension architecture  
- **Content injection** on SteamTrades pages for real-time overlays  
- **Background service worker** — Fast GG.deals API caching  
- **Steam integration** — Direct wishlist and inventory fetching  
- **Fuzzy title matching** — Handles game name variations automatically

---

## License

Licensed under the [Apache License 2.0](LICENSE).
