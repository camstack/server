/**
 * The `tsvesync` adapter behind `VeSyncClient`: a fake library manager proves the mapping —
 * one login attempt, purifiers (and only purifiers) become snapshots, and every command reaches
 * the matching library call with the library's own units (fan level, not percent).
 */
import { describe, expect, it } from 'vitest'
import {
  createTsVeSyncClientFactory,
  type TsVeSyncFan,
  type TsVeSyncLogSink,
  type TsVeSyncManager,
  type TsVeSyncManagerInput,
  VeSyncLoginError,
} from '../vesync-tsvesync-client.js'

interface FakeFanState {
  deviceStatus: string
  mode: string
  speed: number
  childLock: boolean
  screenStatus: 'on' | 'off'
}

type Call = readonly [string, ...unknown[]]

function fakeFan(
  cid: string,
  features: readonly string[],
  calls: Call[],
  over: Partial<FakeFanState> = {},
): TsVeSyncFan {
  const state: FakeFanState = {
    deviceStatus: 'on',
    mode: 'manual',
    speed: 2,
    childLock: false,
    screenStatus: 'on',
    ...over,
  }
  return {
    cid,
    deviceName: `Purifier ${cid}`,
    deviceType: 'Core300S',
    get deviceStatus() {
      return state.deviceStatus
    },
    connectionStatus: 'online',
    get mode() {
      return state.mode
    },
    get speed() {
      return state.speed
    },
    filterLife: 87,
    get screenStatus() {
      return state.screenStatus
    },
    get childLock() {
      return state.childLock
    },
    airQualityValue: 12,
    getMaxFanSpeed: () => 3,
    getSupportedModes: () => ['manual', 'auto', 'sleep'],
    hasFeature: (f) => features.includes(f),
    getDetails: async () => {
      calls.push(['getDetails', cid])
      return true
    },
    turnOn: async () => {
      calls.push(['turnOn', cid])
      return true
    },
    turnOff: async () => {
      calls.push(['turnOff', cid])
      return true
    },
    changeFanSpeed: async (level) => {
      calls.push(['changeFanSpeed', cid, level])
      return true
    },
    setMode: async (mode) => {
      calls.push(['setMode', cid, mode])
      return true
    },
    setChildLock: async (on) => {
      calls.push(['setChildLock', cid, on])
      return true
    },
    setDisplay: async (on) => {
      calls.push(['setDisplay', cid, on])
      return true
    },
  }
}

const PURIFIER = ['display', 'child_lock', 'air_quality', 'fan_speed', 'filter_life']
const HUMIDIFIER = ['display', 'humidity', 'mist']

function world(login: (log: TsVeSyncLogSink) => Promise<boolean>) {
  const calls: Call[] = []
  const seen: TsVeSyncManagerInput[] = []
  const fans: TsVeSyncFan[] = [
    fakeFan('cid-1', PURIFIER, calls),
    fakeFan('cid-2', HUMIDIFIER, calls),
    fakeFan('cid-3', ['display', 'child_lock', 'fan_speed', 'filter_life'], calls, {
      deviceStatus: 'off',
      mode: 'sleep',
    }),
  ]
  const factory = createTsVeSyncClientFactory((input): TsVeSyncManager => {
    seen.push(input)
    return {
      login: async (retryAttempts, initialDelayMs) => {
        calls.push(['login', retryAttempts, initialDelayMs])
        return login(input.logger)
      },
      getDevices: async () => {
        calls.push(['getDevices'])
        return true
      },
      fans,
    }
  })
  const client = factory({ email: 'me@example.com', password: 'pw', region: 'EU' })
  return { client, calls, seen }
}

describe('tsvesync adapter', () => {
  it('logs in exactly once with the credentials and region it was given', async () => {
    const w = world(async () => true)
    await w.client.login()
    expect(w.seen[0]).toMatchObject({ email: 'me@example.com', password: 'pw', region: 'EU' })
    expect(w.calls.filter(([name]) => name === 'login')).toEqual([['login', 1, 0]])
  })

  it('a refused login throws a typed error naming the credentials', async () => {
    const w = world(async (log) => {
      log.error('Step 1 error code:', -11201022, 'message:', 'password error')
      log.error('Credential error detected - invalid username or password')
      return false
    })
    const err = await w.client.login().then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(VeSyncLoginError)
    expect(err instanceof VeSyncLoginError ? err.kind : null).toBe('credentials')
    expect(err instanceof VeSyncLoginError ? err.message : '').not.toContain('pw')
  })

  it('lists purifiers only, refreshed, as snapshots in percent', async () => {
    const w = world(async () => true)
    await w.client.login()
    const list = await w.client.listDevices()
    expect(w.calls).toContainEqual(['getDevices'])
    expect(w.calls).toContainEqual(['getDetails', 'cid-1'])
    expect(list.map((p) => p.nativeId)).toEqual(['cid-1', 'cid-3'])
    expect(list[0]).toMatchObject({
      name: 'Purifier cid-1',
      model: 'Core300S',
      power: true,
      speedPercent: 67,
      preset: '',
      availablePresets: ['auto', 'sleep'],
      childLock: false,
      display: true,
      airQuality: 12,
      filterLifePercent: 87,
      online: true,
    })
    expect(list[0]?.percentageStep).toBeCloseTo(33.33, 1)
    expect(list[1]).toMatchObject({ power: false, speedPercent: null, preset: 'sleep' })
    expect(list[1]?.airQuality).toBeUndefined()
    expect(w.client.getDevice('cid-3')?.name).toBe('Purifier cid-3')
    expect(w.client.getDevice('cid-2')).toBeNull()
  })

  it('drives every command through the matching library call', async () => {
    const w = world(async () => true)
    await w.client.login()
    await w.client.listDevices()
    await w.client.setPower('cid-1', true)
    await w.client.setPower('cid-1', false)
    await w.client.setFanSpeed('cid-1', 100)
    await w.client.setFanSpeed('cid-1', 34)
    await w.client.setFanSpeed('cid-1', 1)
    await w.client.setMode('cid-1', 'sleep')
    await w.client.setChildLock('cid-1', true)
    await w.client.setDisplay('cid-1', false)
    const commands = w.calls.filter(
      ([name]) => !['login', 'getDevices', 'getDetails'].includes(name),
    )
    expect(commands).toEqual([
      ['turnOn', 'cid-1'],
      ['turnOff', 'cid-1'],
      ['changeFanSpeed', 'cid-1', 3],
      ['changeFanSpeed', 'cid-1', 2],
      ['changeFanSpeed', 'cid-1', 1],
      ['setMode', 'cid-1', 'sleep'],
      ['setChildLock', 'cid-1', true],
      ['setDisplay', 'cid-1', false],
    ])
  })

  it('a command for an unknown device throws naming it', async () => {
    const w = world(async () => true)
    await w.client.login()
    await expect(w.client.setPower('nope', true)).rejects.toThrow(/nope/)
  })
})
