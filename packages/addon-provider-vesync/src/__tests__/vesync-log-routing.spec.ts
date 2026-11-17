/**
 * The library logger is process-wide; each call gets the lines its own async context logged.
 *
 * - Interleaved: a poll that logs AFTER a command started keeps its lines, and the command keeps
 *   its own — both directions. A router that hands every line to the latest call fails here.
 * - A shared re-login: the library runs one sign-in for every call that needs one. A call that
 *   JOINS a sign-in another call started still receives that sign-in's lines, so it classifies
 *   the failure the same way (region, not a bare refusal).
 */
import { describe, expect, it } from 'vitest'
import {
  createTsVeSyncClientFactory,
  type TsVeSyncFan,
  type TsVeSyncLogSink,
  type TsVeSyncManager,
  VeSyncLoginError,
} from '../vesync-tsvesync-client.js'

interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

function purifier(cid: string, log: () => TsVeSyncLogSink, commandGate: Deferred): TsVeSyncFan {
  return {
    cid,
    macId: '',
    deviceName: `Purifier ${cid}`,
    deviceType: 'Core300S',
    deviceStatus: 'on',
    connectionStatus: 'online',
    mode: 'manual',
    speed: 1,
    filterLife: 90,
    screenStatus: 'on',
    childLock: false,
    airQualityValue: 5,
    getMaxFanSpeed: () => 3,
    getSupportedModes: () => ['manual', 'auto'],
    hasFeature: (f) => f === 'filter_life',
    getDetails: async () => true,
    turnOn: async () => true,
    turnOff: async () => {
      log().error('command words before the poll answered')
      await commandGate.promise
      log().error('command words after the poll answered')
      return false
    },
    changeFanSpeed: async () => true,
    setMode: async () => true,
  }
}

describe('library log routing — interleaved calls', () => {
  it('a poll logging after a command started keeps its lines, and the command keeps its own', async () => {
    let sink: TsVeSyncLogSink | null = null
    const log = (): TsVeSyncLogSink => {
      if (sink === null) throw new Error('no logger yet')
      return sink
    }
    const pollGate = deferred()
    const commandGate = deferred()
    let listing: 'ok' | 'gated' = 'ok'
    const factory = createTsVeSyncClientFactory((input): TsVeSyncManager => {
      sink = input.logger
      return {
        login: async () => true,
        getDevices: async () => {
          if (listing === 'ok') return true
          await pollGate.promise
          log().error('poll words: device list refused')
          return false
        },
        hydrateSession: () => undefined,
        fans: [purifier('cid-1', log, commandGate)],
      }
    })
    const client = factory({ email: 'me@example.com', password: 'pw', region: 'EU' })
    await client.login()
    await client.listDevices()

    listing = 'gated'
    const poll = client.listDevices().catch((e: unknown) => e)
    await tick()
    const command = client.setPower('cid-1', false).catch((e: unknown) => e)
    await tick()
    // The poll logs now — after the command started, before it ended.
    pollGate.resolve()
    const pollErr = await poll
    commandGate.resolve()
    const commandErr = await command

    const pollWords = pollErr instanceof Error ? pollErr.message : ''
    const commandWords = commandErr instanceof Error ? commandErr.message : ''
    expect(pollWords).toContain('poll words')
    expect(pollWords).not.toContain('command words')
    expect(commandWords).toContain('command words before')
    expect(commandWords).toContain('command words after')
    expect(commandWords).not.toContain('poll words')
  })
})

describe('library log routing — a shared re-login', () => {
  it('a call that joins a sign-in another call started classifies its failure the same way', async () => {
    let sink: TsVeSyncLogSink | null = null
    const log = (): TsVeSyncLogSink => {
      if (sink === null) throw new Error('no logger yet')
      return sink
    }
    const loginGate = deferred()
    /** The library's own de-duplication: one sign-in in flight, every caller awaits it. */
    let inFlight: Promise<boolean> | null = null
    const manager: TsVeSyncManager = {
      login: () => {
        if (inFlight !== null) return inFlight
        inFlight = (async (): Promise<boolean> => {
          await loginGate.promise
          log().error('Login failed: auth code expired')
          return false
        })().finally(() => {
          inFlight = null
        })
        return inFlight
      },
      getDevices: async () => {
        log().debug('Device list request returned a token error; re-authenticating and retrying')
        const ok = await manager.login()
        if (ok) return true
        log().error(
          'VeSync rejected the stored session and re-authentication failed. Check the configured username/password.',
        )
        return false
      },
      hydrateSession: () => undefined,
      fans: [],
    }
    const factory = createTsVeSyncClientFactory((input): TsVeSyncManager => {
      sink = input.logger
      return manager
    })
    const client = factory({ email: 'me@example.com', password: 'pw', region: 'EU' })

    const first = client.listDevices().catch((e: unknown) => e)
    await tick()
    const joiner = client.listDevices().catch((e: unknown) => e)
    await tick()
    loginGate.resolve()
    const [firstErr, joinerErr] = await Promise.all([first, joiner])

    expect(firstErr).toBeInstanceOf(VeSyncLoginError)
    expect(joinerErr).toBeInstanceOf(VeSyncLoginError)
    const kinds = [firstErr, joinerErr].map((e) => (e instanceof VeSyncLoginError ? e.kind : null))
    expect(kinds).toEqual(['region', 'region'])
  })
})
