# SteamTrades Booster

The essential trading companion for SteamTrades. Make smarter trades in seconds.

> **A Chrome Web Store release is on its way — no installation hassle required. Stay tuned!**
>
> In the meantime, you can install it manually in minutes by following the guide below.

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

## Installation

### Step 1 — Prerequisites

You need two free tools installed on your computer before you start:

- **Git** — download from [git-scm.com](https://git-scm.com/downloads) and run the installer (default options are fine)
- **Node.js** — download from [nodejs.org](https://nodejs.org) and install the **LTS** version

Once both are installed, open a terminal:
- **Windows**: press `Win + R`, type `cmd`, press Enter
- **macOS**: press `Cmd + Space`, type `Terminal`, press Enter
- **Linux**: open your terminal application

### Step 2 — Download and build

Paste these commands one by one into your terminal:

```bash
git clone https://github.com/tapstoop/SteamtradesBooster.git
cd SteamtradesBooster
npm install
npm run build
```

### Step 3 — Load the extension in your browser

The extension works in any Chromium-based browser. Find yours below:

<details>
<summary><strong>Google Chrome</strong></summary>

1. Click the three-dot menu `⋮` in the top-right corner
2. Go to **Extensions** → **Manage Extensions**
3. Toggle **Developer mode** on (top-right of the Extensions page)
4. Click **Load unpacked** and select the `SteamtradesBooster` folder
</details>

<details>
<summary><strong>Microsoft Edge</strong></summary>

1. Click the three-dot menu `⋯` in the top-right corner
2. Go to **Extensions** → **Manage Extensions**
3. Toggle **Developer mode** on (left sidebar)
4. Click **Load unpacked** and select the `SteamtradesBooster` folder
</details>

<details>
<summary><strong>Opera / Opera GX</strong></summary>

1. Click the Opera icon in the top-left corner
2. Go to **Extensions** → **Manage Extensions**
3. Toggle **Developer mode** on (top-right of the Extensions page)
4. Click **Load unpacked** and select the `SteamtradesBooster` folder
</details>

<details>
<summary><strong>Brave</strong></summary>

1. Click the menu icon `☰` in the top-right corner
2. Go to **Extensions**
3. Toggle **Developer mode** on (top-right of the Extensions page)
4. Click **Load unpacked** and select the `SteamtradesBooster` folder
</details>

<details>
<summary><strong>Vivaldi</strong></summary>

1. Click the Vivaldi logo in the top-left corner
2. Go to **Tools** → **Extensions**
3. Toggle **Developer mode** on (top-right of the Extensions page)
4. Click **Load unpacked** and select the `SteamtradesBooster` folder
</details>

<details>
<summary><strong>Yandex Browser</strong></summary>

1. Click the menu icon `≡` in the top-right corner
2. Go to **Add-ons**
3. Scroll down and enable **Developer mode**
4. Click **Load unpacked extension** and select the `SteamtradesBooster` folder
</details>

### Step 4 — Pin and configure

1. Click the puzzle-piece icon in your browser toolbar and **pin** SteamTrades Booster so it stays visible
2. Click the extension icon to open the popup, then go to **Settings**
3. Paste your **GG.deals API key** — get one for free at [api.gg.deals](https://api.gg.deals)
4. Paste your **Steam profile URL** (e.g. `https://steamcommunity.com/id/yourname`)

### Step 5 — Use it

Visit any trade page on [steamtrades.com](https://www.steamtrades.com). Price badges and the sidebar will appear automatically — no extra steps needed.

---

## Under the Hood

- **Manifest V3** — Modern, secure extension architecture  
- **Content injection** on SteamTrades pages for real-time overlays  
- **Background service worker** — Fast GG.deals API caching  
- **Steam integration** — Direct wishlist and inventory fetching  
- **Fuzzy title matching** — Handles game name variations automatically
