# SteamTrades Booster

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-Install-4285F4?logo=google-chrome&logoColor=white)](https://chromewebstore.google.com/detail/steamtrades-booster/nonelebfpfibhlmajbejoilgiojalhba?authuser=0&hl=fr)
[![GitHub Release](https://img.shields.io/github/v/release/tapstoop/SteamtradesBooster)](https://github.com/tapstoop/SteamtradesBooster/releases)

The essential trading companion for SteamTrades. Make smarter trades in seconds.

<img width="1280" height="320" alt="logo" src="https://github.com/user-attachments/assets/1425bb0e-6dd1-4eb2-9dc7-5011d3275894" />

## Why SteamTrades Booster?

Trading on SteamTrades means juggling dozens of prices, spotting deals, and evaluating if a trade is actually worth your time. **SteamTrades Booster brings market intelligence directly into your workflow** — real-time pricing from GG.deals, visual deal labels, and a powerful trade simulator to validate exchanges before you commit.

Stop second-guessing trades. Start making confident offers.

<img width="1280" height="800" alt="screenshotstore_1" src="https://github.com/user-attachments/assets/3e6c9784-5807-4656-ba61-9e078227bd92" />

<img width="1153" height="601" alt="showcase" src="https://github.com/user-attachments/assets/247ca0dd-ffa0-4234-9e04-07c54f17de9e" />

---

## What You Get

### 🎯 Smart Game Labeling
Every game on a trade page is instantly categorized:
- **WISH** — Games on your Steam wishlist  
- **OWN (WIP)** — Games you already have (from your tradables list)  
- **DEAL** — Games below historical average price  
- **ATL** — All-Time Low prices  
- **DELISTED (LIMITED ATM)** — Games no longer available on key shops  
- **TRADE** — Games that you're ready to trade

Know at a glance which games matter to you and what the market is paying.

### 📊 Price Trends at Your Fingertips
See current pricing, lowest recorded prices, and price history for every game. Understand price patterns without hunting across multiple sites.

### ⚖️ Trade Simulator
Build complete trades in a side panel workstation:
- Add games to both sides of the exchange  
- See total value and price composition instantly
- Spot misaligned trades before offering  
- Compare side-by-side with live GG.deals data

### 📋 Your Trading Dashboard
**Wishlist Tab:** All your wishlist games with current prices and deal ratings, sorted by best opportunity.

**Tradables Tab:** Manage your inventory — see every tradable game and add/remove items. Bulk import your Steam library in one click.

**Market Insights:** Track which games are priced lowest and highest across the market in real-time.

---

## Quick Start

1. Get a free API key at [https://gg.deals/api/](https://gg.deals/api/)
2. Activate your account through the confirmation email
3. [Install from the Chrome Web Store](https://chromewebstore.google.com/detail/steamtrades-booster/nonelebfpfibhlmajbejoilgiojalhba?authuser=0&hl=fr) (recommended) or download the latest package from the [releases page](https://github.com/tapstoop/SteamtradesBooster/releases) and install manually (see below)
4. Open the popup → **Settings** → paste your API key and Steam profile URL
5. Visit any trade page on [steamtrades.com](https://www.steamtrades.com) — overlays and sidebar activate automatically

> **Note:** The Chrome Web Store version may be a few releases behind. The GitHub version is the latest nightly build — expect newer features but also potential rough edges.

### Installing from a Release

1. Go to the [releases page](https://github.com/tapstoop/SteamtradesBooster/releases)
2. Download the `steamtrades_booster_v<version>.zip` file from the latest release
3. Unzip it anywhere on your computer
4. Open your Chromium-based browser (Chrome, Brave, Edge, Opera, etc.) and go to `chrome://extensions/`
5. Enable **Developer mode** (toggle in the top-right corner)
6. Click **Load unpacked** and select the unzipped folder
7. Click the puzzle piece icon in the toolbar, find SteamTrades Booster, and click the pin icon to keep it visible

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
npm run build
```

This produces a `steamtrades_booster_v<version>/` folder and a `steamtrades_booster_v<version>.zip` package in the project root.

To test in Chrome:
1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `steamtrades_booster_v<version>/` folder

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
