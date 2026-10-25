/**
 * Governor-paced package promotion — raw-box sightings, zone-crop min area,
 * person overlap, and episode drop logging.
 */

import type { Zone, ZoneRule } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createNoopLogger } from '../../../../embedding-encoder/shared/noop-logger.js'
import { PACKAGE_DROP_DEFAULTS } from '../../../package-settings.js'
import {
  deliveredIdempotencyKey,
  PACKAGE_EVENT_CLASS,
  PackageDropDetector,
  type PackageObjectEventClient,
} from '../../package-drop-detector.js'
import { nextPackageLookDropEpisodes } from '../package-look-drop-log.js'
import {
  type PackageLookRawKept,
  type PackageLookTrackedPackage,
  packageLookSightings,
} from '../package-look-sightings.js'
import { packageReferenceArea } from '../package-reference-area.js'
import { PACKAGE_STILLNESS_TTL_MS, PackageStillnessTracker } from '../package-stillness-tracker.js'
import type { StationaryBbox } from '../../stationary/stationary-types.js'

const DEVICE = 101
const FRAME_W = 3840
const FRAME_H = 2160
const MIN_FRAC = PACKAGE_DROP_DEFAULTS.packageDropMinBboxAreaFrac

const USICIO_ZONE = {
  id: 'uscio',
  polygon: [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 0, y: 0.5 },
  ],
} as const

/** 126×124 px — under 0.004 of 4K full frame, above 0.004 of the half-frame crop. */
const PARCEL_BOX: StationaryBbox = { x: 200, y: 300, w: 126, h: 124 }

const PORCH_ZONE: Zone = {
  id: 'porch',
  name: 'Porch',
  kind: 'polygon',
  polygon: USICIO_ZONE.polygon.map((p) => ({ ...p })),
  color: '#fff',
}

const PACKAGE_RULE: ZoneRule = {
  id: 'pkg-rule-1',
  zoneIds: ['porch'],
  mode: 'include',
  enabled: true,
}

function makeTracker(ids: string[] = []): PackageStillnessTracker {
  let n = 0
  return new PackageStillnessTracker({
    newId: () => ids[n] ?? `cand-${(n += 1)}`,
  })
}

function refForUscio() {
  return packageReferenceArea({
    zones: [USICIO_ZONE],
    packageZoneIds: new Set(['uscio']),
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
  })
}

interface LookOver {
  readonly rawKept?: readonly PackageLookRawKept[]
  readonly personBoxes?: readonly StationaryBbox[]
  readonly trackedPackages?: readonly PackageLookTrackedPackage[]
  readonly looked?: boolean
}

function sightingsForLook(over: LookOver = {}) {
  const ref = refForUscio()
  return packageLookSightings({
    looked: over.looked ?? true,
    rawKept: over.rawKept ?? [{ bbox: PARCEL_BOX, score: 0.88 }],
    trackedPackages: over.trackedPackages ?? [],
    personBoxes: over.personBoxes ?? [],
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    referenceAreaPx: ref.areaPx,
    referenceKind: ref.kind,
    minAreaFrac: MIN_FRAC,
    maxAreaFrac: PACKAGE_DROP_DEFAULTS.packageDropMaxBboxAreaFrac,
  })
}

function observeLook(tracker: PackageStillnessTracker, timestamp: number, over: LookOver = {}) {
  const { sightings, drops } = sightingsForLook(over)
  const rawPackageBoxes =
    over.rawKept?.map((r) => r.bbox) ?? (over.looked === false ? [] : [PARCEL_BOX])
  return {
    drops,
    outcome: tracker.observe({
      deviceId: DEVICE,
      sightings,
      frameWidth: FRAME_W,
      frameHeight: FRAME_H,
      timestamp,
      minDwellMs: 0,
      minHits: 3,
      activityWindowMs: 300_000,
      lastActivityAt: -60_000,
      looked: over.looked ?? true,
      rawPackageBoxes,
      occluders: over.personBoxes ?? [],
    }),
  }
}

describe('governor-paced promotion from raw boxes', () => {
  it('three looks at 3s and 5s gaps promote and deliver when the min area uses the zone crop', async () => {
    const ref = refForUscio()
    expect(ref.kind).toBe('zone-crop')
    const fullFrac = (PARCEL_BOX.w * PARCEL_BOX.h) / (FRAME_W * FRAME_H)
    const cropFrac = (PARCEL_BOX.w * PARCEL_BOX.h) / ref.areaPx
    expect(fullFrac).toBeLessThan(MIN_FRAC)
    expect(cropFrac).toBeGreaterThanOrEqual(MIN_FRAC)

    const tracker = makeTracker(['entry-gov'])
    observeLook(tracker, 0)
    observeLook(tracker, 3_000)
    const { outcome } = observeLook(tracker, 8_000)
    expect(outcome.promoted).toHaveLength(1)

    const entry = outcome.promoted[0]
    if (entry === undefined) throw new Error('expected a promoted parcel')

    const events: PackageObjectEventClient = {
      insertObject: async () => 1,
      queryObject: async () => [],
    }
    const captured: { delivered: unknown[] } = { delivered: [] }
    const detector = new PackageDropDetector({
      events,
      emit: {
        delivered: (p) => captured.delivered.push(p),
        pickedUp: () => {},
      },
      logger: createNoopLogger(),
      resolveZones: async () => [PORCH_ZONE],
      resolvePackageRules: async () => [PACKAGE_RULE],
      resolveSettings: async () => ({
        ...PACKAGE_DROP_DEFAULTS,
        packageDropEnabled: true,
        packageDropClassFilter: [PACKAGE_EVENT_CLASS],
      }),
      resolveZoneMembershipMinOverlap: async () => 0,
    })
    await detector.onStationaryChange({
      phase: 'appeared',
      entry,
      timestamp: entry.becameStationaryAt,
    })
    expect(captured.delivered).toHaveLength(1)
    expect(deliveredIdempotencyKey(entry.id)).toBe('pa-pkg-entry-gov-delivered')
  })
})

