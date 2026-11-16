/**
 * Where the retired Recordings and Library → Events URLs now lead.
 *
 * One pure map so the router and its spec read the same table. A URL that is
 * not one of the retired ones answers `null` and is left alone.
 */

export const ARCHIVE_PATH = '/archive'

/** Old `/recordings?tab=` ids and the Archive place that took each over. */
const RECORDINGS_TAB_TARGET: Readonly<Record<string, string>> = {
  storage: ARCHIVE_PATH,
  events: ARCHIVE_PATH,
  cameras: ARCHIVE_PATH,
  exports: ARCHIVE_PATH,
  activity: `${ARCHIVE_PATH}#activity`,
  management: `${ARCHIVE_PATH}#tools`,
}

/**
 * The Archive URL replacing `pathname` + `search`, or `null` when the URL was
 * never retired. `/library` is redirected only for its Events tab; every other
 * Library tab stays where it is.
 */
export function archiveRedirectFor(pathname: string, search: string): string | null {
  const params = new URLSearchParams(search)
  if (pathname === '/recordings') {
    const tab = params.get('tab')
    if (tab === null) return ARCHIVE_PATH
    return RECORDINGS_TAB_TARGET[tab] ?? ARCHIVE_PATH
  }
  if (pathname === '/library' && params.get('tab') === 'events') return ARCHIVE_PATH
  return null
}
