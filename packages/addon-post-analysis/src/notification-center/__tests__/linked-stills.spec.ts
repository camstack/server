import type { IScopedLogger, LogExtras } from '@camstack/types'
import sharp from 'sharp'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NC_STILL_WAIT_MS } from '../dispatcher.js'
import {
  NC_LINKED_WAKE_CAPTURE_TIMEOUT_MS,
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
  grey = await sharp({
    create: { width: 64, height: 36, channels: 3, background: '#808080' },
  })
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
      lines.push({
        level,
        msg,
        deviceId: extras?.tags?.deviceId,
        meta: extras?.meta,
      })
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
    const shelf = shelfWith({
      getSnapshot: () => new Promise(() => undefined),
    })
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
      getSnapshotState: async (id) => ({
        reason: id === 102 ? 'sleeping' : null,
      }),
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
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId), 6_000)
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
    const shelf = shelfWith({
      getSnapshot: async () => null,
      logger: spyLogger(lines),
    })
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

  it('force is used only for a sleeping camera whose set allows a wake — never an awake, unreachable, disabled or offline one', async () => {
    const calls: Array<[number, boolean]> = []
    const shelf = shelfWith({
      isOnline: (id) => id !== 105,
      getSnapshotState: async (id) => ({
        reason:
          id === 102 ? 'sleeping' : id === 103 ? 'unreachable' : id === 104 ? 'disabled' : null,
      }),
      getSnapshot: async (id, opts) => {
        calls.push([id, opts?.force === true])
        return jpeg()
      },
    })
    const set = shelf.captureSet(3243, [101, 102, 103, 104, 105], 1_000, {
      wakeSleeping: true,
    })
    await until(() => shelf.get(set.mosaicOwnerId))
    expect(calls.filter(([, forced]) => forced)).toEqual([[102, true]])
    expect(calls.map(([id]) => id).includes(105)).toBe(false)
  })
})

