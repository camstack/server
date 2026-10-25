/**
 * The derived suggestion band, asserted on the REAL addon (D222).
 *
 * `deriveSuggestionMinCosine` and `planStoredSuggestionPurge` are unit-tested
 * next door, and both of those tests would pass just as happily if nobody ever
 * called them — which is the exact shape of the defect this change exists to
 * remove (a knob the writer keeps writing and the reader stopped reading). So
 * this one boots the addon with the store the live hub actually carried on
 * 2026-08-21 (`similarityThreshold: 0.45`, `suggestionMinCosine: 0.33` set by
 * hand to re-open the band) and asserts three operator-observable things:
 *
 *   1. the stored 0.33 decides NOTHING — the band in force is 0.36 = 0.8×0.45;
 *   2. the retention pass ANNOUNCES it and removes it from the store, global
 *      and per-device, so no future reader can resurrect it;
 *   3. the announcement happens once.
 */

import type { AddonContext, IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveSuggestionMinCosine, type FaceSettings } from '../face-settings.js'
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
  readonly addonStore: Record<string, unknown>
  readonly deviceStore: Map<number, Record<string, unknown>>
}

/** Merge, then drop keys with no value — the settings blob round-trips through
 *  JSON, which is what makes an `undefined` in a patch a DELETE and not a
 *  stored null. A fake that kept the key would hide the very residue under
 *  test. */
function mergeLikeTheStore(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...patch }
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k]
  return merged
}

