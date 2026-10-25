import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { CarbonMonoxideStatusSchema } from '../../capabilities/carbon-monoxide.cap.js'
import { ContactStatusSchema } from '../../capabilities/contact.cap.js'
import { FloodStatusSchema } from '../../capabilities/flood.cap.js'
import { GasStatusSchema } from '../../capabilities/gas.cap.js'
import { MotionStatusSchema } from '../../capabilities/motion.cap.js'
import {
  NC_CONDITION_CATALOG,
  NcConditionsSchema,
} from '../../capabilities/notification-rules.cap.js'
import { SmokeStatusSchema } from '../../capabilities/smoke.cap.js'
import { TamperStatusSchema } from '../../capabilities/tamper.cap.js'
import { VibrationStatusSchema } from '../../capabilities/vibration.cap.js'
import {
  NC_SENSOR_RAISED_FIELD_BY_KIND,
  NC_SENSOR_TRANSITION_KINDS,
  sensorRaisedOf,
  sensorTransitionOffered,
} from '../sensor-raised.js'

describe('the raised-field table (D640)', () => {
  it('is exactly the eight boolean sensor kinds, each naming its cap field', () => {
    expect(NC_SENSOR_RAISED_FIELD_BY_KIND).toEqual({
      contact: 'entryOpen',
      'motion-sensor': 'detected',
      flood: 'flooded',
      gas: 'detected',
      smoke: 'detected',
      'carbon-monoxide': 'detected',
      vibration: 'detected',
      tamper: 'tampered',
    })
    expect([...NC_SENSOR_TRANSITION_KINDS].sort()).toEqual(
      Object.keys(NC_SENSOR_RAISED_FIELD_BY_KIND).sort(),
    )
  })

  it('every field is a BOOLEAN of the cap slice the kind persists', () => {
    // Pinned against the caps' own schemas, not against a copy of their names:
    // a cap that renames its field fails here, not silently in the engine.
    const slices = {
      contact: ContactStatusSchema,
      'motion-sensor': MotionStatusSchema,
      flood: FloodStatusSchema,
      gas: GasStatusSchema,
      smoke: SmokeStatusSchema,
      'carbon-monoxide': CarbonMonoxideStatusSchema,
      vibration: VibrationStatusSchema,
      tamper: TamperStatusSchema,
    } as const
    for (const [kind, field] of Object.entries(NC_SENSOR_RAISED_FIELD_BY_KIND)) {
      const schema = Object.entries(slices).find(([k]) => k === kind)?.[1]
      expect(schema, kind).toBeDefined()
      const shape: Readonly<Record<string, z.ZodType>> = schema?.shape ?? {}
      const fieldSchema = Object.entries(shape).find(([k]) => k === field)?.[1]
      expect(fieldSchema?.safeParse(true).success, `${kind}.${field}`).toBe(true)
      expect(fieldSchema?.safeParse('yes').success, `${kind}.${field}`).toBe(false)
    }
  })

  it('leaves out presence (a word, not a boolean), switches and pulse kinds', () => {
    for (const kind of [
      'presence',
      'switch',
      'doorbell',
      'button',
      'device-event',
      'cover',
      'lock',
    ]) {
      expect(NC_SENSOR_TRANSITION_KINDS.includes(kind), kind).toBe(false)
    }
  })
})

describe('sensorRaisedOf', () => {
  it('reads the raise and the clear', () => {
    expect(sensorRaisedOf('flood', { flooded: true, lastChangedAt: 5 })).toBe(true)
    expect(sensorRaisedOf('flood', { flooded: false, lastChangedAt: 5 })).toBe(false)
    expect(sensorRaisedOf('contact', { entryOpen: true })).toBe(true)
    expect(sensorRaisedOf('tamper', { tampered: false })).toBe(false)
  })

  it('never guesses: an unknown kind, a missing or non-boolean field, a null slice', () => {
    expect(sensorRaisedOf('doorbell', { detected: true })).toBeUndefined()
    expect(sensorRaisedOf('presence', { state: 'home' })).toBeUndefined()
    expect(sensorRaisedOf('flood', { detected: true })).toBeUndefined()
    expect(sensorRaisedOf('flood', { flooded: 'on' })).toBeUndefined()
    expect(sensorRaisedOf('flood', null)).toBeUndefined()
  })
})

describe('sensorTransitionOffered — the support rule both editors apply', () => {
  it('is offered only when every chosen kind has a raise', () => {
    expect(sensorTransitionOffered(['flood'])).toBe(true)
    expect(sensorTransitionOffered(['flood', 'smoke'])).toBe(true)
    expect(sensorTransitionOffered(['Flood'])).toBe(true)
    expect(sensorTransitionOffered(['flood', 'doorbell'])).toBe(false)
    expect(sensorTransitionOffered([])).toBe(false)
    expect(sensorTransitionOffered(undefined)).toBe(false)
  })
})

describe('the condition on the cap', () => {
  it('parses raised / cleared and refuses anything else', () => {
    expect(NcConditionsSchema.parse({ sensorTransition: 'raised' }).sensorTransition).toBe('raised')
    expect(NcConditionsSchema.parse({ sensorTransition: 'cleared' }).sensorTransition).toBe(
      'cleared',
    )
    expect(NcConditionsSchema.parse({}).sensorTransition).toBeUndefined()
    expect(NcConditionsSchema.safeParse({ sensorTransition: 'both' }).success).toBe(false)
  })

  it('is described for device-event only, with its choices on the wire', () => {
    const d = NC_CONDITION_CATALOG.find((c) => c.id === 'sensorTransition')
    expect(d?.appliesTo).toEqual(['device-event'])
    expect(d?.group).toBe('device')
    expect(d?.valueType).toBe('sensorTransition')
    expect(d?.options?.map((o) => o.value)).toEqual(['', 'raised', 'cleared'])
  })
})
