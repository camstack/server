import { AUTO_SWITCH_JSON_KEY } from '@apocaliss92/nodedreame'
import { describe, expect, it } from 'vitest'
import {
  catalogProps,
  DREAME_AUTO_SELECTS,
  DREAME_AUTO_SWITCHES,
  DREAME_BUTTONS,
  DREAME_ENUM_SENSORS,
  DREAME_MOWER_ENUM_SENSORS,
  DREAME_NUMBERS,
  DREAME_NUMERIC_SENSORS,
  DREAME_SELECTS,
  DREAME_SWITCHES,
} from '../dreame-entity-catalog.js'

describe('dreame entity catalog', () => {
  it('numeric sensors have unique keys + coordinates + a section', () => {
    const keys = DREAME_NUMERIC_SENSORS.map((s) => s.key)
    const coords = DREAME_NUMERIC_SENSORS.map((s) => `${s.siid}/${s.piid}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(coords).size).toBe(coords.length)
    for (const s of DREAME_NUMERIC_SENSORS) expect(s.section.length).toBeGreaterThan(0)
  })

  it('switches have unique keys + coordinates + a section', () => {
    const keys = DREAME_SWITCHES.map((s) => s.key)
    const coords = DREAME_SWITCHES.map((s) => `${s.siid}/${s.piid}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(coords).size).toBe(coords.length)
    for (const s of DREAME_SWITCHES) expect(s.section.length).toBeGreaterThan(0)
  })

  it('selects have unique keys + a section + a non-empty, uniquely-valued/labelled option set', () => {
    const keys = DREAME_SELECTS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of DREAME_SELECTS) {
      expect(s.section.length).toBeGreaterThan(0)
      expect(s.options.length).toBeGreaterThan(0)
      const values = s.options.map((o) => o.value)
      const labels = s.options.map((o) => o.label)
      // No duplicate ints (read collision) and no duplicate labels (write collision).
      expect(new Set(values).size).toBe(values.length)
      expect(new Set(labels).size).toBe(labels.length)
    }
  })

  it('buttons have unique keys + a section, and a presence prop is fully-specified when present', () => {
    const keys = DREAME_BUTTONS.map((b) => b.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const b of DREAME_BUTTONS) {
      expect(b.section.length).toBeGreaterThan(0)
      // Presence coordinates are all-or-nothing.
      expect(b.presenceSiid === undefined).toBe(b.presencePiid === undefined)
    }
  })

  it('enum sensors have unique keys + a section + a non-empty, uniquely-valued option map', () => {
    const keys = DREAME_ENUM_SENSORS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of DREAME_ENUM_SENSORS) {
      expect(s.section.length).toBeGreaterThan(0)
      expect(s.options.length).toBeGreaterThan(0)
      const values = s.options.map((o) => o.value)
      // No duplicate ints (a read collision would resolve ambiguously).
      expect(new Set(values).size).toBe(values.length)
      // Labels are humanised (no leftover camelCase boundaries).
      for (const o of s.options) {
        expect(o.label.length).toBeGreaterThan(0)
        expect(o.label).not.toMatch(/[a-z][A-Z]/)
      }
    }
  })

  it('mower enum sensors have unique keys + a section + a non-empty, uniquely-valued option map', () => {
    const keys = DREAME_MOWER_ENUM_SENSORS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of DREAME_MOWER_ENUM_SENSORS) {
      expect(s.section.length).toBeGreaterThan(0)
      expect(s.options.length).toBeGreaterThan(0)
      const values = s.options.map((o) => o.value)
      expect(new Set(values).size).toBe(values.length)
      for (const o of s.options) {
        expect(o.label.length).toBeGreaterThan(0)
        expect(o.label).not.toMatch(/[a-z][A-Z]/)
      }
    }
  })

  it('mower enum sensor keys are distinct from the vacuum enum sensor keys', () => {
    // The two catalogs are kind-gated; distinct keys keep their stableIds (and
    // childLayout childKeys) from colliding when both kinds exist on one account.
    const vac = new Set(DREAME_ENUM_SENSORS.map((s) => s.key))
    for (const s of DREAME_MOWER_ENUM_SENSORS) expect(vac.has(s.key)).toBe(false)
  })

  it('numbers have unique keys + a section + a sane min<max range and positive step', () => {
    const keys = DREAME_NUMBERS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of DREAME_NUMBERS) {
      expect(s.section.length).toBeGreaterThan(0)
      expect(s.min).toBeLessThan(s.max)
      expect(s.step).toBeGreaterThan(0)
    }
  })

  it('auto-switches have unique keys + a section + a valid nodedreame auto-switch key', () => {
    const keys = DREAME_AUTO_SWITCHES.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of DREAME_AUTO_SWITCHES) {
      expect(s.section.length).toBeGreaterThan(0)
      // The packed key must be a real nodedreame AutoSwitchKey.
      expect(Object.prototype.hasOwnProperty.call(AUTO_SWITCH_JSON_KEY, s.autoSwitchKey)).toBe(true)
    }
  })

  it('auto-selects have unique keys, valid auto-switch keys, and uniquely-valued option maps', () => {
    const keys = DREAME_AUTO_SELECTS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of DREAME_AUTO_SELECTS) {
      expect(s.section.length).toBeGreaterThan(0)
      expect(Object.prototype.hasOwnProperty.call(AUTO_SWITCH_JSON_KEY, s.autoSwitchKey)).toBe(true)
      expect(s.options.length).toBeGreaterThan(0)
      const values = s.options.map((o) => o.value)
      const labels = s.options.map((o) => o.label)
      expect(new Set(values).size).toBe(values.length)
      expect(new Set(labels).size).toBe(labels.length)
    }
  })

  it('auto-switch and auto-select keys are disjoint (each setting maps to one platform)', () => {
    const sw = new Set(DREAME_AUTO_SWITCHES.map((s) => s.autoSwitchKey))
    for (const s of DREAME_AUTO_SELECTS) expect(sw.has(s.autoSwitchKey)).toBe(false)
  })

  it('catalogProps dedups to one MiotProp per coordinate across all entity types', () => {
    const props = catalogProps()
    const coords = props.map((p) => `${p.siid}/${p.piid}`)
    expect(new Set(coords).size).toBe(coords.length)
    // Union of sensor + switch + select + enum-sensor + number value coords, button
    // presence coords, and the single packed auto-switch bundle prop (4/50).
    const all = new Set([
      ...DREAME_NUMERIC_SENSORS.map((s) => `${s.siid}/${s.piid}`),
      ...DREAME_SWITCHES.map((s) => `${s.siid}/${s.piid}`),
      ...DREAME_SELECTS.map((s) => `${s.siid}/${s.piid}`),
      ...DREAME_ENUM_SENSORS.map((s) => `${s.siid}/${s.piid}`),
      ...DREAME_MOWER_ENUM_SENSORS.map((s) => `${s.siid}/${s.piid}`),
      ...DREAME_NUMBERS.map((s) => `${s.siid}/${s.piid}`),
      ...DREAME_BUTTONS.filter(
        (b) => b.presenceSiid !== undefined && b.presencePiid !== undefined,
      ).map((b) => `${b.presenceSiid}/${b.presencePiid}`),
      ...(DREAME_AUTO_SWITCHES.length > 0 || DREAME_AUTO_SELECTS.length > 0 ? ['4/50'] : []),
    ])
    expect(props.length).toBe(all.size)
  })
})
