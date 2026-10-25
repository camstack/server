/**
 * The storage-root check runs AT BOOT, outside the six-minute grace the device
 * checks wait out, and its fault becomes ONE alert event — not one per tick.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type AddonContext,
  EventCategory,
  type IEventBus,
  type IScopedLogger,
  type StorageLocation,
  type SystemEvent,
} from '@camstack/types'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { makeAddonContext } from '../../device-manager/__tests__/typed-addon-context.js'
import { LivenessMonitorAddon } from '../liveness-monitor.addon.js'

const runsAsRoot = typeof process.getuid === 'function' && process.getuid() === 0

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-storage-boot-'))
const lockedDir = path.join(root, 'recordings')
fs.mkdirSync(lockedDir)
fs.chmodSync(lockedDir, 0o555)

afterAll(() => {
  fs.chmodSync(lockedDir, 0o755)
  fs.rmSync(root, { recursive: true, force: true })
})

const RECORDINGS: StorageLocation = {
  id: 'recordings:default',
  type: 'recordings',
  displayName: 'Recordings',
  providerId: 'filesystem-storage',
  config: { basePath: lockedDir },
  nodeId: 'hub',
  isSystem: true,
  enabled: true,
  mode: 'active',
  createdAt: 0,
  updatedAt: 0,
}

function memorySettings(): NonNullable<AddonContext['settings']> {
  return {
    readAddonStore: async () => ({}),
    writeAddonStore: async () => undefined,
    readDeviceStoreBatch: async () => new Map(),
    listDeviceStoreIds: async () => [],
    readDeviceStore: async () => ({}),
    writeDeviceStore: async () => undefined,
    clearDeviceStore: async () => undefined,
    readDeviceRuntimeState: async () => ({}),
    writeDeviceRuntimeState: async () => undefined,
    clearDeviceRuntimeState: async () => undefined,
    getSection: async () => ({}),
    setSection: async () => undefined,
  }
}

describe('liveness-monitor: storage roots at boot', () => {
  it.skipIf(runsAsRoot)(
    'an unwritable recordings root is reported at boot, once, as an ERROR and an alert event',
    async () => {
      const errors: string[] = []
      const logger: IScopedLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: (msg: string) => {
          errors.push(msg)
        },
        child: () => logger,
        withTags: () => logger,
      }
      const events: SystemEvent[] = []
      const eventBus: IEventBus = {
        emit: (event: SystemEvent) => {
          events.push(event)
        },
        subscribe: () => () => undefined,
        getRecent: () => [],
      }
      const ctx = makeAddonContext({
        id: 'liveness-monitor',
        logger,
        settings: memorySettings(),
        eventBus,
        api: { storage: { listLocations: { query: async () => [RECORDINGS] } } },
      })
      const addon = new LivenessMonitorAddon()
      await addon.initialize(ctx)
      try {
        const failed = (): readonly SystemEvent[] =>
          events.filter((e) => e.category === EventCategory.SystemLivenessFailed)
        // No tick has run and the device grace has not elapsed.
        await vi.waitFor(() => expect(failed()).toHaveLength(1))
        expect(failed()[0]?.data['findingId']).toBe(`liveness:storage-root-unwritable:${lockedDir}`)
        expect(errors.filter((m) => m.includes(lockedDir))).toHaveLength(1)

        // The next tick (still inside the grace) sees the same fault: no new line, no new alert.
        await addon.tick()
        expect(failed()).toHaveLength(1)
        expect(errors.filter((m) => m.includes(lockedDir))).toHaveLength(1)
      } finally {
        await addon.shutdown()
      }
    },
  )
})
