/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CameraGridAddon } from '../addon.js'

/**
 * A hub-main addon's `ctx.id` is `addon:camera-grid`; the device-manager owns the rows it
 * registered under the BARE id, so asking it for `addon:camera-grid` answers nothing and the
 * declarer's withdrawal sweep never sees its own cameras.
 */
function logger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

describe('CameraGridAddon — the owner id it asks the device-manager for is bare', () => {
  let addon: CameraGridAddon | null = null
  afterEach(async () => {
    await addon?.shutdown()
    addon = null
  })

  it('lists its own devices under the bare addon id', async () => {
    const listAll = vi.fn(async () => [])
    const getByAddonId = vi.fn(async () => ({ id: 'int_0027', info: { fixed: true } }))
    const ctx = {
      id: 'addon:camera-grid',
      logger: logger(),
      dataDir: '/tmp/camera-grid-spec',
      settings: {
        readAddonStore: vi.fn(async () => ({})),
        readAddonStoreResult: vi.fn(async () => ({ kind: 'value' as const, value: {} })),
        writeAddonStore: vi.fn(async () => undefined),
        readDeviceStore: vi.fn(async () => ({})),
        writeDeviceStore: vi.fn(async () => undefined),
        getSection: vi.fn(async () => ({})),
        setSection: vi.fn(async () => undefined),
      },
      eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
      kernel: { localNodeId: 'hub', devices: {} },
      deps: { ensureFfmpeg: vi.fn(async () => '/usr/bin/true') },
      api: {
        deviceManager: { listAll: { query: listAll } },
        integrations: {
          getByAddonId: { query: getByAddonId },
          create: { mutate: vi.fn() },
          update: { mutate: vi.fn(async () => undefined) },
        },
        streamBroker: { listAllProfileSlots: { query: vi.fn(async () => []) } },
      },
    } as unknown as AddonContext
    addon = new CameraGridAddon()
    await addon.initialize(ctx)
    await vi.waitFor(() => expect(listAll).toHaveBeenCalled())
    expect(listAll).toHaveBeenCalledWith({ addonId: 'camera-grid' })
  })
})
