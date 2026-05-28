// popup/tradables-parser.js

/**
 * Parse bulk input string into array of non-empty trimmed entries.
 * Supports newline-separated and comma-separated entries while preserving
 * comma-thousands inside title text, such as "Warhammer 40,000".
 */
export function parseInput(input) {
  if (!input || !input.trim()) return [];
  return input
    .split(/\r?\n/)
    .flatMap(splitInputLine)
    .map(s => s.trim())
    .filter(Boolean);
}

function splitInputLine(line) {
  const numericCsv = /^\s*\d+(?:\s*,\s*\d+)+\s*$/.test(line);
  if (numericCsv) {
    return line.split(',');
  }

  const entries = [];
  let token = '';

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char !== ',') {
      token += char;
      continue;
    }

    if (isThousandsComma(line, i, token)) {
      token += char;
      continue;
    }

    entries.push(token);
    token = '';

    while (line[i + 1] === ',' || /\s/.test(line[i + 1] || '')) {
      i++;
    }
  }

  entries.push(token);
  return entries;
}

function isThousandsComma(line, commaIndex, token) {
  const before = line.slice(0, commaIndex).match(/(\d+)$/)?.[1] ?? '';
  const after = line.slice(commaIndex + 1).match(/^(\d+)/)?.[1] ?? '';
  const afterEnd = commaIndex + 1 + after.length;
  const tokenHasText = /[^\d\s]/.test(token);

  return (
    tokenHasText &&
    before.length >= 1 &&
    before.length <= 3 &&
    after.length === 3 &&
    !/\d/.test(line[afterEnd] || '')
  );
}

/**
 * Classify a parsed entry as either an App ID (pure numeric) or a game name.
 */
export function classifyEntry(entry) {
  const trimmed = entry.trim();
  if (/^\d+$/.test(trimmed)) {
    return { type: 'appId', value: trimmed };
  }
  return { type: 'name', value: trimmed };
}

/**
 * Compute normalized Levenshtein distance confidence score (0-100).
 * 100 = exact match, 0 = completely different.
 */
export function computeConfidence(input, candidate) {
  const a = input.toLowerCase().trim();
  const b = candidate.toLowerCase().trim();
  
  if (a === b) return 100;
  
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 100;
  
  const distance = levenshteinDistance(a, b);
  const ratio = distance / maxLen;
  
  // Standard normalized Levenshtein distance (0-100).
  // 100 = exact match, 0 = completely different.
  const score = 100 * (1 - ratio);
  return Math.round(Math.max(0, Math.min(100, score)));
}

function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}
