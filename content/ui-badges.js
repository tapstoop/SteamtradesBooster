// content/ui-badges.js
// Badge injection and resolution logic

import { formatPrice, formatTimestamp, formatFullTimestamp } from './ui-helpers.js';

// ── Badge injection ───────────────────────────────────────────────────

export function injectSkeleton(el, isStatic = false) {
  const sk = document.createElement('span');
  sk.className = 'stpt-skeleton' + (isStatic ? ' stpt-skeleton-static' : '');
  sk.dataset.stptSkeleton = '1';
  el.appendChild(sk);
  return sk;
}

export function setSkeletonLoading(elements) {
  elements.forEach(el => {
    const skeleton = el.querySelector('.stpt-skeleton');
    if (skeleton) {
      skeleton.classList.remove('stpt-skeleton-static');
    }
  });
}

export function replaceBadge(el, priceData, gameInfo) {
  // Remove ALL existing badges and skeletons
  el.querySelectorAll('.stpt-skeleton, .stpt-badge').forEach(e => e.remove());

  const badges = resolveBadges(priceData, gameInfo);
  const createdBadges = [];

  for (const { type, label, priceText, isPrimary } of badges) {
    const badge = document.createElement('span');
    badge.className = 'stpt-badge';
    badge.dataset.type = type;
    badge.dataset.appid = gameInfo.appId ?? '';
    if (!isPrimary) badge.dataset.secondary = '1';

    if (label) {
      const labelEl = document.createElement('span');
      labelEl.className = 'stpt-badge-label';
      labelEl.textContent = label;
      badge.appendChild(labelEl);
    }

    const priceEl = document.createElement('span');
    priceEl.className = 'stpt-badge-price';
    priceEl.textContent = priceText;

    // Add timestamp to primary badge only
    if (isPrimary) {
      const cachedAt = priceData?.cachedAt;
      if (cachedAt) {
        const tsSpan = document.createElement('span');
        tsSpan.className = 'stpt-badge-ts';
        const showFull = gameInfo.settings?.showFullTimestamp;
        tsSpan.textContent = ' · ' + (showFull ? formatFullTimestamp(cachedAt) : formatTimestamp(cachedAt));
        if (!showFull) tsSpan.title = 'Last updated: ' + formatFullTimestamp(cachedAt);
        priceEl.appendChild(tsSpan);
      }
    }

    badge.appendChild(priceEl);

    badge.addEventListener('click', e => {
      e.stopPropagation();
      // Dynamic import to avoid circular dependency
      import('./ui-pickers.js').then(mod => mod.openPopover(badge, priceData, gameInfo));
    });

    el.appendChild(badge);
    createdBadges.push(badge);
  }

  return createdBadges[0] ?? null;
}

/**
 * Resolve ALL applicable badges for a game (multi-label support).
 * Returns an array of badge descriptors. The first is always the primary (shows price + timestamp).
 * Additional badges are secondary (compact, no price duplication).
 *
 * A game can have multiple labels simultaneously:
 *   - WISH (tier 1), TRADE (tier 2), BUNDLE (inBundle)
 *   - DEAL (when current price is within threshold of ATL)
 *
 * Badge priority for primary: DEAL > WISH > TRADE > BUNDLE > plain/NA
 */
