import {
  type CapCall,
  EMPTY_REMOTE_CONFIG,
  type MediaPlayerStatus,
  type RemoteAssumedState,
  type RemoteConfig,
  customRole,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RemoteService, type RemoteServiceDeps } from '../remote-service.js'
import { recordingLogger } from './fixtures.js'

const TV = 12
const BOARD = 3

function ir(code: string): RemoteConfig['bindings'][string] {
  return {
    action: {
      kind: 'cap',
      deviceId: BOARD,
      cap: 'ir-transmitter',
      method: 'send',
      args: { timings: [9000, -4500], tag: code },
    },
  }
}

function config(patch: Partial<RemoteConfig> = {}): RemoteConfig {
  return { ...EMPTY_REMOTE_CONFIG, ...patch }
}

function nativeStatus(state: MediaPlayerStatus['state']): MediaPlayerStatus {
  return {
    state,
    stateSource: 'reported',
    assumedFields: [],
    volumeLevel: null,
    isMuted: null,
    source: '',
    availableSources: [],
    currentMedia: null,
    position: null,
    duration: null,
    shuffle: null,
    repeat: null,
    lastChangedAt: 1,
  }
}

function world(
  initial: RemoteConfig,
  options: {
    readonly failOn?: number
    readonly reported?: MediaPlayerStatus | null
    readonly templates?: readonly string[]
    readonly mediaPlayer?: boolean
    readonly running?: boolean | null
    readonly assumptions?: { current: RemoteAssumedState | null }
  } = {},
) {
  let stored: RemoteConfig = initial
  const kept = options.assumptions ?? { current: null }
  const calls: CapCall[] = []
  const deps: RemoteServiceDeps = {
    store: {
      read: async () => stored,
      write: async (_id, next) => {
        stored = next
      },
    },
    invoke: async (call) => {
      calls.push(call)
      if (options.failOn !== undefined && calls.length === options.failOn) {
        throw new Error('board is off')
      }
    },
    templateExists: async (id) => (options.templates ?? ['tpl']).includes(id),
    isMediaPlayer: async () => options.mediaPlayer ?? true,
    reportedStatus: async () => options.reported ?? null,
    runningState: async () => options.running ?? null,
    assumptions: {
      read: async () => kept.current,
      write: async (_id, next) => {
        kept.current = next
      },
    },
    logger: recordingLogger().logger,
    now: () => 5,
  }
  return { service: new RemoteService(deps), calls, stored: () => stored }
}

describe('RemoteService.sendCommand', () => {
  it('runs the bound action once by default and repeat times when asked', async () => {
    const w = world(config({ bindings: { volume_up: ir('vol') } }))
    expect(await w.service.sendCommand({ deviceId: TV, role: 'volume_up', repeat: 1 })).toEqual({
      status: 'sent',
      sends: 1,
    })
    expect(await w.service.sendCommand({ deviceId: TV, role: 'volume_up', repeat: 5 })).toEqual({
      status: 'sent',
      sends: 5,
    })
    expect(w.calls).toHaveLength(6)
    expect(w.calls[0]).toMatchObject({ deviceId: BOARD, cap: 'ir-transmitter', method: 'send' })
  })

  it('refuses an unbound role without calling anything', async () => {
    const w = world(config())
    expect(await w.service.sendCommand({ deviceId: TV, role: 'mute', repeat: 1 })).toMatchObject({
      status: 'refused',
      reason: 'unbound-role',
    })
    expect(w.calls).toEqual([])
  })

  it('stops at the first failing send and reports the cause', async () => {
    const w = world(config({ bindings: { volume_up: ir('vol') } }), { failOn: 2 })
    expect(
      await w.service.sendCommand({ deviceId: TV, role: 'volume_up', repeat: 4 }),
    ).toMatchObject({
      status: 'refused',
      reason: 'action-failed',
      detail: expect.stringContaining('board is off'),
    })
    expect(w.calls).toHaveLength(2)
  })

  it('sends a custom button by its custom: role', async () => {
    const w = world(
      config({
        bindings: { [customRole('hdmi1')]: ir('hdmi') },
        customButtons: [{ key: 'hdmi1', name: 'HDMI 1' }],
      }),
    )
    expect(
      await w.service.sendCommand({ deviceId: TV, role: customRole('hdmi1'), repeat: 1 }),
    ).toMatchObject({ status: 'sent' })
  })
})

