/**
 * The camera-sensors setting (D672): how the orchestrator READS the stored
 * `cameraSensors` value beside `motionSources`, and the write gate that
 * `applyDeviceSettingsPatch` runs before anything lands.
 */
import type { AddonContext, IEventBus, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  parseCameraSensorsSetting,
  readCameraSensorsSetting,
  validateCameraSensorsPatch,
} from '../camera-sensors/settings.js'
import { DeviceConfigContributions } from '../device-config-contributions.js'
import { NodeTopologyService } from '../node-topology.js'

const PIR = { addonId: 'provider-homeassistant', stableId: 'ha:porch-pir' }

describe('camera sensors setting', () => {
  it('absent and null are not configured', () => {
    expect(parseCameraSensorsSetting({})).toEqual({ state: 'not-configured' })
    expect(parseCameraSensorsSetting({ cameraSensors: null })).toEqual({ state: 'not-configured' })
  })
  it('a stored value that does not parse is UNREADABLE, never not-configured', () => {
    const r = parseCameraSensorsSetting({
      cameraSensors: { sensors: [{ ...PIR, mode: 'sometimes' }] },
    })
    expect(r.state).toBe('unreadable')
  })
  it('a stored value that parses is configured', () => {
    expect(
      parseCameraSensorsSetting({ cameraSensors: { sensors: [{ ...PIR, mode: 'in-addition' }] } }),
    ).toEqual({
      state: 'configured',
      config: { sensors: [{ ...PIR, mode: 'in-addition' }] },
    })
  })
  it('a cleared (null) value reads as not-configured, never unreadable (G5, D676)', async () => {
    const result = await readCameraSensorsSetting(async () => ({ cameraSensors: null }))
    expect(result).toEqual({ state: 'not-configured' })
  })
  it('a failed read is UNREADABLE with the error', async () => {
    const r = await readCameraSensorsSetting(() => Promise.reject(new Error('store timeout')))
    expect(r).toEqual({ state: 'unreadable', reason: 'settings read failed — store timeout' })
  })
  it('write gate: absent, valid, null removal, refused', () => {
    expect(validateCameraSensorsPatch({ motionSources: ['onboard'] })).toEqual({ kind: 'absent' })
    expect(validateCameraSensorsPatch({ cameraSensors: null })).toEqual({
      kind: 'valid',
      value: null,
    })
    expect(
      validateCameraSensorsPatch({ cameraSensors: { sensors: [{ ...PIR, mode: 'in-addition' }] } })
        .kind,
    ).toBe('valid')
    expect(
      validateCameraSensorsPatch({ cameraSensors: { mode: 'in-addition', sensors: [3299] } }).kind,
    ).toBe('refused')
  })
})

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this
    }),
    withTags: vi.fn(function (this: unknown) {
      return this
    }),
  }
}

function unused(name: string): () => never {
  return () => {
    throw new Error(`${name} not used in this harness`)
  }
}

function makeContributions() {
  const logger = makeLogger()
  const emit = vi.fn()
  const writeDeviceStore = vi.fn(async (_deviceId: number, _patch: Record<string, unknown>) => {})
  const setEnabled = vi.fn(async () => ({ success: true }))
  const ctx = {
    id: 'pipeline-orchestrator',
    logger,
    eventBus: { emit, subscribe: () => () => {}, getRecent: () => [] },
    api: { nativeObjectDetection: { setEnabled: { mutate: setEnabled } } },
    settings: {
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore,
    },
  }
  // A test double for the addon context: the same boundary the other
  // device-config specs cross (`device-contribution.spec.ts`).
  const addonCtx = ctx as unknown as AddonContext
  const busLogger = logger as unknown as IScopedLogger
  const topology = new NodeTopologyService({
    readAgentSettingsMap: async () => ({}),
    eventBus: ctx.eventBus as unknown as IEventBus,
    logger: busLogger,
    localNodeId: () => 'hub',
    addonId: () => ctx.id,
  })
  const contributions = new DeviceConfigContributions({
    ctx: () => addonCtx,
    topology,
    getAssignment: () => null,
    deviceSettingsSchema: () => null,
    deviceHasOnboardMotionCap: async () => true,
    deviceHasActivitySignalCap: async () => false,
    deviceHasNativeObjectDetectionCap: async () => false,
    baseUpdateGlobalSettings: unused('baseUpdateGlobalSettings'),
    resolveGlobalStore: unused('resolveGlobalStore'),
    setGlobalSettings: unused('setGlobalSettings'),
    applyRuntimeSettings: unused('applyRuntimeSettings'),
    redispatchAllActiveCameras: unused('redispatchAllActiveCameras'),
    clearOnSettingsChange: unused('clearOnSettingsChange'),
  })
  return { contributions, writeDeviceStore, setEnabled, logger, emit }
}

describe('applyDeviceSettingsPatch — the cameraSensors write gate', () => {
  it('a refused cameraSensors throws and writes NOTHING, not even the valid keys beside it', async () => {
    const h = makeContributions()
    await expect(
      h.contributions.applyDeviceSettingsPatch({
        deviceId: 103,
        patch: {
          motionSources: ['onboard'],
          detectionSources: ['onboard'],
          cameraSensors: { mode: 'in-addition', sensors: [3299] },
        },
      }),
    ).rejects.toThrow(/cameraSensors refused/)
    expect(h.writeDeviceStore).toHaveBeenCalledTimes(0)
    expect(h.setEnabled).toHaveBeenCalledTimes(0)
    expect(h.logger.warn).toHaveBeenCalledWith(
      'camera sensors: patch refused — nothing written',
      expect.objectContaining({ tags: { deviceId: 103 } }),
    )
  })

  it('a valid cameraSensors is written once, as PARSED: stable refs only (R3)', async () => {
    const h = makeContributions()
    // A caller that also sends the numeric id inside the ref: accepted (Zod
    // strips unknown keys), but the id must never reach the store.
    const value = { mode: 'in-addition', sensors: [{ ...PIR, deviceId: 3299 }], extra: true }
    await h.contributions.applyDeviceSettingsPatch({
      deviceId: 103,
      patch: { motionSources: ['onboard'], cameraSensors: value },
    })
    expect(h.writeDeviceStore).toHaveBeenCalledTimes(1)
    expect(h.writeDeviceStore).toHaveBeenCalledWith(103, {
      motionSources: ['onboard'],
      cameraSensors: { sensors: [{ ...PIR, mode: 'in-addition' }] },
    })
  })

  it('null (the operator removed it) is written, not refused', async () => {
    const h = makeContributions()
    await h.contributions.applyDeviceSettingsPatch({
      deviceId: 103,
      patch: { cameraSensors: null },
    })
    expect(h.writeDeviceStore).toHaveBeenCalledWith(103, { cameraSensors: null })
  })
})
