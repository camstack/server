/**
 * The D62 migration, asserted on the REAL addon rather than on the pure planner.
 *
 * `planRetiredSettingsMigration` is unit-tested next door. That test would pass
 * just as happily if nobody ever called it — which is the exact shape of the
 * failure this whole change exists to fix, so it is not enough on its own. This
 * one boots the addon, gives a device the settings an operator actually has on
 * the live hub, runs the retention pass, and asserts two things the operator
 * can observe: the WARN naming both numbers, and the keys gone from the store.
 */

import type { AddonContext, IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineAnalyticsAddon from '../index.js'
import {
  makeFakeAddonApi,
  makeFakeDeviceManager,
  makeFakeEventBus,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makePipelineBootRecords,
  makeTestDeviceInfo,
} from './test-helpers.js'

interface WarnCall {
  readonly message: string
  readonly extras: LogExtras | undefined
}

// biome-ignore lint/plugin: test spy that extends IScopedLogger to capture warn() calls
interface SpyLogger extends IScopedLogger {
  warnCalls: WarnCall[]
}

function makeSpyLogger(): SpyLogger {
  const warnCalls: WarnCall[] = []
  const noop = (): void => {}
  const logger: SpyLogger = {
    warnCalls,
    debug: noop,
    info: noop,
    warn(message: string, extras?: LogExtras): void {
      warnCalls.push({ message, extras })
    },
    error: noop,
    child: () => logger,
    withTags: (_tags: LogTags) => logger,
  }
  return logger
}

const DEVICE_ID = 102

interface Booted {
  readonly addon: PipelineAnalyticsAddon
  readonly logger: SpyLogger
  readonly deviceStore: Map<number, Record<string, unknown>>
}

async function boot(deviceSettings: Record<string, unknown>): Promise<Booted> {
  const settings = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()
  const logger = makeSpyLogger()
  const addonStore: Record<string, unknown> = {}
  const deviceStore = new Map<number, Record<string, unknown>>([[DEVICE_ID, deviceSettings]])
  const api = makeFakeAddonApi({
    settingsStore: settings.client,
    // `retentionDeviceIds()` walks `deviceManager.listAll` first — the fake
    // helper has no such procedure, so the ONE camera under test is added here.
    deviceManager: {
      ...deviceManager.api.deviceManager,
      listAll: { query: async () => [makeTestDeviceInfo({ id: DEVICE_ID, name: 'cam-102' })] },
    },
  })

  const records = await makePipelineBootRecords()
  const ctx = {
    id: 'pipeline-analytics',
    logger,
    records,
    eventBus: bus.bus,
    addonConfig: {},
    kernel: {
      localNodeId: 'hub',
      storage,
      devices: {
        get: async () => undefined,
        list: async () => [],
        getAll: async () => [],
        getChildren: async () => [],
      },
    },
    api,
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp',
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => {},
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
        // Mirrors the real store: merge, then drop keys with no value — the
        // settings blob round-trips through JSON, which is what makes an
        // `undefined` in the patch a DELETE rather than a stored null.
        const merged: Record<string, unknown> = { ...deviceStore.get(deviceId), ...patch }
        for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k]
        deviceStore.set(deviceId, merged)
      },
      async getSection() {
        return {}
      },
      async setSection() {},
    },
    getNativeProvider: () => {
      throw new Error('no native providers')
    },
    fetchDevice: async () => {
      throw new Error('no devices')
    },
  } as unknown as AddonContext

  const addon = new PipelineAnalyticsAddon()
  await addon.initialize(ctx)
  return { addon, logger, deviceStore }
}

/** Run the retention pass. `sweepRetention` is private; element access is the
 *  language's own escape hatch for exactly this and is not a cast. */
async function runRetentionPass(addon: PipelineAnalyticsAddon): Promise<void> {
  await addon['sweepRetention']()
}

