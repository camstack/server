/**
 * The tile a camera the hub CANNOT REACH answers with.
 *
 * ## The directive this closes (operator, 2026-08-20)
 *
 * "The viewer app should never manage these tiles — you can delete every line
 * of that code. The backend must provision the correct tile in every case."
 *
 * Until this file, `offline` was the one camera state the snapshot service did
 * not really own. A sleeping, waking, disabled or unreachable camera got the
 * whole treatment — the last real frame with its state painted over it, the
 * reason carried in `stateReason` so a surface can label it, the reason in the
 * ETag so a client refetches the moment the state changes. An OFFLINE camera
 * got a generated courtesy frame ONLY when there was nothing cached, and when
 * there WAS something cached it got the stale photograph, bare: no overlay, no
 * `stateReason`, no change of ETag. Nothing about that answer said the camera
 * was gone.
 *
 * That silence is what the client filled in, twice — a `holdLastFrame` branch
 * and a hand-drawn `WifiOff` chip, on top of a gate that refused to even ASK
 * for an offline camera. All of it existed because the server would not say.
 *
 * ## What is deliberately NOT here
 *
 * `offline` does not block the capture ladder, and there is a test below that
 * fails if it ever starts to. `disabled`/`sleeping`/`unreachable`/`waking` are
 * states where dialling cannot produce a better answer; `online: false` is a
 * VERDICT, reached by three consecutive control-plane misses
 * (`reachability-poll.ts`), and treating a verdict as a gate is how a wrong
 * flag becomes self-sealing. So the ladder still runs and a frame that lands
 * is served fresh and unlabelled — which is also this file's recovery test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import sharp from 'sharp'
import {
  batteryCapability,
  snapshotCapability,
  type AddonContext,
  type CapabilityDefinition,
  type DataPlaneHandler,
  type IScopedLogger,
  type InferProvider,
} from '@camstack/types'

import { SnapshotAddon } from '../snapshot.addon.js'
import { freshSnapshotDataDir } from './scratch-data-dir.js'

type ISnapshotProvider = InferProvider<typeof snapshotCapability>

interface SnapshotImage {
  readonly base64: string
  readonly contentType: string
}

/** One row of the links RPC, as the client reads it. */
interface LinkRow {
  readonly deviceId: number
  readonly url: string | null
  readonly capturedAt: number | null
  readonly ageMs: number | null
  readonly stateReason: string | null
  readonly sleeping: boolean
}

interface Recorded {
  status: number
  headers: Record<string, string>
}

const DEVICE_ID = 102

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

/** A real JPEG — the overlay composites actual pixels, so a fake byte string
 *  would exercise nothing but the error path. */
async function makeJpeg(background: string): Promise<SnapshotImage> {
  const bytes = await sharp({ create: { width: 320, height: 180, channels: 3, background } })
    .jpeg()
    .toBuffer()
  return { base64: bytes.toString('base64'), contentType: 'image/jpeg' }
}

function makeReq(url: string): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = url
  return req
}

function makeRes(): { res: ServerResponse; recorded: Recorded } {
  const recorded: Recorded = { status: 0, headers: {} }
  const res = new ServerResponse(makeReq('/'))
  res.writeHead = ((status: number, headers?: Record<string, string>) => {
    recorded.status = status
    Object.assign(recorded.headers, headers ?? {})
    return res
  }) as typeof res.writeHead
  res.end = ((): typeof res => res) as typeof res.end
  return { res, recorded }
}

interface Harness {
  readonly provider: ISnapshotProvider
  readonly mediaHandler: DataPlaneHandler
  /** Flip the hub's reachability verdict for the device. */
  setOnline: (online: boolean) => void
  /** What the native answers next — null makes every live path decline. */
  setFrame: (frame: SnapshotImage | null) => void
  readonly dials: () => number
  readonly logger: IScopedLogger
}

async function makeHarness(initialFrame: SnapshotImage): Promise<Harness> {
  const handlers: Record<string, DataPlaneHandler> = {}
  const addonStore: Record<string, unknown> = {}
  let online = true
  let frame: SnapshotImage | null = initialFrame
  let dials = 0

  const native = {
    getSnapshot: vi.fn(async () => {
      dials += 1
      if (frame === null) throw new Error('connect ECONNREFUSED')
      return frame
    }),
    invalidateCache: vi.fn(async () => undefined),
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
      serve: vi.fn(async (args: { prefix: string; handler: DataPlaneHandler }) => {
        handlers[args.prefix] = args.handler
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
            name: 'Garden',
            features: [],
            disabled: false,
            online,
          })),
        },
      },
      deviceState: { getCapSlice: { query: vi.fn(async () => null) } },
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
    fetchDevice: vi.fn(async () => ({ deviceId: DEVICE_ID, state: {} })),
  } as unknown as AddonContext

  const addon = new SnapshotAddon()
  const registered = await addon.initialize(ctx)
  const registrations = (
    Array.isArray(registered) ? registered : (registered?.providers ?? [])
  ) as ReadonlyArray<{ readonly provider: ISnapshotProvider }>
  const provider = registrations[0]?.provider
  if (provider === undefined) throw new Error('no snapshot provider registered')
  const mediaHandler = handlers['media']
  if (mediaHandler === undefined) throw new Error('media plane was never served')
  return {
    provider,
    mediaHandler,
    setOnline: (v: boolean) => {
      online = v
    },
    setFrame: (v: SnapshotImage | null) => {
      frame = v
    },
    dials: () => dials,
    logger,
  }
}

