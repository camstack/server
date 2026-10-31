import { CompositionSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { LockDoorGate } from '../lock-door-gate.js'
import { doorSensorOf, lockDoorLinkOf, seedLockDoors } from '../lock-door-sensor.js'
import { recordingLogger } from './fixtures.js'

const LOCK_REF = { addonId: 'ha', stableId: 'lock.front' }
const SENSOR_REF = { addonId: 'ha', stableId: 'binary_sensor.front' }

const block = {
  source: {
    kind: 'composition' as const,
    composition: CompositionSchema.parse({
      target: { kind: 'existing', device: LOCK_REF },
      features: [
        {
          kind: 'fields',
          cap: 'lock-control',
          fields: {
            state: {
              kind: 'expression',
              expr: 'x',
              bindings: {
                x: { kind: 'from', source: SENSOR_REF, cap: 'contact', fieldPath: 'entryOpen' },
              },
            },
          },
        },
      ],
    }),
  },
}

describe('lock door sensor (D984)', () => {
  it('reads the linked sensor from the stored override', () => {
    expect(lockDoorLinkOf(block)).toEqual({ lock: LOCK_REF, sensor: SENSOR_REF })
  })

  it('names the sensor for the lock it is linked to, and only for it', async () => {
    const names = {
      find: async (ref: { stableId: string }) =>
        ref.stableId === LOCK_REF.stableId
          ? { id: 7, name: 'Front lock' }
          : { id: 9, name: 'Front door contact' },
    }
    expect(await doorSensorOf([block], 7, names)).toBe('Front door contact')
    expect(await doorSensorOf([block], 8, names)).toBeNull()
  })
})

describe('seeding the gate after a restart (D984, D49)', () => {
  const names = {
    find: async (ref: { stableId: string }) =>
      ref.stableId === LOCK_REF.stableId
        ? { id: 7, name: 'Front lock' }
        : { id: 9, name: 'Front door contact' },
  }
  const lockCall = { capName: 'lock-control', method: 'lock', deviceId: 7, args: {} }

  function world(readState: (deviceId: number) => Promise<string | null>, apply = true) {
    const log = recordingLogger()
    const gate = new LockDoorGate({
      sensorOf: async () => 'Front door contact',
      logger: log.logger,
    })
    const failedLogged = new Set<number>()
    const seed = () =>
      seedLockDoors({
        blocks: [block],
        names,
        readState,
        apply: (deviceId, state) => {
          if (apply) gate.onStateChanged({ deviceId, capName: 'lock-control', slice: { state } })
        },
        logger: log.logger,
        failedLogged,
      })
    return { gate, seed, log }
  }

  it('refuses lock() with the door open before any event arrives', async () => {
    const { gate, seed } = world(async () => 'door-open')
    await seed()
    await expect(gate.redirect().attempt(lockCall)).rejects.toThrow(/door is open/)
  })

  it('a read that fails changes nothing and is logged once, with the device tag', async () => {
    const { gate, seed, log } = world(async () => {
      throw new Error('hub not ready')
    })
    await seed()
    await seed()
    expect(await gate.redirect().attempt(lockCall)).toEqual({ kind: 'not-redirected' })
    const warns = log.lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras?.tags).toEqual({ deviceId: 7 })
  })

  it('disarmed seed leaves the door unknown (the spec above would fail)', async () => {
    const { gate, seed } = world(async () => 'door-open', false)
    await seed()
    expect(await gate.redirect().attempt(lockCall)).toEqual({ kind: 'not-redirected' })
  })
})
