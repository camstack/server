/**
 * Device 617, 2026-11-12 — a large parked car must not be deleted because its
 * box contains a smaller parked car's centroid.
 *
 * Read off the hub that morning (track `e98qjvb0gz`, entry `bb6a1033`, zone
 * "Parcheggio papa'" at min overlap 0.5):
 *
 *   small car, outside the zone, already registered:
 *     x=2081.4 y=0 w=193.2 h=111.6     centroid (2178, 55.8)
 *   father's car, settled, ~0.34 of 3840×2160:
 *     x=720 y=51 w=1629 h=1728
 *
 * The large box contains that centroid and covers 0.54 of the small box — above
 * the swallow bar — so the registry treated them as one spot, deleted the large
 * row and held the later reads against the small entry. The zone then counted
 * 0 vehicles. The two are different objects: both rows survive, the large
 * detection is attributed by IoU to the large entry, and that entry takes no
 * departure strike across minutes of box jitter.
 */
import type { IScopedLogger, Zone } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'

import { makeAnalyticsRecordsNow, type FakeRecords } from '../../../__tests__/fake-records.js'
import { createNoopLogger } from '../../../../embedding-encoder/shared/noop-logger.js'
import { StationaryObjectRegistry } from '../stationary-registry.js'
import { computeStationaryEntryZones } from '../stationary-zones.js'
import {
  centroid,
  findParkedOccupant,
  iou,
  isOversizeBox,
  partitionDetectionsAgainstRegistry,
} from '../stationary-match.js'
import {
  DEFAULT_DEPARTURE_CONFIG,
  DEFAULT_MATCH_CONFIG,
  WAKE_ASSOC_IOU,
  type DepartureStrike,
  type StationaryBbox,
  type StationaryEntry,
} from '../stationary-types.js'

const DEVICE = 617
const FRAME_W = 3840
const FRAME_H = 2160
/** `bb6a1033`, live on 617 while the large car was deleted. */
const SMALL: StationaryBbox = { x: 2081.4, y: 0, w: 193.2, h: 111.6 }
/** Settled box of track `e98qjvb0gz` (area 0.339 of the frame). */
const FATHER: StationaryBbox = { x: 720, y: 51, w: 1629, h: 1728 }
/** Real jitter from the same track's settled tail. Each still contains the
 *  small car's centroid and stays oversize. */
const FATHER_JITTER: readonly StationaryBbox[] = [
  FATHER,
  { x: 721, y: 51, w: 1626, h: 1727 },
  { x: 720, y: 53, w: 1629, h: 1725 },
  { x: 719, y: 51, w: 1630, h: 1728 },
  { x: 723, y: 54, w: 1626, h: 1722 },
  { x: 720, y: 51, w: 1629, h: 1728 },
]
const PAPA: Zone = {
  id: '606116f4-c059-4dcd-896c-d143e45eebdb',
  name: "Parcheggio papa'",
  kind: 'polygon',
  polygon: [
    { x: 0.6, y: 0.872519490971279 },
    { x: 0.5617021276595745, y: 0.13975420418154685 },
    { x: 0.27872340425531916, y: 0.20774273594554266 },
    { x: 0.09787234042553192, y: 0.8385252250892812 },
  ],
  color: '#3b82f6',
}
const ZONE_MIN_OVERLAP = 0.5
/** Small car's `becameStationaryAt` from the live registry. */
const SMALL_PARKED_AT = 1_794_416_217_215
/** Track `e98qjvb0gz` firstSeen — the large car arrives later. */
const FATHER_SEEN_AT = 1_794_467_648_517
const SMALL_ID = 'bb6a1033'
const FATHER_ID = 'father-617'

interface CapturedLog {
  readonly message: string
  readonly deviceId: number | undefined
}

function capturingLogger(lines: CapturedLog[]): IScopedLogger {
  const base = createNoopLogger()
  const info: IScopedLogger['info'] = (message, extras) => {
    lines.push({ message, deviceId: extras?.tags?.deviceId })
  }
  return { ...base, info }
}

interface ParkedRow {
  readonly id: string
  readonly bbox: StationaryBbox
  readonly becameStationaryAt?: number
  readonly sourceTrackId?: string
}