describe('NcLinkedStillShelf — waking a sleeping battery camera (D998)', () => {
  const sleepingState = async (): Promise<{ reason: 'sleeping' }> => ({
    reason: 'sleeping',
  })

  it('a sleeping camera is woken once under the wake bound, logged, and its still ships', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshotState: sleepingState,
      getSnapshot: async () => jpeg(),
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101], 1_000, {
      wakeSleeping: true,
      ruleIds: ['r1'],
    })
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId))
    expect(await widthOf(mosaic[0]!.base64)).toBe(64)
    const line = lines.find(
      (l) => l.msg === 'linked battery camera woken for the sensor notification',
    )
    expect(line?.level).toBe('info')
    expect(line?.deviceId).toBe(101)
    expect(line?.meta).toMatchObject({
      sensorId: 3243,
      ruleIds: ['r1'],
      boundMs: NC_LINKED_WAKE_CAPTURE_TIMEOUT_MS,
    })
  })

  it('not allowed: excluded as wake-skipped:policy and never forced', async () => {
    const lines: MetaLine[] = []
    const forced: number[] = []
    const shelf = shelfWith({
      getSnapshotState: sleepingState,
      getSnapshot: async (id, opts) => {
        if (opts?.force === true) forced.push(id)
        return jpeg()
      },
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101], 1_000, { wakeSleeping: false })
    await until(() => lines.find((l) => l.msg.startsWith('sensor notification has no linked')))
    expect(forced).toEqual([])
    expect(shelf.get(set.mosaicOwnerId)).toEqual([])
    expect(
      lines.find((l) => l.deviceId === 101 && l.meta?.['outcome'] === 'excluded')?.meta,
    ).toMatchObject({
      reason: 'wake-skipped:policy',
    })
  })

  it('a second set within the gap does not wake again: wake-skipped:recent-wake', async () => {
    const lines: MetaLine[] = []
    let t = 1_000
    const forced: number[] = []
    const shelf = shelfWith({
      now: () => t,
      getSnapshotState: sleepingState,
      getSnapshot: async (id, opts) => {
        if (opts?.force === true) forced.push(id)
        return jpeg()
      },
      logger: metaLogger(lines),
    })
    const first = shelf.captureSet(3243, [101], t, { wakeSleeping: true })
    await until(() => shelf.get(first.mosaicOwnerId))
    t += 30_000
    const second = shelf.captureSet(3243, [101], t, { wakeSleeping: true })
    await until(() => lines.find((l) => l.meta?.['reason'] === 'wake-skipped:recent-wake'))
    expect(forced).toEqual([101])
    expect(shelf.get(second.mosaicOwnerId)).toEqual([])
    t += 31_000
    const third = shelf.captureSet(3243, [101], t, { wakeSleeping: true })
    await until(() => shelf.get(third.mosaicOwnerId))
    expect(forced).toEqual([101, 101])
  })

  it('a forced capture that never answers is wake-timeout at the bound', async () => {
    vi.useFakeTimers()
    try {
      const lines: MetaLine[] = []
      const shelf = shelfWith({
        getSnapshotState: sleepingState,
        getSnapshot: (_id, opts) => (opts?.force === true ? never() : Promise.resolve(null)),
        logger: metaLogger(lines),
      })
      shelf.captureSet(3243, [101], 1_000, { wakeSleeping: true })
      await vi.advanceTimersByTimeAsync(NC_LINKED_WAKE_CAPTURE_TIMEOUT_MS - 1_000)
      expect(lines.find((l) => l.meta?.['outcome'] === 'wake-timeout')).toBeUndefined()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(
        lines.find((l) => l.deviceId === 101 && l.meta?.['outcome'] === 'wake-timeout'),
      ).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a refused wake (nothing back) is wake-refused', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshotState: sleepingState,
      getSnapshot: async () => null,
      logger: metaLogger(lines),
    })
    shelf.captureSet(3243, [101], 1_000, { wakeSleeping: true })
    await until(() => lines.find((l) => l.meta?.['outcome'] === 'wake-refused'))
  })

  it('a waking camera is never forced; it is re-polled until the wrapper lets it through', async () => {
    let reads = 0
    const forced: number[] = []
    const shelf = shelfWith({
      getSnapshotState: async () => ({ reason: ++reads < 2 ? 'waking' : null }),
      getSnapshot: async (id, opts) => {
        if (opts?.force === true) forced.push(id)
        return jpeg()
      },
    })
    const set = shelf.captureSet(3243, [101], 1_000, { wakeSleeping: true })
    await until(() => shelf.get(set.mosaicOwnerId), 4_000)
    expect(forced).toEqual([])
    expect(reads).toBeGreaterThanOrEqual(2)
  }, 8_000)

  it('pendingUntil is set only while a wake is in flight', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const shelf = shelfWith({
      getSnapshotState: sleepingState,
      getSnapshot: async (_id, opts) => {
        if (opts?.force === true) await gate
        return jpeg()
      },
    })
    const awake = shelfWith({ getSnapshot: async () => jpeg() })
    const awakeSet = awake.captureSet(3243, [101], 1_000, {
      wakeSleeping: true,
    })
    expect(awake.pendingUntil(awakeSet.mosaicOwnerId)).toBeUndefined()
    const set = shelf.captureSet(3243, [101], 1_000, { wakeSleeping: true })
    await until(() => shelf.pendingUntil(set.mosaicOwnerId) ?? false)
    expect(shelf.pendingUntil(set.cameraOwnerIds[0]!)).toBe(
      1_000 + NC_LINKED_WAKE_CAPTURE_TIMEOUT_MS + 1_000,
    )
    expect(shelf.pendingUntil('nc-linked:unknown')).toBeUndefined()
    release?.()
    await until(() => shelf.get(set.mosaicOwnerId))
    expect(shelf.pendingUntil(set.mosaicOwnerId)).toBeUndefined()
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
      getSnapshotState: async (id) => ({
        reason: id === 102 ? 'sleeping' : null,
      }),
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101, 616, 102], 1_000, {
      wakeSleeping: false,
    })
    await until(() => shelf.get(set.mosaicOwnerId))
    const excluded = lines.filter(
      (l) => l.msg === 'linked camera excluded from the sensor notification',
    )
    expect(excluded.map((l) => [l.deviceId, l.meta?.['reason']])).toEqual([
      [616, 'offline'],
      [102, 'wake-skipped:policy'],
    ])
  })

  it('undecodable bytes never ship — not as the still, not as the camera owner; the camera says `undecodable`', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshot: async (id) =>
        id === 102
          ? {
              base64: Buffer.from('not a jpeg').toString('base64'),
              contentType: 'image/jpeg',
            }
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
        meta: expect.objectContaining({
          outcome: 'error',
          reason: 'undecodable',
        }),
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
    const shelf = shelfWith({
      getSnapshotState: async () => undefined,
      logger: metaLogger(lines),
    })
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
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId), 6_000)
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

