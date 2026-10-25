/**
 * ← / → across the whole corpus, not just the page of the grid that happens to
 * be loaded: past the last frame of a page the next page is fetched and its
 * first frame opens; before the first, the previous page's last.
 */

export type StepTarget =
  | { readonly kind: 'frame'; readonly frameId: string }
  | { readonly kind: 'page'; readonly page: number; readonly edge: 'first' | 'last' }
  | { readonly kind: 'none' }

/** Number of pages for `total` frames — at least 1, so an empty corpus has a page 1. */
export function lastPageOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

/** Where a step from `activeId` lands. `none` at either end of the corpus. */
export function stepTarget(
  frameIds: readonly string[],
  activeId: string,
  step: 1 | -1,
  page: number,
  lastPage: number,
): StepTarget {
  const at = frameIds.indexOf(activeId)
  if (at < 0) return { kind: 'none' }
  const next = frameIds[at + step]
  if (next !== undefined) return { kind: 'frame', frameId: next }
  if (step === 1 && page < lastPage) return { kind: 'page', page: page + 1, edge: 'first' }
  if (step === -1 && page > 1) return { kind: 'page', page: page - 1, edge: 'last' }
  return { kind: 'none' }
}

/** The frame to open once a page requested by a step has loaded. */
export function edgeFrameId(
  frameIds: readonly string[],
  edge: 'first' | 'last',
): string | undefined {
  return edge === 'first' ? frameIds[0] : frameIds[frameIds.length - 1]
}
