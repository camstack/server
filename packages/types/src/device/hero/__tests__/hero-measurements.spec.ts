import { describe, expect, it } from 'vitest'
import { DeviceRole, DeviceType } from '../../device-type.js'
import { buildHeroModel } from '../build-hero-model.js'
import { HERO_LEAD_QUANTITY_BY_ROLE } from '../hero-measurement.js'
import type { HeroModel } from '../hero-model.js'
import { NOW } from './hero-test-kit.js'

const MIN = 60_000

/** Device 5598: a Homematic motion sensor that also reports the light. */
const MOTION_AND_LIGHT = {
  motion: { detected: true, lastDetectedAt: NOW - 3 * MIN, autoClearAfterMs: null },
  'ambient-light-sensor': { illuminance: 142, lastFetchedAt: NOW - 2 * MIN },
}

function buildAs(
  type: string,
  role: string | null,
  slices: Record<string, unknown>,
  online = true,
): HeroModel {
  return buildHeroModel({
    device: { id: 7, type, role, name: 'Dev', online },
    caps: Object.keys(slices),
    features: [],
    slices,
    now: NOW,
    remoteCommands: null,
    access: { canActuate: true },
  })
}

const sensor = (role: string | null, slices: Record<string, unknown>, online = true): HeroModel =>
  buildAs(DeviceType.Sensor, role, slices, online)

const quantities = (m: HeroModel): readonly string[] | undefined =>
  m.measurements?.map((x) => x.quantity)

describe('a sensor carries ALL its measurements', () => {
  it('motion + light (device 5598) are two measurements and the single one stays absent', () => {
    const m = sensor(DeviceRole.MotionSensor, MOTION_AND_LIGHT)
    expect(m.measurement).toBeUndefined()
    expect(quantities(m)).toEqual(['motion', 'illuminance'])
    expect(m.measurements?.[0]).toMatchObject({
      quantity: 'motion',
      value: { en: 'Active' },
      since: NOW - 3 * MIN,
      sinceKind: 'changed',
    })
    expect(m.measurements?.[1]).toMatchObject({
      quantity: 'illuminance',
      reading: { value: 142, quantity: 'illuminance' },
      unit: 'lx',
    })
  })

  it('a sensor with ONE measuring cap keeps `measurement` and a one-element list', () => {
    const m = sensor(DeviceRole.TemperatureSensor, {
      'temperature-sensor': { temperature: 20, lastFetchedAt: NOW },
    })
    expect(m.measurement?.quantity).toBe('temperature')
    expect(m.measurements).toHaveLength(1)
  })

  it('the device ROLE leads, the rest follows in a stable order', () => {
    const slices = {
      'temperature-sensor': { temperature: 20, lastFetchedAt: NOW },
      'humidity-sensor': { humidity: 50, lastFetchedAt: NOW },
      motion: { detected: false, lastDetectedAt: null, autoClearAfterMs: null },
    }
    expect(quantities(sensor(DeviceRole.MotionSensor, slices))).toEqual([
      'motion',
      'temperature',
      'humidity',
    ])
    expect(quantities(sensor(DeviceRole.HumiditySensor, slices))).toEqual([
      'humidity',
      'temperature',
      'motion',
    ])
    expect(quantities(sensor(null, slices))).toEqual(['temperature', 'humidity', 'motion'])
  })

  it('a reading that did not report is empty ("—", reading null), never 0 (D393)', () => {
    const m = sensor(DeviceRole.MotionSensor, {
      motion: { detected: false, lastDetectedAt: null, autoClearAfterMs: null },
      'ambient-light-sensor': { illuminance: null, lastFetchedAt: NOW },
    })
    const light = m.measurements?.find((x) => x.quantity === 'illuminance')
    expect(light).toMatchObject({ reading: null, value: { en: '—' }, unit: 'lx', since: null })
  })

  it('offline: every measurement is empty, none keeps a stale value', () => {
    const m = sensor(DeviceRole.MotionSensor, MOTION_AND_LIGHT, false)
    expect(m.measurements).toHaveLength(2)
    expect(m.measurements?.every((x) => x.reading === null && x.value.en === '—')).toBe(true)
  })

  it('a non-sensor has no measurements', () => {
    expect(buildAs(DeviceType.Switch, null, MOTION_AND_LIGHT).measurements).toBeUndefined()
  })

  it('the lead table names the quantity of each measuring role', () => {
    expect(HERO_LEAD_QUANTITY_BY_ROLE[DeviceRole.MotionSensor]).toBe('motion')
    expect(HERO_LEAD_QUANTITY_BY_ROLE[DeviceRole.AmbientLightSensor]).toBe('illuminance')
  })
})
