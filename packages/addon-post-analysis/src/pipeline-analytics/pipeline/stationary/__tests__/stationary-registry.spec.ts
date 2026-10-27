import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeAnalyticsRecordsNow,
  kindRows,
  type FakeRecords,
} from '../../../__tests__/fake-records.js'
import { StationaryObjectRegistry, type StationaryChangePhase } from '../stationary-registry.js'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { DEFAULT_DEPARTURE_CONFIG, type StationaryEntry } from '../stationary-types.js'
import { watchFrames } from './watch-frames.js'
import { createNoopLogger } from '../../../../embedding-encoder/shared/noop-logger.js'

function makeEntry(over: Partial<StationaryEntry> = {}): StationaryEntry {
  return {
    id: over.id ?? 'e1',
    deviceId: over.deviceId ?? 102,
    className: over.className ?? 'vehicle',
    bbox: over.bbox ?? { x: 100, y: 100, w: 80, h: 60 },
    frameWidth: 1920,
    frameHeight: 1080,
    firstSeenAt: over.firstSeenAt ?? 0,
    becameStationaryAt: over.becameStationaryAt ?? 1000,
    lastConfirmedAt: over.lastConfirmedAt ?? 1000,
    ...(over.sourceTrackId !== undefined ? { sourceTrackId: over.sourceTrackId } : {}),
    ...(over.label !== undefined ? { label: over.label } : {}),
    ...(over.keyFrameMediaId !== undefined ? { keyFrameMediaId: over.keyFrameMediaId } : {}),
  }
}

/**
 * One frame carrying a same-class detection somewhere else in the view.
 *
 * Since 2026-09-15 a TTL retirement requires the detector to have PROVED
 * ITSELF — produced this class somewhere since the entry was last confirmed —
 * because frames-flowing time alone cannot tell "the object left" from "the
 * detector saw nothing". These tests are about the TTL ARITHMETIC, so they
 * establish that precondition rather than assert around it.
 */
function proveDetectorWorks(reg: StationaryObjectRegistry, deviceId: number, at: number): void {
  reg.filter({
    deviceId,
    detections: [{ bbox: { x: 900, y: 900, w: 40, h: 40 }, className: 'vehicle' }],
    frameWidth: 1920,
    frameHeight: 1080,
    timestamp: at,
  })
}

