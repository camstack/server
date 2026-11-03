import { composedDeviceRef, CompositionSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  PowerSourceService,
  type PowerSourceDevices,
  type PowerSourceScheduler,
} from '../power-source-service.js'
import { recordingLogger } from './fixtures.js'

const GATEWAY_REF = { addonId: 'ha', stableId: 'gateway' }
const PLUG_REF = { addonId: 'ha', stableId: 'plug' }
const GATEWAY_ID = 7
const PLUG_ID = 9

function block(offSeconds?: number) {
  return {
    id: 'blk-existing',
    source: {
      kind: 'composition' as const,
      composition: CompositionSchema.parse({
        target: { kind: 'existing', device: GATEWAY_REF },
        features: [
          {
            kind: 'fields',
            cap: 'power-source',
            fields: {
              switchOn: {
                kind: 'from',
                source: PLUG_REF,
                cap: 'switch',
                fieldPath: 'on',
              },
              ...(offSeconds === undefined
                ? {}
                : {
                    offSeconds: {
                      kind: 'expression',
                      expr: `${offSeconds}`,
                      bindings: {},
                    },
                  }),
            },
          },
        ],
      }),
    },
  }
}

/** A scheduler the spec fires by hand. */
function fakeScheduler() {
  const pending: { delayMs: number; fire: () => void; cancelled: boolean }[] = []
  const scheduler: PowerSourceScheduler = {
    schedule: (delayMs, fire) => {
      const entry = { delayMs, fire, cancelled: false }
      pending.push(entry)
      return {
        cancel: () => {
          entry.cancelled = true
        },
      }
    },
  }
  return { scheduler, pending }
}

/** A composed washer: a NEW-target composition whose own device carries the plug. */
function applianceBlock() {
  return {
    id: 'blk-washer',
    source: {
      kind: 'composition' as const,
      composition: CompositionSchema.parse({
        target: { kind: 'new', type: 'washer' },
        features: [
          {
            kind: 'fields',
            cap: 'power-source',
            fields: {
              switchOn: { kind: 'from', source: PLUG_REF, cap: 'switch', fieldPath: 'on' },
              offSeconds: { kind: 'expression', expr: '10', bindings: {} },
            },
          },
        ],
      }),
    },
  }
}

function world(
  opts: { online?: boolean; on?: boolean | null; offSeconds?: number; appliance?: boolean } = {},
) {
  const calls: { id: number; on: boolean }[] = []
  const state = {
    online: opts.online ?? true,
    on: opts.on === undefined ? true : opts.on,
  }
  const devices: PowerSourceDevices = {
    find: async (ref) => {
      if (ref.stableId === composedDeviceRef('blk-washer').stableId)
        return { id: GATEWAY_ID, name: 'Washer', online: true }
      if (ref.stableId === GATEWAY_REF.stableId)
        return { id: GATEWAY_ID, name: 'Gateway', online: true }
      if (ref.stableId === PLUG_REF.stableId)
        return { id: PLUG_ID, name: 'Gateway plug', online: state.online }
      return null
    },
    readOn: async () => state.on,
    setOn: async (id, on) => {
      calls.push({ id, on })
      state.on = on
    },
  }
  const log = recordingLogger()
  const timers = fakeScheduler()
  const service = new PowerSourceService({
    blocks: () => [opts.appliance === true ? applianceBlock() : block(opts.offSeconds)],
    devices,
    scheduler: timers.scheduler,
    logger: log.logger,
  })
  return { service, calls, state, log, timers }
}

