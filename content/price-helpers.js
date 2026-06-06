// content/price-helpers.js
import { normalizeSteamType, typedPriceKey } from '../utils/similarity.js';
import { resolveBadgeType } from './ui.js';

export function _getBadgePrice(priceData, settings) {
  const fakeGameInfo = { settings, tier: 4 };
  const { priceText } = resolveBadgeType(priceData, fakeGameInfo);
  if (!priceText || priceText === 'N/A') return null;
  const match = priceText.match(/([\d,.]+)/);
  if (!match) return null;
  return parseFloat(match[1].replace(',', '.')) * 100;
}

export function setWorkstationPrice(priceMap, appId, type, priceData, settings) {
  const price = _getBadgePrice(priceData, settings);
  if (price == null) return;
  const key = typedPriceKey(appId, type);
  const payload = { price, currency: (priceData.prices?.currency) ?? (settings?.currency) ?? 'EUR' };
  priceMap[key] = payload;
  if (normalizeSteamType(type) === 'app') {
    priceMap[String(appId)] = payload;
  }
}
