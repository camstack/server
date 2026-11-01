import type { ActionStep, FanPreset } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  checkPresetDraft,
  newPresetId,
  omissionText,
  removePreset,
  siblingIds,
  upsertPreset,
} from '../fan-presets-model'

const STEP: ActionStep = {
  kind: 'cap',
  target: { kind: 'devices', ids: [5] },
  cap: 'fan-control',
  method: 'setPercentage',
  args: { speed: 40 },
}

function preset(id: string, name: string): FanPreset {
  return { id, name, steps: [STEP] }
}

describe('siblingIds', () => {
  const fleet = [
    { id: 5, parentDeviceId: 1 },
    { id: 6, parentDeviceId: 1 },
    { id: 7, parentDeviceId: 2 },
    { id: 8, parentDeviceId: 5 },
    { id: 1, parentDeviceId: null },
  ]

  it('is the fan and the children of its container', () => {
    expect(siblingIds(fleet, { id: 5, parentDeviceId: 1 })).toEqual([5, 6])
  })

  it('is the fan and its own children when it has no container', () => {
    expect(siblingIds(fleet, { id: 5, parentDeviceId: null })).toEqual([5, 8])
  })
})

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

describe('checkPresetDraft', () => {
  const others = [preset('p1', 'Notte')]

  it('needs a name and a step', () => {
    expect(checkPresetDraft(others, { id: 'p2', name: ' ', steps: [STEP] })).toEqual({
      ok: false,
      reason: 'no-name',
    })
    expect(checkPresetDraft(others, { id: 'p2', name: 'Sera', steps: [] })).toEqual({
      ok: false,
      reason: 'no-steps',
    })
  })

  it('refuses a name another preset has, whatever its case', () => {
    expect(checkPresetDraft(others, { id: 'p2', name: ' notte ', steps: [STEP] })).toEqual({
      ok: false,
      reason: 'duplicate-name',
    })
  })

  it('lets a preset keep its own name', () => {
    expect(checkPresetDraft(others, { id: 'p1', name: 'Notte', steps: [STEP] }).ok).toBe(true)
  })
})

describe('omissionText', () => {
  it('names what was left out and why', () => {
    expect(omissionText({ what: 'speed', reason: 'the fan reports no speed' })).toBe(
      'speed: the fan reports no speed',
    )
  })
})