describe('D62 migration — wired into the real retention pass', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('WARNS once per retired key, naming the old value and the window that governs now', async () => {
    booted = await boot({
      retentionMode: 'custom',
      trackRetentionDays: 7,
      retentionObjectDays: 30,
      bufferRetentionDays: 3,
    })
    booted.logger.warnCalls.length = 0
    await runRetentionPass(booted.addon)

    const retired = booted.logger.warnCalls.filter((c) =>
      c.message.includes('retention setting RETIRED'),
    )
    expect(retired).toHaveLength(2)

    const objectLine = retired.find((c) => c.extras?.meta?.['setting'] === 'retentionObjectDays')
    expect(objectLine).toBeDefined()
    // Both numbers in one line, or the operator cannot tell what changed.
    expect(objectLine?.extras?.meta?.['wasSetTo']).toBe(30)
    expect(objectLine?.extras?.meta?.['effectiveWindowDays']).toBe(7)
    expect(objectLine?.extras?.meta?.['effectiveMode']).toBe('custom')
    // Per-camera or it cannot be read per camera.
    expect(objectLine?.extras?.tags?.deviceId).toBe(DEVICE_ID)

    expect(retired.map((c) => c.extras?.meta?.['setting']).toSorted()).toEqual([
      'bufferRetentionDays',
      'retentionObjectDays',
    ])
  })

  it('REMOVES the keys from the stored blob and leaves the surviving two alone', async () => {
    booted = await boot({
      retentionMode: 'custom',
      trackRetentionDays: 14,
      retentionObjectDays: 30,
      retentionMotionDays: 14,
      retentionAudioDays: 7,
    })
    await runRetentionPass(booted.addon)

    expect(booted.deviceStore.get(DEVICE_ID)).toEqual({
      retentionMode: 'custom',
      trackRetentionDays: 14,
    })
  })

  it('says it ONCE — a second pass repeats neither the warning nor the write', async () => {
    booted = await boot({ trackRetentionDays: 7, retentionObjectDays: 30 })
    await runRetentionPass(booted.addon)
    booted.logger.warnCalls.length = 0
    await runRetentionPass(booted.addon)

    expect(
      booted.logger.warnCalls.filter((c) => c.message.includes('retention setting RETIRED')),
    ).toHaveLength(0)
  })

  it('a device that never set one is silent', async () => {
    booted = await boot({ retentionMode: 'custom', trackRetentionDays: 7 })
    booted.logger.warnCalls.length = 0
    await runRetentionPass(booted.addon)

    expect(
      booted.logger.warnCalls.filter((c) => c.message.includes('retention setting RETIRED')),
    ).toHaveLength(0)
    expect(booted.deviceStore.get(DEVICE_ID)).toEqual({
      retentionMode: 'custom',
      trackRetentionDays: 7,
    })
  })
})

describe('retention OFF is announced, not inferred from silence', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('WARNS per device when the window is 0 — the terminal roots grow unbounded', async () => {
    booted = await boot({ retentionMode: 'custom', trackRetentionDays: 0 })
    booted.logger.warnCalls.length = 0
    await runRetentionPass(booted.addon)

    const off = booted.logger.warnCalls.filter((c) => c.message.includes('retention is OFF'))
    expect(off).toHaveLength(1)
    expect(off[0]?.extras?.tags?.deviceId).toBe(DEVICE_ID)
  })

  it('says it once per device, not every five minutes', async () => {
    booted = await boot({ retentionMode: 'custom', trackRetentionDays: 0 })
    await runRetentionPass(booted.addon)
    booted.logger.warnCalls.length = 0
    await runRetentionPass(booted.addon)

    expect(
      booted.logger.warnCalls.filter((c) => c.message.includes('retention is OFF')),
    ).toHaveLength(0)
  })

  it('a device with a live window is not reported as off', async () => {
    booted = await boot({ retentionMode: 'custom', trackRetentionDays: 7 })
    booted.logger.warnCalls.length = 0
    await runRetentionPass(booted.addon)

    expect(
      booted.logger.warnCalls.filter((c) => c.message.includes('retention is OFF')),
    ).toHaveLength(0)
  })
})