describe('StationaryObjectRegistry', () => {
  let world: FakeRecords
  let changes: { phase: StationaryChangePhase; id: string }[]
  let reg: StationaryObjectRegistry

  beforeEach(() => {
    world = makeAnalyticsRecordsNow()
    changes = []
    reg = new StationaryObjectRegistry({
      records: world.records,
      logger: createNoopLogger(),
      onChange: (c) => changes.push({ phase: c.phase, id: c.entry.id }),
    })
  })

  /**
   * A departure is CONCLUDED later than it HAPPENS — deliberately, because the
   * confirmation must be independent (D279). On device 102 the gap was 6 to 10
   * minutes of observed time: the confirming evidence arrives from the periodic
   * occupancy recheck, every 300 s. A notification cut at the conclusion showed
   * an empty space with nothing leaving it.
   */
  it('a departure carries WHEN IT HAPPENED beside when it was concluded', async () => {
    const seen: { phase: string; timestamp: number; observedAt: number }[] = []
    const reg2 = new StationaryObjectRegistry({
      records: world.records,
      logger: createNoopLogger(),
      onChange: (c) =>
        seen.push({ phase: c.phase, timestamp: c.timestamp, observedAt: c.observedAt }),
    })
    // A TTL expiry: nothing ever read a departure, so the last honest moment is
    // the last confirmation — not the sweep that noticed.
    await reg2.promote(makeEntry({ id: 'e1', lastConfirmedAt: 1_000 }))
    proveDetectorWorks(reg2, 102, 500_000)
    watchFrames(reg2, 102, 1_000, 1_000_000, 5_000)
    await reg2.sweep(1_000_000)
    const departed = seen.find((c) => c.phase === 'departed')
    expect(departed).toBeDefined()
    expect(departed!.timestamp).toBe(1_000_000)
    expect(departed!.observedAt).toBe(1_000)
  })

  it('an appearance happens when it is concluded — the frame that earned it', async () => {
    const seen: { phase: string; timestamp: number; observedAt: number }[] = []
    const reg2 = new StationaryObjectRegistry({
      records: world.records,
      logger: createNoopLogger(),
      onChange: (c) =>
        seen.push({ phase: c.phase, timestamp: c.timestamp, observedAt: c.observedAt }),
    })
    await reg2.promote(makeEntry({ id: 'e1', becameStationaryAt: 4_242 }))
    expect(seen[0]).toMatchObject({ phase: 'appeared', timestamp: 4_242, observedAt: 4_242 })
  })

  it('promotes an entry: in-memory + persisted + appeared change', async () => {
    await reg.promote(makeEntry({ id: 'car1' }))
    expect(reg.count(102)).toBe(1)
    expect(kindRows(world, 'stationary-objects').length).toBe(1)
    expect(changes).toEqual([{ phase: 'appeared', id: 'car1' }])
  })

  it('load() rehydrates persisted entries (survives respawn)', async () => {
    await reg.promote(makeEntry({ id: 'car1', deviceId: 102 }))
    await reg.promote(makeEntry({ id: 'car2', deviceId: 42, bbox: { x: 0, y: 0, w: 10, h: 10 } }))

    const reg2 = new StationaryObjectRegistry({
      records: world.records,
      logger: createNoopLogger(),
    })
    await reg2.load()
    expect(reg2.count(102)).toBe(1)
    expect(reg2.count(42)).toBe(1)
    expect(reg2.list(102)[0]!.id).toBe('car1')
  })

  it('filter suppresses a matching detection when an entry exists', async () => {
    await reg.promote(makeEntry({ id: 'car1' }))
    const res = reg.filter({
      deviceId: 102,
      detections: [{ bbox: { x: 101, y: 100, w: 80, h: 60 }, className: 'vehicle' }],
      frameWidth: 1920,
      frameHeight: 1080,
      timestamp: 50_000,
    })
    expect(res.suppressedIndices.has(0)).toBe(true)
    expect(res.confirmed.map((c) => c.entryId)).toEqual(['car1'])
  })

  it('applyFrameOutcome advances lastConfirmedAt and retires woken entries', async () => {
    await reg.promote(makeEntry({ id: 'car1', lastConfirmedAt: 1000 }))
    await reg.promote(
      makeEntry({ id: 'car2', lastConfirmedAt: 1000, bbox: { x: 900, y: 900, w: 40, h: 40 } }),
    )

    reg.applyFrameOutcome({
      deviceId: 102,
      confirmed: [
        {
          entryId: 'car1',
          className: 'vehicle',
          bbox: { x: 100, y: 100, w: 80, h: 60 },
          observedBbox: { x: 100, y: 100, w: 80, h: 60 },
          strong: true,
        },
      ],
      woken: [{ entryId: 'car2', cause: 'contradicting-read', strikeAgeMs: 3_000, absentReads: 0 }],
      timestamp: 50_000,
    })

    expect(reg.list(102).find((e) => e.id === 'car1')!.lastConfirmedAt).toBe(50_000)
    expect(reg.count(102)).toBe(1) // car2 retired
    expect(changes.filter((c) => c.phase === 'departed').map((c) => c.id)).toEqual(['car2'])
    expect(kindRows(world, 'stationary-objects').length).toBe(1)
  })

  it('sweep retires entries past TTL of OBSERVED time and flushes lastConfirmedAt', async () => {
    reg = new StationaryObjectRegistry({
      records: world.records,
      logger: createNoopLogger(),
      entryTtlMs: 10_000,
      onChange: (c) => changes.push({ phase: c.phase, id: c.entry.id }),
    })
    await reg.promote(makeEntry({ id: 'fresh', lastConfirmedAt: 100_000 }))
    await reg.promote(
      makeEntry({ id: 'stale', lastConfirmedAt: 100_000, bbox: { x: 5, y: 5, w: 5, h: 5 } }),
    )

    // Frames flow up to t=112k; only 'fresh' is confirmed on them.
    proveDetectorWorks(reg, 102, 111_000)
    watchFrames(reg, 102, 100_000, 112_000)
    reg.applyFrameOutcome({
      deviceId: 102,
      confirmed: [
        {
          entryId: 'fresh',
          className: 'vehicle',
          bbox: { x: 100, y: 100, w: 80, h: 60 },
          observedBbox: { x: 100, y: 100, w: 80, h: 60 },
          strong: true,
        },
      ],
      woken: [],
      timestamp: 112_000,
    })

    // Observed clock at 112k: 'stale' unconfirmed for 12k > 10k TTL → retired;
    // 'fresh' confirmed at 112k → kept, regardless of the wall-clock `now`.
    const retired = await reg.sweep(999_000)
    expect(retired.map((e) => e.id)).toEqual(['stale'])
    expect(reg.count(102)).toBe(1)
    expect(changes.filter((c) => c.phase === 'departed').map((c) => c.id)).toEqual(['stale'])
  })

  it('sweep never expires entries while NO frames flow (session-dispatch quiet periods)', async () => {
    reg = new StationaryObjectRegistry({
      records: world.records,
      logger: createNoopLogger(),
      entryTtlMs: 10_000,
    })
    await reg.promote(makeEntry({ id: 'car1', lastConfirmedAt: 100_000 }))

    // Hours of wall-clock silence with no frames beyond the confirmation: the
    // observed clock never moved past it, so the parked car survives.
    reg.noteFrame(102, 100_000)
    const retired = await reg.sweep(100_000 + 3 * 60 * 60_000)
    expect(retired).toEqual([])
    expect(reg.count(102)).toBe(1)

    // A registry that never recorded a frame for the device (fresh respawn,
    // no session yet) also never expires its rehydrated entries.
    const reg2 = new StationaryObjectRegistry({
      records: world.records,
      logger: createNoopLogger(),
      entryTtlMs: 10_000,
    })
    await reg2.load()
    expect(reg2.count(102)).toBe(1)
    expect((await reg2.sweep(999_999_999)).length).toBe(0)
    expect(reg2.count(102)).toBe(1)
  })

  it('#31: filter honours a per-call match config (per-device suppress/wake IoU)', async () => {
    await reg.promote(makeEntry({ id: 'car1' })) // bbox {100,100,80,60}
    // A detection overlapping the entry (IoU ≈ 0.067) with its centroid OUTSIDE
    // the parked box. Below the DEFAULT wakeAssocIou (0.1) → a MISS.
    const det = { bbox: { x: 160, y: 130, w: 80, h: 60 }, className: 'vehicle' }
    const at = (timestamp: number) => ({
      deviceId: 102,
      detections: [det],
      frameWidth: 1920,
      frameHeight: 1080,
      timestamp,
    })

    // t=0 opens the session (and its warm-up). Under the DEFAULT wakeAssocIou
    // this detection does not even associate.
    const defaultRes = reg.filter(at(0))
    expect(defaultRes.woken).toEqual([])
    expect(reg.strikesFor(102)).toEqual([])
    expect(defaultRes.suppressedIndices.size).toBe(0)

    // Lower the per-device wakeAssocIou → the same detection now ASSOCIATES
    // and, with its centroid outside the box, reads as a departure. Past the
    // warm-up, the first such read only arms the entry (D49); a read a full
    // separation gap later retires it (D279).
    const loose = { suppressIou: 0.6, wakeAssocIou: 0.05 }
    const overrideRes = reg.filter(at(3_000), loose)
    expect(overrideRes.woken).toEqual([])
    expect(reg.strikesFor(102).map((s) => s.entryId)).toEqual(['car1'])
    const secondRes = reg.filter(at(6_500), loose)
    expect(secondRes.woken.map((w) => w.entryId)).toEqual(['car1'])
  })

  it('#31: sweep uses the per-device ttlForDevice resolver over the default', async () => {
    reg = new StationaryObjectRegistry({
      records: world.records,
      logger: createNoopLogger(),
      entryTtlMs: 1_000_000, // large registry default
      ttlForDevice: (deviceId) => (deviceId === 102 ? 10_000 : undefined),
      onChange: (c) => changes.push({ phase: c.phase, id: c.entry.id }),
    })
    await reg.promote(makeEntry({ id: 'stale', deviceId: 102, lastConfirmedAt: 100_000 }))
    proveDetectorWorks(reg, 102, 111_000)
    watchFrames(reg, 102, 100_000, 112_000) // watched 12k > per-device 10k TTL

    const retired = await reg.sweep(999_000)
    expect(retired.map((e) => e.id)).toEqual(['stale'])
  })

  it('sweep keeps an entry confirmed within observed TTL and flushes lastConfirmedAt', async () => {
    reg = new StationaryObjectRegistry({
      records: world.records,
      logger: createNoopLogger(),
      entryTtlMs: 60_000,
    })
    await reg.promote(makeEntry({ id: 'car1', lastConfirmedAt: 100_000 }))
    reg.noteFrame(102, 150_000)
    reg.applyFrameOutcome({
      deviceId: 102,
      confirmed: [
        {
          entryId: 'car1',
          className: 'vehicle',
          bbox: { x: 100, y: 100, w: 80, h: 60 },
          observedBbox: { x: 100, y: 100, w: 80, h: 60 },
          strong: true,
        },
      ],
      woken: [],
      timestamp: 150_000,
    })
    const retired = await reg.sweep(160_000) // observed age 0 < 60k
    expect(retired).toEqual([])
    expect(reg.count(102)).toBe(1)
    // lastConfirmedAt flushed to store.
    const rows = kindRows(world, 'stationary-objects')
    expect(Number(rows[0]!.data['lastConfirmedAt'])).toBe(150_000)
  })
})

