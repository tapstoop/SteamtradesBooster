// content/ui-helpers.js
// Shared helper functions used across UI modules

export function sendMessage(type, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...data }, resp => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

export function formatPrice(amount, currency = 'EUR') {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-EU', { style: 'currency', currency }).format(amount / 100);
}

export function formatTimestamp(cachedAt) {
  if (!cachedAt) return '';
  const now = Date.now();
  const diff = now - cachedAt;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'now';
}

export function formatFullTimestamp(cachedAt) {
  if (!cachedAt) return 'Unknown';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(cachedAt));
}

export function closeAll(selector) {
  document.querySelectorAll(selector).forEach(el => el.remove());
}

export function positionNear(floatEl, anchorEl) {
  document.body.appendChild(floatEl);
  const rect = anchorEl.getBoundingClientRect();
  let top = rect.bottom + window.scrollY + 4;
  let left = rect.left + window.scrollX;

  // Flip if overflows viewport
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  floatEl.style.visibility = 'hidden';
  floatEl.style.top = `${top}px`;
  floatEl.style.left = `${left}px`;

  requestAnimationFrame(() => {
    const fRect = floatEl.getBoundingClientRect();
    if (fRect.right > vpW) left = Math.max(0, vpW - fRect.width - 8);
    if (fRect.bottom > vpH) top = rect.top + window.scrollY - fRect.height - 4;
    floatEl.style.left = `${left}px`;
    floatEl.style.top = `${top}px`;
    floatEl.style.visibility = 'visible';
  });
}
