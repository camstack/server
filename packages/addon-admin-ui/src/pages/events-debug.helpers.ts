/**
 * The Debug tab's contract with the `debug.*` bridge, narrowed by hand.
 *
 * `addons.custom` is typed `z.unknown()` at the cap boundary — the per-action
 * schema lives in the addon and the client never sees it. So every reply is
 * narrowed here, in one file, with type guards rather than casts: a malformed
 * reply yields `null` and the tab says it could not read it, instead of
 * rendering `undefined` into a badge.
 *
 * The finding CODES are the addon's vocabulary; the sentences below are this
 * surface's. They are kept apart deliberately — the addon's `detail` carries the
 * measured number and is shown as the row's tooltip, while the label is the
 * short thing an operator scans a column of.
 */
import {
  isMediaProvenance,
  type MediaProvenance,
} from '../components/detection-intelligence/media-provenance.js'
import { hubPath } from '../lib/mount'

/** The addonId for `addons.custom` is the MANIFEST id, never the npm package. */
export const DEBUG_ADDON_ID = 'pipeline-analytics'
export const DEBUG_LIST_ACTION = 'debug.listTracks'
export const DEBUG_ANALYZE_ACTION = 'debug.analyze'
/** The admin-gated data plane the bundle streams from. */
export const DEBUG_EXPORT_URL = hubPath('/addon/pipeline-analytics/debug-export')

export type DebugSeverity = 'error' | 'warn' | 'info'

export interface DebugFinding {
  readonly code: string
  readonly severity: DebugSeverity
  readonly detail: string
}

/**
 * One marked track, as `debug.listTracks` reports it.
 *
 * It satisfies {@link TrackSubject} structurally — deliberately, and that is
 * the whole convergence: the Debug tab renders the SAME `EventCard` and opens
 * the SAME `EventDetailPanel` the Events feed does, so a track looks the same
 * wherever an operator meets it. `importance` and `bestEventId` are REQUIRED
 * here (defaulted at the parse boundary) because that interface needs a number
 * and a string, and an absent score is a 0 that renders no badge. This bridge
 * carries no `mediaId` (D482) — `EventCard`'s tile falls back to the owner
 * form on `trackId`, which every row here has, so the card still resolves a
 * tile with nothing more than `bestEventId` reports.
 */
export interface DebugTrackListItem {
  readonly trackId: string
  readonly deviceId: number
  readonly className: string
  readonly label?: string
  readonly subLabel?: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly durationMs: number
  readonly active: boolean
  /** `TrackSubject.timestamp` — the track's start. Mirrors `firstSeen`. */
  readonly timestamp: number
  /** `TrackSubject.windowMs` — mirrors `durationMs`. */
  readonly windowMs: number
  readonly importance: number
  /** Id of the track's representative ObjectEvent; `''` when it never got
   *  one. Not read for tile addressing any more (D482) — `EventCard` resolves
   *  the tile from `trackId` instead — but kept because `debug.listTracks`
   *  still reports it and `TrackSubject` still declares it. */
  readonly bestEventId: string
  readonly markForTrain?: boolean
  readonly favourited?: boolean
  /** Always `true` on this list — every row here is a marked track. Present so
   *  the shared card can render the debug flag without a special case. */
  readonly debug: true
  readonly previewMissReason?: string
}

export interface DebugTrackReport extends DebugTrackListItem {
  readonly mediaCount: number
  readonly mediaKinds: readonly string[]
  readonly eventCount: number
  readonly positionCount: number
  readonly findings: readonly DebugFinding[]
  /** Where the shown tile's bytes came from (D276). Absent = the track has no
   *  thumbnail row, or the addon predates the field. */
  readonly thumbnailProvenance?: MediaProvenance
}

export interface DebugListResult {
  readonly tracks: readonly DebugTrackListItem[]
  readonly truncated: boolean
}