// ── 2026-07-22: near-full-frame entries are purged on hydrate ────────────────
describe('StationaryObjectRegistry implausible-entry purge', () => {
  it('load() retires a near-full-frame entry instead of resurrecting it', async () => {
    const world = makeAnalyticsRecordsNow()
    const reg = new StationaryObjectRegistry({ records: world.records, logger: createNoopLogger() })
    await reg.promote(makeEntry({ id: 'real', bbox: { x: 100, y: 100, w: 80, h: 60 } }))
    // The dawn/night "envelope exploded" signature: ~91% of the frame.
    await reg.promote(makeEntry({ id: 'exploded', bbox: { x: 20, y: 0, w: 1846, h: 1024 } }))

    const reg2 = new StationaryObjectRegistry({
      records: world.records,
      logger: createNoopLogger(),
    })
    await reg2.load()
    expect(reg2.count(102)).toBe(1)
    expect(reg2.list(102)[0]!.id).toBe('real')
    // The persisted row is deleted too (self-heal, not just skipped).
    expect(kindRows(world, 'stationary-objects').length).toBe(1)
  })
})

// ── D174 / D279: a departure needs an INDEPENDENT confirmation ──────────────
describe('StationaryObjectRegistry departure strikes (D49, D279)', () => {
  let world: FakeRecords
  let reg: StationaryObjectRegistry
  let changes: { phase: StationaryChangePhase; id: string }[]

  const parked = { x: 100, y: 100, w: 80, h: 60 }
  /** Overlaps the parked box (IoU ≈ 0.23) with its centroid outside it. */
  const slidOff = { x: 150, y: 100, w: 80, h: 60 }
  /** No overlap at all — the entry MISSES this frame. */
  const elsewhere = { x: 1800, y: 1000, w: 40, h: 40 }

  /** Session opens here; the warm-up covers T0 … T0+2000. */
  const T0 = 100_000
  /** The first instant past the warm-up that this suite arms a strike on. */
  const ARM_AT = T0 + 3_000
  const GAP = DEFAULT_DEPARTURE_CONFIG.confirmMinGapMs

  function frame(bbox: { x: number; y: number; w: number; h: number }, at: number): void {
    const res = reg.filter({
      deviceId: 102,
      detections: [{ bbox, className: 'vehicle' }],
      frameWidth: 1920,
      frameHeight: 1080,
      timestamp: at,
    })
    reg.noteFrame(102, at)
    reg.applyFrameOutcome({
      deviceId: 102,
      confirmed: res.confirmed,
      woken: res.woken,
      timestamp: at,
    })
  }

  /** Open the session and get past the warm-up on a plain confirmation. */
  function openSession(): void {
    frame(parked, T0)
    frame(parked, T0 + 1_000)
  }

  beforeEach(async () => {
    world = makeAnalyticsRecordsNow()
    changes = []
    reg = new StationaryObjectRegistry({
      records: world.records,
      logger: createNoopLogger(),
      onChange: (c) => changes.push({ phase: c.phase, id: c.entry.id }),
    })
    await reg.promote(makeEntry({ id: 'car1', bbox: parked }))
  })

  it('survives a SINGLE bad box and keeps suppressing it', () => {
    openSession()
    frame(slidOff, ARM_AT)
    expect(reg.count(102)).toBe(1)
    expect(reg.strikesFor(102).map((s) => s.entryId)).toEqual(['car1'])
    expect(changes.filter((c) => c.phase === 'departed')).toEqual([])
  })

  it('TWO departing reads 0.9 s apart do NOT retire it — the 102 signature', () => {
    // The measured failure: a retirement fired on a session's first two frames,
    // 0.9 s apart, on a car the stored images prove never moved. Both reads are
    // the same optical event; counting to two was satisfied and meant nothing.
    openSession()
    frame(slidOff, ARM_AT)
    frame(slidOff, ARM_AT + 900)
    expect(reg.count(102)).toBe(1)
    expect(changes.filter((c) => c.phase === 'departed')).toEqual([])
    // Still armed, and still armed FROM THE FIRST read — the second one did not
    // restart the clock, or a slow drip of bad boxes could postpone a real
    // departure forever.
    expect(reg.strikesFor(102)).toEqual([{ entryId: 'car1', armedAt: ARM_AT, absentReads: 0 }])
  })

  it('a departing read a full separation gap later DOES retire it', () => {
    openSession()
    frame(slidOff, ARM_AT)
    frame(slidOff, ARM_AT + GAP)
    expect(reg.count(102)).toBe(0)
    expect(changes.filter((c) => c.phase === 'departed').map((c) => c.id)).toEqual(['car1'])
  })

  it('a bad box followed by a normal one leaves the entry intact and disarmed', () => {
    openSession()
    frame(slidOff, ARM_AT) // arm
    frame(parked, ARM_AT + 200) // strong re-confirmation → cancel
    expect(reg.count(102)).toBe(1)
    expect(reg.strikesFor(102)).toEqual([])
    // Disarmed for real: a departing read a full gap after the CANCELLED
    // strike's arming instant must only arm again, not cash the old one in.
    frame(slidOff, ARM_AT + GAP)
    expect(reg.count(102)).toBe(1)
    expect(reg.strikesFor(102)).toEqual([
      { entryId: 'car1', armedAt: ARM_AT + GAP, absentReads: 0 },
    ])
  })

  it('a departing read then ONE miss retires nothing — a miss is not a read', () => {
    openSession()
    frame(slidOff, ARM_AT)
    frame(elsewhere, ARM_AT + GAP)
    expect(reg.count(102)).toBe(1)
  })

  it('a SUSTAINED absence past the gap retires it — a car that drove out of frame', () => {
    openSession()
    frame(slidOff, ARM_AT)
    // Frames keep flowing at ~5 fps and the spot is empty on every one of them.
    for (let i = 1; i <= 20 && reg.count(102) > 0; i++) frame(elsewhere, ARM_AT + i * 200)
    expect(reg.count(102)).toBe(0)
    expect(changes.filter((c) => c.phase === 'departed').map((c) => c.id)).toEqual(['car1'])
  })

  it('a departing read inside the session WARM-UP arms nothing at all', () => {
    // The cold-decode frames. One of the three observed retirements fired on
    // them, and this is the frame that must now do nothing.
    frame(slidOff, T0)
    frame(slidOff, T0 + 900)
    expect(reg.count(102)).toBe(1)
    expect(reg.strikesFor(102)).toEqual([])
  })

  it('a strike nobody confirmed EXPIRES rather than waiting for a later session', () => {
    // The 17-minute case, in miniature. The strike is armed, the camera goes
    // quiet, and minutes later a new session opens on an EMPTY spot — five
    // consecutive misses, which is exactly the sustained absence that retires an
    // armed entry. It retires nothing, because there is no strike left to
    // confirm: the read that armed it decayed while nobody answered it.
    openSession()
    frame(slidOff, ARM_AT)
    const later = ARM_AT + 60_000
    for (let i = 0; i < 6; i++) frame(elsewhere, later + i * 200)
    expect(reg.count(102)).toBe(1)
    expect(reg.strikesFor(102)).toEqual([])
  })

  it('forgetDevice clears the armed set — a rebind never inherits half a departure', async () => {
    openSession()
    frame(slidOff, ARM_AT) // arm
    reg.forgetDevice(102)
    await reg.load()
    // Re-promote the same object; the stale strike must not retire it. The
    // rebind opens a fresh session, so the departing read below lands past its
    // warm-up and ARMS — with a brand-new `armedAt`, not the inherited one.
    await reg.promote(makeEntry({ id: 'car1', bbox: parked }))
    const rebind = ARM_AT + 60_000
    frame(parked, rebind)
    frame(slidOff, rebind + 3_000)
    expect(reg.count(102)).toBe(1)
    expect(reg.strikesFor(102)).toEqual([
      { entryId: 'car1', armedAt: rebind + 3_000, absentReads: 0 },
    ])
  })
})

