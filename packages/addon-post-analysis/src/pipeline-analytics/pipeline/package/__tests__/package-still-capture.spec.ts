/**
 * A parcel the stillness path promoted from a raw look (no track, no key frame)
 * must reach the notification centre WITH a still — device 615 shipped
 * `dropped: ["still", "gif"]` for want of one.
 */
import type { FrameHandle, ObjectEvent } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createNoopLogger } from '../../../../embedding-encoder/shared/noop-logger.js'
import { PACKAGE_DROP_DEFAULTS } from '../../../package-settings.js'
import { PackageDropDetector, PACKAGE_EVENT_CLASS } from '../../package-drop-detector.js'
import type { StationaryEntry } from '../../stationary/stationary-types.js'
import { promoteWithStill, type PackageStillWriter } from '../package-still-capture.js'

const HANDLE: FrameHandle = {
  shmId: 'shm',
  slot: 0,
  seq: 1,
  width: 1920,
  height: 1080,
  format: 'jpeg',
  pts: 1,
  byteLength: 10,
  nodeId: 'hub',
  slotCount: 4,
}

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

interface Run {
  readonly rows: ObjectEvent[]
  readonly order: string[]
  readonly writes: Parameters<PackageStillWriter['putReplacing']>[0][]
  readonly warns: { message: string; meta: unknown }[]
  readonly detector: PackageDropDetector
  readonly logger: ReturnType<typeof createNoopLogger>
}

function makeRun(): Run {
  const rows: ObjectEvent[] = []
  const order: string[] = []
  const writes: Run['writes'] = []
  const warns: Run['warns'] = []
  const base = createNoopLogger()
  const logger = {
    ...base,
    warn: (message: string, extras?: { meta?: unknown }) => {
      warns.push({ message, meta: extras?.meta })
    },
  }
  const detector = new PackageDropDetector({
    events: {
      insertObject: async (ev) => {
        rows.push({ ...ev, id: rows.length + 1 })
        order.push('insert')
        return rows.length
      },
      queryObject: async () => rows,
    },
    emit: { delivered: () => order.push('delivered'), pickedUp: () => undefined },
    logger,
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
      { id: 'r', zoneIds: ['porch'], mode: 'include', enabled: true },
    ],
    resolveSettings: async () => ({ ...PACKAGE_DROP_DEFAULTS, packageDropEnabled: true }),
    resolveZoneMembershipMinOverlap: async () => 0,
  })
  return { rows, order, writes, warns, detector, logger }
}

const query = async () => ({
  jpegBytes: Uint8Array.from([0xff, 0xd8, 1, 2, 3]),
  width: 1920,
  height: 1080,
  tier: 'native' as const,
})

describe('promoteWithStill', () => {
  it('stores the look frame under track:<entry.id> BEFORE delivered, and the row names it', async () => {
    const run = makeRun()
    const writer: PackageStillWriter = {
      putReplacing: async (input) => {
        run.writes.push(input)
        run.order.push('media')
        return 77
      },
    }
    await promoteWithStill({
      entry: ENTRY,
      handle: HANDLE,
      timestamp: 30_000,
      query,
      writer,
      logger: run.logger,
      detector: run.detector,
    })
    expect(run.order).toEqual(['media', 'insert', 'delivered'])
    expect(run.writes[0]).toMatchObject({
      deviceId: 615,
      ownerKind: 'track',
      ownerId: 'uuid-entry',
      kind: 'keyFrame',
      subjectBox: { x: 400, y: 300, w: 200, h: 200, frameWidth: 1920, frameHeight: 1080 },
    })
    expect(run.rows[0]).toMatchObject({ trackId: 'uuid-entry', mediaId: 77 })
  })

  it('a failed write is said with its reason and the delivery still goes out', async () => {
    const run = makeRun()
    await promoteWithStill({
      entry: ENTRY,
      handle: HANDLE,
      timestamp: 30_000,
      query,
      writer: {
        putReplacing: async () => {
          throw new Error('disk full')
        },
      },
      logger: run.logger,
      detector: run.detector,
    })
    expect(run.rows).toHaveLength(1)
    expect(run.rows[0]?.mediaId).toBeUndefined()
    expect(run.warns[0]?.meta).toMatchObject({ reason: 'write-failed', error: 'disk full' })
  })

  it('no frame in hand is said as no-frame-handle, never silent', async () => {
    const run = makeRun()
    await promoteWithStill({
      entry: ENTRY,
      handle: null,
      timestamp: 30_000,
      query,
      writer: { putReplacing: async () => 1 },
      logger: run.logger,
      detector: run.detector,
    })
    expect(run.warns[0]?.meta).toMatchObject({ reason: 'no-frame-handle' })
    expect(run.rows).toHaveLength(1)
  })

  it('a low-resolution preview is refused by name, not stored as the still', async () => {
    const run = makeRun()
    await promoteWithStill({
      entry: ENTRY,
      handle: HANDLE,
      timestamp: 30_000,
      query: async () => ({ ...(await query()), tier: 'ram-fullframe' as const }),
      writer: { putReplacing: async () => 1 },
      logger: run.logger,
      detector: run.detector,
    })
    expect(run.warns[0]?.meta).toMatchObject({ reason: 'preview-only' })
    expect(run.rows[0]?.mediaId).toBeUndefined()
  })

  it('an entry that already has its key frame is untouched', async () => {
    const run = makeRun()
    let wrote = false
    await promoteWithStill({
      entry: { ...ENTRY, keyFrameMediaId: 5 },
      handle: HANDLE,
      timestamp: 30_000,
      query,
      writer: {
        putReplacing: async () => {
          wrote = true
          return 1
        },
      },
      logger: run.logger,
      detector: run.detector,
    })
    expect(wrote).toBe(false)
    expect(run.rows[0]?.mediaId).toBe(5)
  })
})
