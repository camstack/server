/**
 * `debug.tape.status` rows (decision 9, D62). Every camera asked about has a
 * row; the switch is read from the setting, never from recorder state, so a
 * switched-off camera is `off` — reported, not absent. The cost read-out is
 * what the next camera is switched on against (the `keepSourceFrames` rule).
 */
import type { TapeCameraStatus } from './tape-recorder-types.js'
import type { TapeSegmentListing } from './tape-shelf.js'

/** `unknown`: the camera's switch could not be read (L4). */
export type TapeStatusState = 'off' | 'recording' | 'refused' | 'failing' | 'unknown'

/** Why a node records no tapes at all (spec §3.1). */
export type TapeNodeRefusal = 'not-post-processing-node' | 'artifacts-elsewhere'

/** The one node that may hold tapes: sqlite and bulk state are hub-only, and
 *  an agent persists nothing (spec §3.1). */
export const TAPE_NODE_ID = 'hub'

/** What decides, before any storage read, whether this node may record. */
export interface TapeNodeFacts {
  /** The bare node id (`hub`, never `hub/<runner>`). */
  readonly nodeId: string
  readonly isPostProcessingNode: boolean
}

/**
 * Tapes are recorded where the frames are post-processed AND that is the hub.
 * A cluster whose post-processing node is an agent records nothing anywhere:
 * the agent refuses (it persists nothing) and so does the hub (it sees no
 * frames). Both name the same reason, so the operator reads one cause.
 */
export function tapeNodeRefusal(facts: TapeNodeFacts): TapeNodeRefusal | null {
  if (facts.nodeId !== TAPE_NODE_ID || !facts.isPostProcessingNode) {
    return 'not-post-processing-node'
  }
  return null
}

/** What the shelf holds for one camera; every figure `null` when the shelf
 *  could not be read — an unmeasured disk is never "0 bytes" (D393). */
interface ShelfFigures {
  readonly segmentsHeld: number | null
  readonly bytesHeld: number | null
  readonly bytesLastHour: number | null
  readonly heldFromMs?: number
  readonly heldToMs?: number
  readonly shelfError?: string
}

export interface TapeStatusRow extends ShelfFigures {
  readonly deviceId: number
  readonly state: TapeStatusState
  readonly reason?: string
  readonly segmentOriginMs?: number
  readonly framesPerMin?: number
  readonly gapsSinceArmed: number
}

export interface TapeStatusInput {
  readonly deviceIds: readonly number[]
  readonly switchOn: ReadonlyMap<number, boolean>
  /** Cameras whose `trackingTape` setting could not be read, with why (L4):
   *  `unknown`, never guessed off or on, and never failing the whole call. */
  readonly switchUnreadable?: ReadonlyMap<number, string>
  /** `null` = no recorder on this node (refused, not started, or failed). A
   *  running recorder always answers, `off` included. */
  readonly recorder: (deviceId: number) => TapeCameraStatus | null
  readonly refusal: TapeNodeRefusal | null
  /** Why the recorder failed to start on a node allowed to record. */
  readonly startFailure?: string | null
  /** A camera absent from the map was not read: its figures are `null`. */
  readonly segments: ReadonlyMap<number, TapeSegmentListing>
  readonly now: number
}

const HOUR_MS = 3_600_000

const NOT_READ: ShelfFigures = {
  segmentsHeld: null,
  bytesHeld: null,
  bytesLastHour: null,
  shelfError: 'not read',
}

function shelfFigures(listing: TapeSegmentListing | undefined, now: number): ShelfFigures {
  if (listing === undefined) return NOT_READ
  if (!listing.ok) {
    return { segmentsHeld: null, bytesHeld: null, bytesLastHour: null, shelfError: listing.reason }
  }
  if (listing.unstatted.length > 0) {
    return {
      segmentsHeld: null,
      bytesHeld: null,
      bytesLastHour: null,
      shelfError: `${String(listing.unstatted.length)} segment file(s) could not be read`,
    }
  }
  const held = listing.segments
  const first = held[0]
  const last = held[held.length - 1]
  return {
    segmentsHeld: held.length,
    bytesHeld: held.reduce((sum, s) => sum + s.bytes, 0),
    bytesLastHour: held
      .filter((s) => s.originMs >= now - HOUR_MS)
      .reduce((sum, s) => sum + s.bytes, 0),
    ...(first !== undefined ? { heldFromMs: first.originMs } : {}),
    ...(last !== undefined ? { heldToMs: last.originMs } : {}),
  }
}

/**
 * Default `debug.tape.status` (no `deviceIds`): drop the noise. An Off camera
 * with a measured empty shelf is not a cost row and is not promotable; keep
 * everything else — Recording / Refused / Failing / Unknown, Off with held
 * segments (still promotable after the switch went off), and Off whose shelf
 * could not be read (D393: never silently hide an unreadable camera). Explicit
 * `deviceIds` still return every asked-about camera, Off included (D62).
 */
export function defaultTapeStatusCameras(rows: readonly TapeStatusRow[]): readonly TapeStatusRow[] {
  return rows.filter(
    (row) => row.state !== 'off' || row.segmentsHeld === null || row.segmentsHeld > 0,
  )
}

export function describeTapeStatus(input: TapeStatusInput): readonly TapeStatusRow[] {
  return input.deviceIds.map((deviceId): TapeStatusRow => {
    const shelf = { deviceId, ...shelfFigures(input.segments.get(deviceId), input.now) }
    const rec = input.recorder(deviceId)
    const gaps = { gapsSinceArmed: rec?.gapsSinceArmed ?? 0 }
    const unreadable = input.switchUnreadable?.get(deviceId)
    if (unreadable !== undefined) return { ...shelf, ...gaps, state: 'unknown', reason: unreadable }
    if (input.switchOn.get(deviceId) !== true) return { ...shelf, ...gaps, state: 'off' }
    if (input.refusal !== null)
      return { ...shelf, ...gaps, state: 'refused', reason: input.refusal }
    // No recorder on a node that may record: it never started, or its start
    // threw. Never `recording` — nothing is (M2, D393).
    if (rec === null) {
      const failure = input.startFailure ?? null
      return {
        ...shelf,
        ...gaps,
        state: 'failing',
        reason:
          failure === null
            ? 'tracking tapes not started'
            : `tracking tapes could not start: ${failure}`,
      }
    }
    // Armed by the setting, not yet told by a frame: the next frame arms it.
    if (rec.state === 'off') return { ...shelf, ...gaps, state: 'recording' }
    if (rec.state === 'failing') {
      return {
        ...shelf,
        ...gaps,
        state: 'failing',
        ...(rec.reason !== undefined ? { reason: rec.reason } : {}),
      }
    }
    const minutes = rec.armedSinceMs === undefined ? 0 : (input.now - rec.armedSinceMs) / 60_000
    return {
      ...shelf,
      ...gaps,
      state: 'recording',
      ...(rec.segmentOriginMs !== undefined ? { segmentOriginMs: rec.segmentOriginMs } : {}),
      ...(minutes > 0 ? { framesPerMin: Math.round(rec.framesSinceArmed / minutes) } : {}),
    }
  })
}
