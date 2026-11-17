import type { AddonApi, SwitchOptions } from '@camstack/types'
import { CompositionSchema } from '@camstack/types'
import { TRPCClientError } from '@trpc/client'
import { describe, expect, it } from 'vitest'
import { createChildCapDispatch } from '../../../kernel/moleculer/child-cap-dispatch.js'
import { powerSourceDevicesOver } from '../power-source-devices.js'
import { PowerSourceService, type PowerSourceScheduler } from '../power-source-service.js'
import { recordingLogger } from './fixtures.js'

const CAMERA_REF = { addonId: 'reolink', stableId: 'cam' }
const PORT_REF = { addonId: 'unifi', stableId: 'port-3' }
const CAMERA_ID = 21
const PORT_ID = 33

/** A camera whose power-source is a PoE port. */
const BLOCK = {
  id: 'blk-cam',
  source: {
    kind: 'composition' as const,
    composition: CompositionSchema.parse({
      target: { kind: 'existing', device: CAMERA_REF },
      features: [
        {
          kind: 'fields',
          cap: 'power-source',
          fields: {
            switchOn: { kind: 'from', source: PORT_REF, cap: 'switch', fieldPath: 'on' },
          },
        },
      ],
    }),
  },
}

/** How `switch.getOptions` answers: options, or the error it rejects with. */
type OptionsAnswer = SwitchOptions | Error

/** What the hub answers when the switch provider does not implement `getOptions`. */
function notImplemented(): Error {
  return Object.assign(new Error('Capability "switch" provider does not implement "getOptions"'), {
    data: { code: 'NOT_IMPLEMENTED' },
  })
}

function rig(options: OptionsAnswer) {
  const setState: { deviceId: number; on: boolean }[] = []
  const powerCycle: number[] = []
  const fake = {
    deviceManager: {
      listAll: {
        query: async ({ addonId }: { addonId: string }) =>
          [
            {
              id: CAMERA_ID,
              stableId: CAMERA_REF.stableId,
              name: 'Cam',
              online: true,
              addonId: 'reolink',
            },
            {
              id: PORT_ID,
              stableId: PORT_REF.stableId,
              name: 'Port 3',
              online: true,
              addonId: 'unifi',
            },
          ].filter((r) => r.addonId === addonId),
      },
    },
    switch: {
      getStatus: { query: async () => ({ on: true, lastChangedAt: 1 }) },
      getOptions: {
        query: async () => {
          if (options instanceof Error) throw options
          return options
        },
      },
      setState: {
        mutate: async (input: { deviceId: number; on: boolean }) => {
          setState.push(input)
        },
      },
      powerCycle: {
        mutate: async ({ deviceId }: { deviceId: number }) => {
          powerCycle.push(deviceId)
        },
      },
    },
  }
  // The fake covers only the two routers the power-source wiring reads.
  const api: AddonApi = Object.assign(Object.create(null), fake)
  const scheduled: (() => void)[] = []
  const scheduler: PowerSourceScheduler = {
    schedule: (_delayMs, fire) => {
      scheduled.push(fire)
      return { cancel: () => undefined }
    },
  }
  const recorded = recordingLogger()
  const service = new PowerSourceService({
    blocks: () => [BLOCK],
    devices: powerSourceDevicesOver(() => api),
    scheduler,
    logger: recorded.logger,
  })
  return { service, setState, powerCycle, scheduled, recorded }
}

/**
 * What a FORKED switch provider without `getOptions` really answers: the child's
 * dispatcher refuses the optional method by name, and the in-hub link wraps it as
 * a client error (`localProviderLink` / `brokerTransportLink`). No typed code
 * survives the UDS hop — only the message prefix.
 */
