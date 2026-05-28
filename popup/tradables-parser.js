// popup/tradables-parser.js

/**
 * Parse bulk input string into array of non-empty trimmed entries.
 * Supports newline-separated entries and comma-separated entries when the comma
 * is followed by whitespace, preserving titles like "Warhammer 40,000".
 */
export function parseInput(input) {
  if (!input || !input.trim()) return [];
  return input
    .split(/\r?\n/)
    .flatMap(line => line.split(/,+\s+(?=\S)|,+(?=\s*[A-Za-z])/))
    .map(s => s.trim())
    .filter(Boolean);
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
