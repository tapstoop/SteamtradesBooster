// content/resolution-helpers.js

export function applyResolvedRow(rowData, rowEl, resolution) {
  const row = rowData.find(r => r.el === rowEl);
  if (!row) return null;

  // Capture originalTitle before mutating row.title
  row.originalTitle = resolution.originalTitle ?? row.originalTitle ?? row.title;
  row.title = resolution.title ?? row.title;
  row.appId = resolution.appId;
  row.type = resolution.type ?? row.type ?? 'app';
  row.manuallyResolved = true;
  row.cacheKey = resolution.cacheKey ?? row.cacheKey;
  row.fuzzy = false;
  row.removal = null;
  row.resolution = { status: 'resolved', appId: resolution.appId, type: resolution.type ?? row.type ?? 'app' };

  return row;
}