async function forkedProviderWithoutGetOptions(): Promise<Error> {
  const dispatch = createChildCapDispatch({
    getSingletonProvider: () => null,
    getDeviceProvider: () => ({ setState: async () => undefined }),
    isCollectionListMethod: () => false,
    isProviderOptionalMethod: (cap, method) => cap === 'switch' && method === 'getOptions',
  })
  try {
    await dispatch({
      capName: 'switch',
      method: 'getOptions',
      args: { deviceId: PORT_ID },
      deviceId: PORT_ID,
    })
  } catch (cause: unknown) {
    return TRPCClientError.from(cause instanceof Error ? cause : new Error(String(cause)))
  }
  throw new Error('the dispatcher served a method the provider does not have')
}

describe('power-source over ctx.api', () => {
  it('a forked provider without getOptions (the real child refusal) is a plain on/off switch', async () => {
    const r = rig(await forkedProviderWithoutGetOptions())
    expect(await r.service.forceRestart({ deviceId: CAMERA_ID })).toEqual({
      accepted: true,
    })
    expect(r.setState).toEqual([{ deviceId: PORT_ID, on: false }])
    expect((await r.service.getStatus({ deviceId: CAMERA_ID })).switchSettable).toBe(true)
  })

  it('a camera on a reports-only PoE port is refused power on / off as not-settable; setState is never called', async () => {
    const r = rig({ supportsSetState: false, supportsPowerCycle: true })
    expect(await r.service.powerOn({ deviceId: CAMERA_ID })).toMatchObject({
      accepted: false,
      reason: 'not-settable',
    })
    expect(await r.service.powerOff({ deviceId: CAMERA_ID })).toMatchObject({
      accepted: false,
      reason: 'not-settable',
    })
    expect(r.setState).toEqual([])
    expect((await r.service.getStatus({ deviceId: CAMERA_ID })).switchSettable).toBe(false)
  })

  it('restarts a camera on an API-key-only PoE port with ONE native power cycle, never on/off', async () => {
    const r = rig({ supportsSetState: false, supportsPowerCycle: true })
    expect(await r.service.forceRestart({ deviceId: CAMERA_ID })).toEqual({ accepted: true })
    expect(r.powerCycle).toEqual([PORT_ID])
    expect(r.setState).toEqual([])
    expect(r.scheduled).toHaveLength(0)
  })

  it('restarts through off / wait / on on a port that switches PoE (local account)', async () => {
    const r = rig({ supportsSetState: true, supportsPowerCycle: false })
    expect(await r.service.forceRestart({ deviceId: CAMERA_ID })).toEqual({ accepted: true })
    expect(r.setState).toEqual([{ deviceId: PORT_ID, on: false }])
    r.scheduled[0]?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(r.setState).toEqual([
      { deviceId: PORT_ID, on: false },
      { deviceId: PORT_ID, on: true },
    ])
    expect(r.powerCycle).toEqual([])
  })

  it('treats a switch whose provider has no getOptions as a plain on/off switch', async () => {
    for (const absent of [
      notImplemented(),
      new Error('No procedure found on path "switch.getOptions"'),
    ]) {
      const r = rig(absent)
      expect(await r.service.forceRestart({ deviceId: CAMERA_ID })).toEqual({ accepted: true })
      expect(r.setState).toEqual([{ deviceId: PORT_ID, on: false }])
      expect(r.powerCycle).toEqual([])
    }
  })

  it('a getOptions that FAILED refuses the restart with its own cause — never off / wait / on blind', async () => {
    const r = rig(new Error('request timed out after 10000ms'))
    const result = await r.service.forceRestart({ deviceId: CAMERA_ID })
    expect(result).toMatchObject({ accepted: false, reason: 'switch-options-unreadable' })
    expect(result.accepted ? '' : result.message).toContain('request timed out')
    expect(r.setState).toEqual([])
    expect(r.powerCycle).toEqual([])
    expect(r.scheduled).toHaveLength(0)
    const line = r.recorded.lines.find((l) => l.message.includes('switch-options-unreadable'))
    expect(line?.extras?.tags).toEqual({ deviceId: CAMERA_ID })
  })
})