export interface DebugAnalyzeResult {
  readonly reports: readonly DebugTrackReport[]
  readonly vanished: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function num(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function bool(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key]
  return typeof value === 'boolean' ? value : null
}

function isSeverity(value: unknown): value is DebugSeverity {
  return value === 'error' || value === 'warn' || value === 'info'
}

function parseFinding(raw: unknown): DebugFinding | null {
  if (!isRecord(raw)) return null
  const code = str(raw, 'code')
  const detail = str(raw, 'detail')
  const severity = raw['severity']
  if (code === null || detail === null || !isSeverity(severity)) return null
  return { code, severity, detail }
}

function parseListItem(raw: unknown): DebugTrackListItem | null {
  if (!isRecord(raw)) return null
  const trackId = str(raw, 'trackId')
  const deviceId = num(raw, 'deviceId')
  const className = str(raw, 'className')
  const firstSeen = num(raw, 'firstSeen')
  const lastSeen = num(raw, 'lastSeen')
  const durationMs = num(raw, 'durationMs')
  const active = bool(raw, 'active')
  if (
    trackId === null ||
    deviceId === null ||
    className === null ||
    firstSeen === null ||
    lastSeen === null ||
    durationMs === null ||
    active === null
  ) {
    return null
  }
  const label = str(raw, 'label')
  const subLabel = str(raw, 'subLabel')
  const previewMissReason = str(raw, 'previewMissReason')
  const markForTrain = bool(raw, 'markForTrain')
  const favourited = bool(raw, 'favourited')
  return {
    trackId,
    deviceId,
    className,
    ...(label === null ? {} : { label }),
    ...(subLabel === null ? {} : { subLabel }),
    firstSeen,
    lastSeen,
    durationMs,
    active,
    // The `TrackSubject` mirrors. An addon that predates these fields sends
    // nothing, and the defaults are the honest reading of that: an unscored
    // track is 0 (no badge), and no representative event is `''`. Neither
    // invents a value — they are what "we were not told" looks like on a
    // surface whose card needs a number.
    timestamp: firstSeen,
    windowMs: durationMs,
    importance: num(raw, 'importance') ?? 0,
    bestEventId: str(raw, 'bestEventId') ?? '',
    ...(markForTrain === null ? {} : { markForTrain }),
    ...(favourited === null ? {} : { favourited }),
    // Every row on this list IS marked — that is what the list is.
    debug: true,
    ...(previewMissReason === null || previewMissReason.length === 0 ? {} : { previewMissReason }),
  }
}

function parseReport(raw: unknown): DebugTrackReport | null {
  const base = parseListItem(raw)
  if (base === null || !isRecord(raw)) return null
  const mediaCount = num(raw, 'mediaCount')
  const eventCount = num(raw, 'eventCount')
  const positionCount = num(raw, 'positionCount')
  if (mediaCount === null || eventCount === null || positionCount === null) return null
  const kindsRaw = raw['mediaKinds']
  const findingsRaw = raw['findings']
  if (!Array.isArray(kindsRaw) || !Array.isArray(findingsRaw)) return null
  const mediaKinds = kindsRaw.filter((k): k is string => typeof k === 'string')
  const findings: DebugFinding[] = []
  for (const item of findingsRaw) {
    const parsed = parseFinding(item)
    // A single unreadable finding must not discard the rest of the row — the
    // codes are independent observations, not one document.
    if (parsed !== null) findings.push(parsed)
  }
  // An UNRECOGNISED provenance reads as ABSENT, never as a value: the addon
  // ships separately and could add a fourth rank, and a badge drawn from a word
  // this build does not understand would be a claim nobody can check.
  const provenance = raw['thumbnailProvenance']
  return {
    ...base,
    mediaCount,
    mediaKinds,
    eventCount,
    positionCount,
    findings,
    ...(isMediaProvenance(provenance) ? { thumbnailProvenance: provenance } : {}),
  }
}

/** Narrow a `debug.listTracks` reply. `null` when it is not the shape promised. */
export function parseDebugList(raw: unknown): DebugListResult | null {
  if (!isRecord(raw)) return null
  const truncated = bool(raw, 'truncated')
  const tracksRaw = raw['tracks']
  if (truncated === null || !Array.isArray(tracksRaw)) return null
  const tracks: DebugTrackListItem[] = []
  for (const item of tracksRaw) {
    const parsed = parseListItem(item)
    if (parsed === null) return null
    tracks.push(parsed)
  }
  return { tracks, truncated }
}

/** Narrow a `debug.analyze` reply. `null` when it is not the shape promised. */
export function parseDebugAnalyze(raw: unknown): DebugAnalyzeResult | null {
  if (!isRecord(raw)) return null
  const reportsRaw = raw['reports']
  const vanishedRaw = raw['vanished']
  if (!Array.isArray(reportsRaw) || !Array.isArray(vanishedRaw)) return null
  const reports: DebugTrackReport[] = []
  for (const item of reportsRaw) {
    const parsed = parseReport(item)
    if (parsed === null) return null
    reports.push(parsed)
  }
  return {
    reports,
    vanished: vanishedRaw.filter((v): v is string => typeof v === 'string'),
  }
}

/** The short label shown on a badge, per finding code. */
const FINDING_LABELS: Readonly<Record<string, string>> = {
  MEDIA_EVICTED_OR_NEVER: 'no media',
  MISSING_KEYFRAME: 'no keyframe',
  MISSING_FIRSTFRAME: 'no first frame',
  MISSING_LASTFRAME: 'no last frame',
  MISSING_THUMBNAIL: 'no thumbnail',
  MISSING_BEST_CROP: 'no crop',
  SHORT_TRACK: 'very short',
  ZERO_EVENTS: 'no events',
  ZERO_POSITIONS: 'no trajectory',
  NO_PERIODIC_SNAPSHOTS: 'no snapshots',
  LASTFRAME_STALE: 'stale last frame',
  MEDIA_STOPPED_EARLY: 'media stopped early',
  NO_BEST_EVENT: 'no best event',
  LOW_BEST_SCORE: 'low score',
  UNSCORED_LABEL: 'unscored label',
  BEST_SHOT_STANDIN: 'stand-in best shot',
  BEST_SHOT_RASTER: 'low-res best shot',
}

/**
 * The badge label for a code.
 *
 * An UNKNOWN code falls back to the code itself rather than being hidden: the
 * addon is deployed separately from this bundle, so it can and will ship a
 * finding this build has never heard of — and a new defect silently not
 * rendering is the worst possible way to learn that.
 */
export function findingLabel(code: string): string {
  return FINDING_LABELS[code] ?? code
}

const SEVERITY_ORDER: Readonly<Record<DebugSeverity, number>> = { error: 0, warn: 1, info: 2 }

/** Worst first, then alphabetical — a stable order across renders. */
export function sortFindings(findings: readonly DebugFinding[]): readonly DebugFinding[] {
  return findings.toSorted(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code),
  )
}

