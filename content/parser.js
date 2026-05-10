// content/parser.js
import { fuzzySetMatch } from '../utils/similarity.js';

/**
 * Strip common list prefixes from game titles.
 * Handles: bullets (•●○◆►), dashes (-–—), asterisks (*), numbered lists (1. 1) 1-)
 */
function stripListPrefixes(text) {
  return text
    .replace(/^[•●○◆►►\-*]+\s*/g, '')  // Unicode bullets and dashes at start
    .replace(/^\d+[\.\)\-]\s*/g, '')    // Numbered lists: "1. ", "1) ", "1 - "
    .replace(/^\*+\s*/g, '')            // Asterisks (but leaves "**" wildcards)
    .trim();
}

/**
 * PHASE 5B: Strip region/platform/suffix tags from game names.
 * Preserves the core game name while removing noise like region locks, keyshop tags, prices.
 */
function stripSuffixes(text) {
  let cleaned = text;
  // Strip region tags
  cleaned = cleaned.replace(/\b(LATAM|ROW|EU|Global|Region\s*Lock(ed)?)\b/gi, '');
  // Strip platform tags (parenthesized or appended)
  cleaned = cleaned.replace(/\(?(GOG|Steam\s*Key|Origin\s*Key|Uplay\s*Key|Epic\s*Key|EGS)\)?/gi, '');
  // Strip "steamkey", "originkey" etc when appended
  cleaned = cleaned.replace(/\b(steam|origin|uplay|epic|gog)key\b/gi, '');
  // Strip "GLOBAL", "SOLD" as standalone suffixes
  cleaned = cleaned.replace(/\b(GLOBAL|SOLD|TRADED|RESERVED|PENDING)\b/gi, '');
  // Strip price suffixes: "2,00€", "0.50€", "3.72USD", "$5.00"
  cleaned = cleaned.replace(/[\-\s]*\d+[.,]\d{1,2}\s*[€$]?\s*(EUR|USD|€|\$)?$/i, '');
  cleaned = cleaned.replace(/[\-\s]*[€$]\s*\d+[.,]\d{1,2}$/i, '');
  // Strip (^) and similar single-char parenthetical annotations
  cleaned = cleaned.replace(/\s*\([^)]{1,3}\)\s*/g, ' ');
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * PHASE 5A: Check if text matches skip phrases (standalone lines that are NOT games).
 */
const SKIP_PHRASES = new Set([
  'tf2 keys', 'csgo keys', 'cs2 keys', 'paypal', 'revolut', 'crypto',
  'offers', 'game offers', 'games offers', 'game offer', 'games offer',
  'others', 'microsoft store', 'windows', 'gems', 'sack of gems',
  'emoticons', 'emotes', 'emojis', 'items', 'profile backgrounds',
  'have', 'want', 'steamwallet', 'steam wallet', 'wishlist',
  'steam cards', 'steam trading cards', 'sepa', 'bank transfer',
  'priority',
  // NEW: standalone section headers and common noise
  'games', 'game',
  'keys',
  'bundles', 'bundle',
  'free to play', 'f2p',
  'rep', '+rep', '-rep',
  'vouches', 'vouch',
  'middleman', 'middlemen', 'mm',
  'closed', 'bump',
]);

function matchesSkipPhrase(text) {
  if (!text) return false;
  const normalized = text.toLowerCase().trim();
  // Exact match
  if (SKIP_PHRASES.has(normalized)) return true;
  // Match if line starts with a skip phrase followed by colon
  for (const phrase of SKIP_PHRASES) {
    if (normalized.startsWith(phrase + ':') || normalized.startsWith(phrase + ' ')) {
      return true;
    }
  }
  return false;
}

/**
 * PHASE 5A: Check if text looks like a date announcement.
 */
function isDateAnnouncement(text) {
  const datePattern = /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/;
  const announcementWords = /\b(ADDED|UPDATED|NEW|RELEASE|LAUNCH|DROP)\b/i;
  return datePattern.test(text) && announcementWords.test(text);
}

