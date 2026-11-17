/**
 * A command never queues behind a poll. The library logger is process-wide, so the adapter used to
 * run every library call — a whole device list included — through one serialized queue to keep
 * each call's log lines apart; a command then waited for the full poll (`getDevices` plus one
 * `getDetails` per device). The lines are now attributed per call through the async context, so
 * a command runs at once and still reports only its own words.
 *
 * Also here: a single-device refresh (the read a command is followed by), and humidifiers listed
 * and driven as humidifiers.
 */
import { describe, expect, it } from 'vitest'
import {
  createTsVeSyncClientFactory,
  type TsVeSyncFan,
  type TsVeSyncHumidifier,
  type TsVeSyncLogSink,
  type TsVeSyncManager,
} from '../vesync-tsvesync-client.js'

type Call = readonly [string, ...unknown[]]

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

const PURIFIER = ['display', 'child_lock', 'air_quality', 'fan_speed', 'filter_life']

/** A purifier whose `getDetails` waits on `gate.current` when one is armed. */
function purifier(
  cid: string,
  calls: Call[],
  log: () => TsVeSyncLogSink,
  gate: { current: Deferred | null },
  state: { deviceStatus: string; speed: number },
): TsVeSyncFan {
  return {
    cid,
    macId: '',
    deviceName: `Purifier ${cid}`,
    deviceType: 'Core300S',
    get deviceStatus() {
      return state.deviceStatus
    },
    connectionStatus: 'online',
    mode: 'manual',
    get speed() {
      return state.speed
    },
    filterLife: 90,
    screenStatus: 'on',
    childLock: false,
    airQualityValue: 5,
    getMaxFanSpeed: () => 3,
    getSupportedModes: () => ['manual', 'auto', 'sleep'],
    hasFeature: (f) => PURIFIER.includes(f),
    getDetails: async () => {
      calls.push(['getDetails', cid])
      const g = gate.current
      if (g !== null) {
        log().error('poll noise while reading details')
        await g.promise
      }
      return true
    },
    turnOn: async () => {
      calls.push(['turnOn', cid])
      state.deviceStatus = 'on'
      return true
    },
    turnOff: async () => {
      calls.push(['turnOff', cid])
      log().error('Device refused: offline')
      return false
    },
    changeFanSpeed: async (level) => {
      calls.push(['changeFanSpeed', cid, level])
      return true
    },
    setMode: async (mode) => {
      calls.push(['setMode', cid, mode])
      return true
    },
  }
}

interface HumidState {
  deviceStatus: string
  mode: string
  humidity: number
  target: number
  /** What the library's detail read answers; `false` leaves the class defaults in place. */
  detailsOk?: boolean
}

/** A humidifier shaped like tsvesync's base `VeSyncHumidifier` (target only in `details`). */
function humidifier(cid: string, calls: Call[], state: HumidState): TsVeSyncHumidifier {
  return {
    cid,
    macId: 'AA:BB:CC:DD:EE:FF',
    deviceName: `Humidifier ${cid}`,
    deviceType: 'Classic300S',
    get deviceStatus() {
      return state.deviceStatus
    },
    connectionStatus: 'online',
    get mode() {
      return state.mode
    },
    speed: 0,
    filterLife: 0,
    screenStatus: 'off',
    childLock: false,
    airQualityValue: 0,
    getMaxFanSpeed: () => 3,
    getSupportedModes: (defaults) => defaults ?? [],
    hasFeature: (f) => ['display', 'humidity', 'mist', 'timer', 'auto_mode'].includes(f),
    get currentHumidity() {
      return state.humidity
    },
    waterLacks: true,
    get details() {
      return {
        humidity: state.humidity,
        display: true,
        configuration: { auto_target_humidity: state.target },
      }
    },
    modes: ['auto', 'manual', 'sleep'],
    humidityRange: { min: 30, max: 80 },
    getDetails: async () => {
      calls.push(['getDetails', cid])
      return state.detailsOk ?? true
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
      state.mode = mode
      return true
    },
    setDisplay: async (on) => {
      calls.push(['setDisplay', cid, on])
      return true
    },
    setHumidity: async (h) => {
      calls.push(['setHumidity', cid, h])
      state.target = h
      return true
    },
  }
}

function world() {
  const calls: Call[] = []
  const gate: { current: Deferred | null } = { current: null }
  let sink: TsVeSyncLogSink | null = null
  const log = (): TsVeSyncLogSink => {
    if (sink === null) throw new Error('no logger yet')
    return sink
  }
  const p1 = { deviceStatus: 'off', speed: 1 }
  const h1: HumidState = { deviceStatus: 'on', mode: 'auto', humidity: 41, target: 55 }
  const fans: object[] = [purifier('cid-1', calls, log, gate, p1), humidifier('hum-1', calls, h1)]
  const factory = createTsVeSyncClientFactory((input): TsVeSyncManager => {
    sink = input.logger
    return {
      login: async () => true,
      getDevices: async () => {
        calls.push(['getDevices'])
        return true
      },
      hydrateSession: () => undefined,
      fans,
    }
  })
  const client = factory({ email: 'me@example.com', password: 'pw', region: 'EU' })
  return { client, calls, gate, p1, h1 }
}

