/**
 * An in-memory world for the promotion / pin-ledger specs (D681, Task 12):
 * the real index store over the records world, a shelf of named
 * segment files, a pin map, and knobs that make one dependency misbehave.
 */
import { makeAnalyticsWorld } from '../../../__tests__/fake-records.js'
import { makeLogRecorder } from '../../../__tests__/test-helpers.js'
import {
  TrackingTapeIndexStore,
  type TrackingTapeRow,
} from '../../../store/tracking-tape-index-store.js'
import { sampleEnd, sampleFrame, sampleHeader } from '../../__tests__/tape-fixtures.js'
import type { Tape } from '../../tape-codec.js'
import type { TapePromotionDeps } from '../tape-promotion.js'
import type { TapeSegmentListing } from '../tape-shelf.js'

export const NOW = 1_800_000_000_000
export const ORIGIN = NOW - 3_600_000

/** The default shelf's one segment: `trk-a` at 0, `trk-b` at 1 000. */
export function segment(): Tape {
  return {
    header: sampleHeader(),
    body: [
      sampleFrame(0, { live: [{ trk: 'trk-a', det: 'd-0', m: true, st: 'moving' }] }),
      sampleFrame(1_000, { live: [{ trk: 'trk-b', det: 'd-1000', m: true, st: 'moving' }] }),
    ],
    end: sampleEnd({ durationMs: 1_000 }),
  }
}

/** Knobs a test turns to make one dependency misbehave. */
export interface Faults {
  /** Ids whose pin/unpin write fails (not counted, as `setBenchPinned` does). */
  readonly failingPins: Set<string>
  listing: TapeSegmentListing | null
  failInsert: boolean
  /** The insert commits, then reports a failure (a timeout after commit). */
  insertCommitsThenThrows: boolean
  /** While set, an UNPIN call made now waits on it before writing — an
   *  unpin that lands late (fix round 2, N1). Captured at call time. */
  unpinGate: Promise<void> | null
  /** How many unpin calls parked on `unpinGate` — a test waits for this to know
   *  the write is in flight, instead of guessing with wall-clock time. */
  unpinsHeld: number
  /** While set, a segment read waits on it — a slow promotion (N1). */
  readGate: Promise<void> | null
  /** What `currentSession` answers: the running recorder's session. */
  liveSession: string | null
}

/** A gate a test opens by hand. */
export interface Gate {
  readonly wait: Promise<void>
  readonly open: () => void
}

export function gate(): Gate {
  let open = (): void => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

/** Let queued microtasks and every already-scheduled macrotask turn run. No
 *  wall-clock wait: the world is microtasks and `setImmediate` only, so a
 *  bounded number of turns is a complete drain on any host load. */
export async function flush(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Turn the loop until `predicate` holds; fails loudly instead of hanging. */
export async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1_000; i++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`never reached: ${label}`)
}

export interface World {
  readonly deps: TapePromotionDeps
  readonly index: TrackingTapeIndexStore
  readonly written: Map<string, Buffer>
  readonly pins: Map<string, boolean>
  readonly rotated: number[]
  /** Segment files by name; `readTape` throws for a missing one. */
  readonly tapes: Map<string, Tape>
  /** Every file `readTape` was asked for, in order. */
  readonly reads: string[]
  readonly faults: Faults
  readonly logs: ReturnType<typeof makeLogRecorder>['entries']
}

export function oldRow(i: number): TrackingTapeRow {
  return {
    id: `old-${String(i).padStart(4, '0')}`,
    deviceId: 102,
    scenario: 'old',
    note: null,
    lighting: 'day',
    fromMs: 0,
    toMs: 1,
    state: 'complete',
    frames: 1,
    skips: 0,
    gaps: 0,
    bytes: 1,
    reviewed: false,
    trackIds: [],
    createdAt: i,
    releasedAt: null,
    pinsSettled: true,
  }
}

export async function world(): Promise<World> {
  const { ledgers } = await makeAnalyticsWorld()
  const { logger, entries } = makeLogRecorder()
  const real = new TrackingTapeIndexStore({ tapeLedger: ledgers.trackingTapes, logger })
  const written = new Map<string, Buffer>()
  const pins = new Map<string, boolean>()
  const rotated: number[] = []
  const tapes = new Map<string, Tape>([['seg-1', segment()]])
  const reads: string[] = []
  const faults: Faults = {
    failingPins: new Set(),
    listing: null,
    failInsert: false,
    insertCommitsThenThrows: false,
    unpinGate: null,
    unpinsHeld: 0,
    readGate: null,
    liveSession: null,
  }
  const index: TapePromotionDeps['index'] = {
    insert: async (r) => {
      if (faults.failInsert) throw new Error('settings store unavailable')
      await real.insert(r)
      if (faults.insertCommitsThenThrows) throw new Error('settings store timed out')
    },
    get: (id) => real.get(id),
    list: async (deviceId) => {
      const rows = await real.list(deviceId)
      // Yield once so an unserialised caller interleaves with another.
      await new Promise((resolve) => setImmediate(resolve))
      return rows
    },
    setReleased: (id, atMs) => real.setReleased(id, atMs),
    setPinsSettled: (id, settled) => real.setPinsSettled(id, settled),
    remove: (id) => real.remove(id),
  }
  let n = 0
  const deps: TapePromotionDeps = {
    readSegments: async (deviceId) =>
      faults.listing ?? {
        ok: true,
        segments: [{ deviceId, originMs: ORIGIN, file: 'seg-1', bytes: 10 }],
        unstatted: [],
      },
    promotedFile: (deviceId, tapeId) => `${String(deviceId)}/promoted/${tapeId}`,
    rotate: async (deviceId) => {
      rotated.push(deviceId)
    },
    readTape: async (file) => {
      reads.push(file)
      if (faults.readGate !== null) await faults.readGate
      const tape = tapes.get(file)
      if (tape === undefined) throw new Error(`unexpected end of file: ${file}`)
      return tape
    },
    writeFile: async (file, bytes) => {
      written.set(file, bytes)
    },
    removeFile: async (file) => {
      written.delete(file)
    },
    index,
    pin: async (_deviceId, ids, pinned) => {
      const held = pinned ? null : faults.unpinGate
      if (held !== null) {
        faults.unpinsHeld += 1
        await held
      }
      let count = 0
      for (const id of ids) {
        if (faults.failingPins.has(id)) continue
        pins.set(id, pinned)
        count += 1
      }
      return count
    },
    mintTapeId: () => {
      n += 1
      return `promo-000${String(n)}`
    },
    currentSession: () => faults.liveSession,
    logger,
    now: () => NOW,
  }
  return { deps, index: real, written, pins, rotated, tapes, reads, faults, logs: entries }
}
