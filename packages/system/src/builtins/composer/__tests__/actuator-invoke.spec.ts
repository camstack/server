import { ACTUATOR_METHODS, ACTUATOR_TEMPLATE_IDS, type FanOutCall } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type ActuatorInvokeApi, invokeActuatorCall } from '../actuator-invoke.js'

type Seen = readonly [string, number, ...unknown[]]

function recordingApi(seen: Seen[]): ActuatorInvokeApi {
  const note =
    (name: string) =>
    async (deviceId: number, ...rest: unknown[]) => {
      seen.push([name, deviceId, ...rest])
    }
  return {
    switchSetState: note('switchSetState'),
    setBrightness: note('setBrightness'),
    setColor: note('setColor'),
    fanSetPercentage: note('fanSetPercentage'),
    fanSetPreset: note('fanSetPreset'),
    fanSetDirection: note('fanSetDirection'),
    fanSetOscillating: note('fanSetOscillating'),
    coverOpen: note('coverOpen'),
    coverClose: note('coverClose'),
    coverStop: note('coverStop'),
    coverSetPosition: note('coverSetPosition'),
    coverSetTiltPosition: note('coverSetTiltPosition'),
    valveOpen: note('valveOpen'),
    valveClose: note('valveClose'),
    valveSetPosition: note('valveSetPosition'),
    lockLock: note('lockLock'),
    lockUnlock: note('lockUnlock'),
    mediaPlay: note('mediaPlay'),
    mediaPause: note('mediaPause'),
    mediaSetVolume: note('mediaSetVolume'),
    climateSetMode: note('climateSetMode'),
    climateSetTarget: note('climateSetTarget'),
    climateSetFanMode: note('climateSetFanMode'),
  }
}

function call(cap: string, method: string, args: FanOutCall['args'] = {}): FanOutCall {
  return { deviceId: 7, cap, method, args }
}

describe('invoking a fan-out call on one member', () => {
  it('reaches the member method each table row names', async () => {
    const seen: Seen[] = []
    const api = recordingApi(seen)
    await invokeActuatorCall(api, call('cover', 'open'))
    await invokeActuatorCall(api, call('cover', 'setPosition', { position: 30 }))
    await invokeActuatorCall(api, call('cover', 'setTiltPosition', { tiltPosition: 80 }))
    await invokeActuatorCall(api, call('valve', 'setPosition', { position: 0 }))
    await invokeActuatorCall(api, call('fan-control', 'setPercentage', { speed: 60 }))
    await invokeActuatorCall(api, call('fan-control', 'setDirection', { direction: 'reverse' }))
    await invokeActuatorCall(api, call('lock-control', 'lock'))
    await invokeActuatorCall(api, call('lock-control', 'unlock', { code: '1234' }))
    await invokeActuatorCall(api, call('media-player', 'setVolume', { volumeLevel: 25 }))
    await invokeActuatorCall(api, call('climate-control', 'setMode', { mode: 'heat' }))
    await invokeActuatorCall(api, call('climate-control', 'setTarget', { target: 21.5 }))
    expect(seen).toEqual([
      ['coverOpen', 7],
      ['coverSetPosition', 7, 30],
      ['coverSetTiltPosition', 7, 80],
      ['valveSetPosition', 7, 0],
      ['fanSetPercentage', 7, 60],
      ['fanSetDirection', 7, 'reverse'],
      ['lockLock', 7, undefined],
      ['lockUnlock', 7, '1234'],
      ['mediaSetVolume', 7, 25],
      ['climateSetMode', 7, 'heat'],
      ['climateSetTarget', 7, 21.5],
    ])
  })

  it('fails that member alone on a bad argument, and sends nothing', async () => {
    const seen: Seen[] = []
    const api = recordingApi(seen)
    await expect(
      invokeActuatorCall(api, call('cover', 'setPosition', { position: 'half' })),
    ).rejects.toThrow(/position/)
    await expect(
      invokeActuatorCall(api, call('climate-control', 'setMode', { mode: 'melt' })),
    ).rejects.toThrow(/mode/)
    await expect(
      invokeActuatorCall(api, call('fan-control', 'setDirection', { direction: 'sideways' })),
    ).rejects.toThrow(/direction/)
    expect(seen).toEqual([])
  })

  it('has a fan-out for every row of every method table', async () => {
    const seen: Seen[] = []
    const api = recordingApi(seen)
    const args: FanOutCall['args'] = {
      on: true,
      level: 10,
      speed: 10,
      preset: 'turbo',
      direction: 'forward',
      oscillating: true,
      position: 10,
      tiltPosition: 10,
      volumeLevel: 10,
      mode: 'cool',
      target: 20,
      fanMode: 'auto',
      color: { mode: 'mired', colorTemperature: 250 },
    }
    for (const id of ACTUATOR_TEMPLATE_IDS) {
      for (const row of ACTUATOR_METHODS[id]) {
        await expect(
          invokeActuatorCall(api, call(row.cap, row.method, args)),
          `${row.cap}.${row.method}`,
        ).resolves.toBeUndefined()
      }
    }
  })

  it('refuses a method outside the tables', async () => {
    const api = recordingApi([])
    await expect(invokeActuatorCall(api, call('lock-control', 'open'))).rejects.toThrow(
      /no fan-out for lock-control.open/,
    )
  })
})
