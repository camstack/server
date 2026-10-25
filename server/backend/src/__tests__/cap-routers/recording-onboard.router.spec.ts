/**
 * `recording-onboard` — the tRPC surface.
 *
 * The router builder does not re-validate a provider's output: it is a
 * structural pass-through, so the provider owns the payload and THIS is
 * what pins it. Three things are pinned:
 *
 *   1. the cap mounts DEVICE-NATIVE (every provider registers it per
 *      camera via `registerNativeCap`; nothing registers a singleton, so
 *      a singleton mount would 412 on every camera — the `motion` defect);
 *   2. `setSettings` is admin-only, because it writes a camera's
 *      recording configuration;
 *   3. a refusal from the provider reaches the caller AS a refusal, with
 *      its sentence intact — the whole point of refusing by name is that
 *      the operator reads the reason.
 */
import { buildCapRouters, type CapRouterServices, type CapabilityRegistry } from '@camstack/system'
import {
  type RecordingOnboardOptions,
  type RecordingOnboardStatus,
  recordingOnboardCapability,
  resolveCapMount,
} from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { requireDeviceScoped } from '../../api/trpc/cap-mount-helpers.js'
import { createCapRouterPrimitives } from '../../api/trpc/cap-router-runtime.js'
import { type CreateCallerCapableRouter, makeCtx } from './harness.js'

const DEVICE_ID = 1436
const CAP = 'recording-onboard'
/** The builder keys its routers by the camelCase name, not the cap name. */
const ROUTER_KEY = 'recordingOnboard'

const REFUSAL = 'device 1436: this camera cannot change the master recording switch: read-only here'

const STATUS: RecordingOnboardStatus = {
  storage: {
    kind: 'present',
    volumes: [{ id: '1', label: 'hdde', status: 'ok', capacityMb: 238800, freeMb: 11776 }],
  },
  tracks: [
    {
      id: '101',
      enabled: true,
      isVideo: true,
      codec: 'H.265',
      resolution: '3840x2160',
      overwriteWhenFull: true,
    },
  ],
  primaryTrackId: '101',
  enabled: true,
  overwriteWhenFull: true,
  preRecordSec: 10,
  postRecordSec: 10,
  segmentMinutes: null,
  windows: [{ trigger: 'motion', day: 0, startMinute: 0, endMinute: 1440 }],
  unreadableWindows: 0,
  recordingToNowhere: false,
  lastFetchedAt: 1_700_000_000_000,
}

const OPTIONS: RecordingOnboardOptions = {
  enabled: { readable: true, writable: true },
  overwriteWhenFull: { readable: true, writable: true },
  preRecordSec: { readable: true, writable: true },
  preRecordSecRange: { min: 0, max: 30, step: 1 },
  postRecordSec: { readable: true, writable: true },
  postRecordSecRange: { min: 0, max: 60, step: 1 },
  segmentMinutes: { readable: false, writable: false, reason: 'not on this firmware' },
  schedule: {
    support: { readable: true, writable: true },
    granularityMinutes: 1,
    triggers: ['continuous', 'motion', 'alarmInput'],
    supportsOverlappingTriggers: false,
  },
}

type ProviderSurface = Readonly<Record<string, (input: unknown) => unknown>>

/** Mirrors production: no singleton, one per-device native. */
function makeRegistry(writes: Array<Record<string, unknown>>): CapabilityRegistry {
  const native: ProviderSurface = {
    getStatus: async () => STATUS,
    getOptions: async () => OPTIONS,
    setSettings: async (input: unknown) => {
      const settings = (input as { settings?: Record<string, unknown> }).settings ?? {}
      if ('enabled' in settings) throw new Error(REFUSAL)
      writes.push(settings)
      return undefined
    },
  }
  const registry = {
    getSingleton: <T>(): T | null => null,
    getNativeProvider: <T>(capName: string, deviceId: number): T | null =>
      capName === CAP && deviceId === DEVICE_ID ? (native as T) : null,
    getProviderForDevice: <T>(capName: string, deviceId: number): T | null =>
      capName === CAP && deviceId === DEVICE_ID ? (native as T) : null,
  }
  return registry as unknown as CapabilityRegistry
}

function buildRouter(reg: CapabilityRegistry): CreateCallerCapableRouter {
  const services: CapRouterServices = {
    getLocalProvider: (capName, mountKind) => {
      if (capName !== CAP) return null
      if (mountKind === 'device-native') return requireDeviceScoped(reg, capName)
      return reg.getSingleton(capName)
    },
    remoteProxy: () => null,
    noProvider: (name): never => {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Capability "${name}" provider not available`,
      })
    },
    noNodeRouting: (name): never => {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Node routing not available for "${name}"`,
      })
    },
    badRequest: (message): never => {
      throw new TRPCError({ code: 'BAD_REQUEST', message })
    },
  }
  const routers = buildCapRouters(createCapRouterPrimitives(), services)
  const router = routers[ROUTER_KEY]
  if (router === undefined) throw new Error(`no router built for cap "${CAP}"`)
  return router as CreateCallerCapableRouter
}

describe('recording-onboard cap router', () => {
  it('mounts DEVICE-NATIVE — nothing registers a singleton for it', () => {
    expect(resolveCapMount(recordingOnboardCapability).kind).toBe('device-native')
  })

  it('serves the camera status through to the caller, whole', async () => {
    const caller = buildRouter(makeRegistry([])).createCaller(makeCtx('user'))
    await expect(caller['getStatus']?.({ deviceId: DEVICE_ID })).resolves.toEqual(STATUS)
  })

  it('serves the per-camera options, including a field it cannot write', async () => {
    const caller = buildRouter(makeRegistry([])).createCaller(makeCtx('user'))
    const options = await caller['getOptions']?.({ deviceId: DEVICE_ID })
    expect(options).toEqual(OPTIONS)
  })

  it('refuses setSettings to a non-admin session — this writes a camera', async () => {
    const caller = buildRouter(makeRegistry([])).createCaller(makeCtx('user'))
    await expect(
      caller['setSettings']?.({ deviceId: DEVICE_ID, settings: { preRecordSec: 12 } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('lets an admin write, and passes the settings through unchanged', async () => {
    const writes: Array<Record<string, unknown>> = []
    const caller = buildRouter(makeRegistry(writes)).createCaller(makeCtx('admin'))
    await caller['setSettings']?.({ deviceId: DEVICE_ID, settings: { preRecordSec: 12 } })
    expect(writes).toEqual([{ preRecordSec: 12 }])
  })

  it("carries a provider's refusal to the caller with its reason intact", async () => {
    const caller = buildRouter(makeRegistry([])).createCaller(makeCtx('admin'))
    await expect(
      caller['setSettings']?.({ deviceId: DEVICE_ID, settings: { enabled: false } }),
    ).rejects.toThrow(/cannot change the master recording switch/)
  })

  it('fails device-specifically for a camera that does not have the cap', async () => {
    const caller = buildRouter(makeRegistry([])).createCaller(makeCtx('user'))
    await expect(caller['getStatus']?.({ deviceId: 999 })).rejects.toMatchObject({
      message: `Capability "${CAP}" not registered for device 999`,
    })
  })
})
