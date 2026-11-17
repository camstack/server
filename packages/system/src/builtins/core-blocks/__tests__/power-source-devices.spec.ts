import type { AddonApi, SwitchOptions } from '@camstack/types'
import { CompositionSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
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

/** `options: null` = the switch provider has no `getOptions` (a plain on/off switch). */
function rig(options: SwitchOptions | null) {
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
          if (options === null) throw new Error('No procedure found on path "switch.getOptions"')
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
  const service = new PowerSourceService({
    blocks: () => [BLOCK],
    devices: powerSourceDevicesOver(() => api),
    scheduler,
    logger: recordingLogger().logger,
  })
  return { service, setState, powerCycle, scheduled }
}

describe('power-source over ctx.api', () => {
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
    const r = rig(null)
    expect(await r.service.forceRestart({ deviceId: CAMERA_ID })).toEqual({ accepted: true })
    expect(r.setState).toEqual([{ deviceId: PORT_ID, on: false }])
    expect(r.powerCycle).toEqual([])
  })
})
