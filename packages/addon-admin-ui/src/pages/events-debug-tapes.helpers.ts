/**
 * The Tapes section's contract with `debug.tape.*` / `debug.gt.*` (D681),
 * narrowed by hand like `events-debug.helpers.ts`: `addons.custom` is
 * `z.unknown()` at the cap boundary, so every reply passes a type guard here
 * and a malformed one is `null`, never a cast.
 *
 * The status row's byte/segment figures are `number | null` — the shelf can
 * fail to be read (`shelfError` is then set), and a `null` measurement is
 * never folded into `0` (D393). A camera whose switch could not itself be
 * read answers `unknown`, not a guessed `off`.
 */
import { hubPath } from '../lib/mount'
import i18n from '../i18n/index'

export const TAPE_ACTIONS = {
  status: 'debug.tape.status',
  promote: 'debug.tape.promote',
  list: 'debug.tape.list',
  tracks: 'debug.tape.tracks',
  review: 'debug.tape.review',
  release: 'debug.tape.release',
  remove: 'debug.tape.delete',
} as const

export const GT_ACTIONS = {
  setRelation: 'debug.gt.setRelation',
  setPurity: 'debug.gt.setPurity',
  list: 'debug.gt.list',
} as const

/** The admin-gated data plane a promoted tape downloads from. */
export const TAPE_EXPORT_URL = hubPath('/addon/pipeline-analytics/tape-export')

/** Relations are read this far around a tape window (spec §4.4). */
export const GT_MARGIN_MS = 10 * 60_000

export function tapeExportUrl(tapeId: string): string {
  return `${TAPE_EXPORT_URL}?tapeId=${encodeURIComponent(tapeId)}`
}

/** Shared across `EventsDebugTapes.tsx` and the sibling files it composes
 *  (`EventsDebugTapesPromoteForm.tsx`, `EventsDebugTapesReview.tsx`) — one
 *  message for "the server answered in a shape this build does not
 *  understand", never re-worded per call site. */
export const UNREADABLE = 'The server answered in a shape this build does not understand.'

export type ActionInput = Readonly<Record<string, unknown>>
export type CallAction = (action: string, input: ActionInput) => Promise<unknown>

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : i18n.t('helpers.eventsDebugTapes.actionFailed')
}

/** `unknown`: the camera's switch itself could not be read (L4) — never
 *  guessed as `off`. */
export type TapeStatusState = 'off' | 'recording' | 'refused' | 'failing' | 'unknown'

export interface TapeStatusRow {
  readonly deviceId: number
  readonly state: TapeStatusState
  readonly reason?: string
  readonly segmentOriginMs?: number
  readonly framesPerMin?: number
  readonly gapsSinceArmed: number
  /** `null` when the shelf could not be read — see {@link TapeStatusRow.shelfError}. */
  readonly segmentsHeld: number | null
  readonly heldFromMs?: number
  readonly heldToMs?: number
  readonly bytesLastHour: number | null
  readonly bytesHeld: number | null
  /** Why the three figures above are `null`. Absent when they were read. */
  readonly shelfError?: string
}

export interface TapeListItem {
  readonly id: string
  readonly deviceId: number
  readonly scenario: string
  readonly note: string | null
  readonly lighting: 'day' | 'ir'
  readonly fromMs: number
  readonly toMs: number
  readonly state: 'complete' | 'incomplete'
  readonly frames: number
  readonly gaps: number
  readonly bytes: number
  readonly reviewed: boolean
  readonly released: boolean
  /** Live track ids the window names. */
  readonly tracks: readonly string[]
  readonly tracksStillStored: number
}

export interface TapeLaneItem {
  readonly trackId: string
  readonly firstT: number
  readonly lastT: number
  readonly boundFrames: number
  readonly cls: string
  readonly stillStored: boolean
}