// ── 2026-08-15 (D174): a confirmed entry FOLLOWS its object ──────────────────
describe('StationaryObjectRegistry re-anchoring', () => {
  let world: FakeRecords
  let reg: StationaryObjectRegistry

  beforeEach(async () => {
    world = makeAnalyticsRecordsNow()
    reg = new StationaryObjectRegistry({ records: world.records, logger: createNoopLogger() })
    await reg.promote(makeEntry({ id: 'car1', bbox: { x: 100, y: 100, w: 80, h: 60 } }))
  })

  it('an UNAMBIGUOUS confirmation re-anchors the reference box to the observed one', () => {
    const observed = { x: 108, y: 104, w: 80, h: 60 }
    reg.applyFrameOutcome({
      deviceId: 102,
      confirmed: [
        {
          entryId: 'car1',
          className: 'vehicle',
          bbox: { x: 100, y: 100, w: 80, h: 60 },
          observedBbox: observed,
          strong: true,
        },
      ],
      woken: [],
      timestamp: 50_000,
    })
    expect(reg.list(102)[0]!.bbox).toEqual(observed)
  })

  it('a WEAK (jitter) confirmation advances the clock but leaves the box alone', () => {
    reg.applyFrameOutcome({
      deviceId: 102,
      confirmed: [
        {
          entryId: 'car1',
          className: 'vehicle',
          bbox: { x: 100, y: 100, w: 80, h: 60 },
          observedBbox: { x: 110, y: 110, w: 50, h: 40 },
          strong: false,
        },
      ],
      woken: [],
      timestamp: 50_000,
    })
    expect(reg.list(102)[0]!.bbox).toEqual({ x: 100, y: 100, w: 80, h: 60 })
    expect(reg.list(102)[0]!.lastConfirmedAt).toBe(50_000)
  })

  it('drift that would have escaped the FROZEN box is absorbed by the anchor that follows', () => {
    // Eight unambiguous confirmations, each 8px further right. Against a frozen
    // box the object's centroid ends up 64px away — outside it — and the entry
    // would be armed then retired. Against an anchor that follows, every frame
    // is a plain confirmation and the entry never even arms.
    let box = { x: 100, y: 100, w: 80, h: 60 }
    for (let i = 0; i < 8; i++) {
      box = { ...box, x: box.x + 8 }
      const res = reg.filter({
        deviceId: 102,
        detections: [{ bbox: box, className: 'vehicle' }],
        frameWidth: 1920,
        frameHeight: 1080,
        timestamp: 50_000 + i,
      })
      expect(reg.strikesFor(102)).toEqual([])
      expect(res.woken).toEqual([])
      reg.applyFrameOutcome({
        deviceId: 102,
        confirmed: res.confirmed,
        woken: res.woken,
        timestamp: 50_000 + i,
      })
    }
    expect(reg.count(102)).toBe(1)
    expect(reg.list(102)[0]!.bbox.x).toBe(164)
  })
})

