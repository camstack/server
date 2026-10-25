/**
 * The three post-analysis counters, asserted through the REAL production
 * objects — the capture-crop factory, the capture scheduler and the
 * person-over-vehicle predicate — not through their fakes.
 *
 * A green suite is not proof: each of these was run once with the implementing
 * line reverted and confirmed RED before being kept (D277 § Enforcement).
 */
import { describe, expect, it, vi } from 'vitest'
import type { FrameHandle, IScopedLogger } from '@camstack/types'
import { createCaptureCrop } from '../pipeline/capture-crop.js'
import { personOverVehicle } from '../pipeline/person-over-vehicle.js'
import { CaptureScheduler } from '../runtime/capture-scheduler.js'
import {
  AnalyticsFailureReport,
  FAMILY_CAPTURE_SCHEDULE,
  FAMILY_ENRICHMENT_CROP,
  FAMILY_PERSON_BIRTH,
  FAMILY_PLATE_OCR,
  REASON_EMPTY_READ,
  REASON_NATIVE_MISS,
  REASON_PERSON_OVER_VEHICLE,
  REASON_QUEUE_OVERFLOW,
} from '../runtime/failure-report.js'

const logger: IScopedLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: (): IScopedLogger => logger,
  withTags: (): IScopedLogger => logger,
}

const handle: FrameHandle = {
  shmId: 'shm-1',
  slot: 0,
  seq: 2,
  width: 1920,
  height: 1080,
  format: 'rgb',
  pts: 1,
  byteLength: 10,
  nodeId: 'hub',
  slotCount: 4,
}

const BBOX = { x: 100, y: 100, w: 200, h: 200 }

function report(): AnalyticsFailureReport {
  let clock = 1_700_000_000_000
  return new AnalyticsFailureReport(() => (clock += 1))
}

function entry(
  failure: AnalyticsFailureReport,
  deviceId: number,
  family: string,
): { attempts: number; succeeded: number; reasons: Record<string, number> } | undefined {
  const sample = failure.list().find((s) => s.deviceId === deviceId && s.family === family)
  if (sample === undefined) return undefined
  const reasons: Record<string, number> = {}
  for (const r of sample.reasons) reasons[r.reason] = r.count
  return { attempts: sample.attempts, succeeded: sample.succeeded, reasons }
}

describe('enrichment-crop counter', () => {
  it('counts a native miss against the RIGHT camera, and a hit as its denominator', async () => {
    const failure = report()
    // `tryNativeCrop` answers a miss for 102 and a hit for 101 — the exact
    // asymmetry the operator asks about ("why is 102 worse than 101?").
    const captureCrop = createCaptureCrop({
      tryNativeCrop: async (_h, _b, _w) => null,
      bumpCropMetric: () => {},
      noteCropOutcome: (deviceId, reason) => failure.noteEnrichmentCrop(deviceId, reason),
      logger,
    })
    const landing = createCaptureCrop({
      tryNativeCrop: async () => Buffer.from([1, 2, 3]),
      bumpCropMetric: () => {},
      noteCropOutcome: (deviceId, reason) => failure.noteEnrichmentCrop(deviceId, reason),
      logger,
    })

    await captureCrop(handle, BBOX, 1920, 1080, 0.1, undefined, 102)
    await captureCrop(handle, BBOX, 1920, 1080, 0.1, undefined, 102)
    await landing(handle, BBOX, 1920, 1080, 0.1, undefined, 102)
    await landing(handle, BBOX, 1920, 1080, 0.1, undefined, 101)

    expect(entry(failure, 102, FAMILY_ENRICHMENT_CROP)).toEqual({
      attempts: 3,
      succeeded: 1,
      reasons: { [REASON_NATIVE_MISS]: 2 },
    })
    // 101 has the same family and a clean record — proof the two cameras are
    // not sharing a bucket.
    expect(entry(failure, 101, FAMILY_ENRICHMENT_CROP)).toEqual({
      attempts: 1,
      succeeded: 1,
      reasons: {},
    })
  })

  it('emits NOTHING per attempt at frame rate', async () => {
    const failure = report()
    const lines: string[] = []
    const recording: IScopedLogger = {
      debug: (m: string) => lines.push(m),
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
      child: (): IScopedLogger => recording,
      withTags: (): IScopedLogger => recording,
    }
    const captureCrop = createCaptureCrop({
      tryNativeCrop: async () => Buffer.from([1]),
      bumpCropMetric: () => {},
      noteCropOutcome: (deviceId, reason) => failure.noteEnrichmentCrop(deviceId, reason),
      logger: recording,
    })
    for (let i = 0; i < 500; i += 1) {
      await captureCrop(handle, BBOX, 1920, 1080, 0.1, undefined, 102)
    }
    // 507 misses in five minutes was the measured peak; a line each would be
    // its own defect. The counter is the whole record of the successful path.
    expect(lines).toEqual([])
    expect(entry(failure, 102, FAMILY_ENRICHMENT_CROP)?.attempts).toBe(500)
  })
})