export function resolveBadges(priceData, gameInfo) {
  const settings = gameInfo.settings;
  const prices = priceData?.prices ?? {};
  const keyshopsEnabled = settings?.keyshopsEnabled;

  // Compute best current price (retail or keyshop)
  let bestCurrent = prices.currentRetail;
  if (keyshopsEnabled && prices.currentKeyshops != null) {
    if (bestCurrent == null || prices.currentKeyshops < bestCurrent) bestCurrent = prices.currentKeyshops;
  }

  // Compute best historical ATL (retail or keyshop)
  let bestAtl = prices.historicalRetail;
  if (keyshopsEnabled && prices.historicalKeyshops != null) {
    if (bestAtl == null || prices.historicalKeyshops < bestAtl) bestAtl = prices.historicalKeyshops;
  }

  const currency = prices.currency ?? 'EUR';
  const priceFormatted = formatPrice(bestCurrent, currency);

  const badges = [];

  // Detect DEAL
  let isDeal = false;
  if (bestCurrent != null && bestAtl != null && bestAtl > 0) {
    const pct = ((bestCurrent - bestAtl) / bestCurrent) * 100;
    if (pct <= (settings?.dealThresholdPct ?? 10)) {
      isDeal = true;
    }
  }

  // Collect ALL applicable tier/bundle labels (not mutually exclusive)
  const labels = [];
  if (gameInfo.tier === 1) labels.push('WISH');
  if (gameInfo.tier === 2) labels.push('TRADE');
  if (gameInfo.inBundle) labels.push('BUNDLE');

  // Build badges array with proper priority
  if (isDeal) {
    // DEAL is always primary when present
    badges.push({ type: 'DEAL', label: 'DEAL', priceText: `${priceFormatted} · ATL`, isPrimary: true });
    // Remaining labels become secondary badges
    for (const label of labels) {
      badges.push({ type: label, label, priceText: priceFormatted, isPrimary: false });
    }
  } else if (labels.length > 0) {
    // First label is primary, rest are secondary
    badges.push({ type: labels[0], label: labels[0], priceText: priceFormatted, isPrimary: true });
    for (const label of labels.slice(1)) {
      badges.push({ type: label, label, priceText: priceFormatted, isPrimary: false });
    }
  } else {
    // No labels — plain price or N/A
    if (bestCurrent == null) {
      badges.push({ type: 'NA', label: null, priceText: 'N/A', isPrimary: true });
    } else {
      badges.push({ type: 'plain', label: null, priceText: priceFormatted, isPrimary: true });
    }
  }

  return badges;
}

/**
 * Backward-compatible single-badge resolver.
 * Returns the primary badge descriptor (first from resolveBadges).
 */
export function resolveBadgeType(priceData, gameInfo) {
  const badges = resolveBadges(priceData, gameInfo);
  return badges[0] ?? { type: 'NA', label: null, priceText: 'N/A' };
}

export function injectQuestionBadge(el, candidates, cacheKey) {
  const existing = el.querySelector('.stpt-skeleton, .stpt-badge');
  if (existing) existing.remove();

  const badge = document.createElement('span');
  badge.className = 'stpt-badge';
  badge.dataset.type = '?';

  const labelEl = document.createElement('span');
  labelEl.className = 'stpt-badge-label';
  labelEl.textContent = '?';
  badge.appendChild(labelEl);

  const priceEl = document.createElement('span');
  priceEl.className = 'stpt-badge-price';
  priceEl.textContent = 'ambiguous ▾';
  badge.appendChild(priceEl);

  badge.addEventListener('click', e => {
    e.stopPropagation();
    import('./ui-pickers.js').then(mod => mod.openCandidatePicker(badge, candidates, cacheKey, el));
  });

  el.appendChild(badge);
}

export function injectFuzzyBadge(el, resolution) {
  const existing = el.querySelector('.stpt-skeleton, .stpt-badge');
  if (existing) existing.remove();

  const badge = document.createElement('span');
  badge.className = 'stpt-badge';
  badge.dataset.type = 'fuzzy';
  badge.dataset.appid = resolution.appId ?? '';

  const labelEl = document.createElement('span');
  labelEl.className = 'stpt-badge-label';
  labelEl.textContent = '≈';
  labelEl.title = `Auto-matched (${resolution.similarity}% similarity)`;
  badge.appendChild(labelEl);

  const priceEl = document.createElement('span');
  priceEl.className = 'stpt-badge-price';
  priceEl.textContent = `${resolution.similarity}%`;
  badge.appendChild(priceEl);

  badge.addEventListener('click', e => {
    e.stopPropagation();
    import('./ui-pickers.js').then(mod => mod.openFuzzyPicker(badge, resolution));
  });

  el.appendChild(badge);
}