/**
 * PHASE 5A: Check if text is a plain URL (not inside an <a> tag).
 */
function isPlainUrl(text) {
  return /^https?:\/\//.test(text.trim());
}

/**
 * PHASE 5A: Check if text matches a choice pattern (e.g., "choice january 2024").
 */
function isChoicePattern(text) {
  const months = 'january|february|march|april|may|june|july|august|september|october|november|december';
  return new RegExp(`^choice\\s+(${months})\\s+\\d{4}$`, 'i').test(text.trim());
}

/**
 * Strip parenthetical suffixes from game names.
 * E.g., "My Little Universe (region lock)" -> "My Little Universe"
 */
export function stripParentheses(text) {
  return text.replace(/\s*\([^)]*\)\s*/g, '').trim();
}

/**
 * Check if text contains unicode character successions (like 𝕦𝕟𝕚𝕔𝕠𝕕𝕖)
 */
function hasUnicodeSuccession(text) {
  return /[\u{1D00}-\u{1FFF}]{4,}/u.test(text) ||  // Musical/mathematical alphanumerics
         /[\u{2100}-\u{2BFF}]{4,}/u.test(text) ||  // Miscellaneous alphanumerics
         /[\u{1F600}-\u{1F64F}]{3,}/u.test(text); // Emoji range (common spam)
}

/**
 * Check if text looks like a sentence (likely not a game name)
 */
