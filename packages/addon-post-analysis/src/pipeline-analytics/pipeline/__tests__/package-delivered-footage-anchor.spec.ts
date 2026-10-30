/**
 * The delivered row is dated when the vision confirm LANDED, not when the
 * parcel settled: the confirm's own seconds were spent out of a 16 s footage
 * window before the notification existed, and the gif shipped dropped
 * ("footage window expired while queued", device 615, 2026-10-30).
 */
import type { ObjectEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNoopLogger } from '../../../embedding-encoder/shared/noop-logger.js'
import { PACKAGE_DROP_DEFAULTS } from '../../package-settings.js'
import { PACKAGE_EVENT_CLASS, PackageDropDetector } from '../package-drop-detector.js'
import type { StationaryEntry } from '../stationary/stationary-types.js'

afterEach(() => {
  vi.useRealTimers()
})

const ENTRY: StationaryEntry = {
  id: 'uuid-entry',
  deviceId: 615,
  className: PACKAGE_EVENT_CLASS,
  bbox: { x: 400, y: 300, w: 200, h: 200 },
  frameWidth: 1920,
  frameHeight: 1080,
  firstSeenAt: 0,
  becameStationaryAt: 30_000,
  lastConfirmedAt: 30_000,
}

async function deliver(confirmWithLlm: boolean): Promise<{
  readonly row: ObjectEvent | undefined
  readonly emittedAt: number | undefined
}> {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const rows: ObjectEvent[] = []
  let emittedAt: number | undefined
  const detector = new PackageDropDetector({
    events: {
      insertObject: async (ev) => {
        rows.push({ ...ev, id: 1 })
        return 1
      },
      queryObject: async () => rows,
    },
    emit: {
      delivered: (p) => {
        emittedAt = p.timestamp
      },
      pickedUp: () => undefined,
    },
    logger: createNoopLogger(),
    resolveZones: async () => [
      {
        id: 'porch',
        name: 'Porch',
        kind: 'polygon',
        polygon: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        color: '#fff',
      },
    ],
    resolvePackageRules: async () => [
      { id: 'r', zoneIds: ['porch'], mode: 'include', enabled: true, confirmWithLlm },
    ],
    resolveSettings: async () => ({ ...PACKAGE_DROP_DEFAULTS, packageDropEnabled: true }),
    resolveZoneMembershipMinOverlap: async () => 0,
    confirmPackage: async () => {
      vi.setSystemTime(12_000)
      return { kind: 'yes', verdict: { package: true, confidence: 0.9, reason: 'box on mat' } }
    },
  })
  await detector.onStationaryChange({
    phase: 'appeared',
    entry: ENTRY,
    timestamp: ENTRY.becameStationaryAt,
  })
  return { row: rows[0], emittedAt }
}

describe('package delivered — footage anchor', () => {
  it('a 12 s confirm moves the row (and the emit) 12 s later, so the window is not spent', async () => {
    const { row, emittedAt } = await deliver(true)
    expect(row?.timestamp).toBe(42_000)
    expect(emittedAt).toBe(42_000)
  })

  it('no confirm asked: the row keeps the instant the parcel settled', async () => {
    const { row, emittedAt } = await deliver(false)
    expect(row?.timestamp).toBe(30_000)
    expect(emittedAt).toBe(30_000)
  })
})