export function injectNotFoundBadge(el, cacheKey, title) {
  const existing = el.querySelector('.stpt-skeleton, .stpt-badge');
  if (existing) existing.remove();

  const badge = document.createElement('span');
  badge.className = 'stpt-badge';
  badge.dataset.type = 'NA';

  const priceEl = document.createElement('span');
  priceEl.className = 'stpt-badge-price';
  priceEl.textContent = 'N/A ▾';
  badge.appendChild(priceEl);

  badge.addEventListener('click', e => {
    e.stopPropagation();
    import('./ui-pickers.js').then(mod => mod.openNotFoundPicker(badge, cacheKey, title, el));
  });

  el.appendChild(badge);
}

export function injectDismissedBadge(el, cacheKey, title) {
  const existing = el.querySelector('.stpt-skeleton, .stpt-badge');
  if (existing) existing.remove();

  const badge = document.createElement('span');
  badge.className = 'stpt-badge stpt-badge-dismissed';
  badge.dataset.type = 'dismissed';
  badge.style.opacity = '0.5';
  badge.style.cursor = 'pointer';

  const priceEl = document.createElement('span');
  priceEl.className = 'stpt-badge-price';
  priceEl.textContent = '×';
  priceEl.title = 'Dismissed — click to re-resolve';
  badge.appendChild(priceEl);

  badge.addEventListener('click', async e => {
    e.stopPropagation();
    const { sendMessage } = await import('./ui-helpers.js');
    await sendMessage('SET_UNDISMISSED', { cacheKey });
    badge.remove();
    injectSkeleton(el, true);
    el.dispatchEvent(new CustomEvent('stpt-recheck', { bubbles: true, detail: { title, cacheKey } }));
  });

  el.appendChild(badge);
}

export function injectDelistedBadge(el, cacheKey, title, priceData = null, gameInfo = null) {
  const existing = el.querySelector('.stpt-skeleton, .stpt-badge');
  if (existing) existing.remove();

  const badge = document.createElement('span');
  badge.className = 'stpt-badge';
  badge.dataset.type = 'delisted';
  badge.dataset.appid = gameInfo?.appId ?? '';
  badge.style.cursor = 'pointer';

  const labelEl = document.createElement('span');
  labelEl.className = 'stpt-badge-label';
  labelEl.textContent = 'DELISTED';
  badge.appendChild(labelEl);

  // Show price if available
  if (priceData && gameInfo) {
    const prices = priceData.prices ?? {};
    const keyshopsEnabled = gameInfo.settings?.keyshopsEnabled;
    let bestCurrent = prices.currentRetail;
    if (keyshopsEnabled && prices.currentKeyshops != null) {
      if (bestCurrent == null || prices.currentKeyshops < bestCurrent) {
        bestCurrent = prices.currentKeyshops;
      }
    }
    const currency = prices.currency ?? 'EUR';
    const priceEl = document.createElement('span');
    priceEl.className = 'stpt-badge-price';
    priceEl.textContent = formatPrice(bestCurrent, currency);
    badge.appendChild(priceEl);
  }

  badge.addEventListener('click', async e => {
    e.stopPropagation();
    if (priceData && gameInfo?.appId) {
      const { openPopover } = await import('./ui-pickers.js');
      openPopover(badge, priceData, { ...gameInfo, cacheKey, resolution: { status: 'delisted' } });
    } else {
      const { sendMessage } = await import('./ui-helpers.js');
      await sendMessage('SET_UNDELISTED', { cacheKey });
      badge.remove();
      injectSkeleton(el, true);
      el.dispatchEvent(new CustomEvent('stpt-recheck', { bubbles: true, detail: { title, cacheKey } }));
    }
  });

  el.appendChild(badge);
}