describe('StationaryObjectRegistry — a dropped detection is counted, never logged per frame (D275)', () => {
  interface CapturedLine {
    readonly message: string
    readonly extras?: LogExtras
  }

  function makeCapturingLogger(into: CapturedLine[]): IScopedLogger {
    const logger: IScopedLogger = {
      debug: () => undefined,
      info: (message, extras) => {
        into.push(extras === undefined ? { message } : { message, extras })
      },
      warn: () => undefined,
      error: () => undefined,
      child: () => logger,
      withTags: () => logger,
    }
    return logger
  }

  it('rolls every suppressed detection into ONE line per device per sweep, tagged with the device', async () => {
    const world = makeAnalyticsRecordsNow()
    const lines: CapturedLine[] = []
    const reg = new StationaryObjectRegistry({
      records: world.records,
      logger: makeCapturingLogger(lines),
    })
    await reg.promote(makeEntry({ id: 'car1' }))
    reg.noteFrame(102, 10_000)

    // Ten frames, two boxes on the parked car each: 20 dropped detections, of
    // which 10 are the reach pass. Not one line while it happens.
    for (let i = 0; i < 10; i++) {
      const res = reg.filter({
        deviceId: 102,
        detections: [
          { bbox: { x: 100, y: 100, w: 80, h: 60 }, className: 'vehicle' },
          { bbox: { x: 106, y: 103, w: 78, h: 58 }, className: 'vehicle' },
        ],
        frameWidth: 1920,
        frameHeight: 1080,
        timestamp: 10_000 + i,
      })
      expect(res.suppressedIndices.size).toBe(2)
      reg.applyFrameOutcome({
        deviceId: 102,
        confirmed: res.confirmed,
        woken: res.woken,
        timestamp: 10_000 + i,
      })
    }
    expect(lines.filter((l) => l.message === 'stationary registry absorbed detections')).toEqual([])

    await reg.sweep(20_000)
    const absorbed = lines.filter((l) => l.message === 'stationary registry absorbed detections')
    expect(absorbed).toHaveLength(1)
    expect(absorbed[0]!.extras?.tags).toEqual({ deviceId: 102 })
    expect(absorbed[0]!.extras?.meta).toMatchObject({
      deviceId: 102,
      suppressed: 20,
      reach: 10,
      entries: 1,
    })

    // And the counters reset — the next sweep reports the next window, not a
    // running total that only ever grows.
    await reg.sweep(30_000)
    expect(
      lines.filter((l) => l.message === 'stationary registry absorbed detections'),
    ).toHaveLength(1)
  })

  it('the sweep line separates the weak holds handed on as continuable, and how many continued a track (D410)', async () => {
    const world = makeAnalyticsRecordsNow()
    const lines: CapturedLine[] = []
    const reg = new StationaryObjectRegistry({
      records: world.records,
      logger: makeCapturingLogger(lines),
    })
    await reg.promote(makeEntry({ id: 'car1' }))
    reg.noteFrame(102, 10_000)

    // Five frames: the parked car's own box (strong) and a half-height read of
    // it (IoU 0.55, centroid inside — weak). Both suppressed; only the weak one
    // is continuable.
    for (let i = 0; i < 5; i++) {
      const res = reg.filter({
        deviceId: 102,
        detections: [
          { bbox: { x: 100, y: 100, w: 80, h: 60 }, className: 'vehicle' },
          { bbox: { x: 100, y: 100, w: 80, h: 33 }, className: 'vehicle' },
        ],
        frameWidth: 1920,
        frameHeight: 1080,
        timestamp: 10_000 + i,
      })
      expect(res.suppressedIndices.size).toBe(2)
      expect([...res.continuableIndices]).toEqual([1])
    }
    // The tracker reports back how many of those actually continued a track.
    reg.noteContinued(102, 3)
    await reg.sweep(20_000)
    const absorbed = lines.filter((l) => l.message === 'stationary registry absorbed detections')
    expect(absorbed).toHaveLength(1)
    expect(absorbed[0]!.extras?.meta).toMatchObject({
      deviceId: 102,
      suppressed: 10,
      continuable: 5,
      continued: 3,
      reach: 5,
    })
  })

  it('rolls the departure-strike lifecycle into ONE line per device per sweep (D279)', async () => {
    const world = makeAnalyticsRecordsNow()
    const lines: CapturedLine[] = []
    const reg = new StationaryObjectRegistry({
      records: world.records,
      logger: makeCapturingLogger(lines),
    })
    await reg.promote(makeEntry({ id: 'car1', bbox: { x: 100, y: 100, w: 80, h: 60 } }))

    const run = (bbox: { x: number; y: number; w: number; h: number }, at: number) => {
      const res = reg.filter({
        deviceId: 102,
        detections: [{ bbox, className: 'vehicle' }],
        frameWidth: 1920,
        frameHeight: 1080,
        timestamp: at,
      })
      reg.noteFrame(102, at)
      reg.applyFrameOutcome({
        deviceId: 102,
        confirmed: res.confirmed,
        woken: res.woken,
        timestamp: at,
      })
    }
    const parked = { x: 100, y: 100, w: 80, h: 60 }
    const slidOff = { x: 150, y: 100, w: 80, h: 60 }

    // Session opens; a departing read inside the WARM-UP is refused, then four
    // arm/cancel cycles past it. The entry is never retired, and none of the
    // eight decisions produces a line of its own — this fires on the frame path.
    run(slidOff, 200_000)
    for (let i = 0; i < 4; i++) {
      run(slidOff, 203_000 + i * 400)
      run(parked, 203_200 + i * 400)
    }
    expect(reg.count(102)).toBe(1)
    expect(lines.filter((l) => l.message === 'stationary departure strikes')).toEqual([])

    await reg.sweep(210_000)
    const strikeLines = lines.filter((l) => l.message === 'stationary departure strikes')
    expect(strikeLines).toHaveLength(1)
    expect(strikeLines[0]!.extras?.tags).toEqual({ deviceId: 102 })
    expect(strikeLines[0]!.extras?.meta).toMatchObject({
      deviceId: 102,
      armed: 4,
      cancelled: 4,
      warmUpIgnored: 1,
      wokenByRead: 0,
      wokenByAbsence: 0,
      pending: 0,
    })

    // And the window resets: a sweep over a quiet interval says nothing.
    await reg.sweep(215_000)
    expect(lines.filter((l) => l.message === 'stationary departure strikes')).toHaveLength(1)
  })
})
