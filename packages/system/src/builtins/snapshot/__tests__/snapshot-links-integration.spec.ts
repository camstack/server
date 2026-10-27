/**
 * `snapshot.getSnapshotLinks` — the demand signal a client cache cannot swallow.
 *
 * ## What these cover that nothing else could
 *
 * D93 made an image REQUEST the demand signal for a camera, and made the image
 * URL versioned by an identity the client reads from the cache-only
 * `getSnapshotOverview`. D94 and D95 each closed a different way for that
 * request not to happen. None of them could close the last one, because it is
 * not in our code at all: `expo-image` is URL-keyed and never revalidates, so a
 * URL the app painted in a previous session is served from disk with **no
 * network**. No request, no capture, and an overview that keeps reporting the
 * same frozen identity forever.
 *
 * Measured on the live hub before this change: reopening after two minutes idle
 * painted 15 of 16 tiles at **168 s old**, from cache, with zero HTTP requests.
 *
 * The first test below is that scenario, and it is the discriminating one:
 * delete the `awaitFreshEnough` call from `getSnapshotLinks` and it goes red,
 * because the only remaining way to get a fresh frame is a request the client
 * has no reason to make.
 *
 * Since 2026-08-11 this RPC is the ONLY thing that refreshes a snapshot. The
 * server-side keep-warm loop it used to share the job with is gone (operator
 * directive: on-demand, always), so "nobody asked" now means "nothing ran".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import {
  batteryCapability,
  snapshotCapability,
  type AddonContext,
  type BatteryStatus,
  type CapabilityDefinition,
  type DataPlaneHandler,
  type IScopedLogger,
  type InferProvider,
} from '@camstack/types'

import { SnapshotAddon } from '../snapshot.addon.js'
import { freshSnapshotDataDir } from './scratch-data-dir.js'

type ISnapshotProvider = InferProvider<typeof snapshotCapability>

const SLEEPING_BATTERY: BatteryStatus = {
  level: 96,
  charging: 'none',
  sleeping: true,
  lastUpdated: 1_700_000_000_000,
}

function makeLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

function makeReq(url: string): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = url
  return req
}

interface Recorded {
  statusCode: number
  headers: Record<string, unknown>
  body: Buffer | null
}

function makeRes(): { res: ServerResponse; recorded: Recorded } {
  const recorded: Recorded = { statusCode: 0, headers: {}, body: null }
  const res = new ServerResponse(makeReq('/'))
  res.assignSocket(new Socket())
  res.writeHead = ((code: number, hdrs?: Record<string, string | number | string[]>) => {
    recorded.statusCode = code
    if (hdrs) for (const [k, v] of Object.entries(hdrs)) recorded.headers[k] = v
    return res
  }) as typeof res.writeHead
  const chunks: Buffer[] = []
  res.end = ((chunk?: unknown): ServerResponse => {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk)
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    recorded.body = chunks.length > 0 ? Buffer.concat(chunks) : null
    return res
  }) as typeof res.end
  return { res, recorded }
}

interface Harness {
  readonly addon: SnapshotAddon
  /** The AUTHENTICATED plane (`/addon/snapshot/media`). */
  readonly mediaHandler: DataPlaneHandler
  /** The PUBLIC, signed plane (`/addon/snapshot/link`). */
  readonly linkHandler: DataPlaneHandler
  readonly captures: () => number
  readonly provider: ISnapshotProvider
  readonly planeAccess: Record<string, string>
  readonly logger: IScopedLogger
}