function entry(over: ParkedRow): StationaryEntry {
  const at = over.becameStationaryAt ?? SMALL_PARKED_AT
  return {
    id: over.id,
    deviceId: DEVICE,
    className: 'vehicle',
    bbox: over.bbox,
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    firstSeenAt: at,
    becameStationaryAt: at,
    lastConfirmedAt: at,
    ...(over.sourceTrackId !== undefined ? { sourceTrackId: over.sourceTrackId } : {}),
  }
}

function coverageOfSmall(big: StationaryBbox): number {
  const x1 = Math.max(SMALL.x, big.x)
  const y1 = Math.max(SMALL.y, big.y)
  const x2 = Math.min(SMALL.x + SMALL.w, big.x + big.w)
  const y2 = Math.min(SMALL.y + SMALL.h, big.y + big.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  return inter / (SMALL.w * SMALL.h)
}

describe('617: a large parked car is not the small one whose centre it covers', () => {
  it('the measured boxes are the scene the rule is about', () => {
    const centre = centroid(SMALL)
    expect(centre.y).toBeGreaterThanOrEqual(FATHER.y)
    expect(centre.y).toBeLessThanOrEqual(FATHER.y + FATHER.h)
    expect(centre.x).toBeGreaterThanOrEqual(FATHER.x)
    expect(centre.x).toBeLessThanOrEqual(FATHER.x + FATHER.w)
    expect(isOversizeBox(FATHER, FRAME_W, FRAME_H)).toBe(true)
    expect(isOversizeBox(SMALL, FRAME_W, FRAME_H)).toBe(false)
    // Above the swallow bar, below the association floor: only centroid-inside
    // of the small box in the large one can call them one spot.
    expect(coverageOfSmall(FATHER)).toBeGreaterThanOrEqual(0.5)
    expect(iou(SMALL, FATHER)).toBeLessThan(WAKE_ASSOC_IOU)
    const smallZones = computeStationaryEntryZones(
      { bbox: SMALL, frameWidth: FRAME_W, frameHeight: FRAME_H },
      [PAPA],
      ZONE_MIN_OVERLAP,
    )
    const fatherZones = computeStationaryEntryZones(
      { bbox: FATHER, frameWidth: FRAME_W, frameHeight: FRAME_H },
      [PAPA],
      ZONE_MIN_OVERLAP,
    )
    expect(smallZones).toEqual([])
    expect(fatherZones).toEqual([PAPA.id])
  })

  it('does not hand the large box to the small entry by centroid', () => {
    const small = entry({ id: SMALL_ID, bbox: SMALL })
    expect(findParkedOccupant([small], 'vehicle', FATHER)).toBeUndefined()
    const res = partitionDetectionsAgainstRegistry({
      entries: [small],
      detections: [{ bbox: FATHER, className: 'vehicle' }],
      config: DEFAULT_MATCH_CONFIG,
      now: FATHER_SEEN_AT,
    })
    expect(res.suppressedIndices.size).toBe(0)
    expect(res.continuableIndices.size).toBe(0)
    expect(res.confirmed).toEqual([])
    expect(res.strikeChanges).toEqual([])
  })

  it('attributes a jittered large detection to the large entry, not the small one', () => {
    const small = entry({ id: SMALL_ID, bbox: SMALL })
    const father = entry({
      id: FATHER_ID,
      bbox: FATHER,
      becameStationaryAt: FATHER_SEEN_AT,
      sourceTrackId: 'e98qjvb0gz',
    })
    for (const [i, box] of FATHER_JITTER.entries()) {
      const now = FATHER_SEEN_AT + i * 1_000
      const res = partitionDetectionsAgainstRegistry({
        entries: [small, father],
        detections: [{ bbox: box, className: 'vehicle' }],
        config: DEFAULT_MATCH_CONFIG,
        now,
        departure: DEFAULT_DEPARTURE_CONFIG,
      })
      expect(res.confirmed.map((c) => c.entryId)).toEqual([FATHER_ID])
      expect(res.confirmed[0]?.strong).toBe(true)
      expect(res.continuableIndices.size).toBe(0)
      expect(res.suppressedIndices.has(0)).toBe(true)
      expect(res.strikeChanges.filter((s) => s.entryId === FATHER_ID)).toEqual([])
      expect(res.woken).toEqual([])
    }
  })
})

describe('617 registry: both parked cars survive and the large one stays counted', () => {
  let world: FakeRecords
  let lines: CapturedLog[]
  let reg: StationaryObjectRegistry

  beforeEach(() => {
    world = makeAnalyticsRecordsNow()
    lines = []
    reg = new StationaryObjectRegistry({
      records: world.records,
      logger: capturingLogger(lines),
    })
  })

  it('a later oversize promotion is born beside the small car, not absorbed', async () => {
    const small = await reg.promote(entry({ id: SMALL_ID, bbox: SMALL }))
    expect(small.outcome).toBe('born')
    const father = await reg.promote(
      entry({
        id: FATHER_ID,
        bbox: FATHER,
        becameStationaryAt: FATHER_SEEN_AT,
        sourceTrackId: 'e98qjvb0gz',
      }),
    )
    expect(father.outcome).toBe('born')
    expect(father.entry.id).toBe(FATHER_ID)
    expect(
      reg
        .list(DEVICE)
        .map((e) => e.id)
        .sort(),
    ).toEqual([FATHER_ID, SMALL_ID].sort())
    expect(lines.some((l) => l.message.includes('kept apart') && l.deviceId === DEVICE)).toBe(true)
  })

  it('minutes of jitter do not delete the large car or strike it as departed', async () => {
    // Raising the IoU thresholds is how a duplicate of the SAME box is forced
    // onto disk. It does not defeat the swallow: on the old rule the large
    // car is still absorbed here, and the count stays 1.
    await reg.promote(entry({ id: SMALL_ID, bbox: SMALL }), { suppressIou: 2, wakeAssocIou: 2 })
    await reg.promote(
      entry({
        id: FATHER_ID,
        bbox: FATHER,
        becameStationaryAt: FATHER_SEEN_AT,
        sourceTrackId: 'e98qjvb0gz',
      }),
      { suppressIou: 2, wakeAssocIou: 2 },
    )
    expect(reg.count(DEVICE)).toBe(2)

    for (const [i, box] of FATHER_JITTER.entries()) {
      const now = FATHER_SEEN_AT + i * 1_000
      const frame = reg.filter({
        deviceId: DEVICE,
        detections: [{ bbox: box, className: 'vehicle' }],
        frameWidth: FRAME_W,
        frameHeight: FRAME_H,
        timestamp: now,
      })
      expect(frame.confirmed.map((c) => c.entryId)).toEqual([FATHER_ID])
      expect(frame.confirmed[0]?.strong).toBe(true)
      expect(frame.continuableIndices.size).toBe(0)
      expect(frame.woken).toEqual([])
      expect(reg.strikesFor(DEVICE).map((s) => s.entryId)).not.toContain(FATHER_ID)
      reg.applyFrameOutcome({
        deviceId: DEVICE,
        confirmed: frame.confirmed,
        woken: frame.woken,
        timestamp: now,
      })
    }

    // A second session, minutes later — still the same two objects.
    const later = FATHER_SEEN_AT + 4 * 60_000
    const again = reg.filter({
      deviceId: DEVICE,
      detections: [{ bbox: FATHER_JITTER[2]!, className: 'vehicle' }],
      frameWidth: FRAME_W,
      frameHeight: FRAME_H,
      timestamp: later,
    })
    expect(again.confirmed.map((c) => c.entryId)).toEqual([FATHER_ID])
    expect(again.woken).toEqual([])
    expect(reg.strikesFor(DEVICE).map((s) => s.entryId)).not.toContain(FATHER_ID)
    reg.applyFrameOutcome({
      deviceId: DEVICE,
      confirmed: again.confirmed,
      woken: again.woken,
      timestamp: later,
    })

    reg.noteFrame(DEVICE, later)
    await reg.sweep(later)

    const rows = reg.list(DEVICE)
    expect(rows.map((e) => e.id).sort()).toEqual([FATHER_ID, SMALL_ID].sort())
    const father = rows.find((e) => e.id === FATHER_ID)
    if (father === undefined) throw new Error('father entry missing after sweep')
    expect(
      computeStationaryEntryZones(
        { bbox: father.bbox, frameWidth: FRAME_W, frameHeight: FRAME_H },
        [PAPA],
        ZONE_MIN_OVERLAP,
      ),
    ).toEqual([PAPA.id])
    expect(
      computeStationaryEntryZones(
        { bbox: SMALL, frameWidth: FRAME_W, frameHeight: FRAME_H },
        [PAPA],
        ZONE_MIN_OVERLAP,
      ),
    ).toEqual([])
    expect(lines.some((l) => l.message.includes('kept apart') && l.deviceId === DEVICE)).toBe(true)
  })
})

/**
 * Reviewer probe — a truck covering a small parked car, the small car's own
 * box missing that frame. The truck is 0.36 of the frame and contains the
 * parked box (0.05); their IoU is above {@link WAKE_ASSOC_IOU}, so pass 1
 * used to treat the truck as the entry's best read and wake it as departed
 * ~3 s later. The truck is a different object: the entry misses.
 */
const PROBE_SMALL: StationaryBbox = { x: 1500, y: 800, w: 700, h: 600 }
const PROBE_TRUCK: StationaryBbox = { x: 1000, y: 300, w: 2000, h: 1500 }
/** The probe's sample times: arm, hold, contradicting-read, and one more. */
const PROBE_READS_MS = [0, 1_000, 3_500, 6_000] as const

function frameFraction(box: StationaryBbox): number {
  return (box.w * box.h) / (FRAME_W * FRAME_H)
}

interface ProbeRead {
  readonly now: number
  readonly woken: number
  readonly reasons: readonly string[]
  readonly confirmed: number
  readonly suppressed: number
}

function boxContains(outer: StationaryBbox, inner: StationaryBbox): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

describe('a truck covering a small parked car is a miss, not a departure', () => {
  it('the probe boxes sit above the wake bar', () => {
    expect(frameFraction(PROBE_SMALL)).toBeCloseTo(0.05, 2)
    expect(frameFraction(PROBE_TRUCK)).toBeGreaterThanOrEqual(0.3)
    expect(isOversizeBox(PROBE_TRUCK, FRAME_W, FRAME_H)).toBe(true)
    expect(isOversizeBox(PROBE_SMALL, FRAME_W, FRAME_H)).toBe(false)
    expect(boxContains(PROBE_TRUCK, PROBE_SMALL)).toBe(true)
    expect(iou(PROBE_SMALL, PROBE_TRUCK)).toBeGreaterThanOrEqual(WAKE_ASSOC_IOU)
  })

  it('does not arm a strike or wake the small entry over several seconds', () => {
    const parked = entry({ id: 'small-parked', bbox: PROBE_SMALL, becameStationaryAt: 0 })
    let strikes = new Map<string, DepartureStrike>()
    const reads: ProbeRead[] = []
    for (const now of PROBE_READS_MS) {
      const res = partitionDetectionsAgainstRegistry({
        entries: [parked],
        detections: [{ bbox: PROBE_TRUCK, className: 'vehicle' }],
        config: DEFAULT_MATCH_CONFIG,
        now,
        departure: DEFAULT_DEPARTURE_CONFIG,
        strikes,
      })
      reads.push({
        now,
        woken: res.woken.length,
        reasons: res.strikeChanges.map((c) => c.reason),
        confirmed: res.confirmed.length,
        suppressed: res.suppressedIndices.size,
      })
      const next = new Map(strikes)
      for (const change of res.strikeChanges) {
        if (change.strike === null) next.delete(change.entryId)
        else next.set(change.entryId, change.strike)
      }
      strikes = next
    }
    expect(reads).toEqual([
      { now: 0, woken: 0, reasons: [], confirmed: 0, suppressed: 0 },
      { now: 1_000, woken: 0, reasons: [], confirmed: 0, suppressed: 0 },
      { now: 3_500, woken: 0, reasons: [], confirmed: 0, suppressed: 0 },
      { now: 6_000, woken: 0, reasons: [], confirmed: 0, suppressed: 0 },
    ])
  })
})
