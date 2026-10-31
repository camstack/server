import { CompositionSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { doorSensorOf, lockDoorLinkOf } from '../lock-door-sensor.js'

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
