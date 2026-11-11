import type { FanPreset, FanPresetState } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  checkPresetDraft,
  newPresetId,
  omissionText,
  parseOptionalNumber,
  presetFieldCount,
  removePreset,
  upsertPreset,
  withAxis,
} from '../fan-presets-model'

function preset(id: string, name: string, state: FanPresetState = { speed: 40 }): FanPreset {
  return { id, name, state }
}

describe('preset list edits', () => {
  it('upserts by id and keeps the order', () => {
    const list = [preset('p1', 'Notte'), preset('p2', 'Giorno')]
    expect(upsertPreset(list, preset('p1', 'Sera')).map((p) => p.name)).toEqual(['Sera', 'Giorno'])
    expect(upsertPreset(list, preset('p3', 'Extra')).map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('removes by id', () => {
    expect(removePreset([preset('p1', 'a'), preset('p2', 'b')], 'p1').map((p) => p.id)).toEqual([
      'p2',
    ])
  })

  it('picks the smallest unused id', () => {
    expect(newPresetId([preset('p1', 'a'), preset('p3', 'c')])).toBe('p2')
  })
})

describe('presetFieldCount', () => {
  it('counts every field set, axis fields included', () => {
    expect(
      presetFieldCount({
        speed: 25,
        preset: 'Preset 1',
        oscillationAxes: { horizontal: { oscillating: false, angle: 45 }, vertical: {} },
      }),
    ).toBe(4)
    expect(presetFieldCount({})).toBe(0)
  })
})

describe('withAxis', () => {
  it('replaces one axis and keeps the other', () => {
    const state: FanPresetState = {
      speed: 25,
      oscillationAxes: { vertical: { oscillating: true } },
    }
    expect(withAxis(state, 'horizontal', { angle: 30 })).toEqual({
      speed: 25,
      oscillationAxes: { horizontal: { angle: 30 }, vertical: { oscillating: true } },
    })
  })

  it('drops an axis that sets nothing, and the axes object when none is left', () => {
    const state: FanPresetState = { speed: 25, oscillationAxes: { horizontal: { angle: 30 } } }
    expect(withAxis(state, 'horizontal', { angle: undefined })).toEqual({ speed: 25 })
  })
})

describe('checkPresetDraft', () => {
  const others = [preset('p1', 'Notte')]

  it('needs a name and at least one field', () => {
    expect(checkPresetDraft(others, preset('p2', ' '))).toEqual({ ok: false, reason: 'no-name' })
    expect(checkPresetDraft(others, preset('p2', 'Sera', {}))).toEqual({
      ok: false,
      reason: 'no-fields',
    })
    expect(
      checkPresetDraft(others, preset('p2', 'Sera', { oscillationAxes: { vertical: {} } })),
    ).toEqual({ ok: false, reason: 'no-fields' })
  })

  it('refuses a name another preset has, whatever its case', () => {
    expect(checkPresetDraft(others, preset('p2', ' notte '))).toEqual({
      ok: false,
      reason: 'duplicate-name',
    })
  })

  it('lets a preset keep its own name', () => {
    expect(checkPresetDraft(others, preset('p1', 'Notte')).ok).toBe(true)
  })
})

describe('omissionText', () => {
  it('names what was left out and why', () => {
    expect(omissionText({ what: 'speed', reason: 'the fan reports no speed' })).toBe(
      'speed: the fan reports no speed',
    )
  })
})

describe('parseOptionalNumber', () => {
  it('empty or unparsable is not set; a number is kept, 0 included', () => {
    expect(parseOptionalNumber('')).toBeUndefined()
    expect(parseOptionalNumber('abc')).toBeUndefined()
    expect(parseOptionalNumber('0')).toBe(0)
    expect(parseOptionalNumber('45')).toBe(45)
  })
})
