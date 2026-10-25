/**
 * URL helpers for the Targets tab deep link.
 *
 *   ?tab=targets&target=<id>           → open edit for that target
 *   ?tab=targets&target=new&kind=…     → open create for that kind
 *   ?tab=targets&target=new            → open kind picker
 *
 * `AdminTabs` drops `ownedParams` when leaving the tab so a stale editor does
 * not reopen on the next visit to Targets.
 */

export const TARGETS_TAB_ID = 'targets'
export const TARGET_PARAM = 'target'
export const TARGET_KIND_PARAM = 'kind'
export const TARGET_NEW = 'new'

export const TARGETS_TAB_OWNED_PARAMS: readonly string[] = [TARGET_PARAM, TARGET_KIND_PARAM]

export function withTargetsTabForTarget(
  params: URLSearchParams,
  targetId: string,
): URLSearchParams {
  const next = new URLSearchParams(params)
  next.set('tab', TARGETS_TAB_ID)
  next.set(TARGET_PARAM, targetId)
  next.delete(TARGET_KIND_PARAM)
  return next
}

export function withTargetsTabForNewKind(
  params: URLSearchParams,
  kind: string | null,
): URLSearchParams {
  const next = new URLSearchParams(params)
  next.set('tab', TARGETS_TAB_ID)
  next.set(TARGET_PARAM, TARGET_NEW)
  if (kind === null || kind.length === 0) next.delete(TARGET_KIND_PARAM)
  else next.set(TARGET_KIND_PARAM, kind)
  return next
}

export function clearTargetsEditorParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete(TARGET_PARAM)
  next.delete(TARGET_KIND_PARAM)
  return next
}