describe('forceRestart', () => {
  it('switches off now and on only after offSeconds', async () => {
    const w = world({ offSeconds: 30 })
    expect(await w.service.forceRestart({ deviceId: GATEWAY_ID })).toEqual({
      accepted: true,
    })
    expect(w.calls).toEqual([{ id: PLUG_ID, on: false }])
    expect(w.timers.pending).toHaveLength(1)
    expect(w.timers.pending[0]?.delayMs).toBe(30_000)
    w.timers.pending[0]?.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(w.calls).toEqual([
      { id: PLUG_ID, on: false },
      { id: PLUG_ID, on: true },
    ])
  })

  it('cuts the plug of a composed appliance (a new-target composition)', async () => {
    const w = world({ appliance: true })
    expect(await w.service.forceRestart({ deviceId: GATEWAY_ID })).toEqual({
      accepted: true,
    })
    expect(w.calls).toEqual([{ id: PLUG_ID, on: false }])
  })

  it('uses 10 s when no off time is stored', async () => {
    const w = world()
    await w.service.forceRestart({ deviceId: GATEWAY_ID })
    expect(w.timers.pending[0]?.delayMs).toBe(10_000)
  })

  it('is refused, with the reason, when the switch is offline, and cuts nothing', async () => {
    const w = world({ online: false })
    const result = await w.service.forceRestart({ deviceId: GATEWAY_ID })
    expect(result).toMatchObject({ accepted: false, reason: 'switch-offline' })
    expect(w.calls).toEqual([])
    expect(w.timers.pending).toHaveLength(0)
    const warn = w.log.lines.find((l) => l.level === 'warn')
    expect(warn?.extras?.tags).toEqual({ deviceId: GATEWAY_ID })
    expect(JSON.stringify(warn?.extras?.meta)).toContain('switch-offline')
  })

  it('is refused when the switch state is unknown', async () => {
    const w = world({ on: null })
    expect(await w.service.forceRestart({ deviceId: GATEWAY_ID })).toMatchObject({
      accepted: false,
      reason: 'switch-unknown',
    })
    expect(w.calls).toEqual([])
  })

  it('is refused while a restart of the same device is in progress', async () => {
    const w = world()
    await w.service.forceRestart({ deviceId: GATEWAY_ID })
    const second = await w.service.forceRestart({ deviceId: GATEWAY_ID })
    expect(second).toMatchObject({
      accepted: false,
      reason: 'restart-in-progress',
    })
    expect(w.calls).toEqual([{ id: PLUG_ID, on: false }])
    expect((await w.service.getStatus({ deviceId: GATEWAY_ID })).restartInProgress).toBe(true)
  })

  it('accepts a new restart once the first one finished', async () => {
    const w = world()
    await w.service.forceRestart({ deviceId: GATEWAY_ID })
    w.timers.pending[0]?.fire()
    await new Promise((resolve) => setImmediate(resolve))
    expect(await w.service.forceRestart({ deviceId: GATEWAY_ID })).toEqual({
      accepted: true,
    })
  })

  it('refuses a device that has no power source', async () => {
    const w = world()
    expect(await w.service.forceRestart({ deviceId: 123 })).toMatchObject({
      accepted: false,
      reason: 'no-power-source',
    })
  })
})

describe('stop', () => {
  it('cancels the pending switch-on and logs it with the device and the switch', async () => {
    const w = world()
    await w.service.forceRestart({ deviceId: GATEWAY_ID })
    w.service.stop()
    expect(w.timers.pending[0]?.cancelled).toBe(true)
    const line = w.log.lines.find((l) => l.message.includes('cancelled'))
    expect(line?.extras?.tags).toEqual({ deviceId: GATEWAY_ID })
    expect(JSON.stringify(line?.extras?.meta)).toContain(`${PLUG_ID}`)
  })
})

describe('powerOn / powerOff / getStatus', () => {
  it('switch the linked plug and log with the device tag and the switch id', async () => {
    const w = world()
    expect(await w.service.powerOff({ deviceId: GATEWAY_ID })).toEqual({
      accepted: true,
    })
    expect(await w.service.powerOn({ deviceId: GATEWAY_ID })).toEqual({
      accepted: true,
    })
    expect(w.calls).toEqual([
      { id: PLUG_ID, on: false },
      { id: PLUG_ID, on: true },
    ])
    const info = w.log.lines.filter((l) => l.level === 'info')
    expect(info).toHaveLength(2)
    expect(info[0]?.extras?.tags).toEqual({ deviceId: GATEWAY_ID })
    expect(JSON.stringify(info[0]?.extras?.meta)).toContain(`${PLUG_ID}`)
  })

  it('reports the linked switch, its state (null when unknown) and the off time', async () => {
    const w = world({ on: null, offSeconds: 20 })
    expect(await w.service.getStatus({ deviceId: GATEWAY_ID })).toEqual({
      linked: true,
      switchDeviceId: PLUG_ID,
      switchName: 'Gateway plug',
      switchOn: null,
      switchOnline: true,
      restartInProgress: false,
      offSeconds: 20,
    })
    expect((await w.service.getStatus({ deviceId: 123 })).linked).toBe(false)
  })
})