describe('person overlap blocks opening', () => {
  const personCover: StationaryBbox = { x: PARCEL_BOX.x, y: PARCEL_BOX.y, w: PARCEL_BOX.w, h: 40 }

  it('does not open while a person covers the box, then promotes after they leave', () => {
    const tracker = makeTracker()
    for (const at of [0, 3_000, 6_000]) {
      observeLook(tracker, at, { personBoxes: [personCover] })
    }
    expect(tracker.debugCandidateCount(DEVICE)).toBe(0)

    observeLook(tracker, 10_000, { personBoxes: [] })
    observeLook(tracker, 13_000, { personBoxes: [] })
    const { outcome } = observeLook(tracker, 18_000, { personBoxes: [] })
    expect(outcome.promoted).toHaveLength(1)
  })
})

describe('below-area-floor and TTL expiry', () => {
  it('drops under the zone-crop floor, expires a one-hit candidate, and episodes announce once', () => {
    const tiny: StationaryBbox = { x: 10, y: 10, w: 4, h: 4 }
    const floorTracker = makeTracker()
    const { drops, outcome: first } = observeLook(floorTracker, 0, {
      rawKept: [{ bbox: tiny, score: 0.5 }],
    })
    expect(drops.some((d) => d.reason === 'below-area-floor')).toBe(true)
    expect(first.promoted).toHaveLength(0)

    const tracker = makeTracker()
    const oneHit = observeLook(tracker, 0).outcome
    expect(oneHit.promoted).toHaveLength(0)
    expect(tracker.debugCandidateCount(DEVICE)).toBe(1)

    const expired = tracker.observe({
      deviceId: DEVICE,
      sightings: [],
      frameWidth: FRAME_W,
      frameHeight: FRAME_H,
      timestamp: PACKAGE_STILLNESS_TTL_MS + 1,
      minDwellMs: 0,
      minHits: 3,
      activityWindowMs: 300_000,
      lastActivityAt: -60_000,
      looked: true,
      rawPackageBoxes: [],
      occluders: [],
    })
    expect(expired.expired).toHaveLength(1)
    expect(expired.expired[0]?.hits).toBe(1)

    const drop = {
      reason: 'below-area-floor' as const,
      bbox: tiny,
      areaFrac: 0.001,
      referenceKind: 'zone-crop' as const,
    }
    const streak1 = nextPackageLookDropEpisodes(new Set(), [drop])
    expect(streak1.announce).toHaveLength(1)
    const streak2 = nextPackageLookDropEpisodes(streak1.next, [drop])
    expect(streak2.announce).toHaveLength(0)
    const cleared = nextPackageLookDropEpisodes(streak2.next, [])
    expect(cleared.next.size).toBe(0)
    const again = nextPackageLookDropEpisodes(cleared.next, [drop])
    expect(again.announce).toHaveLength(1)
  })
})

describe('IoU enrichment on a looked frame', () => {
  it('emits one sighting and copies trackId from the matching tracked box', () => {
    const { sightings } = sightingsForLook({
      trackedPackages: [
        {
          className: 'package',
          bbox: { ...PARCEL_BOX },
          trackId: 'trk-99',
          confidence: 0.91,
        },
      ],
    })
    expect(sightings).toHaveLength(1)
    expect(sightings[0]?.trackId).toBe('trk-99')
    expect(sightings[0]?.confidence).toBe(0.91)
  })
})

describe('between looks', () => {
  it('rejects a tracked box over the full-frame ceiling and keeps a parcel-sized one', () => {
    const wedge: StationaryBbox = { x: 100, y: 100, w: 800, h: 900 }
    const { sightings, drops } = sightingsForLook({
      looked: false,
      rawKept: [],
      trackedPackages: [
        { className: 'package', bbox: wedge, trackId: 'wedge' },
        { className: 'package', bbox: PARCEL_BOX, trackId: 'parcel' },
      ],
    })
    expect(drops.map((d) => d.reason)).toEqual(['above-area-ceiling'])
    expect(sightings).toHaveLength(1)
    expect(sightings[0]?.trackId).toBe('parcel')
  })
})

describe('packageReferenceArea', () => {
  it('uses the full frame when zones are empty', () => {
    const r = packageReferenceArea({
      zones: [],
      packageZoneIds: new Set(['ghost']),
      frameWidth: FRAME_W,
      frameHeight: FRAME_H,
    })
    expect(r.kind).toBe('frame')
    expect(r.areaPx).toBe(FRAME_W * FRAME_H)
  })

  it('returns half-frame crop area for a 0.5×0.5 polygon', () => {
    const r = packageReferenceArea({
      zones: [USICIO_ZONE],
      packageZoneIds: new Set(['uscio']),
      frameWidth: FRAME_W,
      frameHeight: FRAME_H,
    })
    expect(r.kind).toBe('zone-crop')
    expect(r.areaPx).toBeCloseTo(0.25 * FRAME_W * FRAME_H, 0)
  })

  it('accepts a full-frame polygon as frame-sized reference', () => {
    const full = {
      id: 'all',
      polygon: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
    }
    const r = packageReferenceArea({
      zones: [full],
      packageZoneIds: new Set(['all']),
      frameWidth: FRAME_W,
      frameHeight: FRAME_H,
    })
    expect(r.areaPx).toBe(FRAME_W * FRAME_H)
  })
})