describe('NcLinkedStillShelf — a failed state read must not destroy the wake (D49, #382)', () => {
  const failingState = async (): Promise<never> => {
    throw new Error('getDebugState: no native provider implementing it')
  }

  it('state unknown + an EMPTY unforced capture on a battery camera → the D998 wake is taken', async () => {
    const forced: boolean[] = []
    const shelf = shelfWith({
      getSnapshotState: failingState,
      isBatteryCamera: async () => true,
      getSnapshot: async (_id, opts) => {
        forced.push(opts?.force === true)
        return opts?.force === true ? jpeg() : null
      },
    })
    const set = shelf.captureSet(3243, [101], 1_000, { wakeSleeping: true, ruleIds: ['r1'] })
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId))
    expect(await widthOf(mosaic[0]!.base64)).toBe(64)
    expect(forced).toEqual([false, true])
  })

  it('a camera that is NOT a battery camera is never woken on an unknown state', async () => {
    const forced: boolean[] = []
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshotState: failingState,
      isBatteryCamera: async () => false,
      getSnapshot: async (_id, opts) => {
        forced.push(opts?.force === true)
        return null
      },
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101], 1_000, { wakeSleeping: true })
    await until(() => lines.find((l) => l.msg.startsWith('sensor notification has no linked')))
    expect(forced).toEqual([false])
    expect(shelf.get(set.mosaicOwnerId)).toEqual([])
  })

  it('a rule that did not allow the wake never forces, battery or not', async () => {
    const forced: boolean[] = []
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshotState: failingState,
      isBatteryCamera: async () => true,
      getSnapshot: async (_id, opts) => {
        forced.push(opts?.force === true)
        return null
      },
      logger: metaLogger(lines),
    })
    shelf.captureSet(3243, [101], 1_000, { wakeSleeping: false })
    await until(() => lines.find((l) => l.msg.startsWith('sensor notification has no linked')))
    expect(forced).toEqual([false])
  })

  it('the failed state read names its error at warn, on the camera (D391)', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({ getSnapshotState: failingState, logger: metaLogger(lines) })
    const set = shelf.captureSet(3243, [101], 1_000)
    await until(() => shelf.get(set.mosaicOwnerId))
    const line = lines.find((l) => l.level === 'warn' && l.deviceId === 101)
    expect(line?.msg).toBe('linked camera snapshot state read failed — state unknown')
    expect(String(line?.meta?.['error'])).toContain('no native provider')
  })
})

describe('NcLinkedStillShelf — a stale tile is re-polled, not dropped (D60, kitchen)', () => {
  it('a frame older than the event on the first read is re-captured until it lands fresh', async () => {
    let reads = 0
    let captures = 0
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshot: async () => {
        captures += 1
        return jpeg()
      },
      getFrameCapturedAt: async () => {
        reads += 1
        // The wrapper settles a soft miss with its old hit once, then refreshes.
        return new Map([[101, reads === 1 ? 1_000 - 60_000 : 1_000]])
      },
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101], 1_000)
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId))
    expect(await widthOf(mosaic[0]!.base64)).toBe(64)
    expect(captures).toBe(2)
    expect(lines.find((l) => l.deviceId === 101 && l.meta?.['outcome'] === 'landed')).toBeDefined()
  })

  it('pendingUntil is open while the re-poll runs, so the dispatcher waits for it', async () => {
    const shelf = shelfWith({
      getFrameCapturedAt: async () => new Map([[101, 1_000 - 60_000]]),
    })
    const set = shelf.captureSet(3243, [101], 1_000)
    await until(() => shelf.pendingUntil(set.cameraOwnerIds[0]!) !== undefined)
    expect(shelf.pendingUntil(set.cameraOwnerIds[0]!)).toBeGreaterThan(1_000)
  })

  it('a frame that never freshens is dropped at the bound, as stale', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getFrameCapturedAt: async () => new Map([[101, 1_000 - 60_000]]),
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101], 1_000)
    await until(
      () => lines.find((l) => l.msg.startsWith('sensor notification has no linked')),
      6_000,
    )
    expect(shelf.get(set.mosaicOwnerId)).toEqual([])
    expect(lines.find((l) => l.meta?.['outcome'] === 'stale')).toBeDefined()
  })
})

