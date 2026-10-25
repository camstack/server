import type { IScopedLogger, LogExtras } from '@camstack/types'
import sharp from 'sharp'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NC_STILL_WAIT_MS } from '../dispatcher.js'
import {
  NcLinkedStillShelf,
  type NcLinkedStillShelfDeps,
  SENSOR_LINKED_READ_BUDGET_MS,
} from '../linked-stills.js'
import { renderMosaic } from '../summary/mosaic-renderer.js'

// The real renderer, spied: one test makes it throw once.
vi.mock('../summary/mosaic-renderer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../summary/mosaic-renderer.js')>()
  return { ...actual, renderMosaic: vi.fn(actual.renderMosaic) }
})

interface LoggedLine {
  readonly msg: string
  readonly deviceId: number | undefined
}

/** A line with its level and meta, for tests that assert WHAT a line says. */
interface MetaLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly msg: string
  readonly deviceId: number | undefined
  readonly meta: Record<string, unknown> | undefined
}

interface SnapshotBytes {
  readonly base64: string
  readonly contentType: string
}

let grey: Buffer

beforeAll(async () => {
  grey = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#808080' } })
    .jpeg()
    .toBuffer()
})

function jpeg(): SnapshotBytes {
  return { base64: grey.toString('base64'), contentType: 'image/jpeg' }
}

function shelfWith(overrides: Partial<NcLinkedStillShelfDeps>): NcLinkedStillShelf {
  return new NcLinkedStillShelf({
    getSnapshot: async () => jpeg(),
    isOnline: () => true,
    logger: makeSilentLogger(),
    now: () => 1_000,
    ...overrides,
  })
}

function spyLogger(lines: LoggedLine[]): IScopedLogger {
  const record = (msg: string, extras?: LogExtras): void => {
    lines.push({ msg, deviceId: extras?.tags?.deviceId })
  }
  const logger: IScopedLogger = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function metaLogger(lines: MetaLine[]): IScopedLogger {
  const at =
    (level: MetaLine['level']) =>
    (msg: string, extras?: LogExtras): void => {
      lines.push({ level, msg, deviceId: extras?.tags?.deviceId, meta: extras?.meta })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined)
}

type Polled<T> = T | undefined | null | false

function isReady<T>(value: Polled<T>): value is T {
  if (value === undefined || value === null || value === false) return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

/** Poll `fn` every 5 ms for up to `ms` (2 s); resolve on a non-empty array / truthy value. */
async function until<T>(fn: () => Polled<T>, ms = 2_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = fn()
    if (isReady(value)) return value
    if (Date.now() > deadline) throw new Error('until: timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function widthOf(base64: string): Promise<number | undefined> {
  return (await sharp(Buffer.from(base64, 'base64')).metadata()).width
}

describe('NcLinkedStillShelf', () => {
  it('mints every owner id synchronously, before any capture lands', () => {
    const shelf = shelfWith({ getSnapshot: () => new Promise(() => undefined) })
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    expect(set.mosaicOwnerId.startsWith('nc-mosaic:')).toBe(true)
    expect(set.cameraOwnerIds).toHaveLength(2)
    expect(shelf.get(set.mosaicOwnerId)).toEqual([])
    expect(shelf.get(set.cameraOwnerIds[0]!)).toEqual([])
  })

  it('composes ONE mosaic from every landed camera and serves each camera its own still', async () => {
    const shelf = shelfWith({ getSnapshot: async () => jpeg() })
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId))
    expect(mosaic.map((f) => f.kind)).toEqual(['keyFrameSmall', 'keyFrame', 'fullFrame'])
    expect(mosaic[0]!.timestamp).toBe(1_000)
    expect(await widthOf(mosaic[0]!.base64)).toBeGreaterThan(64) // composed, not a single tile
    expect((await until(() => shelf.get(set.cameraOwnerIds[1]!))).length).toBe(3)
  })

  it('never dials a camera the directory calls offline, and says so on that camera', async () => {
    const dialled: number[] = []
    const lines: LoggedLine[] = []
    const shelf = shelfWith({
      isOnline: (id) => (id === 102 ? false : true),
      getSnapshot: async (id) => {
        dialled.push(id)
        return jpeg()
      },
      logger: spyLogger(lines),
    })
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    await until(() => shelf.get(set.mosaicOwnerId))
    expect(dialled).toEqual([101])
    expect(lines).toContainEqual({
      msg: 'linked camera excluded from the sensor notification',
      deviceId: 102,
    })
  })

  it('never ships a camera the wrapper calls sleeping — its bytes are a state card', async () => {
    // Controller ruling (fix round 2): the state read runs IN PARALLEL with the
    // capture, so 102 IS dialled; what matters is that its bytes never ship.
    const shelf = shelfWith({
      getSnapshotState: async (id) => ({ reason: id === 102 ? 'sleeping' : null }),
      getSnapshot: async () => jpeg(),
    })
    // Capture ONCE: a captureSet inside the poll would start a new set every 5 ms.
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId))
    expect(await widthOf(mosaic[0]!.base64)).toBe(64) // 101 alone, uncomposed
    expect(shelf.get(set.cameraOwnerIds[1]!)).toEqual([])
  })

  it('a FAILED state read does not exclude — the camera is dialled (D49)', async () => {
    const dialled: number[] = []
    const shelf = shelfWith({
      getSnapshotState: async () => {
        throw new Error('wrapper down')
      },
      getSnapshot: async (id) => {
        dialled.push(id)
        return jpeg()
      },
    })
    // Capture ONCE: a captureSet inside the poll would start a new set every 5 ms.
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    await until(() => shelf.get(set.mosaicOwnerId))
    expect(dialled).toEqual([101, 102])
  })

  it('drops a stale frame instead of showing it', async () => {
    const shelf = shelfWith({
      getSnapshot: async () => jpeg(),
      getFrameCapturedAt: async () =>
        new Map([
          [101, 1_000],
          [102, 1_000 - 60_000],
        ]),
    })
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId))
    // Only 101 survived: ONE tile ships as the plain still, uncomposed.
    expect(await widthOf(mosaic[0]!.base64)).toBe(64)
    expect(shelf.get(set.cameraOwnerIds[1]!)).toEqual([])
  })

  it('a FAILED freshness read keeps every tile (D49)', async () => {
    const shelf = shelfWith({
      getSnapshot: async () => jpeg(),
      getFrameCapturedAt: async () => {
        throw new Error('x')
      },
    })
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId))
    expect(await widthOf(mosaic[0]!.base64)).toBeGreaterThan(64)
  })

  it('zero tiles leaves the mosaic owner empty forever (text-only), and logs it on the sensor', async () => {
    const lines: LoggedLine[] = []
    const shelf = shelfWith({ getSnapshot: async () => null, logger: spyLogger(lines) })
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    await until(() =>
      lines.find((l) => l.msg.startsWith('sensor notification has no linked picture')),
    )
    expect(shelf.get(set.mosaicOwnerId)).toEqual([])
    expect(lines).toContainEqual({
      msg: 'sensor notification has no linked picture — it ships text-only',
      deviceId: 3243,
    })
  })

  it('never sets force (the snapshot dep takes only a device id)', () => {
    // Compile-time: NcLinkedStillShelfDeps.getSnapshot is (deviceId) => …; nothing to pass force through.
    expect(shelfWith({}).captureSet(1, [2, 3], 0).cameraIds).toEqual([2, 3])
  })
})