/** Links for one device, typed as the client reads them. */
async function linkRow(provider: ISnapshotProvider): Promise<LinkRow> {
  const rows = (await provider.getSnapshotLinks({
    targets: [{ deviceId: DEVICE_ID }],
  })) as readonly LinkRow[]
  const row = rows[0]
  if (row === undefined) throw new Error('no link row')
  return row
}

async function etagOf(handler: DataPlaneHandler, url: string): Promise<string> {
  const { res, recorded } = makeRes()
  await handler(makeReq(url), res)
  return recorded.headers['etag'] ?? ''
}

/**
 * The device-meta memo (10 s) and the per-device max-age (10 s for a mains
 * camera) both have to expire before the next call re-reads the world. Every
 * test that changes the world moves the clock past both.
 */
function moveClockPast(ms = 30_000): void {
  vi.setSystemTime(Date.now() + ms)
}

describe('an OFFLINE camera is a tile the server provisions, not a gap the client fills', () => {
  let live: SnapshotImage

  beforeEach(async () => {
    live = await makeJpeg('#2f6f3f')
  })

  it('serves the last good frame with the state painted over it — never the bare photograph', async () => {
    const h = await makeHarness(live)
    // A frame from when the camera was up.
    const captured = await h.provider.getSnapshot({ deviceId: DEVICE_ID })
    expect(captured?.base64).toBe(live.base64)

    // …and then the camera drops: the hub's reachability poller says so, and
    // every live path refuses.
    h.setOnline(false)
    h.setFrame(null)

    vi.useFakeTimers()
    try {
      moveClockPast()
      const served = await h.provider.getSnapshot({ deviceId: DEVICE_ID })
      expect(served).not.toBeNull()
      // Still a real JPEG at the frame's own size — the photograph is the
      // background, not the thing that was replaced.
      const meta = await sharp(Buffer.from(served?.base64 ?? '', 'base64')).metadata()
      expect(meta.width).toBe(320)
      expect(meta.height).toBe(180)
      // …but NOT the bare cached bytes. An unlabelled stale frame reads as live,
      // which is the whole reason the client grew a chip of its own.
      expect(served?.base64).not.toBe(live.base64)
    } finally {
      vi.useRealTimers()
    }
  })

  it('names the state and the age in the link row, so a surface can label it without guessing', async () => {
    const h = await makeHarness(live)
    await h.provider.getSnapshot({ deviceId: DEVICE_ID })

    h.setOnline(false)
    h.setFrame(null)

    vi.useFakeTimers()
    try {
      moveClockPast()
      const row = await linkRow(h.provider)
      expect(row.stateReason).toBe('offline')
      // The same shape sleeping has always carried: state PLUS the honest age
      // of the photograph behind it.
      expect(row.capturedAt).not.toBeNull()
      expect(row.ageMs ?? 0).toBeGreaterThan(0)
      expect(row.sleeping).toBe(false)
      // The link is still minted — there IS a tile to paint (D94).
      expect(row.url).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('changes the frame identity when the camera drops, so a client holding the live frame refetches', async () => {
    const h = await makeHarness(live)
    const url = `/${String(DEVICE_ID)}.jpg`
    const whileUp = await etagOf(h.mediaHandler, url)
    expect(whileUp).not.toBe('')

    h.setOnline(false)
    h.setFrame(null)

    vi.useFakeTimers()
    try {
      moveClockPast()
      const whileDown = await etagOf(h.mediaHandler, url)
      // Same capture, different answer: the tag has to describe what went out
      // or the client keeps painting the unlabelled frame forever.
      expect(whileDown).not.toBe(whileUp)
      expect(whileDown).toContain('offline')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still dials — an offline verdict is a fallback, never a gate', async () => {
    // Deliberately opposite to `disabled`/`sleeping`: those cannot produce a
    // better answer by dialling. `online:false` is a poller's verdict, and a
    // camera that is never probed can never be observed to come back.
    const h = await makeHarness(live)
    await h.provider.getSnapshot({ deviceId: DEVICE_ID })
    const before = h.dials()

    h.setOnline(false)
    h.setFrame(null)

    vi.useFakeTimers()
    try {
      moveClockPast()
      await h.provider.getSnapshot({ deviceId: DEVICE_ID })
      expect(h.dials()).toBeGreaterThan(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a recovered camera serve fresh frames again, with nothing left stuck to them', async () => {
    const h = await makeHarness(live)
    await h.provider.getSnapshot({ deviceId: DEVICE_ID })
    h.setOnline(false)
    h.setFrame(null)

    vi.useFakeTimers()
    try {
      moveClockPast()
      await h.provider.getSnapshot({ deviceId: DEVICE_ID })

      // The camera comes back: the poller flips the verdict and the native
      // answers again.
      const back = await makeJpeg('#7a3fa0')
      h.setOnline(true)
      h.setFrame(back)
      moveClockPast()

      const served = await h.provider.getSnapshot({ deviceId: DEVICE_ID })
      // Exactly the new capture — no overlay, no leftover treatment.
      expect(served?.base64).toBe(back.base64)
      const row = await linkRow(h.provider)
      expect(row.stateReason).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers a camera that has never captured with the generated state frame, not a 404', async () => {
    const h = await makeHarness(live)
    h.setOnline(false)
    h.setFrame(null)
    const served = await h.provider.getSnapshot({ deviceId: DEVICE_ID })
    expect(served).not.toBeNull()
    expect(served?.contentType).toBe('image/jpeg')
  })
})
