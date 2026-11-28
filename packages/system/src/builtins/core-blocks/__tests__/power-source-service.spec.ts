import {
  composedDeviceRef,
  CompositionSchema,
  type IdentityLink,
  type IdentityLinksRead,
  SWITCH_DEFAULT_OPTIONS,
  type SwitchOptions,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  PowerSourceService,
  type PowerSourceDevices,
  type PowerSourceScheduler,
  SwitchOptionsUnreadableError,
} from '../power-source-service.js'
import { recordingLogger } from './fixtures.js'

const GATEWAY_REF = { addonId: 'ha', stableId: 'gateway' }
const PLUG_REF = { addonId: 'ha', stableId: 'plug' }
const GATEWAY_ID = 7
const PLUG_ID = 9

function block(offSeconds?: number, stampedBy?: string) {
  return {
    id: 'blk-existing',
    source: {
      kind: 'composition' as const,
      composition: CompositionSchema.parse({
        target: { kind: 'existing', device: GATEWAY_REF },
        features: [
          {
            kind: 'fields',
            customizeKind: 'power-source',
            cap: 'power-source',
            ...(stampedBy === undefined ? {} : { contributedBy: { linkId: stampedBy } }),
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
function applianceBlock(plugIsActuator = false) {
  const actuator = {
    kind: 'fields',
    cap: 'switch',
    fields: { on: { kind: 'from', source: PLUG_REF, cap: 'switch', fieldPath: 'on' } },
  }
  return {
    id: 'blk-washer',
    source: {
      kind: 'composition' as const,
      composition: CompositionSchema.parse({
        target: { kind: 'new', type: 'washer' },
        features: [
          ...(plugIsActuator ? [actuator] : []),
          {
            kind: 'fields',
            customizeKind: 'power-source',
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
  opts: {
    online?: boolean
    on?: boolean | null
    offSeconds?: number
    appliance?: boolean
    plugIsActuator?: boolean
    /** The switch's native cycle: absent = the provider wires none, 'fails' = the call throws. */
    nativeCycle?: 'declared' | 'not-declared' | 'fails'
    /** What the switch's options read answers: absent = the wiring reads none, 'fails' = it throws. */
    options?: SwitchOptions | 'fails'
    /** The feature is stamped `contributedBy` this identity link (D1063). */
    stampedBy?: string
    /** What `listIdentityLinks` answers: 'fails' = the read throws. */
    links?: IdentityLinksRead | 'fails'
  } = {},
) {
  const calls: { id: number; on: boolean }[] = []
  const cycles: number[] = []
  const state: { online: boolean; on: boolean | null; options: SwitchOptions | 'fails' } = {
    online: opts.online ?? true,
    on: opts.on === undefined ? true : opts.on,
    options: opts.options ?? SWITCH_DEFAULT_OPTIONS,
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
    ...(opts.options === undefined
      ? {}
      : {
          options: async (id: number): Promise<SwitchOptions> => {
            if (state.options === 'fails')
              throw new SwitchOptionsUnreadableError(id, new Error('request timed out'))
            return state.options
          },
        }),
    ...(opts.nativeCycle === undefined
      ? {}
      : {
          cycle: async (id: number) => {
            if (opts.nativeCycle === 'fails') throw new Error('POWER_CYCLE refused')
            if (opts.nativeCycle === 'not-declared') return false
            cycles.push(id)
            return true
          },
        }),
  }
  const log = recordingLogger()
  const timers = fakeScheduler()
  const linkReads: { count: number; lostKicks: number[] } = { count: 0, lostKicks: [] }
  const service = new PowerSourceService({
    blocks: () => [
      opts.appliance === true
        ? applianceBlock(opts.plugIsActuator === true)
        : block(opts.offSeconds, opts.stampedBy),
    ],
    devices,
    links: {
      read: async () => {
        linkReads.count++
        if (opts.links === 'fails') throw new Error('device-manager unreachable')
        return opts.links ?? { status: 'answered', links: [] }
      },
      lost: (deviceId) => {
        linkReads.lostKicks.push(deviceId)
      },
    },
    scheduler: timers.scheduler,
    logger: log.logger,
  })
  return { service, calls, cycles, state, log, timers, linkReads }
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

  it('uses the switch’s native power cycle once when it declares one, and never switches off/on', async () => {
    const w = world({ nativeCycle: 'declared' })
    expect(await w.service.forceRestart({ deviceId: GATEWAY_ID })).toEqual({ accepted: true })
    expect(w.cycles).toEqual([PLUG_ID])
    expect(w.calls).toEqual([])
    expect(w.timers.pending).toHaveLength(0)
    // The native cycle is one call: the restart slot is free again at once.
    expect(await w.service.forceRestart({ deviceId: GATEWAY_ID })).toEqual({ accepted: true })
    expect(w.cycles).toEqual([PLUG_ID, PLUG_ID])
  })

  it('switches off and on when the switch declares no native cycle', async () => {
    const w = world({ nativeCycle: 'not-declared' })
    expect(await w.service.forceRestart({ deviceId: GATEWAY_ID })).toEqual({ accepted: true })
    expect(w.cycles).toEqual([])
    expect(w.calls).toEqual([{ id: PLUG_ID, on: false }])
    expect(w.timers.pending).toHaveLength(1)
  })

  it('is refused, with the reason, when the native cycle fails, and switches nothing', async () => {
    const w = world({ nativeCycle: 'fails' })
    expect(await w.service.forceRestart({ deviceId: GATEWAY_ID })).toMatchObject({
      accepted: false,
      reason: 'switch-call-failed',
    })
    expect(w.calls).toEqual([])
    expect(w.timers.pending).toHaveLength(0)
    const warn = w.log.lines.find((l) => l.level === 'warn')
    expect(warn?.extras?.tags).toEqual({ deviceId: GATEWAY_ID })
  })

  it('cuts the plug of a composed appliance (a new-target composition)', async () => {
    const w = world({ appliance: true })
    expect(await w.service.forceRestart({ deviceId: GATEWAY_ID })).toEqual({
      accepted: true,
    })
    expect(w.calls).toEqual([{ id: PLUG_ID, on: false }])
  })

  it('is refused when a stored link names the device’s own actuator plug, and cuts nothing', async () => {
    const w = world({ appliance: true, plugIsActuator: true })
    for (const call of [w.service.forceRestart, w.service.powerOff, w.service.powerOn]) {
      expect(await call({ deviceId: GATEWAY_ID })).toMatchObject({
        accepted: false,
        reason: 'switch-is-actuator',
      })
    }
    expect(w.calls).toEqual([])
    expect(w.timers.pending).toHaveLength(0)
    const warn = w.log.lines.find((l) => l.level === 'warn')
    expect(warn?.extras?.tags).toEqual({ deviceId: GATEWAY_ID })
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
      switchSettable: true,
      restartInProgress: false,
      offSeconds: 20,
    })
    expect((await w.service.getStatus({ deviceId: 123 })).linked).toBe(false)
  })
})

describe('a linked switch that only reports (D1058)', () => {
  const REPORTS_ONLY: SwitchOptions = {
    supportsSetState: false,
    supportsPowerCycle: true,
  }

  it('power on / off are refused as not-settable before the switch is called, logged with the device', async () => {
    const w = world({ options: REPORTS_ONLY })
    for (const result of [
      await w.service.powerOn({ deviceId: GATEWAY_ID }),
      await w.service.powerOff({ deviceId: GATEWAY_ID }),
    ]) {
      expect(result).toMatchObject({ accepted: false, reason: 'not-settable' })
      expect(result.accepted ? '' : result.message).toContain('Gateway plug')
    }
    expect(w.calls).toEqual([])
    const warn = w.log.lines.filter((l) => l.level === 'warn')
    expect(warn).toHaveLength(2)
    expect(warn[0]?.extras?.tags).toEqual({ deviceId: GATEWAY_ID })
  })

  it('a FAILED options read changes nothing: power on / off still reach the switch (D315)', async () => {
    const w = world({ options: 'fails' })
    expect(await w.service.powerOff({ deviceId: GATEWAY_ID })).toEqual({
      accepted: true,
    })
    expect(w.calls).toEqual([{ id: PLUG_ID, on: false }])
  })

  it('getStatus says whether the linked switch can be set: false, true, or null when unread', async () => {
    const settable = async (options?: SwitchOptions | 'fails') =>
      (
        await world({
          ...(options === undefined ? {} : { options }),
        }).service.getStatus({
          deviceId: GATEWAY_ID,
        })
      ).switchSettable
    expect(await settable(REPORTS_ONLY)).toBe(false)
    expect(await settable({ supportsSetState: true, supportsPowerCycle: false })).toBe(true)
    expect(await settable('fails')).toBeNull()
    expect(await settable()).toBe(true)
    expect(
      (
        await world({ options: REPORTS_ONLY }).service.getStatus({
          deviceId: 123,
        })
      ).switchSettable,
    ).toBeNull()
  })

  it('the forced restart is unchanged: a reports-only port with a native cycle restarts', async () => {
    const w = world({ options: REPORTS_ONLY, nativeCycle: 'declared' })
    expect(await w.service.forceRestart({ deviceId: GATEWAY_ID })).toEqual({
      accepted: true,
    })
    expect(w.cycles).toEqual([PLUG_ID])
  })

  it('a failing options read warns once per failure streak, per device; a success re-arms it', async () => {
    const w = world({ options: 'fails' })
    const optionsWarns = () =>
      w.log.lines.filter(
        (l) => l.level === 'warn' && l.message.includes('options could not be read'),
      )
    for (let i = 0; i < 3; i++) await w.service.getStatus({ deviceId: GATEWAY_ID })
    expect(optionsWarns()).toHaveLength(1)
    expect(optionsWarns()[0]?.extras?.tags).toEqual({ deviceId: GATEWAY_ID })

    w.state.options = { supportsSetState: true, supportsPowerCycle: false }
    await w.service.getStatus({ deviceId: GATEWAY_ID })
    w.state.options = 'fails'
    await w.service.getStatus({ deviceId: GATEWAY_ID })
    await w.service.getStatus({ deviceId: GATEWAY_ID })
    expect(optionsWarns()).toHaveLength(2)
  })
})

/** A poe-power link from the port (`a`) to the gateway (`b`), in `state`. */
function poeLink(
  state: IdentityLink['state'],
  port: { addonId: string; stableId: string } = PLUG_REF,
): IdentityLink {
  return {
    id: 'L1',
    kind: 'poe-power',
    a: { ...port, deviceId: PLUG_ID },
    b: { ...GATEWAY_REF, deviceId: GATEWAY_ID },
    state,
    origin: 'auto',
    evidence: [],
    createdAt: 1,
  }
}

describe('a power-source contributed by an identity link (D1063): checked at the point of use', () => {
  it('acts when the link is still linked and names the port it reads', async () => {
    const w = world({ stampedBy: 'L1', links: { status: 'answered', links: [poeLink('linked')] } })
    expect(await w.service.forceRestart({ deviceId: GATEWAY_ID })).toEqual({ accepted: true })
    expect(w.calls).toEqual([{ id: PLUG_ID, on: false }])
    expect(w.linkReads.count).toBe(1)
  })

  it.each([
    ['dismissed', { status: 'answered', links: [poeLink('dismissed')] }],
    ['proposed', { status: 'answered', links: [poeLink('proposed')] }],
    ['gone', { status: 'answered', links: [] }],
    [
      'linked by the operator but its evidence is gone',
      {
        status: 'answered',
        // The camera moved to port 9 (auto-linked there); port 7 now feeds another camera.
        links: [
          { ...poeLink('linked'), origin: 'operator', evidenceGone: true },
          { ...poeLink('linked', { addonId: 'ha', stableId: 'port-9' }), id: 'L9' },
        ],
      },
    ],
    [
      'moved to another port',
      { status: 'answered', links: [poeLink('linked', { addonId: 'ha', stableId: 'port-9' })] },
    ],
  ] as const)('refuses as link-lost when the link is %s, never touches the switch, and kicks a reconcile', async (_label, links) => {
    const w = world({ stampedBy: 'L1', links })
    const restart = await w.service.forceRestart({ deviceId: GATEWAY_ID })
    expect(restart).toMatchObject({ accepted: false, reason: 'link-lost' })
    const off = await w.service.powerOff({ deviceId: GATEWAY_ID })
    expect(off).toMatchObject({ accepted: false, reason: 'link-lost' })
    expect(w.calls).toEqual([])
    expect(w.linkReads.lostKicks).toEqual([GATEWAY_ID, GATEWAY_ID])
    expect(
      w.log.lines.some(
        (l) =>
          l.level === 'warn' &&
          l.message.includes('link-lost') &&
          l.extras?.tags?.deviceId === GATEWAY_ID,
      ),
    ).toBe(true)
  })

  it.each([
    ['the read fails', 'fails'],
    ['device-manager has not loaded the links', { status: 'not-loaded', reason: 'booting' }],
  ] as const)('refuses as link-unknown when %s (destructive work, D49)', async (_label, links) => {
    const w = world({ stampedBy: 'L1', links })
    expect(await w.service.forceRestart({ deviceId: GATEWAY_ID })).toMatchObject({
      accepted: false,
      reason: 'link-unknown',
    })
    expect(await w.service.powerOn({ deviceId: GATEWAY_ID })).toMatchObject({
      accepted: false,
      reason: 'link-unknown',
    })
    expect(w.calls).toEqual([])
    expect(w.linkReads.lostKicks).toEqual([])
  })

  it('an operator-written power-source never reads the links', async () => {
    const w = world({ links: 'fails' })
    expect(await w.service.forceRestart({ deviceId: GATEWAY_ID })).toEqual({ accepted: true })
    expect(w.linkReads.count).toBe(0)
  })
})