async function makeHarness(
  opts: {
    readonly isBattery?: boolean
    readonly batterySlice?: BatteryStatus | null
    readonly captureDelayMs?: number | ((deviceId: number) => number)
  } = {},
): Promise<Harness> {
  let captures = 0
  const handlers: Record<string, DataPlaneHandler> = {}
  const planeAccess: Record<string, string> = {}
  // The addon store must actually PERSIST — the link signing secret is minted
  // once and read back, and a store that forgets would mint a new secret per
  // call and make every link unverifiable.
  const addonStore: Record<string, unknown> = {}

  const resize = async (bytes: Buffer, width: number): Promise<Buffer> =>
    Buffer.from(`resized-${String(width)}-${String(bytes.length)}`)

  const native = {
    getSnapshot: vi.fn(async (input: { deviceId: number }) => {
      const delay =
        typeof opts.captureDelayMs === 'function'
          ? opts.captureDelayMs(input.deviceId)
          : (opts.captureDelayMs ?? 0)
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
      }
      captures += 1
      return {
        base64: Buffer.from(`frame-${String(captures)}`).toString('base64'),
        contentType: 'image/jpeg',
      }
    }),
    invalidateCache: vi.fn(async () => undefined),
  }

  const seeded = opts.batterySlice ?? undefined
  let sliceValue: BatteryStatus | undefined
  const batteryHandle = {
    get value() {
      return sliceValue
    },
    refresh: async () => {
      sliceValue = seeded
    },
    subscribe: (cb: (s: BatteryStatus | undefined) => void) => {
      sliceValue = seeded
      cb(sliceValue)
      return () => undefined
    },
  }

  const logger = makeLogger()
  const ctx = {
    id: 'snapshot',
    logger,
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir: freshSnapshotDataDir(),
    kernel: { localNodeId: 'hub', devices: {} as never },
    dataPlane: {
      serve: vi.fn(async (args: { prefix: string; access: string; handler: DataPlaneHandler }) => {
        handlers[args.prefix] = args.handler
        planeAccess[args.prefix] = args.access
        return { dispose: async () => undefined }
      }),
    },
    settings: {
      readAddonStore: vi.fn(async () => ({ ...addonStore })),
      writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(addonStore, patch)
      }),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
    api: {
      deviceManager: {
        getDevice: {
          query: vi.fn(async ({ deviceId }: { deviceId: number }) => ({
            id: deviceId,
            name: 'test-cam',
            features: opts.isBattery === true ? ['battery-operated'] : [],
          })),
        },
      },
      deviceState: {
        getCapSlice: {
          query: vi.fn(async () => {
            await batteryHandle.refresh()
            return batteryHandle.value
          }),
        },
      },
      pipelineOrchestrator: {
        getIngestOwner: { query: vi.fn(async () => ({ ownerNodeId: 'hub' })) },
      },
      streamBroker: {
        getAllRtspEntries: { query: vi.fn(async () => []) },
        listAllProfileSlots: { query: vi.fn(async () => []) },
      },
    } as never,
    getNativeProvider: vi.fn((cap: CapabilityDefinition) =>
      cap.name === snapshotCapability.name
        ? native
        : cap.name === batteryCapability.name
          ? null
          : null,
    ),
    fetchDevice: vi.fn(async () => ({ deviceId: 1, state: { battery: batteryHandle } })),
  } as unknown as AddonContext

  const addon = new SnapshotAddon(resize)
  const registered = await addon.initialize(ctx)
  const registrations = (
    Array.isArray(registered) ? registered : (registered?.providers ?? [])
  ) as ReadonlyArray<{ readonly provider: ISnapshotProvider }>
  const provider = registrations[0]?.provider
  if (provider === undefined) throw new Error('no snapshot provider registered')
  const mediaHandler = handlers['media']
  const linkHandler = handlers['link']
  if (mediaHandler === undefined) throw new Error('media plane was never served')
  if (linkHandler === undefined) throw new Error('link plane was never served')
  return {
    addon,
    mediaHandler,
    linkHandler,
    captures: () => captures,
    provider,
    planeAccess,
    logger,
  }
}

async function get(handler: DataPlaneHandler, url: string): Promise<Recorded> {
  const { res, recorded } = makeRes()
  await handler(makeReq(url), res)
  return recorded
}

/** The handler-relative part of a minted link (the plane prefix is stripped by
 *  the hub's reverse proxy before the handler ever sees it). */
function handlerPath(link: string): string {
  return link.replace('/addon/snapshot/link', '')
}

