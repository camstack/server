/**
 * Unit tests for the `getEventMedia` kind filter — Task 8.
 *
 * Verifies that the addon provider's `getEventMedia` method:
 *  1. Without a `kind` filter, returns all media items for the event.
 *  2. With `kind:'crop'`, returns only items whose kind is 'crop'.
 *  3. With `kind:'thumbnail'`, returns only items whose kind is 'thumbnail'.
 *  4. Returns [] when no media matches the filter.
 *  5. Returns [] when the mediaStore is absent (no-store fallback).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AddonContext, IScopedLogger, MediaFileKind } from '@camstack/types'
import PipelineAnalyticsAddon from '../index.js'
import { MediaStore } from '../store/media-store.js'
import {
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeFakeEventBus,
  makeFakeDeviceManager,
  makeFakeAddonApi,
  makePipelineBootRecords,
  makeSilentLogger,
} from './test-helpers.js'

// ── Boot helpers ──────────────────────────────────────────────────────

interface BootResult {
  readonly addon: PipelineAnalyticsAddon
  readonly mediaStore: MediaStore
}

async function boot(): Promise<BootResult> {
  const settings = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()

  const api = makeFakeAddonApi({
    settingsStore: settings.client,
    deviceManager: deviceManager.api.deviceManager,
  })
  const logger: IScopedLogger = makeSilentLogger()
  const addonStore: Record<string, unknown> = {}
  const deviceStore = new Map<number, Record<string, unknown>>()

  const records = await makePipelineBootRecords()
  const ctx: AddonContext = {
    id: 'pipeline-analytics',
    logger,
    records,
    eventBus: bus.bus,
    addonConfig: {},
    kernel: {
      localNodeId: 'hub',
      storage,
      devices: {
        allocateDeviceId: async () => {
          throw new Error('no')
        },
        create: async () => {
          throw new Error('no')
        },
        createContext: () => {
          throw new Error('no')
        },
        register: async () => {
          throw new Error('no')
        },
        remove: async () => {
          /* no-op */
        },
        decommission: async () => {
          /* no-op */
        },
        getAll: async () => [],
        getChildren: async () => [],
      },
    } as unknown as AddonContext['kernel'],
    api,
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp',
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => {
        /* no-op */
      },
      getDepsDir: () => '/tmp/fake/deps',
    },
    settings: {
      async readAddonStore() {
        return { ...addonStore }
      },
      async writeAddonStore(patch: Record<string, unknown>) {
        Object.assign(addonStore, patch)
      },
      async readDeviceStore(deviceId: number) {
        return { ...deviceStore.get(deviceId) }
      },
      async writeDeviceStore(deviceId: number, patch: Record<string, unknown>) {
        const existing = deviceStore.get(deviceId) ?? {}
        deviceStore.set(deviceId, { ...existing, ...patch })
      },
      async getSection() {
        return {}
      },
      async setSection() {
        /* no-op */
      },
    },
    getNativeProvider: () => {
      throw new Error('no native providers in test')
    },
    fetchDevice: async () => {
      throw new Error('no devices in test')
    },
  } as unknown as AddonContext

  const addon = new PipelineAnalyticsAddon()
  await addon.initialize(ctx)

  // Access the internal mediaStore through the private field (test-only cast).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mediaStore = (addon as any).mediaStore as MediaStore
  if (!mediaStore) throw new Error('mediaStore not initialized after addon.initialize()')

  return { addon, mediaStore }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('getEventMedia kind filter', () => {
  let booted: BootResult

  beforeEach(async () => {
    booted = await boot()
  })

  afterEach(async () => {
    await booted.addon.shutdown()
  })

  /** An event id is a per-table SQLite rowid (D474/D482), never a string. */
  const EVENT_ID = 20_260_912
  const DEVICE_ID = 4

  async function putMedia(kind: MediaFileKind, seq: number): Promise<void> {
    await booted.mediaStore.put({
      deviceId: DEVICE_ID,
      ownerKind: 'object',
      ownerId: String(EVENT_ID),
      kind,
      timestamp: seq,
      data: Buffer.from(`data-${kind}-${seq}`),
    })
  }

  it('returns all media items when no kind filter is provided', async () => {
    const { addon } = booted

    await putMedia('crop', 1000)
    await putMedia('thumbnail', 1001)
    await putMedia('fullFrame', 1002)

    const result = await addon.getEventMedia({
      ownerType: 'object',
      eventId: EVENT_ID,
      deviceId: DEVICE_ID,
    })
    expect(result).toHaveLength(3)
    const kinds = result.map((m) => m.kind).toSorted()
    expect(kinds).toEqual(['crop', 'fullFrame', 'thumbnail'])
  })

  it('returns only crop items when kind:"crop" is specified', async () => {
    const { addon } = booted

    await putMedia('crop', 1000)
    await putMedia('thumbnail', 1001)
    await putMedia('fullFrame', 1002)

    const result = await addon.getEventMedia({
      ownerType: 'object',
      eventId: EVENT_ID,
      deviceId: DEVICE_ID,
      kind: 'crop',
    })
    expect(result).toHaveLength(1)
    expect(result[0]!.kind).toBe('crop')
  })

  it('returns only thumbnail items when kind:"thumbnail" is specified', async () => {
    const { addon } = booted

    await putMedia('crop', 1000)
    await putMedia('thumbnail', 1001)

    const result = await addon.getEventMedia({
      ownerType: 'object',
      eventId: EVENT_ID,
      deviceId: DEVICE_ID,
      kind: 'thumbnail',
    })
    expect(result).toHaveLength(1)
    expect(result[0]!.kind).toBe('thumbnail')
  })

  it('returns [] for a known event when the filtered kind has no items', async () => {
    const { addon } = booted

    await putMedia('thumbnail', 1001)

    const result = await addon.getEventMedia({
      ownerType: 'object',
      eventId: EVENT_ID,
      deviceId: DEVICE_ID,
      kind: 'crop',
    })
    expect(result).toHaveLength(0)
  })

  it('returns [] when no media exists for the event (no kind filter)', async () => {
    const { addon } = booted
    const result = await addon.getEventMedia({
      ownerType: 'object',
      eventId: EVENT_ID,
      deviceId: DEVICE_ID,
    })
    expect(result).toHaveLength(0)
  })
})
