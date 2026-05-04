# SteamTrades Booster

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

1. Get a free API key at [api.gg.deals](https://api.gg.deals)  
2. Install in Chrome → Developer mode → **Load unpacked** → select the extension folder  
3. Open the popup → **Settings** → paste your API key and Steam profile URL  
4. Visit any trade page on [steamtrades.com](https://www.steamtrades.com) — overlays and sidebar activate automatically

---

## Build

```bash
npm install
npm run build
```

Load the `dist/` folder as an unpacked extension in Chrome.

---

## Under the Hood

- **Manifest V3** — Modern, secure extension architecture  
- **Content injection** on SteamTrades pages for real-time overlays  
- **Background service worker** — Fast GG.deals API caching  
- **Steam integration** — Direct wishlist and inventory fetching  
- **Fuzzy title matching** — Handles game name variations automatically
