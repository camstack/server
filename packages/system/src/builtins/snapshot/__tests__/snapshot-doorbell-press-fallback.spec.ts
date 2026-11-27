/**
 * A doorbell press asks for a snapshot at the one moment the camera's own
 * endpoint is busiest (live-view sessions starting, HTTP 503 from the ISAPI
 * server). Camera 615 answered 503 on 3 of 5 presses and HomeKit got nothing:
 * the in-memory cache of a camera nobody polls had idled out, the broker had
 * no frame, and the persisted last frame — which the wrapper wrote on every
 * capture — was consulted only for a camera in a blocked state, never when
 * every live rung came back empty.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  type AddonContext,
  type CapabilityDefinition,
  type InferProvider,
  type IScopedLogger,
  snapshotCapability,
} from '@camstack/types'
import { SnapshotAddon } from '../snapshot.addon.js'
import { freshSnapshotDataDir } from './scratch-data-dir.js'

type ISnapshotProvider = InferProvider<typeof snapshotCapability>

const DEVICE = 615
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64')

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

function makeCtx(
  native: { current: { base64: string; contentType: string } | null },
  logger: IScopedLogger,
): AddonContext {
  const store: Record<string, unknown> = {}
  return {
    id: 'snapshot',
    logger,
    eventBus: { emit: vi.fn(), subscribe: () => () => undefined },
    addonConfig: {},
    dataDir: freshSnapshotDataDir(),
    kernel: { localNodeId: 'hub', devices: {} as never },
    settings: {
      readAddonStore: vi.fn(async () => ({ ...store })),
      writeAddonStore: vi.fn(async (p: Record<string, unknown>) => {
        Object.assign(store, p)
      }),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
    api: {
      deviceManager: {
        getDevice: {
          query: vi.fn(async () => ({
            id: DEVICE,
            name: 'doorbell',
            features: [],
            disabled: false,
            online: true,
          })),
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
      cap.name !== 'snapshot'
        ? null
        : {
            getSnapshot: vi.fn(async () => native.current),
            invalidateCache: vi.fn(async () => undefined),
          },
    ),
    fetchDevice: vi.fn(async () => ({ deviceId: DEVICE, state: {} })),
  } as unknown as AddonContext
}

describe('SnapshotAddon — every live rung empty (doorbell press, camera answers 503)', () => {
  it('serves the persisted last frame instead of nothing, and says so', async () => {
    const native = {
      current: { base64: JPEG_B64, contentType: 'image/jpeg' } as {
        base64: string
        contentType: string
      } | null,
    }
    const logger = makeLogger()
    const ctx = makeCtx(native, logger)
    const addon = new SnapshotAddon()
    const result = await addon.initialize(ctx)
    const list = (Array.isArray(result) ? result : (result?.providers ?? [])) as ReadonlyArray<{
      readonly provider: ISnapshotProvider
    }>
    const provider = list[0]?.provider
    if (!provider) throw new Error('no provider')

    // An earlier capture lands and is persisted.
    expect(await provider.getSnapshot({ deviceId: DEVICE })).not.toBeNull()
    const file = join(ctx.dataDir, 'last-frame', `${String(DEVICE)}.jpg`)
    await vi.waitFor(() => expect(existsSync(file)).toBe(true))

    // Time passes with nobody polling: the memory cache is gone.
    await provider.invalidateCache({ deviceId: DEVICE })

    // The press: native answers nothing (503), the broker has no frame.
    native.current = null
    const image = await provider.getSnapshot({ deviceId: DEVICE })

    expect(image).not.toBeNull()
    expect(image?.base64).toBe(JPEG_B64)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('serving the persisted frame'),
      expect.objectContaining({ tags: { deviceId: DEVICE } }),
    )
  })

  it('names the empty broker rung instead of dropping silently', async () => {
    const native = { current: null as { base64: string; contentType: string } | null }
    const logger = makeLogger()
    const ctx = makeCtx(native, logger)
    const addon = new SnapshotAddon()
    const result = await addon.initialize(ctx)
    const list = (Array.isArray(result) ? result : (result?.providers ?? [])) as ReadonlyArray<{
      readonly provider: ISnapshotProvider
    }>
    const provider = list[0]?.provider
    if (!provider) throw new Error('no provider')

    expect(await provider.getSnapshot({ deviceId: DEVICE })).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no live source produced a frame'),
      expect.objectContaining({ tags: { deviceId: DEVICE } }),
    )
  })
})