async function boot(
  globalSettings: Record<string, unknown>,
  deviceSettings: Record<string, unknown> = {},
): Promise<Booted> {
  const settings = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()
  const logger = makeSpyLogger()
  let addonStore: Record<string, unknown> = { ...globalSettings }
  const deviceStore = new Map<number, Record<string, unknown>>([[DEVICE_ID, deviceSettings]])
  const api = makeFakeAddonApi({
    settingsStore: settings.client,
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
        addonStore = mergeLikeTheStore(addonStore, patch)
      },
      async readDeviceStore(deviceId: number) {
        return { ...deviceStore.get(deviceId) }
      },
      async writeDeviceStore(deviceId: number, patch: Record<string, unknown>) {
        deviceStore.set(deviceId, mergeLikeTheStore(deviceStore.get(deviceId) ?? {}, patch))
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
  return {
    addon,
    logger,
    // A live view: the fake replaces the object on write, so hand back a getter
    // proxy-free snapshot accessor instead of a stale reference.
    get addonStore() {
      return addonStore
    },
    deviceStore,
  }
}

/** `sweepRetention` is private; element access is the language's own escape
 *  hatch for exactly this and is not a cast. */
async function runRetentionPass(addon: PipelineAnalyticsAddon): Promise<void> {
  await addon['sweepRetention']()
}

describe('D222 — the suggestion band is derived, and the stored value is gone', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('the stored 0.33 decides nothing: the band in force is 0.8 × the threshold', async () => {
    booted = await boot({ similarityThreshold: 0.45, suggestionMinCosine: 0.33 })
    const resolved: FaceSettings = await booted.addon['resolveDeviceFaceSettings'](DEVICE_ID)
    expect(resolved.similarityThreshold).toBe(0.45)
    expect(Object.keys(resolved)).not.toContain('suggestionMinCosine')
    expect(deriveSuggestionMinCosine(resolved.similarityThreshold)).toBe(0.36)
  })

  it('`face.rescoreTrack` reports the DERIVED floor and the factor it came from', async () => {
    booted = await boot({ similarityThreshold: 0.45, suggestionMinCosine: 0.33 })
    const settings: FaceSettings = await booted.addon['resolveDeviceFaceSettings'](DEVICE_ID)
    const params = booted.addon['faceRescoreParams'](settings)
    expect(params).toEqual({
      threshold: 0.45,
      margin: 0.12,
      minIdentitySamples: 2,
      suggestionMinCosine: 0.36,
      suggestionBandFactor: 0.8,
    })
  })

  it('the retention pass ANNOUNCES the retired value and removes it from the GLOBAL store', async () => {
    booted = await boot({ similarityThreshold: 0.45, suggestionMinCosine: 0.33 })
    booted.logger.warnCalls.length = 0
    await runRetentionPass(booted.addon)

    const line = booted.logger.warnCalls.find((c) =>
      c.message.includes('face suggestion threshold RETIRED'),
    )
    expect(line).toBeDefined()
    // Both numbers, or the operator cannot tell what changed.
    expect(line?.extras?.meta?.['wasSetTo']).toBe(0.33)
    expect(line?.extras?.meta?.['nowInForce']).toBe(0.36)
    expect(line?.extras?.meta?.['scope']).toBe('global')

    // Gone from the blob — not merely undefined, ABSENT (the store round-trips
    // through JSON, so a key with no value is a key that is not there).
    expect('suggestionMinCosine' in booted.addonStore).toBe(false)
    // The knob that DOES decide is untouched.
    expect(booted.addonStore['similarityThreshold']).toBe(0.45)
  })

  it('removes a PER-DEVICE override too, and leaves every other key alone', async () => {
    booted = await boot(
      { similarityThreshold: 0.45 },
      { similarityThreshold: 0.7, suggestionMinCosine: 0.6, bufferMaxPerDevice: 20 },
    )
    await runRetentionPass(booted.addon)
    expect(booted.deviceStore.get(DEVICE_ID)).toEqual({
      similarityThreshold: 0.7,
      bufferMaxPerDevice: 20,
    })
    const line = booted.logger.warnCalls.find(
      (c) =>
        c.message.includes('face suggestion threshold RETIRED') &&
        c.extras?.meta?.['scope'] === 'device',
    )
    // Per-camera, or it cannot be read per camera.
    expect(line?.extras?.tags?.deviceId).toBe(DEVICE_ID)
    // The DEVICE's own threshold governs its band, not the global one.
    expect(line?.extras?.meta?.['nowInForce']).toBe(0.56)
  })

  it('says it ONCE — a second pass repeats neither the warning nor the write', async () => {
    booted = await boot({ similarityThreshold: 0.45, suggestionMinCosine: 0.33 })
    await runRetentionPass(booted.addon)
    booted.logger.warnCalls.length = 0
    await runRetentionPass(booted.addon)
    expect(
      booted.logger.warnCalls.filter((c) =>
        c.message.includes('face suggestion threshold RETIRED'),
      ),
    ).toHaveLength(0)
    expect('suggestionMinCosine' in booted.addonStore).toBe(false)
    expect(booted.addonStore['similarityThreshold']).toBe(0.45)
  })

  it('a store that never carried the key is untouched', async () => {
    booted = await boot({ similarityThreshold: 0.45 })
    await runRetentionPass(booted.addon)
    expect(
      booted.logger.warnCalls.filter((c) =>
        c.message.includes('face suggestion threshold RETIRED'),
      ),
    ).toHaveLength(0)
    expect('suggestionMinCosine' in booted.addonStore).toBe(false)
    expect(booted.addonStore['similarityThreshold']).toBe(0.45)
  })
})

/**
 * D662 — the recognizer's `minFaceConfidence` is retired the same way: the hub
 * carried an interim `0.85` written by hand on 2026-09-27 (the only lever an
 * operator had while YuNet ran at SCRFD's 0.5). Once the detector's per-model
 * floor ships, that number decides nothing and must leave the store, loudly.
 */
describe('D662 — the stored face-confidence bar is announced and removed', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  const retiredLines = (b: Booted): readonly WarnCall[] =>
    b.logger.warnCalls.filter((c) => c.message.includes('face confidence bar RETIRED'))

  it('removes it from the GLOBAL store, says what it was, once', async () => {
    booted = await boot({ similarityThreshold: 0.45, minFaceConfidence: 0.85 })
    booted.logger.warnCalls.length = 0
    await runRetentionPass(booted.addon)
    const [line, ...rest] = retiredLines(booted)
    expect(rest).toHaveLength(0)
    expect(line?.extras?.meta?.['wasSetTo']).toBe(0.85)
    expect(line?.extras?.meta?.['scope']).toBe('global')
    expect('minFaceConfidence' in booted.addonStore).toBe(false)
    expect(booted.addonStore['similarityThreshold']).toBe(0.45)

    booted.logger.warnCalls.length = 0
    await runRetentionPass(booted.addon)
    expect(retiredLines(booted)).toHaveLength(0)
  })

  it('removes a PER-DEVICE override, tagged with the camera, and nothing else', async () => {
    booted = await boot(
      { similarityThreshold: 0.45 },
      { minFaceConfidence: 0.7, bufferMaxPerDevice: 20 },
    )
    await runRetentionPass(booted.addon)
    expect(booted.deviceStore.get(DEVICE_ID)).toEqual({ bufferMaxPerDevice: 20 })
    const line = retiredLines(booted).find((c) => c.extras?.meta?.['scope'] === 'device')
    expect(line?.extras?.tags?.deviceId).toBe(DEVICE_ID)
  })

  it('a store that never carried it is untouched', async () => {
    booted = await boot({ similarityThreshold: 0.45 })
    await runRetentionPass(booted.addon)
    expect(retiredLines(booted)).toHaveLength(0)
  })
})