describe('power on a toggle remote', () => {
  const toggle = config({ bindings: { power: ir('pwr') }, power: { mode: 'toggle' } })

  it('sends only when the current state differs from the requested one', async () => {
    const w = world(toggle, { reported: nativeStatus('off') })
    expect(await w.service.sendMediaCommand({ deviceId: TV, command: 'stop', repeat: 1 })).toEqual({
      status: 'skipped',
      reason: 'already-in-state',
    })
    expect(w.calls).toEqual([])
    expect(
      await w.service.sendMediaCommand({ deviceId: TV, command: 'play', repeat: 1 }),
    ).toMatchObject({
      status: 'sent',
    })
    expect(w.calls).toHaveLength(1)
  })

  it('assumes the requested state after a send when nothing reports one', async () => {
    const w = world(toggle)
    await w.service.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 })
    expect(w.calls).toHaveLength(1)
    // already assumed on: a second power_on sends nothing
    expect(await w.service.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 })).toEqual({
      status: 'skipped',
      reason: 'already-in-state',
    })
    expect(w.calls).toHaveLength(1)
    expect(await w.service.assumedStatus(TV)).toMatchObject({ state: 'on', stateSource: 'assumed' })
    await w.service.sendCommand({ deviceId: TV, role: 'power_off', repeat: 1 })
    expect(w.calls).toHaveLength(2)
    expect(await w.service.assumedStatus(TV)).toMatchObject({ state: 'off' })
  })

  it('does not move the assumption when the send fails', async () => {
    const w = world(toggle, { failOn: 1 })
    await w.service.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 })
    expect(await w.service.assumedStatus(TV)).toBeNull()
  })

  it('prefers the running source over the assumption', async () => {
    const w = world(toggle, { reported: nativeStatus('on') })
    // the source reads `on` and nothing was assumed yet: a power_on is skipped on the reading
    expect(
      await w.service.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 }),
    ).toMatchObject({
      status: 'skipped',
    })
    expect(w.calls).toHaveLength(0)
  })

  it('a discrete remote always sends', async () => {
    const w = world(
      config({
        bindings: { power_on: ir('on'), power_off: ir('off') },
        power: { mode: 'discrete' },
      }),
    )
    await w.service.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 })
    await w.service.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 })
    expect(w.calls).toHaveLength(2)
  })
})

describe('the power source', () => {
  const toggle = config({ bindings: { power: ir('pwr') }, power: { mode: 'toggle' } })

  it('reads the running-state source before anything else', async () => {
    const on = world(toggle, { running: true })
    expect(await on.service.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 })).toEqual({
      status: 'skipped',
      reason: 'already-in-state',
    })
    const off = world(toggle, { running: false })
    expect(
      await off.service.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 }),
    ).toMatchObject({ status: 'sent' })
    expect(off.calls).toHaveLength(1)
  })

  it('a running-state reading outranks a stale assumption', async () => {
    const assumptions = { current: null as RemoteAssumedState | null }
    const first = world(toggle, { assumptions })
    await first.service.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 })
    const second = world(toggle, { assumptions, running: false })
    expect(
      await second.service.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 }),
    ).toMatchObject({ status: 'sent' })
  })

  it('reports the power as read and lists no assumed field when the source answers', async () => {
    const w = world(toggle, { running: true })
    expect(await w.service.assumedStatus(TV)).toMatchObject({
      state: 'on',
      stateSource: 'reported',
      assumedFields: [],
    })
  })

  it('keeps an assumption across a restart', async () => {
    const assumptions = { current: null as RemoteAssumedState | null }
    const before = world(toggle, { assumptions })
    await before.service.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 })
    const after = world(toggle, { assumptions })
    expect(await after.service.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 })).toEqual({
      status: 'skipped',
      reason: 'already-in-state',
    })
    expect(await after.service.assumedStatus(TV)).toMatchObject({
      state: 'on',
      stateSource: 'assumed',
      assumedFields: ['state'],
    })
  })
})

