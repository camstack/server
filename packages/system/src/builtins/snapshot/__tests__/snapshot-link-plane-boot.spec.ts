/**
 * The link plane's BOOT WINDOW — new, and only observable, now that the
 * snapshot wrapper runs in its own process.
 *
 * ## What changed underneath
 *
 * As a hub-main builtin, this addon booted AFTER storage and settings in the
 * same process: `ctx.settings` was always there, and "the store is not
 * answering yet" was not a state it could reach. In its own runner it can, and
 * the link plane is the one thing that cannot shrug it off — it needs a
 * PERSISTED signing secret before it will serve at all.
 *
 * Two failures follow from getting that wrong, and neither announces itself:
 *
 *   1. **One-shot serve.** A single failed attempt at init left `linkDataPlane`
 *      null for the life of the process. Every `getSnapshotLinks` row then
 *      answers `url: null` — the honest wire value for "no plane" — and every
 *      tile on every grid stays blank until somebody restarts the runner.
 *      Nothing failed twice, so nothing looked wrong.
 *
 *   2. **Re-mint over a live secret.** `state.get()` cannot distinguish "never
 *      written" from "could not be read": `readAddonStoreWithRetry` gives up
 *      and answers `{}`. A store that is merely slow therefore reads as empty,
 *      and minting a second secret invalidates every link the fleet is
 *      currently holding.
 *
 * The store fake here is deliberately hostile for a bounded window and honest
 * afterwards, which is exactly the shape of a runner starting before the
 * settings builtin finished.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  snapshotCapability,
  type AddonContext,
  type DataPlaneHandler,
  type InferProvider,
  type IScopedLogger,
} from '@camstack/types'

import { SnapshotAddon } from '../snapshot.addon.js'
import { parseVerifiedSnapshotLink } from '../snapshot-link-url.js'
import { freshSnapshotDataDir } from './scratch-data-dir.js'

type ISnapshotProvider = InferProvider<typeof snapshotCapability>

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

interface Harness {
  readonly provider: ISnapshotProvider
  readonly servedPrefixes: () => readonly string[]
  readonly store: Record<string, unknown>
  /** Flip the settings store from "not answering" to answering. */
  readonly bringStoreUp: () => void
}

/**
 * @param storeUpAtInit  whether the settings store answers while the addon
 *                       initialises. `false` reproduces a runner that boots
 *                       before the settings builtin is resident.
 */
async function makeHarness(storeUpAtInit: boolean): Promise<Harness> {
  const store: Record<string, unknown> = {}
  const served: string[] = []
  let up = storeUpAtInit

  const ctx = {
    id: 'snapshot',
    logger: makeLogger(),
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir: freshSnapshotDataDir(),
    kernel: { localNodeId: 'hub', devices: {} as never },
    dataPlane: {
      serve: vi.fn(async (args: { prefix: string; access: string; handler: DataPlaneHandler }) => {
        served.push(args.prefix)
        return {
          baseUrl: 'http://127.0.0.1:0',
          prefix: args.prefix,
          dispose: async () => undefined,
        }
      }),
    },
    settings: {
      readAddonStore: vi.fn(async () => {
        // `provider not available` is one of the two fingerprints
        // `BaseAddon.readAddonStoreWithRetry` treats as transient — it retries,
        // then gives up and answers `{}`. That `{}` is the trap this guards.
        if (!up) throw new Error('settings-store provider not available')
        return { ...store }
      }),
      writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
        if (!up) throw new Error('settings-store provider not available')
        Object.assign(store, patch)
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
            name: 'cam',
            features: [],
            disabled: false,
            online: true,
          })),
        },
      },
      pipelineOrchestrator: {
        getIngestOwner: { query: vi.fn(async () => ({ ownerNodeId: 'hub' })) },
      },
    },
    getNativeProvider: vi.fn(() => null),
    fetchDevice: vi.fn(async () => ({ deviceId: 1, state: {} })),
    registerProvider: vi.fn(),
  } as unknown as AddonContext

  const addon = new SnapshotAddon(async (b: Buffer) => b)
  const result = await addon.initialize(ctx)
  const registrations = (
    Array.isArray(result) ? result : (result?.providers ?? [])
  ) as ReadonlyArray<{
    readonly provider: ISnapshotProvider
  }>
  const first = registrations[0]
  if (!first) throw new Error('snapshot registered no provider')
  return {
    provider: first.provider,
    servedPrefixes: () => served,
    store,
    bringStoreUp: () => {
      up = true
    },
  }
}

describe('snapshot link plane — the settings store is not ready at init', () => {
  it('serves the link plane on a LATER getSnapshotLinks instead of never', async () => {
    const h = await makeHarness(false)

    // Init got the media plane up (no secret needed) but not the link plane.
    expect(h.servedPrefixes()).toEqual(['media'])

    h.bringStoreUp()
    const rows = await h.provider.getSnapshotLinks({ targets: [{ deviceId: 1, width: 640 }] })

    expect(h.servedPrefixes()).toEqual(['media', 'link'])
    expect(rows[0]?.url).not.toBeNull()
    expect(typeof h.store['snapshotLinkSecret']).toBe('string')
  })

  it('mints the signing secret ONCE — a slow store never rotates it', async () => {
    const h = await makeHarness(false)
    h.bringStoreUp()

    const first = await h.provider.getSnapshotLinks({ targets: [{ deviceId: 1, width: 640 }] })
    const secret = h.store['snapshotLinkSecret']
    expect(typeof secret).toBe('string')

    const second = await h.provider.getSnapshotLinks({ targets: [{ deviceId: 1, width: 640 }] })

    // Same secret in the store, and BOTH links verify against it. A re-mint
    // would leave the first link unverifiable — the fleet-wide blank grid.
    expect(h.store['snapshotLinkSecret']).toBe(secret)
    for (const url of [first[0]?.url, second[0]?.url]) {
      expect(url).not.toBeNull()
      const verified = parseVerifiedSnapshotLink({
        url: url!.slice(url!.indexOf('/link/') + '/link'.length),
        secret: String(secret),
        nowMs: Date.now(),
      })
      expect(verified).not.toBeNull()
      expect(verified?.deviceId).toBe(1)
    }
  })

  it('a healthy store still serves the link plane at init (no behaviour change)', async () => {
    const h = await makeHarness(true)
    expect(h.servedPrefixes()).toEqual(['media', 'link'])
    const rows = await h.provider.getSnapshotLinks({ targets: [{ deviceId: 1 }] })
    expect(rows[0]?.url).not.toBeNull()
  })
})
