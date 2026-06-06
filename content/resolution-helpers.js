// content/resolution-helpers.js

export function applyResolvedRow(rowData, rowEl, resolution) {
  const row = rowData.find(r => r.el === rowEl);
  if (!row) return null;

  row.appId = resolution.appId;
  row.type = resolution.type ?? row.type ?? 'app';
  row.title = resolution.title ?? row.title;
  row.cacheKey = resolution.cacheKey ?? row.cacheKey;
  row.fuzzy = false;
  row.resolution = { status: 'resolved', appId: resolution.appId, type: resolution.type ?? row.type ?? 'app' };

  return row;
}