describe('capture-schedule counter', () => {
  it('counts a shed capture per camera, with the started ones as its denominator', async () => {
    const failure = report()
    const scheduler = new CaptureScheduler({
      logger,
      maxInFlightPerDevice: 1,
      maxQueuedPerDevice: 1,
      onDropped: (drop) =>
        failure.noteCaptureSchedule(
          drop.deviceId,
          drop.cause === 'stale' ? 'stale-drop' : REASON_QUEUE_OVERFLOW,
        ),
      onStarted: (deviceId) => failure.noteCaptureSchedule(deviceId),
    })

    // One in flight (never settles), one queued, two shed past the cap.
    let releaseFirst: () => void = () => {}
    const blocked = new Promise<null>((resolve) => {
      releaseFirst = () => resolve(null)
    })
    const inFlight = scheduler.request({
      deviceId: 102,
      kind: 'embed',
      exec: () => blocked,
    })
    const queued = [
      scheduler.request({ deviceId: 102, kind: 'embed', exec: async () => null }),
      scheduler.request({ deviceId: 102, kind: 'embed', exec: async () => null }),
      scheduler.request({ deviceId: 102, kind: 'embed', exec: async () => null }),
    ]

    const shed = entry(failure, 102, FAMILY_CAPTURE_SCHEDULE)
    expect(shed?.reasons[REASON_QUEUE_OVERFLOW]).toBe(2)
    // The first request STARTED — that is the denominator, and without it
    // "2 shed" is a number that moves with traffic instead of with saturation.
    expect(shed?.succeeded).toBe(1)
    expect(shed?.attempts).toBe(3)

    releaseFirst()
    await Promise.all([inFlight, ...queued])
  })
})

describe('plate-ocr counter', () => {
  it('gives an empty read a reason and a denominator', () => {
    const failure = report()
    // The branch the detail router used to fall through silently.
    failure.notePlateRead(102, REASON_EMPTY_READ)
    failure.notePlateRead(102)
    failure.notePlateRead(102)

    expect(entry(failure, 102, FAMILY_PLATE_OCR)).toEqual({
      attempts: 3,
      succeeded: 2,
      reasons: { [REASON_EMPTY_READ]: 1 },
    })
  })
})

describe('person-over-vehicle', () => {
  it('counts a person born inside a car box, and does NOT count a passer-by', () => {
    const car = { className: 'car', bbox: { x: 0, y: 0, w: 400, h: 300 } }
    const inside = { x: 100, y: 100, w: 60, h: 150 }
    const passingBy = { x: 370, y: 100, w: 60, h: 150 }

    expect(personOverVehicle(inside, [car])).not.toBeNull()
    // Half a person box over a car is a pedestrian, not a phantom — counting it
    // would make the number mean "somebody was near a car".
    expect(personOverVehicle(passingBy, [car])).toBeNull()
    // A non-vehicle neighbour never qualifies, whatever the overlap.
    expect(personOverVehicle(inside, [{ className: 'person', bbox: car.bbox }])).toBeNull()
  })

  it('reports the rate, not the suppression', () => {
    const failure = report()
    const car = { className: 'car', bbox: { x: 0, y: 0, w: 400, h: 300 } }
    const births = [
      { x: 100, y: 100, w: 60, h: 150 },
      { x: 120, y: 90, w: 60, h: 150 },
      { x: 900, y: 100, w: 60, h: 150 },
      { x: 950, y: 120, w: 60, h: 150 },
    ]
    for (const bbox of births) {
      const overlap = personOverVehicle(bbox, [car])
      failure.notePersonBirth(102, overlap === null ? undefined : REASON_PERSON_OVER_VEHICLE)
    }

    // 2 of 4 — the shape of the hand-count that motivated this (4 of 23).
    expect(entry(failure, 102, FAMILY_PERSON_BIRTH)).toEqual({
      attempts: 4,
      succeeded: 2,
      reasons: { [REASON_PERSON_OVER_VEHICLE]: 2 },
    })
  })
})
