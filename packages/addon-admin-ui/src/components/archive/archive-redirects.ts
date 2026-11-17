/**
 * Archive URLs, and where the retired Recordings, Library → Events and
 * `/archive/:deviceId` URLs now lead.
 *
 * One pure map so the router and its spec read the same table. A URL that is
 * not one of the retired ones answers `null` and is left alone.
 */
import { EXPORT_CAMERA_PARAM } from '../recordings/export-camera-filter'

export const ARCHIVE_PATH = '/archive'
export const TRAINING_PATH = '/addon/training'
export const LIBRARY_EXPORTS_PATH = '/library?tab=exports'

/** `?section=` of the Archive page: `overview` | `cameras`. */
export const SECTION_PARAM = 'section'
/** `?camera=<deviceId>` of the Cameras section. */
export const CAMERA_PARAM = 'camera'
/** `?view=` of the Cameras section: `review` | `health` | `settings`. */
export const VIEW_PARAM = 'view'

/** A view of the Cameras section. */
export type ArchiveCameraView = 'review' | 'health' | 'settings'

/** The Cameras section, open on one camera (and one of its views). */
export function archiveCameraPath(deviceId: number, view?: ArchiveCameraView): string {
  const base = `${ARCHIVE_PATH}?${SECTION_PARAM}=cameras&${CAMERA_PARAM}=${String(deviceId)}`
  return view === undefined ? base : `${base}&${VIEW_PARAM}=${view}`
}

/** Library → Exports, narrowed to one camera when one is given. */
export function libraryExportsPath(deviceId?: number): string {
  return deviceId === undefined
    ? LIBRARY_EXPORTS_PATH
    : `${LIBRARY_EXPORTS_PATH}&${EXPORT_CAMERA_PARAM}=${String(deviceId)}`
}

/** Old `/archive/:deviceId?section=` ids and the camera view that took each over. */
const CAMERA_SECTION_VIEW: Readonly<Record<string, ArchiveCameraView>> = {
  settings: 'settings',
  space: 'health',
  health: 'health',
  events: 'review',
  review: 'review',
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
  if (camera?.[1] !== undefined) {
    const deviceId = Number(camera[1])
    const section = params.get(SECTION_PARAM)
    if (section === 'exports') return libraryExportsPath(deviceId)
    const view = section === null ? undefined : CAMERA_SECTION_VIEW[section]
    return archiveCameraPath(deviceId, view)
  }
  return null
}