const settled = (ms: number): Promise<'pending'> =>
  new Promise((resolve) => setTimeout(() => resolve('pending'), ms))

describe('tsvesync adapter — a command does not wait behind a poll', () => {
  it('a command issued while a poll is in flight completes before the poll does', async () => {
    const w = world()
    await w.client.login()
    await w.client.listDevices()
    w.gate.current = deferred()
    const poll = w.client.listDevices()
    // Let the poll reach its blocked getDetails.
    await settled(5)
    const command = w.client.setPower('cid-1', true).then((): 'done' => 'done')
    const outcome = await Promise.race([command, settled(50)])
    // Release the poll before asserting, so a failure here cannot wedge the specs after it.
    w.gate.current.resolve()
    await poll
    expect(outcome).toBe('done')
  })

  it('a refused command reports its own library lines, never the concurrent poll ones', async () => {
    const w = world()
    await w.client.login()
    await w.client.listDevices()
    w.gate.current = deferred()
    const poll = w.client.listDevices()
    await settled(5)
    const err: unknown = await w.client.setPower('cid-1', false).catch((e: unknown) => e)
    expect(err instanceof Error ? err.message : '').toContain('Device refused: offline')
    expect(err instanceof Error ? err.message : '').not.toContain('poll noise')
    w.gate.current.resolve()
    await poll
  })
})

describe('tsvesync adapter — single-device refresh', () => {
  it('re-reads only that device and answers its fresh snapshot', async () => {
    const w = world()
    await w.client.login()
    await w.client.listDevices()
    w.calls.length = 0
    w.p1.deviceStatus = 'on'
    w.p1.speed = 3
    const fresh = await w.client.refreshDevice('cid-1')
    expect(w.calls).toEqual([['getDetails', 'cid-1']])
    expect(fresh).toMatchObject({ kind: 'purifier', power: true, speedPercent: 100 })
    expect(w.client.getDevice('cid-1')).toMatchObject({ power: true, speedPercent: 100 })
  })

  it('an unknown device answers null and reads nothing', async () => {
    const w = world()
    await w.client.login()
    await w.client.listDevices()
    w.calls.length = 0
    expect(await w.client.refreshDevice('nope')).toBeNull()
    expect(w.calls).toEqual([])
  })
})

describe('tsvesync adapter — humidifiers', () => {
  it('lists a humidifier as a humidifier snapshot', async () => {
    const w = world()
    await w.client.login()
    const list = await w.client.listDevices()
    expect(list.map((d) => `${d.kind}:${d.nativeId}`)).toEqual([
      'purifier:cid-1',
      'humidifier:hum-1',
    ])
    expect(w.calls).toContainEqual(['getDetails', 'hum-1'])
    expect(w.client.getDevice('hum-1')).toEqual({
      kind: 'humidifier',
      nativeId: 'hum-1',
      name: 'Humidifier hum-1',
      model: 'Classic300S',
      mac: 'AA:BB:CC:DD:EE:FF',
      power: true,
      currentHumidity: 41,
      targetHumidity: 55,
      mode: 'auto',
      availableModes: ['auto', 'manual', 'sleep'],
      minHumidity: 30,
      maxHumidity: 80,
      display: true,
      waterLacks: true,
      online: true,
    })
  })

  it('drives power, mode, setpoint and display through the library calls', async () => {
    const w = world()
    await w.client.login()
    await w.client.listDevices()
    w.calls.length = 0
    await w.client.setPower('hum-1', true)
    await w.client.setMode('hum-1', 'sleep')
    await w.client.setTargetHumidity('hum-1', 60)
    await w.client.setDisplay('hum-1', false)
    expect(w.calls).toEqual([
      ['turnOn', 'hum-1'],
      ['setMode', 'hum-1', 'sleep'],
      ['setHumidity', 'hum-1', 60],
      ['setDisplay', 'hum-1', false],
    ])
  })

  it('a tank never read is unknown, not "tank OK" (the class default reads false)', async () => {
    const w = world()
    w.h1.detailsOk = false
    await w.client.login()
    await w.client.listDevices()
    expect(w.client.getDevice('hum-1')).toMatchObject({ kind: 'humidifier', waterLacks: null })
    w.h1.detailsOk = true
    await w.client.refreshDevice('hum-1')
    expect(w.client.getDevice('hum-1')).toMatchObject({ waterLacks: true })
  })

  it('a setpoint on a purifier is refused by name', async () => {
    const w = world()
    await w.client.login()
    await w.client.listDevices()
    await expect(w.client.setTargetHumidity('cid-1', 50)).rejects.toThrow(/humidity/)
  })
})
