import { describe, expect, it } from 'vitest'
import { AlarmStateSchema } from '../../capabilities/alarm-panel.cap.js'
import { CoverStateSchema } from '../../capabilities/cover.cap.js'
import { LockStateSchema } from '../../capabilities/lock-control.cap.js'
import { SceneVerdictSchema } from '../../capabilities/scene-monitor.cap.js'
import { DEVICE_STATE_READERS } from '../../catalogs/device-state-vocabulary.js'
import { STATE_LABEL_KEYS, STATE_LABELS, isStateLabelKey, stateLabel } from '../state-labels.js'

describe('STATE_LABELS — the shared dictionary of state words (R7)', () => {
  it('has an English AND an Italian label for every key, never empty', () => {
    for (const key of STATE_LABEL_KEYS) {
      const entry = STATE_LABELS[key]
      expect(entry.en.trim().length, `${key}.en`).toBeGreaterThan(0)
      expect(entry.it.trim().length, `${key}.it`).toBeGreaterThan(0)
    }
  })

  it('the key tuple and the record list the same keys', () => {
    expect([...STATE_LABEL_KEYS].sort()).toEqual(Object.keys(STATE_LABELS).sort())
  })

  it('covers every closed state vocabulary a device-state gate can offer', () => {
    const closed = [
      ...AlarmStateSchema.options,
      ...CoverStateSchema.options,
      ...LockStateSchema.options,
    ]
    for (const value of closed) expect(isStateLabelKey(value), value).toBe(true)
  })

  it('covers both words of every boolean reader', () => {
    for (const reader of DEVICE_STATE_READERS) {
      for (const word of reader.booleanWords ?? []) {
        expect(isStateLabelKey(word), `${reader.cap}:${word}`).toBe(true)
      }
    }
  })

  it('covers the scene verdicts the scene gate shows beside a scene', () => {
    for (const verdict of SceneVerdictSchema.options) {
      expect(isStateLabelKey(verdict), verdict).toBe(true)
    }
  })
})

describe('stateLabel', () => {
  it('answers in the asked locale', () => {
    expect(stateLabel('armed_away', 'en')).toBe('Armed (away)')
    expect(stateLabel('armed_away', 'it')).toBe('Inserito (fuori casa)')
    expect(stateLabel('not_home', 'it')).toBe('Fuori casa')
  })

  it('humanizes a word it does not know — never throws', () => {
    expect(stateLabel('garden', 'en')).toBe('Garden')
    expect(stateLabel('delivery_truck', 'it')).toBe('Delivery truck')
    expect(stateLabel('open-door', 'en')).toBe('Open door')
    expect(stateLabel('', 'it')).toBe('')
  })

  it('does not answer for inherited object keys', () => {
    expect(stateLabel('toString', 'en')).toBe('ToString')
    expect(isStateLabelKey('constructor')).toBe(false)
  })
})