function isSentence(text) {
  // Game names typically don't start with I', I'm, The, If, But, And followed by full sentences
  // Also check for common sentence patterns
  const sentenceStarters = /^(i'm|i |if |but |and |so |however|actually|basically|honestly|seriously|wait|hey|hello|hi |please|thank)/i;
  const hasQuestionMark = text.includes('?');
  const hasExclaimMark = text.includes('!');
  const words = text.split(/\s+/);
  // Very long "titles" with many words are likely sentences
  const isVeryLong = words.length > 15;
  // Contains comma near the end suggesting explanation
  const hasTrailingExplanation = /,.{20,}$/.test(text);
  
  return sentenceStarters.test(text) || 
         (hasQuestionMark && hasTrailingExplanation) ||
         (hasExclaimMark && text.length > 50) ||
         (isVeryLong && hasTrailingExplanation);
}

/**
 * Check if text contains bundle store references
 */
function hasBundleStoreRef(text) {
  const normalized = text.toLowerCase();
  const stores = [
    'humble choice', 'humble bundle', 'humble store', 'humble',
    'indiegala', 'indie gala',
    'fanatical',
    'gamesplanet', 'gmg', 'green man gaming',
    'steam gift', 'steam key', 'steam wallet',
    'origin', 'ea play', 'uplay', 'ubisoft',
    'epic games', 'epic store',
    'gog', 'gog.com'
  ];
  return stores.some(store => {
    if (store.includes(' ')) {
      return normalized.includes(store);
    }
    // Single words need word boundary
    const regex = new RegExp(`\\b${store}\\b`, 'i');
    return regex.test(normalized);
  });
}

/**
 * Check if a line should be filtered out (not a game)
 */
export function isNotGame(text) {
  if (!text || text.length < 2) return true;
  const normalized = text.toLowerCase().trim();
  
  // PHASE 5A: Skip phrases
  if (matchesSkipPhrase(text)) return true;
  
  if (hasUnicodeSuccession(text)) return true;
  if (isSentence(text)) return true;
  if (hasBundleStoreRef(text)) return true;
  if (isChoicePattern(text)) return true;
  if (isDateAnnouncement(text)) return true;
  if (isPlainUrl(text)) return true;
  
  return false;
}

/**
 * Check if badge text indicates non-game
 */
export function isNotGameBadge(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (lower.includes('humble')) return true;
  if (lower.includes('indiegala')) return true;
  if (lower.includes('fanatical')) return true;
  return false;
}

export function parseGameRows() {
  const rows = [];
  const seenTitles = new Set();

  // Parse individual trade pages: games are in .have/.want sections
  // Two main formats:
  // 1. <p> elements with <br>-separated lines
  // 2. <ul>/<ol> elements with <li> children
  const haveContainers = [
    ...document.querySelectorAll('.have .markdown p'),
    ...document.querySelectorAll('.have .markdown ul li'),
    ...document.querySelectorAll('.have .markdown ol li'),
  ];
  const wantContainers = [
    ...document.querySelectorAll('.want .markdown p'),
    ...document.querySelectorAll('.want .markdown ul li'),
    ...document.querySelectorAll('.want .markdown ol li'),
  ];

  /**
   * Parse a single element (could be <p> or <li>)
   */
  const parseElement = (el, section) => {
    if (!el) return;

    // Handle <li> elements directly (no <br> splitting needed)
    if (el.tagName === 'LI') {
      const rawText = el.textContent.trim();
      if (rawText.length < 2) return;

      // Skip wildcard entries
      if (/^\*{1,3}$/.test(rawText)) return;

      // Check raw text for skip phrases ONLY (not full isNotGame — that would filter out
      // games whose raw text contains platform tags like "Steam Key" before stripSuffixes runs)
      if (matchesSkipPhrase(rawText)) return;

      // PHASE 5B: Hyperlink-first detection for LI elements
      const anchor = el.querySelector('a');
      let text;
      if (anchor) {
        // Extract ONLY the anchor text as the game name
        text = anchor.textContent.trim();
      } else {
        // Strip list prefixes then suffixes
        text = stripListPrefixes(rawText);
        text = stripSuffixes(text);
      }
      if (text.length < 2) return;

      // Filter out non-games (safety net after extraction)
      if (isNotGame(text)) return;

      // Skip duplicates
      const normalized = text.toLowerCase();
      if (seenTitles.has(normalized)) return;
      seenTitles.add(normalized);

      // Create wrapper span
      const span = document.createElement('span');
      span.className = 'stpt-game-item';
      span.dataset.stptSection = section;
      span.dataset.stptIndex = rows.length;
      span.dataset.stptTitle = stripParentheses(text);

      // Move all children of <li> into the span
      while (el.firstChild) {
        span.appendChild(el.firstChild);
      }
      el.appendChild(span);

      rows.push({ title: stripParentheses(text), el: span });
      return;
    }

    // Handle <p> elements - group child nodes by <br> separators into "lines"
    const lines = [];
    let current = [];
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
        lines.push(current);
        current = [];
      } else {
        current.push(node);
      }
    }
    if (current.length > 0) lines.push(current);

    let index = 0;
    const startIndex = rows.length;

    lines.forEach(lineNodes => {
      // Extract plain text for the line
      const rawText = lineNodes.map(n => n.textContent).join('').trim();
      if (rawText.length < 2) return;

      // Skip wildcard entries (SteamTrades convention for "anything")
      if (/^\*{1,3}$/.test(rawText)) return;

      // Check raw text for skip phrases ONLY (not full isNotGame — that would filter out
      // games whose raw text contains platform tags like "Steam Key" before stripSuffixes runs)
      if (matchesSkipPhrase(rawText)) return;

      // PHASE 5B: Hyperlink-first detection
      const hasLink = lineNodes.some(n => {
        if (n.nodeType === Node.ELEMENT_NODE) {
          return n.tagName === 'A' || n.querySelector('a') !== null;
        }
        return false;
      });

      let text;
      if (hasLink) {
        // PHASE 5B: Extract ONLY the anchor text as the game name
        const anchor = lineNodes.find(n => {
          if (n.nodeType === Node.ELEMENT_NODE) {
            return n.tagName === 'A';
          }
          return false;
        });
        if (anchor) {
          text = anchor.textContent.trim();
        } else {
          // Fallback: strip prefixes and suffixes
          text = stripListPrefixes(rawText);
          text = stripSuffixes(text);
        }
      } else {
        // Strip list prefixes then suffixes
        text = stripListPrefixes(rawText);
        text = stripSuffixes(text);
      }
      if (text.length < 2) return;

      // Determine if this line is a category header:
      // - <strong>/<em> without any <a> child → category header → skip
      const isHeaderish = !hasLink && lineNodes.some(n => {
        if (n.nodeType === Node.ELEMENT_NODE) {
          return n.tagName === 'STRONG' || n.tagName === 'EM';
        }
        return false;
      });

      if (isHeaderish) return; // Skip category headers, preserve original HTML

      // Filter out non-games (safety net after extraction)
      if (isNotGame(text)) return;

      // Skip duplicates
      const normalized = text.toLowerCase();
      if (seenTitles.has(normalized)) return;
      seenTitles.add(normalized);

      // Wrap the original DOM nodes in a game span (preserves links, formatting)
      const span = document.createElement('span');
      span.className = 'stpt-game-item';
      span.dataset.stptSection = section;
      span.dataset.stptIndex = startIndex + index++;
      span.dataset.stptTitle = stripParentheses(text);

      const firstNode = lineNodes[0];
      el.insertBefore(span, firstNode);
      lineNodes.forEach(n => span.appendChild(n));

      rows.push({ title: stripParentheses(text), el: span });
    });
  };

  haveContainers.forEach(el => parseElement(el, 'have'));
  wantContainers.forEach(el => parseElement(el, 'want'));

  return rows;
}

