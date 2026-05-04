// content/ggdeals-scraper.js
// Scrapes "2nd best" historical price from GG.deals game pages
// Used as fallback when historical low is "Free" (giveaway)

(function() {
  const GAME_ID_MATCH = window.location.pathname.match(/\/game\/([^/]+)/);
  if (!GAME_ID_MATCH) return;

  function parsePrice(priceStr) {
    if (!priceStr) return null;
    if (priceStr.toLowerCase() === 'free') return 0;
    const cleaned = priceStr.replace(/[^\d.,]/g, '');
    const normalized = cleaned.replace(',', '.');
    const num = parseFloat(normalized);
    if (isNaN(num)) return null;
    return Math.round(num * 100);
  }

  function extractPriceInfo() {
    const result = {
      historicalLow: { retail: null, keyshops: null },
      secondBest: { retail: null, keyshops: null },
      thirdBest: { retail: null, keyshops: null },
      scrapedAt: Date.now()
    };

    const priceRows = document.querySelectorAll('.game-lowest-price-row');
    for (const row of priceRows) {
      const priceTypeEl = row.querySelector('.price-type');
      if (!priceTypeEl) continue;

      const priceType = priceTypeEl.textContent.trim().toLowerCase();
      const priceEl = row.querySelector('.price');
      if (!priceEl) continue;

      const price = parsePrice(priceEl.textContent);
      if (price === null) continue;

      const isKeyshop = row.classList.contains('keyshop') ||
                        row.querySelector('.shop-name')?.textContent?.toLowerCase().includes('keyshop');

      if (priceType.includes('historical low') || priceType === 'historical low:') {
        if (isKeyshop) {
          result.historicalLow.keyshops = price;
        } else {
          result.historicalLow.retail = price;
        }
      } else if (priceType.includes('2nd best') || priceType === '2nd best:') {
        if (isKeyshop) {
          result.secondBest.keyshops = price;
        } else {
          result.secondBest.retail = price;
        }
      } else if (priceType.includes('3rd best') || priceType === '3rd best:') {
        if (isKeyshop) {
          result.thirdBest.keyshops = price;
        } else {
          result.thirdBest.retail = price;
        }
      }
    }

    return result;
  }

  function extractAppId() {
    const urlMatch = window.location.pathname.match(/\/game\/([^/]+)/);
    if (urlMatch) return urlMatch[1];
    return null;
  }

  async function scrapeAndSend() {
    try {
      await new Promise(r => setTimeout(r, 2000));

      const priceHistoryEl = document.querySelector('#price-history');
      if (priceHistoryEl) {
        priceHistoryEl.scrollIntoView({ behavior: 'auto', block: 'center' });
        await new Promise(r => setTimeout(r, 1000));
        priceHistoryEl.scrollIntoView({ behavior: 'auto', block: 'start' });
      }

      await new Promise(r => setTimeout(r, 2000));

      const priceInfo = extractPriceInfo();
      if (!priceInfo) {
        console.warn('[GG.deals scraper] Could not extract price info');
        chrome.runtime.sendMessage({
          type: 'GGDEALS_SCRAPED',
          success: false,
          error: 'Could not extract price info',
          url: window.location.href
        });
        return;
      }

      const appId = extractAppId();
      const gameId = GAME_ID_MATCH[1];

      chrome.runtime.sendMessage({
        type: 'GGDEALS_SCRAPED',
        success: true,
        gameId,
        appId,
        data: priceInfo,
        url: window.location.href
      });

    } catch (err) {
      console.warn('[GG.deals scraper] Error:', err.message);
      chrome.runtime.sendMessage({
        type: 'GGDEALS_SCRAPED',
        success: false,
        error: err.message,
        url: window.location.href
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scrapeAndSend);
  } else {
    scrapeAndSend();
  }
})();
