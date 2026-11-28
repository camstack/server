import { describe, expect, it } from 'vitest'
import type { IScopedLogger, LogExtras } from '@dominevo/types'
import { KiaBridgeError, type KiaCommand, type KiaCommandResult } from '../kia-bridge.js'
import { KiaBudgetExhaustedError } from '../kia-integration-manager.js'
import { KiaVehicleHandle } from '../kia-device-handle.js'
import { createKiaClimateProvider, createKiaLockProvider } from '../kia-vehicle-commands.js'
import { sportageState } from './kia-fixtures.js'

interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly extras: LogExtras | undefined
}

function recordingLogger(lines: LoggedLine[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: (message, extras) => void lines.push({ level: 'debug', message, extras }),
    info: (message, extras) => void lines.push({ level: 'info', message, extras }),
    warn: (message, extras) => void lines.push({ level: 'warn', message, extras }),
    error: (message, extras) => void lines.push({ level: 'error', message, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Rig {
  readonly handle: KiaVehicleHandle
  readonly sent: KiaCommand[]
  readonly lines: LoggedLine[]
  next: { error: Error | null; result: KiaCommandResult }
}

function rig(state = sportageState()): Rig {
  const sent: KiaCommand[] = []
  const lines: LoggedLine[] = []
  const r: Rig = {
    sent,
    lines,
    next: { error: null, result: { outcome: 'success', state } },
    handle: new KiaVehicleHandle('veh-1', state, {
      requestRefresh: async () => ({ ok: false, reason: 'account-error', retryAt: null }),
      command: async (_id, command) => {
        sent.push(command)
        if (r.next.error !== null) throw r.next.error
        return r.next.result
      },
    }),
  }
  return r
}

const DEVICE_ID = 77

describe('the lock accessory', () => {
  it('sends lock and unlock to the car and never writes the commanded state itself', async () => {
    const r = rig()
    const provider = createKiaLockProvider({
      deviceId: DEVICE_ID,
      logger: recordingLogger(r.lines),
      resolveHandle: () => r.handle,
    })
    await provider.lock({ deviceId: DEVICE_ID })
    await provider.unlock({ deviceId: DEVICE_ID })
    expect(r.sent).toEqual([{ command: 'lock' }, { command: 'unlock' }])
    expect(r.lines.every((l) => l.extras?.tags?.['deviceId'] === DEVICE_ID)).toBe(true)
  })

  it('never forwards a PIN code: the PIN lives in the worker', async () => {
    const r = rig()
    const provider = createKiaLockProvider({
      deviceId: DEVICE_ID,
      logger: recordingLogger(r.lines),
      resolveHandle: () => r.handle,
    })
    await provider.unlock({ deviceId: DEVICE_ID, code: '1234' })
    expect(JSON.stringify(r.sent)).not.toContain('1234')
    expect(JSON.stringify(r.lines)).not.toContain('1234')
  })

  it('refuses, naming the allowance, when the daily budget is spent', async () => {
    const r = rig()
    r.next = { error: new KiaBudgetExhaustedError(1_795_400_000_000), result: r.next.result }
    const provider = createKiaLockProvider({
      deviceId: DEVICE_ID,
      logger: recordingLogger(r.lines),
      resolveHandle: () => r.handle,
    })
    await expect(provider.lock({ deviceId: DEVICE_ID })).rejects.toThrow(
      /allowance.*try again after 2026/i,
    )
    expect(r.lines.some((l) => l.level === 'warn')).toBe(true)
  })

  it('refuses when the car is unreachable, with the cloud reason', async () => {
    const r = rig()
    r.next = { error: new KiaBridgeError('vehicle-unreachable', 'asleep'), result: r.next.result }
    const provider = createKiaLockProvider({
      deviceId: DEVICE_ID,
      logger: recordingLogger(r.lines),
      resolveHandle: () => r.handle,
    })
    await expect(provider.unlock({ deviceId: DEVICE_ID })).rejects.toThrow(/unreachable|asleep/i)
  })

  it('refuses without a cloud connection', async () => {
    const r = rig()
    const provider = createKiaLockProvider({
      deviceId: DEVICE_ID,
      logger: recordingLogger(r.lines),
      resolveHandle: () => null,
    })
    await expect(provider.lock({ deviceId: DEVICE_ID })).rejects.toThrow(/connection/i)
  })
})

describe('the climate accessory', () => {
  const make = (r: Rig) =>
    createKiaClimateProvider({
      deviceId: DEVICE_ID,
      logger: recordingLogger(r.lines),
      resolveHandle: () => r.handle,
    })

  it('starts on auto at the cloud target and stops on off', async () => {
    const r = rig(sportageState({ climateOn: false, climateTargetC: 22 }))
    const provider = make(r)
    await provider.setMode({ deviceId: DEVICE_ID, mode: 'auto' })
    await provider.setMode({ deviceId: DEVICE_ID, mode: 'off' })
    expect(r.sent[0]).toMatchObject({ command: 'climate-start', temperature: 22 })
    expect(r.sent[1]).toEqual({ command: 'climate-stop' })
  })

  it('falls back to 21 degrees when no target is known', async () => {
    const r = rig(sportageState({ climateOn: false, climateTargetC: null }))
    await make(r).setMode({ deviceId: DEVICE_ID, mode: 'heat' })
    expect(r.sent[0]).toMatchObject({ command: 'climate-start', temperature: 21 })
  })

  it('refuses a mode the car cannot do', async () => {
    const r = rig()
    await expect(make(r).setMode({ deviceId: DEVICE_ID, mode: 'dry' })).rejects.toThrow(/mode/i)
    expect(r.sent).toEqual([])
  })

  it('setTarget while running restarts at the new temperature', async () => {
    const r = rig(sportageState({ climateOn: true, climateTargetC: 20 }))
    await make(r).setTarget({ deviceId: DEVICE_ID, target: 23.5 })
    expect(r.sent).toEqual([{ command: 'climate-start', temperature: 23.5, durationMinutes: 10 }])
  })

  it('setTarget while off sends nothing and is used by the next start', async () => {
    const r = rig(sportageState({ climateOn: false, climateTargetC: 20 }))
    const provider = make(r)
    await provider.setTarget({ deviceId: DEVICE_ID, target: 24 })
    expect(r.sent).toEqual([])
    await provider.setMode({ deviceId: DEVICE_ID, mode: 'auto' })
    expect(r.sent[0]).toMatchObject({ command: 'climate-start', temperature: 24 })
  })

  it('setTarget while the state is unknown sends nothing', async () => {
    const r = rig(sportageState({ climateOn: null }))
    await make(r).setTarget({ deviceId: DEVICE_ID, target: 24 })
    expect(r.sent).toEqual([])
  })

  it('refuses a target outside the car range', async () => {
    const r = rig()
    const provider = make(r)
    await expect(provider.setTarget({ deviceId: DEVICE_ID, target: 35 })).rejects.toThrow(/range/i)
    await expect(provider.setTarget({ deviceId: DEVICE_ID, target: 10 })).rejects.toThrow(/range/i)
  })

  it('refuses with the allowance message when the budget is spent', async () => {
    const r = rig()
    r.next = { error: new KiaBudgetExhaustedError(1_795_400_000_000), result: r.next.result }
    await expect(make(r).setMode({ deviceId: DEVICE_ID, mode: 'off' })).rejects.toThrow(
      /allowance/i,
    )
  })
})