describe('NcLinkedStillShelf — a battery camera that answered awake with no usable picture is woken', () => {
  const awake = async (): Promise<{ reason: null }> => ({ reason: null })
  const WOKEN = 'linked battery camera woken for the sensor notification'

  it('awake verdict + unforced TIMEOUT on a battery camera → one forced wake, tile lands', async () => {
    const calls: boolean[] = []
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshotState: awake,
      isBatteryCamera: async () => true,
      getSnapshot: (_id, opts) => {
        calls.push(opts?.force === true)
        return opts?.force === true ? Promise.resolve(jpeg()) : new Promise(() => undefined)
      },
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101], 1_000, { wakeSleeping: true })
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId), 6_000)
    expect(await widthOf(mosaic[0]!.base64)).toBe(64)
    expect(calls).toEqual([false, true])
    const why = lines.find((l) => l.msg.startsWith('linked battery camera answered awake'))
    expect(why?.deviceId).toBe(101)
    expect(why?.meta).toMatchObject({ sensorId: 3243, capture: 'timeout' })
  })

  it('awake verdict + a STALE frame on a battery camera → woken once, tile lands', async () => {
    const calls: boolean[] = []
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshotState: awake,
      isBatteryCamera: async () => true,
      getSnapshot: async (_id, opts) => {
        calls.push(opts?.force === true)
        return jpeg()
      },
      getFrameCapturedAt: async () => new Map([[101, 1_000 - 155_798]]),
      logger: metaLogger(lines),
    })
    const set = shelf.captureSet(3243, [101], 1_000, { wakeSleeping: true })
    const mosaic = await until(() => shelf.get(set.mosaicOwnerId))
    expect(await widthOf(mosaic[0]!.base64)).toBe(64)
    expect(calls).toEqual([false, true])
    const why = lines.find((l) => l.msg === 'linked battery camera frame is stale — waking it')
    expect(why?.meta).toMatchObject({ sensorId: 3243, capture: 'stale' })
    expect(lines.filter((l) => l.msg === WOKEN)).toHaveLength(1)
  })

  it('a MAINS camera with a stale frame is re-polled unforced, never forced', async () => {
    const calls: boolean[] = []
    let reads = 0
    const shelf = shelfWith({
      getSnapshotState: awake,
      isBatteryCamera: async () => false,
      getSnapshot: async (_id, opts) => {
        calls.push(opts?.force === true)
        return jpeg()
      },
      getFrameCapturedAt: async () => {
        reads += 1
        return new Map([[101, reads === 1 ? 1_000 - 60_000 : 1_000]])
      },
    })
    const set = shelf.captureSet(3243, [101], 1_000, { wakeSleeping: true })
    await until(() => shelf.get(set.mosaicOwnerId))
    expect(calls).toEqual([false, false])
  })

  it('wakeSleeping off → a battery camera is never forced, whatever the capture did', async () => {
    const calls: boolean[] = []
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshotState: awake,
      isBatteryCamera: async () => true,
      getSnapshot: async (_id, opts) => {
        calls.push(opts?.force === true)
        return null
      },
      logger: metaLogger(lines),
    })
    shelf.captureSet(3243, [101], 1_000, { wakeSleeping: false })
    await until(() => lines.find((l) => l.msg.startsWith('sensor notification has no linked')))
    expect(calls).toEqual([false])
  })

  it('a wake refused inside the min gap leaves the stale tile to the D60 re-poll', async () => {
    let t = 1_000
    let asleep = true
    let reads = 0
    const forced: number[] = []
    const shelf = shelfWith({
      now: () => t,
      isBatteryCamera: async () => true,
      getSnapshotState: async () => ({ reason: asleep ? 'sleeping' : null }),
      getSnapshot: async (id, opts) => {
        if (opts?.force === true) forced.push(id)
        return jpeg()
      },
      getFrameCapturedAt: async () => {
        reads += 1
        return new Map([[101, reads === 1 ? t - 60_000 : t]])
      },
    })
    const first = shelf.captureSet(3243, [101], t, { wakeSleeping: true })
    await until(() => shelf.get(first.mosaicOwnerId))
    t += 30_000
    asleep = false
    reads = 0
    const second = shelf.captureSet(3243, [101], t, { wakeSleeping: true })
    const mosaic = await until(() => shelf.get(second.mosaicOwnerId))
    expect(await widthOf(mosaic[0]!.base64)).toBe(64)
    expect(forced).toEqual([101])
  })

  it('a wake that brings nothing names its reason on the tile (D400)', async () => {
    const lines: MetaLine[] = []
    const shelf = shelfWith({
      getSnapshotState: awake,
      isBatteryCamera: async () => true,
      getSnapshot: async () => null,
      logger: metaLogger(lines),
    })
    shelf.captureSet(3243, [101], 1_000, { wakeSleeping: true })
    await until(() => lines.find((l) => l.msg.startsWith('sensor notification has no linked')))
    expect(
      lines.find((l) => l.deviceId === 101 && l.meta?.['outcome'] === 'wake-refused'),
    ).toBeDefined()
  })
})
