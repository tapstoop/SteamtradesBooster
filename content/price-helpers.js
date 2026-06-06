// content/price-helpers.js
import { normalizeSteamType, typedPriceKey } from '../utils/similarity.js';

export function _getBadgePrice(priceData, settings) {
  const prices = priceData?.prices ?? {};
  let price = prices.currentRetail ?? null;
  if (settings?.keyshopsEnabled && prices.currentKeyshops != null) {
    if (price == null || prices.currentKeyshops < price) price = prices.currentKeyshops;
  }
  return price;
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
