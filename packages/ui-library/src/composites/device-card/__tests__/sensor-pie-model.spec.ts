import type { HeroMeasurement, HeroRow } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { readingOf } from '../__fixtures__/pie-readings'
import {
  PIE_MAX_WEDGES,
  pieGeometry,
  readingStateOf,
  sensorLayoutOf,
  type SensorLayoutInput,
} from '../scenes/sensor/pie-model'

const motion = readingOf('motion', { value: 'Active', tone: 'primary' })
const light = readingOf('illuminance', {
  value: '142',
  number: 142,
  unit: 'lx',
})
const temp = readingOf('temperature', { value: '21', number: 21, unit: '°C' })
const hum = readingOf('humidity', {
  value: '48',
  number: 48,
  unit: '%',
  tone: 'info',
})
const pow = readingOf('power', {
  value: '80',
  number: 80,
  unit: 'W',
  tone: 'primary',
})
const door = readingOf('contact', { value: 'Closed', tone: 'success' })
const text = readingOf('text', { value: 'Eco' })

/** A row the operator can set (a number to change). */
const SETTABLE: HeroRow = {
  id: 'contact',
  icon: 'plug',
  status: null,
  controls: [
    {
      kind: 'number',
      id: 'offset',
      label: { en: 'Offset', it: 'Offset' },
      value: 0,
      step: null,
      unit: '°C',
      call: { cap: 'temperature-sensor', method: 'setOffset', args: {} },
      valueArg: 'offset',
    },
  ],
}

const model = (measurements: readonly HeroMeasurement[] | undefined): SensorLayoutInput => ({
  ...(measurements?.length === 1 ? { measurement: measurements[0] } : {}),
  ...(measurements === undefined ? {} : { measurements: [...measurements] }),
  rows: [],
  gated: [],
})

describe('sensorLayoutOf: the layout is derived from the number of readings', () => {
  it('no readings, no card', () => {
    expect(sensorLayoutOf(model(undefined))).toBeNull()
    expect(sensorLayoutOf(model([]))).toBeNull()
  })

  it("one reading is today's single-measurement scene", () => {
    expect(sensorLayoutOf(model([temp]))).toEqual({
      kind: 'single',
      measurement: temp,
    })
  })

  it('device 5598 (motion + light) is a two-wedge pie, the role reading first', () => {
    expect(sensorLayoutOf(model([motion, light]))).toEqual({
      kind: 'pie',
      shown: [motion, light],
    })
  })

  it('two to six readings are one wedge each', () => {
    for (let n = 2; n <= PIE_MAX_WEDGES; n++) {
      const layout = sensorLayoutOf(model([motion, light, temp, hum, pow, door].slice(0, n)))
      expect(layout).toMatchObject({ kind: 'pie' })
      expect(layout?.kind === 'pie' ? layout.shown.length : -1).toBe(n)
    }
  })

  it('seven readings are a grid of seven tiles, none hidden', () => {
    const layout = sensorLayoutOf(model([motion, light, temp, hum, pow, door, text]))
    expect(layout).toEqual({
      kind: 'grid',
      shown: [motion, light, temp, hum, pow, door, text],
    })
  })

  it('a sensor with a setting the operator can change keeps the full hero card', () => {
    const settable: SensorLayoutInput = {
      ...model([motion, light]),
      rows: [SETTABLE],
    }
    expect(sensorLayoutOf(settable)).toBeNull()
    expect(sensorLayoutOf({ ...settable, gated: ['contact'] })).not.toBeNull()
  })
})

describe('readingStateOf', () => {
  it('a reading with no data is empty, never idle at zero (D393)', () => {
    expect(readingStateOf(readingOf('illuminance', { value: '—', unit: 'lx' }))).toBe('empty')
    expect(readingStateOf(readingOf('motion', { value: '—' }))).toBe('empty')
    expect(readingStateOf(readingOf('text', { value: '—' }))).toBe('empty')
  })

  it('motion detected breathes, a clear one does not', () => {
    expect(readingStateOf(motion)).toBe('active')
    expect(readingStateOf(readingOf('motion', { value: 'Clear' }))).toBe('idle')
  })

  it('a hot temperature is active, a mild one idle', () => {
    expect(
      readingStateOf(readingOf('temperature', { value: '35', number: 35, tone: 'warning' })),
    ).toBe('active')
    expect(readingStateOf(temp)).toBe('idle')
  })
})

describe('pieGeometry', () => {
  it("N equal wedges from 12 o'clock, clockwise", () => {
    const g = pieGeometry(4)
    expect(g.map((w) => [w.startDeg, w.endDeg])).toEqual([
      [0, 90],
      [90, 180],
      [180, 270],
      [270, 360],
    ])
    expect(g[0]?.centroid.x).toBeGreaterThan(100)
    expect(g[0]?.centroid.y).toBeLessThan(100)
    expect(g[2]?.centroid.x).toBeLessThan(100)
    expect(g[2]?.centroid.y).toBeGreaterThan(100)
  })

  it('each wedge is a closed path from the centre', () => {
    for (const w of pieGeometry(3)) expect(w.path).toMatch(/^M100 100 L.* A.* Z$/)
  })
})