/** The worst severity present, or `null` for a clean track. */
export function worstSeverity(findings: readonly DebugFinding[]): DebugSeverity | null {
  let worst: DebugSeverity | null = null
  for (const f of findings) {
    if (worst === null || SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[worst]) worst = f.severity
  }
  return worst
}

/** `?deviceIds=101,102`, or no query at all for every camera. */
export function debugExportUrl(deviceIds: readonly number[]): string {
  if (deviceIds.length === 0) return DEBUG_EXPORT_URL
  return `${DEBUG_EXPORT_URL}?deviceIds=${deviceIds.join(',')}`
}

/** `1.5s`, `42s`, `3m 07s` — a duration read at a glance. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes)}m ${String(seconds % 60).padStart(2, '0')}s`
}

// ── Selection ────────────────────────────────────────────────────────────────

/**
 * The selection key, IDENTICAL in construction to the Events feed's
 * `trackSelectionKey`: `trackId` is a per-device counter, so `track-158` exists
 * on every camera and a bare-trackId set un-marks the wrong camera's track.
 *
 * Re-declared rather than imported so this module stays free of the feed's
 * merge helpers, which pull in `@camstack/types`; the shape is pinned by a test
 * that compares the two.
 */
export function debugSelectionKey(deviceId: number, trackId: string): string {
  return `${String(deviceId)}:${trackId}`
}

/**
 * Group a selection into one `setTrackFlags` call per (device, track).
 *
 * `setTrackFlags` is per-track — there is no batch write, and inventing one
 * would be a cap change and therefore a release train, which this tab exists
 * not to need. So a bulk action is N writes, and the caller reports the ones
 * that failed rather than claiming the whole set succeeded.
 */
export interface DebugSelectionTarget {
  readonly deviceId: number
  readonly trackId: string
}

export function resolveSelection(
  tracks: readonly DebugTrackListItem[],
  selectedKeys: ReadonlySet<string>,
): readonly DebugSelectionTarget[] {
  const out: DebugSelectionTarget[] = []
  const seen = new Set<string>()
  for (const track of tracks) {
    const key = debugSelectionKey(track.deviceId, track.trackId)
    if (!selectedKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push({ deviceId: track.deviceId, trackId: track.trackId })
  }
  return out
}