describe('NcLinkedStillShelf — bounded reads and undecodable bytes (fix round 1)', () => {
  it('the whole read budget fits under the dispatcher still-wait', () => {
    expect(SENSOR_LINKED_READ_BUDGET_MS).toBeLessThan(NC_STILL_WAIT_MS)
  })

  it('a state read that never settles is UNKNOWN — the camera is dialled and its line says so', async () => {
    const lines: MetaLine[] = []
    const dialled: number[] = []
    const shelf = shelfWith({
      getSnapshotState: () => never(),
      getSnapshot: async (id) => {
        dialled.push(id)
        return jpeg()
      },
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId), 4_000)
    expect(dialled).toEqual([101, 102])
    expect(await widthOf(mosaic[0]!.base64)).toBeGreaterThan(64)
    const line = lines.find((l) => l.deviceId === 102 && l.meta?.['outcome'] === 'landed')
    expect(line?.meta?.['stateUnknown']).toBe('timeout')
    expect(line?.level).toBe('info')
  }, 8_000)

  it('a freshness read that never settles keeps every tile and says `freshness unverified`', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getFrameCapturedAt: () => never(),
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId), 1_500)
    expect(await widthOf(mosaic[0]!.base64)).toBeGreaterThan(64)
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: 'linked pictures freshness unverified — keeping every tile',
        deviceId: 3243,
      }),
    )
  })

  it('a capture that never settles is a `timeout` on that camera, and the rest still ship', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshot: (id) => (id === 102 ? never() : Promise.resolve(jpeg())),
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    await until(
      () => lines.find((l) => l.msg.startsWith('sensor notification pictures ready')),
      4_000,
    )
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        deviceId: 102,
        meta: expect.objectContaining({ outcome: 'timeout' }),
      }),
    )
    const mosaic = shelf.get(set.mosaicOwnerId) ?? []
    expect(await widthOf(mosaic[0]!.base64)).toBe(64) // 101 alone, as the plain still
  }, 8_000)

  it('the exclusion line names its reason', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      isOnline: (id) => id !== 616,
      getSnapshotState: async (id) => ({ reason: id === 102 ? 'sleeping' : null }),
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101, 616, 102], 1_000)
    await until(() => shelf.get(set.mosaicOwnerId))
    const excluded = lines.filter(
      (l) => l.msg === 'linked camera excluded from the sensor notification',
    )
    expect(excluded.map((l) => [l.deviceId, l.meta?.['reason']])).toEqual([
      [616, 'offline'],
      [102, 'sleeping'],
    ])
  })

  it('undecodable bytes never ship — not as the still, not as the camera owner; the camera says `undecodable`', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshot: async (id) =>
        id === 102
          ? { base64: Buffer.from('not a jpeg').toString('base64'), contentType: 'image/jpeg' }
          : jpeg(),
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId))
    expect(await widthOf(mosaic[0]!.base64)).toBe(64) // 101 alone
    expect(shelf.get(set.cameraOwnerIds[1]!)).toEqual([])
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        deviceId: 102,
        meta: expect.objectContaining({ outcome: 'error', reason: 'undecodable' }),
      }),
    )
  })

  it('a single undecodable camera ships text-only, logged on the sensor', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshot: async () => ({
        base64: Buffer.from('not a jpeg').toString('base64'),
        contentType: 'image/jpeg',
      }),
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [102], 1_000)
    await until(() =>
      lines.find((l) => l.msg.startsWith('sensor notification has no linked picture')),
    )
    expect(shelf.get(set.mosaicOwnerId)).toEqual([])
    expect(shelf.get(set.cameraOwnerIds[0]!)).toEqual([])
  })

  it('a camera owner serves the SAME minted still on every read', async () => {
    const shelf = shelfWith({})
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    const first = await until(() => shelf.get(set.cameraOwnerIds[0]!))
    expect(shelf.get(set.cameraOwnerIds[0]!)).toBe(first)
  })
})