describe('getSnapshotLinks — demand that a client cache cannot swallow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('makes a COLD reopen current, where an overview poll leaves it stale', async () => {
    const h = await makeHarness()

    // ── Yesterday: the app was open, so the tile was requested and warmed.
    await get(h.mediaHandler, '/101.jpg?w=240')
    expect(h.captures()).toBe(1)

    // ── The app is closed. Nothing asks, so nothing captures: the cached frame
    //    just ages.
    await vi.advanceTimersByTimeAsync(240_000)
    const capturesWhileClosed = h.captures()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(h.captures()).toBe(capturesWhileClosed)

    // ── Today: the app reopens. Every tile is painted from the platform image
    //    cache, so NO request reaches us. The only thing that does is the
    //    app-wide overview poll — which is cache-only and renew-only by D93.
    const overview = await h.provider.getSnapshotOverview({ deviceIds: [101] })
    const staleIdentity = overview[0]?.lastCapturedAt ?? null
    expect(h.captures()).toBe(capturesWhileClosed) // it captured nothing...
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.captures()).toBe(capturesWhileClosed) // ...and enrolled nothing.

    // ── Now the same reopen through the links call. It cannot be answered by an
    //    image cache, so the demand lands, and it waits for what it triggered.
    const before = h.captures()
    const links = await h.provider.getSnapshotLinks({ targets: [{ deviceId: 101, width: 240 }] })
    expect(h.captures()).toBeGreaterThan(before)

    const row = links[0]
    expect(row?.deviceId).toBe(101)
    expect(row?.capturedAt).not.toBeNull()
    // The whole point: the identity handed to the client is the frame that was
    // just captured, not the one the cache was sitting on.
    expect(row?.capturedAt).not.toBe(staleIdentity)
    expect(row?.ageMs ?? Number.MAX_SAFE_INTEGER).toBeLessThan(1_000)
    expect(row?.neverCaptured).toBe(false)
    expect(row?.sleeping).toBe(false)

    // ── And then NOTHING happens on its own. The keep-warm loop was removed on
    //    2026-08-11 (operator directive: snapshots are on-demand, always). The
    //    client polls this same RPC every 5 s while it is showing tiles, so the
    //    demand that used to come from a server-side timer now comes from the
    //    surface that actually wants the frame — and when no surface wants one,
    //    the hub does no work at all.
    const afterMint = h.captures()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.captures()).toBe(afterMint)

    await h.addon.shutdown()
  })

  it('the minted link serves bytes, and a tampered one is refused', async () => {
    const h = await makeHarness()
    const [row] = await h.provider.getSnapshotLinks({ targets: [{ deviceId: 101, width: 240 }] })
    const url = row?.url
    expect(typeof url).toBe('string')
    if (typeof url !== 'string') throw new Error('no link minted')

    const ok = await get(h.linkHandler, handlerPath(url))
    expect(ok.statusCode).toBe(200)
    expect(ok.body?.length ?? 0).toBeGreaterThan(0)

    // Escalating the signed width to the full frame must not work.
    const escalated = await get(h.linkHandler, handlerPath(url).replace('w=240&', ''))
    expect(escalated.statusCode).toBe(404)
    // Nor may a link be replayed against another camera.
    const swapped = await get(h.linkHandler, handlerPath(url).replace('/101.jpg', '/102.jpg'))
    expect(swapped.statusCode).toBe(404)
    // Nor may an unsigned request reach the capture path at all.
    const unsigned = await get(h.linkHandler, '/101.jpg?w=240')
    expect(unsigned.statusCode).toBe(404)

    await h.addon.shutdown()
  })

  it('the link plane is PUBLIC and the media plane stays authenticated', async () => {
    // The authority on the link plane is the signature, not a session — that is
    // the whole reason a WebView `<img>` can use it. The pre-existing
    // authenticated plane must not have been loosened to get there.
    const h = await makeHarness()
    expect(h.planeAccess['link']).toBe('public')
    expect(h.planeAccess['media']).toBe('authenticated')
    await h.addon.shutdown()
  })

  it('a link over a sleeping battery camera is honest, and never wakes it', async () => {
    const h = await makeHarness({ isBattery: true, batterySlice: SLEEPING_BATTERY })
    const before = h.captures()
    const [row] = await h.provider.getSnapshotLinks({ targets: [{ deviceId: 640, width: 240 }] })

    // `force` is an OPERATOR signal. A tile appearing on screen is not one, so
    // the camera must stay asleep however stale its frame is.
    expect(h.captures()).toBe(before)
    expect(row?.sleeping).toBe(true)
    // It still gets a link: D94 — the request is what would trigger a capture,
    // so "no frame" can never be the reason to withhold the URL.
    expect(row?.url).not.toBeNull()
    expect(row?.neverCaptured).toBe(true)

    await h.addon.shutdown()
  })

  it('the width is snapped to the ladder, so tile sizes collapse onto one variant', async () => {
    const h = await makeHarness()
    const rows = await h.provider.getSnapshotLinks({
      targets: [
        { deviceId: 101, width: 181 },
        { deviceId: 102, width: 240 },
      ],
    })
    expect(rows[0]?.width).toBe(240)
    expect(rows[1]?.width).toBe(240)
    await h.addon.shutdown()
  })

  it('a device that has never captured still gets a link and says so', async () => {
    const h = await makeHarness()
    const [row] = await h.provider.getSnapshotLinks({ targets: [{ deviceId: 108 }] })
    expect(row?.url).not.toBeNull()
    expect(row?.width).toBeNull()
    // It captured on demand, so it is no longer "never" — the flag describes the
    // answer, and the answer is the one the wait produced.
    expect(row?.capturedAt).not.toBeNull()
    await h.addon.shutdown()
  })

  it('one slow camera never head-of-line blocks fast cameras in the same Viewer batch', async () => {
    const slowDeviceId = 715
    const h = await makeHarness({
      captureDelayMs: (deviceId) => (deviceId === slowDeviceId ? 4_000 : 100),
    })
    const targets = Array.from({ length: 16 }, (_, index) => ({
      deviceId: 700 + index,
      width: 240,
    }))

    const startedAt = Date.now()
    const firstPending = h.provider.getSnapshotLinks({ targets })
    // Let metadata reads arm the capture and batch timers, then cross only the
    // 750 ms batch budget — nowhere near the slow camera's 4 s capture.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(800)
    const first = await firstPending
    expect(Date.now() - startedAt).toBeLessThanOrEqual(800)
    expect(first.find((row) => row.deviceId === slowDeviceId)?.capturedAt).toBeNull()
    expect(
      first.filter((row) => row.deviceId !== slowDeviceId).every((row) => row.capturedAt !== null),
    ).toBe(true)

    // The slow work is not cancelled. Let it populate the shared cache, then
    // simulate the Viewer's next links poll.
    await vi.advanceTimersByTimeAsync(3_500)
    const second = await h.provider.getSnapshotLinks({ targets })
    expect(second).toHaveLength(targets.length)
    expect(second.every((row) => row.capturedAt !== null)).toBe(true)
    expect(second.every((row) => (row.ageMs ?? Number.MAX_SAFE_INTEGER) < 5_000)).toBe(true)

    await h.addon.shutdown()
  })

  it('the link mint gives up at ITS deadline on a cold cache, not at the 10 s cold wait', async () => {
    // Capture slower than the mint deadline but faster than the cold-path
    // wait: the mint must stop waiting at 2.5 s (its documented deadline) —
    // before this fix, Math.max(coldWaitMs, deadline) held it for 10 s.
    const h = await makeHarness({ captureDelayMs: 9_000 })

    const pending = h.provider.getSnapshotLinks({ targets: [{ deviceId: 801 }] })
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(800)
    await pending

    // Cross the mint deadline (total ~2.8 s), stay far from the 10 s cold wait.
    await vi.advanceTimersByTimeAsync(2_000)
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()

    expect(h.logger.debug).toHaveBeenCalledWith(
      'snapshot: link mint gave up waiting; serving the older frame',
      expect.anything(),
    )
    await h.addon.shutdown()
  })
})
