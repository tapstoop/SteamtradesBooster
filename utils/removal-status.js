export const REMOVAL_STATUS_META = Object.freeze({
  removed_delisted: Object.freeze({
    categoryId: 1,
    categoryName: 'Delisted',
    label: 'DELISTED',
    styleKey: 'removed_delisted',
    severity: 1,
  }),
  removed_disabled: Object.freeze({
    categoryId: 3,
    categoryName: 'Purchase disabled',
    label: 'NO PURCHASE',
    styleKey: 'removed_disabled',
    severity: 2,
  }),
  removed_banned: Object.freeze({
    categoryId: 20,
    categoryName: 'Banned',
    label: 'BANNED',
    styleKey: 'removed_banned',
    severity: 3,
  }),
});

const CATEGORY_TO_STATUS = Object.freeze(Object.fromEntries(
  Object.entries(REMOVAL_STATUS_META).map(([status, meta]) => [meta.categoryId, status])
));

export function isRemovedStatus(status) {
  return Object.hasOwn(REMOVAL_STATUS_META, status);
}

export function getRemovalStatusMeta(status) {
  return REMOVAL_STATUS_META[status] ?? null;
}

export function removalStatusFromCategoryId(categoryId) {
  return CATEGORY_TO_STATUS[Number(categoryId)] ?? null;
}

export function createRemovalRecord(categoryId, observedAt = Date.now()) {
  const status = removalStatusFromCategoryId(categoryId);
  const meta = getRemovalStatusMeta(status);
  if (!meta) return null;
  return {
    status,
    categoryId: meta.categoryId,
    categoryName: meta.categoryName,
    observedAt: Number(observedAt) || Date.now(),
  };
}

export function sameRemoval(left, right) {
  return (left?.status ?? null) === (right?.status ?? null)
    && (left?.categoryId ?? null) === (right?.categoryId ?? null);
}