/**
 * Inject checkboxes into game elements.
 * All tiers get a checkbox so users can manually re-fetch prices.
 * @param {{ tier: number, el: HTMLElement }[]} rows - prioritized rows
 */
export function injectCheckboxes(rows) {
  rows.forEach(row => {
    const el = row.el;
    if (el.dataset.stptCheckbox) return; // already injected

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'stpt-game-checkbox';
    checkbox.dataset.stptTitle = el.dataset.stptTitle;
    el.dataset.stptCheckbox = '1';
    el.parentNode.insertBefore(checkbox, el);
  });
}

/**
 * Get list of selected game titles from checkboxes.
 * @returns {string[]} - array of selected game titles
 */
export function getSelectedTitles() {
  const checkboxes = document.querySelectorAll('.stpt-game-checkbox:checked');
  return Array.from(checkboxes).map(cb => cb.dataset.stptTitle);
}

/**
 * Split rows into 4 priority tiers based on wishlist/tradables membership.
 * Uses fuzzy matching for near-matches (Phase 5C).
 * @param {{ title: string, el: HTMLElement }[]} rows
 * @param {string[]} wishlist - normalized titles
 * @param {string[]} tradables - normalized titles
 * @returns {{ tier: 1|2|3|4, title: string, el: HTMLElement }[]}
 */
export function prioritize(rows, wishlist, tradables) {
  const wishSet = (wishlist ?? []).map(t => {
    const name = typeof t === 'string' ? t : t?.name;
    return (name ?? '').toLowerCase().trim();
  }).filter(Boolean);
  const tradeSet = (tradables ?? []).map(t => {
    const name = typeof t === 'string' ? t : t?.name;
    return (name ?? '').toLowerCase().trim();
  }).filter(Boolean);

  return rows.map(row => {
    const norm = row.title.toLowerCase().trim();
    let tier;
    // PHASE 5C: Fuzzy matching for wishlist/tradables
    if (wishSet.includes(norm)) tier = 1;
    else if (fuzzySetMatch(row.title, wishSet)) tier = 1;
    else if (tradeSet.includes(norm)) tier = 2;
    else if (fuzzySetMatch(row.title, tradeSet)) tier = 2;
    else tier = 4; // viewport/on-demand handled by intersection observer
    return { ...row, tier };
  });
}
