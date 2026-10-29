import {
  EMPTY_REMOTE_CONFIG,
  type CapCall,
  type MediaPlayerStatus,
  type RemoteAssumedState,
  type RemoteConfig,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { remoteCallRedirect } from '../remote-call-redirect.js'
import { RemoteService } from '../remote-service.js'
import { recordingLogger } from './fixtures.js'

const TV = 12
const BOARD = 3

const ir: RemoteConfig['bindings'][string] = {
  action: {
    kind: 'cap',
    deviceId: BOARD,
    cap: 'ir-transmitter',
    method: 'send',
    args: { timings: [9000, -4500] },
  },
}

function world(config: RemoteConfig, native = false) {
  const calls: CapCall[] = []
  const kept = { current: null as RemoteAssumedState | null }
  const remote = new RemoteService({
    store: { read: async () => config, write: async () => undefined },
    invoke: async (call) => {
      calls.push(call)
    },
    templateExists: async () => true,
    isMediaPlayer: async () => true,
    reportedStatus: async () => null,
    runningState: async () => null,
    assumptions: {
      read: async () => kept.current,
      write: async (_id, next) => {
        kept.current = next
      },
    },
    logger: recordingLogger().logger,
    now: () => 9,
  })
  const redirect = remoteCallRedirect({
    remote,
    hasNative: () => native,
    logger: recordingLogger().logger,
  })
  return { redirect, calls, remote }
}

const call = (method: string, args: Record<string, unknown> = {}) => ({
  capName: 'media-player',
  method,
  deviceId: TV,
  args: { deviceId: TV, ...args },
})

describe('remoteCallRedirect — precedence at dispatch (D963)', () => {
  it('covers the media-player commands and getStatus, nothing else', () => {
    const { redirect } = world(EMPTY_REMOTE_CONFIG)
    for (const m of [
      'play',
      'pause',
      'stop',
      'next',
      'previous',
      'setMute',
      'selectSource',
      'getStatus',
    ]) {
      expect(redirect.covers('media-player', m)).toBe(true)
    }
    expect(redirect.covers('media-player', 'setVolume')).toBe(false)
    expect(redirect.covers('battery', 'play')).toBe(false)
  })

  it('a bound role runs the binding and answers; the native cap never runs', async () => {
    const { redirect, calls } = world({ ...EMPTY_REMOTE_CONFIG, bindings: { next: ir } })
    expect(await redirect.attempt(call('next'))).toEqual({ kind: 'redirected', result: undefined })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ deviceId: BOARD, cap: 'ir-transmitter' })
  })

  it('passes the caller count through (volume-style repeat)', async () => {
    const { redirect, calls } = world({ ...EMPTY_REMOTE_CONFIG, bindings: { next: ir } })
    await redirect.attempt(call('next', { repeat: 4 }))
    expect(calls).toHaveLength(4)
  })

  it('an unbound role falls through to the native cap', async () => {
    const { redirect, calls } = world(EMPTY_REMOTE_CONFIG)
    expect(await redirect.attempt(call('pause'))).toEqual({ kind: 'not-redirected' })
    expect(calls).toEqual([])
  })

  it('a refused binding fails the call instead of silently running the native cap', async () => {
    const calls: CapCall[] = []
    const remote = new RemoteService({
      store: {
        read: async () => ({ ...EMPTY_REMOTE_CONFIG, bindings: { next: ir } }),
        write: async () => undefined,
      },
      invoke: async (c) => {
        calls.push(c)
        throw new Error('board is off')
      },
      templateExists: async () => true,
      isMediaPlayer: async () => true,
      reportedStatus: async () => null,
      runningState: async () => null,
      assumptions: { read: async () => null, write: async () => undefined },
      logger: recordingLogger().logger,
    })
    const redirect = remoteCallRedirect({
      remote,
      hasNative: () => true,
      logger: recordingLogger().logger,
    })
    await expect(redirect.attempt(call('next'))).rejects.toThrow(/board is off/)
  })

  it('setMute and selectSource carry their arguments to the role resolution', async () => {
    const { redirect, calls } = world({
      ...EMPTY_REMOTE_CONFIG,
      bindings: { mute: ir, 'custom:hdmi1': ir },
      customButtons: [{ key: 'hdmi1', name: 'HDMI 1' }],
    })
    await redirect.attempt(call('setMute', { muted: true }))
    await redirect.attempt(call('selectSource', { source: 'HDMI 1' }))
    expect(calls).toHaveLength(2)
  })
})

describe('remoteCallRedirect — the state hook (D963)', () => {
  const toggle: RemoteConfig = {
    ...EMPTY_REMOTE_CONFIG,
    bindings: { power: ir },
    power: { mode: 'toggle' },
  }

  it('serves the assumed state when no running source exists, marked assumed', async () => {
    const { redirect } = world(toggle, false)
    await redirect.attempt(call('play'))
    const status = await redirect.attempt(call('getStatus'))
    expect(status.kind).toBe('redirected')
    const slice: MediaPlayerStatus | undefined =
      status.kind === 'redirected' ? (status.result as MediaPlayerStatus) : undefined
    expect(slice).toMatchObject({ state: 'on', stateSource: 'assumed' })
  })

  it('leaves getStatus to the running source when one exists', async () => {
    const { redirect } = world(toggle, true)
    await redirect.attempt(call('play'))
    expect(await redirect.attempt(call('getStatus'))).toEqual({ kind: 'not-redirected' })
  })

  it('answers nothing before anything was sent', async () => {
    const { redirect } = world(toggle, false)
    expect(await redirect.attempt(call('getStatus'))).toEqual({ kind: 'not-redirected' })
  })
})
