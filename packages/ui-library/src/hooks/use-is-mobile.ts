import { useSyncExternalStore } from 'react'

const MOBILE_QUERY = '(max-width: 767px)'
/**
 * Mid breakpoint — below this width the sidebar collapses to an
 * icons-only rail to reclaim canvas space. Above it (and outside
 * mobile) the full sidebar renders. Threshold matches Tailwind `lg`
 * so sidebar fans out at the same point grids switch to multi-column.
 */
const MID_QUERY = '(min-width: 768px) and (max-width: 1023px)'

/**
 * `matchMedia` is universal in browsers but absent in bare DOM environments.
 * These hooks are called from shared primitives (`DataTable` picks its narrow
 * layout with one), so throwing here takes down the whole page that merely
 * rendered a table. Where the capability is missing, report the desktop
 * layout — a widescreen rendering is wrong-looking; a crashed page is gone.
 */
function matchQuery(query: string): MediaQueryList | null {
  if (typeof window.matchMedia !== 'function') return null
  return window.matchMedia(query)
}

function subscribeQuery(query: string): (callback: () => void) => () => void {
  return (callback) => {
    const mql = matchQuery(query)
    if (mql === null) return () => {}
    mql.addEventListener('change', callback)
    return () => mql.removeEventListener('change', callback)
  }
}

function getSnapshot(query: string): () => boolean {
  return () => matchQuery(query)?.matches ?? false
}

function getServerSnapshot(): boolean {
  return false
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeQuery(MOBILE_QUERY),
    getSnapshot(MOBILE_QUERY),
    getServerSnapshot,
  )
}

/**
 * True when the viewport is in the medium (`md`) Tailwind range —
 * 768px ≤ width < 1024px. Use to drive layouts that should pack denser
 * than full-desktop but more legibly than mobile (e.g. icons-only
 * sidebar rail, narrower stat tiles).
 */
export function useIsMidWidth(): boolean {
  return useSyncExternalStore(subscribeQuery(MID_QUERY), getSnapshot(MID_QUERY), getServerSnapshot)
}