describe('NcLinkedStillShelf — state read in parallel with the capture (fix round 2)', () => {
  it('dials the camera while the state read is still in flight', async () => {
    let stateSettled = false
    const dialledWhilePending: boolean[] = []
    const shelf = shelfWith({
      getSnapshotState: () =>
        new Promise((r) =>
          setTimeout(() => {
            stateSettled = true
            r({ reason: null })
          }, 50),
        ),
      getSnapshot: async () => {
        dialledWhilePending.push(!stateSettled)
        return jpeg()
      },
    })
    const set = shelf.captureSet(3243, [101], 1_000)
    await until(() => shelf.get(set.mosaicOwnerId))
    expect(dialledWhilePending).toEqual([true])
  })

  it('a SLOW state read that answers a blocking reason still excludes (bounded by the capture, not 200 ms)', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshotState: (id) =>
        new Promise((r) => setTimeout(() => r({ reason: id === 102 ? 'disabled' : null }), 600)),
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId))
    expect(await widthOf(mosaic[0]!.base64)).toBe(64)
    expect(shelf.get(set.cameraOwnerIds[1]!)).toEqual([])
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: 'linked camera excluded from the sensor notification',
        deviceId: 102,
        meta: expect.objectContaining({ reason: 'disabled' }),
      }),
    )
  })

  it('a state read that THROWS keeps the tile and says stateUnknown: error', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshotState: async () => {
        throw new Error('wrapper down')
      },
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101], 1_000)
    await until(() => shelf.get(set.mosaicOwnerId))
    const line = lines.find((l) => l.deviceId === 101 && l.meta?.['outcome'] === 'landed')
    expect(line?.meta?.['stateUnknown']).toBe('error')
  })

  it('a state read that answers NOTHING keeps the tile and says stateUnknown: empty', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({ getSnapshotState: async () => undefined, logger: metaLogger(lines) })
    const set = shelf.captureSet(3243, [101], 1_000)
    await until(() => shelf.get(set.mosaicOwnerId))
    const line = lines.find((l) => l.deviceId === 101 && l.meta?.['outcome'] === 'landed')
    expect(line?.meta?.['stateUnknown']).toBe('empty')
  })

  it('a freshness read inside 400 ms is honoured (a 300 ms answer still drops the stale tile)', async () => {
    const shelf = shelfWith({
      getFrameCapturedAt: () =>
        new Promise((r) =>
          setTimeout(
            () =>
              r(
                new Map([
                  [101, 1_000],
                  [102, 1_000 - 60_000],
                ]),
              ),
            300,
          ),
        ),
    })
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId))
    expect(await widthOf(mosaic[0]!.base64)).toBe(64)
  })

  it('a compose failure over probe-verified tiles ships the FIRST camera, not text-only', async () => {
    const lines: MetaLine[] = []
    vi.mocked(renderMosaic).mockRejectedValueOnce(new Error('canvas failed'))
    const shelf = shelfWith({ logger: metaLogger(lines) })
    const set = shelf.captureSet(3243, [101, 102], 1_000)
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId))
    expect(await widthOf(mosaic[0]!.base64)).toBe(64)
    expect(shelf.get(set.cameraOwnerIds[1]!)?.length).toBe(3)
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: 'sensor mosaic could not be composed — shipping the first camera',
        deviceId: 3243,
      }),
    )
  })
})