describe('mute on a device that does not report it', () => {
  const withMute = config({ bindings: { mute: ir('mute'), power: ir('pwr') } })

  it('sends when the state is unknown and marks the field assumed', async () => {
    const w = world(withMute, { running: true })
    expect(
      await w.service.sendMediaCommand({
        deviceId: TV,
        command: 'setMute',
        muted: true,
        repeat: 1,
      }),
    ).toMatchObject({ status: 'sent' })
    expect(await w.service.assumedStatus(TV)).toMatchObject({
      isMuted: true,
      stateSource: 'assumed',
      assumedFields: ['isMuted'],
    })
  })

  it('does not resend a mute the assumption already holds, and flips on the opposite', async () => {
    const w = world(withMute, { running: true })
    await w.service.sendMediaCommand({ deviceId: TV, command: 'setMute', muted: true, repeat: 1 })
    expect(
      await w.service.sendMediaCommand({
        deviceId: TV,
        command: 'setMute',
        muted: true,
        repeat: 1,
      }),
    ).toEqual({ status: 'skipped', reason: 'already-in-state' })
    expect(
      await w.service.sendMediaCommand({
        deviceId: TV,
        command: 'setMute',
        muted: false,
        repeat: 1,
      }),
    ).toMatchObject({ status: 'sent' })
    expect(w.calls).toHaveLength(2)
    expect(await w.service.assumedStatus(TV)).toMatchObject({ isMuted: false })
  })

  it('a native reading of the mute outranks the assumption', async () => {
    const reported = { ...nativeStatus('on'), isMuted: true }
    const w = world(withMute, { reported })
    expect(
      await w.service.sendMediaCommand({
        deviceId: TV,
        command: 'setMute',
        muted: true,
        repeat: 1,
      }),
    ).toEqual({ status: 'skipped', reason: 'already-in-state' })
  })
})

describe('RemoteService.sendMediaCommand', () => {
  it('routes a bound media command and passes the caller count through', async () => {
    const w = world(config({ bindings: { next: ir('nx') } }))
    expect(await w.service.sendMediaCommand({ deviceId: TV, command: 'next', repeat: 3 })).toEqual({
      status: 'sent',
      sends: 3,
    })
  })

  it('answers not-routed for an unbound role so the native cap runs', async () => {
    const w = world(config())
    expect(await w.service.sendMediaCommand({ deviceId: TV, command: 'pause', repeat: 1 })).toEqual(
      {
        status: 'not-routed',
      },
    )
    expect(w.calls).toEqual([])
  })

  it('answers not-routed for a device with no remote at all', async () => {
    const w = world(config({ bindings: {} }), { mediaPlayer: false })
    expect(await w.service.sendMediaCommand({ deviceId: TV, command: 'play', repeat: 1 })).toEqual({
      status: 'not-routed',
    })
  })

  it('maps selectSource to the custom button of that name', async () => {
    const w = world(
      config({
        bindings: { [customRole('hdmi1')]: ir('hdmi') },
        customButtons: [{ key: 'hdmi1', name: 'HDMI 1' }],
      }),
    )
    expect(
      await w.service.sendMediaCommand({
        deviceId: TV,
        command: 'selectSource',
        source: 'HDMI 1',
        repeat: 1,
      }),
    ).toMatchObject({ status: 'sent' })
    expect(
      await w.service.sendMediaCommand({
        deviceId: TV,
        command: 'selectSource',
        source: 'Nope',
        repeat: 1,
      }),
    ).toEqual({ status: 'not-routed' })
  })

  it('maps setMute to the mute role', async () => {
    const w = world(config({ bindings: { mute: ir('m') } }))
    expect(
      await w.service.sendMediaCommand({
        deviceId: TV,
        command: 'setMute',
        muted: true,
        repeat: 1,
      }),
    ).toMatchObject({ status: 'sent' })
  })
})

describe('RemoteService config', () => {
  it('round-trips a config and lists only bound roles', async () => {
    const w = world(config())
    const next = config({
      layoutTemplateId: 'tpl',
      bindings: { power: ir('p'), volume_up: ir('v') },
      power: { mode: 'toggle' },
    })
    expect(await w.service.setConfig({ deviceId: TV, config: next })).toEqual({ status: 'saved' })
    expect(await w.service.getConfig({ deviceId: TV })).toEqual(next)
    const list = await w.service.listCommands({ deviceId: TV })
    expect(list.commands.map((c) => c.role).toSorted()).toEqual(['power', 'volume_up'])
    expect(list.layoutTemplateId).toBe('tpl')
  })

  it('refuses a template that does not exist and a device that is not a media player', async () => {
    const w = world(config())
    expect(
      await w.service.setConfig({ deviceId: TV, config: config({ layoutTemplateId: 'ghost' }) }),
    ).toMatchObject({ status: 'refused', reason: 'unknown-template' })
    const other = world(config(), { mediaPlayer: false })
    expect(await other.service.setConfig({ deviceId: TV, config: config() })).toMatchObject({
      status: 'refused',
      reason: 'not-a-media-player',
    })
    expect(w.stored().layoutTemplateId).toBeNull()
  })
})