export interface TapeTracksResult {
  readonly tapeId: string
  readonly deviceId: number
  readonly fromMs: number
  readonly toMs: number
  readonly reviewed: boolean
  readonly lanes: readonly TapeLaneItem[]
}

export interface PromoteAccepted {
  readonly ok: true
  readonly tapeId: string
  readonly state: 'complete' | 'incomplete'
  readonly frames: number
  readonly gaps: number
  readonly pinnedTracks: number
  readonly bytes: number
}

export interface PromoteRefused {
  readonly ok: false
  readonly reason: string
  readonly detail: string
}

export type PromoteOutcome = PromoteAccepted | PromoteRefused

/** `debug.tape.release`'s reply — a `status` union, never folded into success
 *  (Task 12 fix round). */
export interface TapeReleased {
  readonly status: 'released'
  readonly unpinned: number
  readonly pinsSettled: boolean
}
export interface TapeAlreadyReleased {
  readonly status: 'already-released'
}
export interface TapeOperationNotFound {
  readonly status: 'not-found'
}
/** The node itself could not answer — distinct from every answer about the
 *  tape (D393). */
export interface TapeOperationUnavailable {
  readonly status: 'unavailable'
  readonly reason: string
}
export type TapeReleaseOutcome =
  | TapeReleased
  | TapeAlreadyReleased
  | TapeOperationNotFound
  | TapeOperationUnavailable

/** `debug.tape.delete`'s reply. */
export interface TapeDeleted {
  readonly status: 'deleted'
}
/** Refused: the row still names pins not yet taken back. */
export interface TapePinsOwed {
  readonly status: 'pins-owed'
}
export type TapeDeleteOutcome =
  | TapeDeleted
  | TapePinsOwed
  | TapeOperationNotFound
  | TapeOperationUnavailable

export interface GtRelation {
  readonly leftTrackId: string
  readonly rightTrackId: string
  readonly relation: 'same-subject' | 'different-subjects'
  readonly presence: 'continuous' | null
}

export interface GtPurity {
  readonly sourceTrackId: string
  readonly purity: 'mixed' | 'not-a-subject'
  readonly switchAtMs: number | null
}

export interface GtMarks {
  readonly relations: readonly GtRelation[]
  readonly purities: readonly GtPurity[]
  /** `true` when the read hit `ListTrackRelationsInputSchema.limit` and more
   *  marks exist for the window than were returned — see
   *  {@link truncatedMarksNotice}. Never dropped silently (D315/D393): an
   *  unread mark must not look like an absent one. */
  readonly truncated: boolean
}

