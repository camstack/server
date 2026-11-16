/**
 * Archive URLs, and where the retired Recordings, Library → Events and
 * `/archive/:deviceId` URLs now lead.
 *
 * One pure map so the router and its spec read the same table. A URL that is
 * not one of the retired ones answers `null` and is left alone.
 */

export const ARCHIVE_PATH = '/archive'
export const TRAINING_PATH = '/addon/training'
export const LIBRARY_EXPORTS_PATH = '/library?tab=exports'

/** `?section=` of the Archive page: `overview` | `cameras`. */
export const SECTION_PARAM = 'section'
/** `?camera=<deviceId>` of the Cameras section. */
export const CAMERA_PARAM = 'camera'
/** `?view=` of the Cameras section: `review` | `health` | `settings`. */
export const VIEW_PARAM = 'view'

/** The Cameras section, open on one camera. */
export function archiveCameraPath(deviceId: number): string {
  return `${ARCHIVE_PATH}?${SECTION_PARAM}=cameras&${CAMERA_PARAM}=${String(deviceId)}`
}

/** Old `/recordings?tab=` ids and the place that took each over. */
const RECORDINGS_TAB_TARGET: Readonly<Record<string, string>> = {
  storage: ARCHIVE_PATH,
  events: ARCHIVE_PATH,
  cameras: ARCHIVE_PATH,
  exports: LIBRARY_EXPORTS_PATH,
  activity: `${ARCHIVE_PATH}#activity`,
  management: `${ARCHIVE_PATH}#tools`,
}

const ARCHIVE_CAMERA_PATH = /^\/archive\/(\d+)\/?$/

/**
 * The URL replacing `pathname` + `search`, or `null` when the URL was never
 * retired. `/library` is redirected only for its Events tab; every other
 * Library tab stays where it is.
 */
export function archiveRedirectFor(pathname: string, search: string): string | null {
  const params = new URLSearchParams(search)
  if (pathname === '/recordings') {
    const tab = params.get('tab')
    if (tab === null) return ARCHIVE_PATH
    return RECORDINGS_TAB_TARGET[tab] ?? ARCHIVE_PATH
  }
  if (pathname === '/library' && params.get('tab') === 'events') {
    // Retrain lives in the Training addon page, not in the Archive.
    if (params.get('section') === 'retrain') return TRAINING_PATH
    return ARCHIVE_PATH
  }
  const camera = ARCHIVE_CAMERA_PATH.exec(pathname)
  if (camera?.[1] !== undefined) return archiveCameraPath(Number(camera[1]))
  return null
}