export interface TrackPair {
  readonly trackId: string
  readonly otherTrackId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(r: Record<string, unknown>, key: string): number | null {
  const v = r[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * A key whose value is legitimately `null` (an unmeasured figure, D393) is
 * read as `null`; a key that is absent or holds anything else is `undefined`
 * — the caller's signal that the WHOLE reply is unreadable, never that the
 * figure is zero.
 */
function numOrNull(r: Record<string, unknown>, key: string): number | null | undefined {
  if (!(key in r)) return undefined
  const v = r[key]
  if (v === null) return null
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function str(r: Record<string, unknown>, key: string): string | null {
  const v = r[key]
  return typeof v === 'string' ? v : null
}

function bool(r: Record<string, unknown>, key: string): boolean | null {
  const v = r[key]
  return typeof v === 'boolean' ? v : null
}

/** Every element must parse, or the whole reply is unreadable. */
function all<T>(raw: unknown, parse: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(raw)) return null
  const out: T[] = []
  for (const item of raw) {
    const parsed = parse(item)
    if (parsed === null) return null
    out.push(parsed)
  }
  return out
}

function isStatusState(v: unknown): v is TapeStatusState {
  return v === 'off' || v === 'recording' || v === 'refused' || v === 'failing' || v === 'unknown'
}

function parseStatusRow(raw: unknown): TapeStatusRow | null {
  if (!isRecord(raw)) return null
  const deviceId = num(raw, 'deviceId')
  const state = raw['state']
  const gapsSinceArmed = num(raw, 'gapsSinceArmed')
  const segmentsHeld = numOrNull(raw, 'segmentsHeld')
  const bytesLastHour = numOrNull(raw, 'bytesLastHour')
  const bytesHeld = numOrNull(raw, 'bytesHeld')
  if (
    deviceId === null ||
    !isStatusState(state) ||
    gapsSinceArmed === null ||
    segmentsHeld === undefined ||
    bytesLastHour === undefined ||
    bytesHeld === undefined
  ) {
    return null
  }
  const reason = str(raw, 'reason')
  const segmentOriginMs = num(raw, 'segmentOriginMs')
  const framesPerMin = num(raw, 'framesPerMin')
  const heldFromMs = num(raw, 'heldFromMs')
  const heldToMs = num(raw, 'heldToMs')
  const shelfError = str(raw, 'shelfError')
  return {
    deviceId,
    state,
    gapsSinceArmed,
    segmentsHeld,
    bytesLastHour,
    bytesHeld,
    ...(reason !== null ? { reason } : {}),
    ...(segmentOriginMs !== null ? { segmentOriginMs } : {}),
    ...(framesPerMin !== null ? { framesPerMin } : {}),
    ...(heldFromMs !== null ? { heldFromMs } : {}),
    ...(heldToMs !== null ? { heldToMs } : {}),
    ...(shelfError !== null ? { shelfError } : {}),
  }
}

export function parseTapeStatus(raw: unknown): readonly TapeStatusRow[] | null {
  return isRecord(raw) ? all(raw['cameras'], parseStatusRow) : null
}

function parseListItem(raw: unknown): TapeListItem | null {
  if (!isRecord(raw)) return null
  const id = str(raw, 'id')
  const deviceId = num(raw, 'deviceId')
  const scenario = str(raw, 'scenario')
  const lighting = raw['lighting']
  const fromMs = num(raw, 'fromMs')
  const toMs = num(raw, 'toMs')
  const state = raw['state']
  const frames = num(raw, 'frames')
  const gaps = num(raw, 'gaps')
  const bytes = num(raw, 'bytes')
  const reviewed = bool(raw, 'reviewed')
  const released = bool(raw, 'released')
  const tracks = all(raw['tracks'], (t) => (typeof t === 'string' ? t : null))
  const tracksStillStored = num(raw, 'tracksStillStored')
  if (
    id === null ||
    deviceId === null ||
    scenario === null ||
    (lighting !== 'day' && lighting !== 'ir') ||
    fromMs === null ||
    toMs === null ||
    (state !== 'complete' && state !== 'incomplete') ||
    frames === null ||
    gaps === null ||
    bytes === null ||
    reviewed === null ||
    released === null ||
    tracks === null ||
    tracksStillStored === null
  ) {
    return null
  }
  return {
    id,
    deviceId,
    scenario,
    note: str(raw, 'note'),
    lighting,
    fromMs,
    toMs,
    state,
    frames,
    gaps,
    bytes,
    reviewed,
    released,
    tracks,
    tracksStillStored,
  }
}

export function parseTapeList(raw: unknown): readonly TapeListItem[] | null {
  return isRecord(raw) ? all(raw['tapes'], parseListItem) : null
}

function parseLane(raw: unknown): TapeLaneItem | null {
  if (!isRecord(raw)) return null
  const trackId = str(raw, 'trackId')
  const firstT = num(raw, 'firstT')
  const lastT = num(raw, 'lastT')
  const boundFrames = num(raw, 'boundFrames')
  const cls = str(raw, 'cls')
  const stillStored = bool(raw, 'stillStored')
  if (
    trackId === null ||
    firstT === null ||
    lastT === null ||
    boundFrames === null ||
    cls === null ||
    stillStored === null
  ) {
    return null
  }
  return { trackId, firstT, lastT, boundFrames, cls, stillStored }
}

export function parseTapeTracks(raw: unknown): TapeTracksResult | null {
  if (!isRecord(raw)) return null
  const tapeId = str(raw, 'tapeId')
  const deviceId = num(raw, 'deviceId')
  const fromMs = num(raw, 'fromMs')
  const toMs = num(raw, 'toMs')
  const reviewed = bool(raw, 'reviewed')
  const lanes = all(raw['lanes'], parseLane)
  if (
    tapeId === null ||
    deviceId === null ||
    fromMs === null ||
    toMs === null ||
    reviewed === null ||
    lanes === null
  ) {
    return null
  }
  return { tapeId, deviceId, fromMs, toMs, reviewed, lanes }
}

export function parsePromote(raw: unknown): PromoteOutcome | null {
  if (!isRecord(raw)) return null
  if (raw['ok'] === false) {
    const reason = str(raw, 'reason')
    const detail = str(raw, 'detail')
    return reason === null || detail === null ? null : { ok: false, reason, detail }
  }
  if (raw['ok'] !== true) return null
  const tapeId = str(raw, 'tapeId')
  const state = raw['state']
  const frames = num(raw, 'frames')
  const gaps = num(raw, 'gaps')
  const pinnedTracks = num(raw, 'pinnedTracks')
  const bytes = num(raw, 'bytes')
  if (
    tapeId === null ||
    (state !== 'complete' && state !== 'incomplete') ||
    frames === null ||
    gaps === null ||
    pinnedTracks === null ||
    bytes === null
  ) {
    return null
  }
  return { ok: true, tapeId, state, frames, gaps, pinnedTracks, bytes }
}

export function parseTapeRelease(raw: unknown): TapeReleaseOutcome | null {
  if (!isRecord(raw)) return null
  const status = raw['status']
  if (status === 'released') {
    const unpinned = num(raw, 'unpinned')
    const pinsSettled = bool(raw, 'pinsSettled')
    return unpinned === null || pinsSettled === null ? null : { status, unpinned, pinsSettled }
  }
  if (status === 'already-released' || status === 'not-found') return { status }
  if (status === 'unavailable') {
    const reason = str(raw, 'reason')
    return reason === null ? null : { status, reason }
  }
  return null
}

export function parseTapeDelete(raw: unknown): TapeDeleteOutcome | null {
  if (!isRecord(raw)) return null
  const status = raw['status']
  if (status === 'deleted' || status === 'pins-owed' || status === 'not-found') return { status }
  if (status === 'unavailable') {
    const reason = str(raw, 'reason')
    return reason === null ? null : { status, reason }
  }
  return null
}

/** The message for a non-success release/delete status; `null` on success —
 *  the caller must not fold either into "nothing happened" (Task 12). */
export function tapeOperationMessage(
  outcome: TapeReleaseOutcome | TapeDeleteOutcome,
): string | null {
  switch (outcome.status) {
    case 'released':
    case 'deleted':
      return null
    case 'already-released':
      return i18n.t('helpers.eventsDebugTapes.alreadyReleased')
    case 'not-found':
      return i18n.t('helpers.eventsDebugTapes.notFound')
    case 'pins-owed':
      return i18n.t('helpers.eventsDebugTapes.pinsOwed')
    case 'unavailable':
      return i18n.t('helpers.eventsDebugTapes.unavailable', { reason: outcome.reason })
  }
}

function parseRelation(raw: unknown): GtRelation | null {
  if (!isRecord(raw)) return null
  const leftTrackId = str(raw, 'leftTrackId')
  const rightTrackId = str(raw, 'rightTrackId')
  const relation = raw['relation']
  const presence = raw['presence']
  if (
    leftTrackId === null ||
    rightTrackId === null ||
    (relation !== 'same-subject' && relation !== 'different-subjects')
  ) {
    return null
  }
  return {
    leftTrackId,
    rightTrackId,
    relation,
    presence: presence === 'continuous' ? 'continuous' : null,
  }
}

function parsePurity(raw: unknown): GtPurity | null {
  if (!isRecord(raw)) return null
  const sourceTrackId = str(raw, 'sourceTrackId')
  const purity = raw['purity']
  if (sourceTrackId === null || (purity !== 'mixed' && purity !== 'not-a-subject')) return null
  return { sourceTrackId, purity, switchAtMs: num(raw, 'switchAtMs') }
}

export function parseGtMarks(raw: unknown): GtMarks | null {
  if (!isRecord(raw)) return null
  const relations = all(raw['relations'], parseRelation)
  const purities = all(raw['purities'], parsePurity)
  const truncated = bool(raw, 'truncated')
  return relations === null || purities === null || truncated === null
    ? null
    : { relations, purities, truncated }
}

/**
 * `null` when the read was whole; a message naming how many marks are
 * actually shown when it was not — a truncated read must say so, never drop
 * badges off the review view without a trace (Task 24 fix round 1, D315).
 * The count is what landed (`relations.length + purities.length`), because
 * that is what the operator can see on screen, not the query's own `limit`.
 */
export function truncatedMarksNotice(marks: GtMarks): string | null {
  if (!marks.truncated) return null
  const count = marks.relations.length + marks.purities.length
  return i18n.t('helpers.eventsDebugTapes.truncatedMarks', { count })
}

/** A camera worth offering in the promotion picker; regardless of switch
 *  state (fix round 1) — see {@link promotableCameras}. */
export interface PromotableCamera {
  readonly deviceId: number
  /** `true` when the shelf itself could not be read for this camera — it is
   *  offered anyway, with a note, rather than silently excluded (D393). */
  readonly segmentsUnknown: boolean
}

/**
 * Every camera worth offering to promote a window from, REGARDLESS of its
 * current switch state (Task 24 fix round 1): `debug.tape.promote` only
 * needs a segment covering the window, not a currently-armed switch, so a
 * camera switched off after capturing a scenario must still be promotable.
 * A camera with zero known segments is excluded (nothing to promote); one
 * whose shelf could not be read is offered anyway, flagged
 * `segmentsUnknown` — excluding it would silently hide a camera that may
 * still have something to promote (D393).
 */
export function promotableCameras(rows: readonly TapeStatusRow[]): readonly PromotableCamera[] {
  return rows
    .filter((r) => r.segmentsHeld === null || r.segmentsHeld > 0)
    .map((r) => ({ deviceId: r.deviceId, segmentsUnknown: r.segmentsHeld === null }))
}

export function sameSubjectPairs(selection: readonly string[]): readonly TrackPair[] {
  return selection
    .slice(1)
    .map((otherTrackId, i) => ({ trackId: selection[i] ?? otherTrackId, otherTrackId }))
}

export function differentSubjectPairs(selection: readonly string[]): readonly TrackPair[] {
  return selection.flatMap((trackId, i) =>
    selection.slice(i + 1).map((otherTrackId) => ({ trackId, otherTrackId })),
  )
}

export function laneMarks(trackId: string, marks: GtMarks): readonly string[] {
  const out: string[] = []
  for (const r of marks.relations) {
    const other =
      r.leftTrackId === trackId ? r.rightTrackId : r.rightTrackId === trackId ? r.leftTrackId : null
    if (other === null) continue
    const word = r.relation === 'same-subject' ? 'same as' : 'different from'
    out.push(`${word} ${other}${r.presence === 'continuous' ? ' (continuous)' : ''}`)
  }
  for (const p of marks.purities) {
    if (p.sourceTrackId !== trackId) continue
    out.push(
      p.purity === 'not-a-subject'
        ? 'not a subject'
        : p.switchAtMs === null
          ? 'mixed'
          : 'mixed at switch',
    )
  }
  return out
}

export function statusLabel(row: TapeStatusRow): string {
  switch (row.state) {
    case 'off':
      return i18n.t('helpers.eventsDebugTapes.statusOff')
    case 'recording':
      return i18n.t('helpers.eventsDebugTapes.statusRecording')
    case 'refused':
      return i18n.t('helpers.eventsDebugTapes.statusRefused', {
        reason: row.reason ?? i18n.t('helpers.eventsDebugTapes.unknownReason'),
      })
    case 'failing':
      return i18n.t('helpers.eventsDebugTapes.statusFailing', {
        reason: row.reason ?? i18n.t('helpers.eventsDebugTapes.unknownReason'),
      })
    case 'unknown':
      return i18n.t('helpers.eventsDebugTapes.statusUnknown', {
        reason: row.reason ?? i18n.t('helpers.eventsDebugTapes.unknownReason'),
      })
  }
}

const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  'window-too-long': 'A promoted window is at most 30 minutes.',
  'window-in-future': 'The window ends in the future.',
  'window-not-recorded':
    'No segment covers that window — the camera was not recording then, or it is older than 24 h.',
  'invalid-scenario':
    'The scenario must be a slug: lowercase letters, digits and dashes, 3–64 characters.',
  'promotion-budget':
    'A promotion budget is full (60 tapes, 1 GiB, 3 000 pinned tracks). Release or delete a tape already committed as a case first.',
  'empty-window': 'No frame was recorded in that window.',
  'shelf-unreadable':
    "The camera's recorded segments could not be listed, so the window cannot be proven whole.",
  'not-post-processing-node':
    'This node does not post-process frames, so it records no tracking tapes.',
  'artifacts-elsewhere':
    'The artifacts storage location is on another node; tapes are recorded only where it lives.',
  'tapes-not-started': 'The tape recorder has not started on this node (or failed to).',
}

export function promoteRefusalText(reason: string, detail: string): string {
  const sentence = REFUSAL_TEXT[reason] ?? `Refused (${reason}).`
  return detail.length > 0 ? `${sentence} ${detail}` : sentence
}

/** `<input type="datetime-local">` value → epoch ms in the browser's zone. */
export function parseLocalDateTime(value: string): number | null {
  if (value.length === 0) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024)
    return i18n.t('helpers.eventsDebugTapes.sizeKb', { value: (bytes / 1024).toFixed(0) })
  return i18n.t('helpers.eventsDebugTapes.sizeMb', { value: (bytes / 1024 / 1024).toFixed(1) })
}

/** A figure that could not be measured is `unknown`, never `0` (D393). */
export function formatBytesOrUnknown(bytes: number | null): string {
  return bytes === null ? 'unknown' : formatBytes(bytes)
}

export function countOrUnknown(value: number | null): string {
  return value === null ? 'unknown' : String(value)
}

/**
 * The export plane names three outcomes by HTTP status (spec / Task 17):
 * 404 `unknown` (no such tape was ever promoted), 503 `unavailable` (this
 * node cannot serve tapes at all), 500 `read-failed` (the node can, but this
 * read did not land — usually a release/delete racing the download). The
 * body is the handler's own text; shown as-is rather than re-worded, so an
 * operator sees exactly what the node said.
 */
export function tapeExportErrorText(status: number, body: string): string {
  const trimmed = body.trim()
  if (status === 404) return i18n.t('helpers.eventsDebugTapes.exportUnknown')
  if (status === 503)
    return trimmed.length > 0 ? trimmed : i18n.t('helpers.eventsDebugTapes.tapesUnavailable')
  if (status === 500) {
    return trimmed.length > 0 ? trimmed : i18n.t('helpers.eventsDebugTapes.exportUnreadable')
  }
  return i18n.t('helpers.eventsDebugTapes.downloadFailed', { status })
}
