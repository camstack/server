/**
 * The preset registry and the suggestions the wizard shows: a preset builds
 * only from a complete set of picks, the filter is a pair, and a suggestion
 * is a presentation — it never picks.
 */
import { type CompositionSourceRef, DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { CandidateDevice } from '../../device/customize/assignments/assignment-candidates'
import { deviceCandidates, entitySuggestions } from '../command-sources'
import {
  COMPOSITION_PRESETS,
  type CompositionPreset,
  firstPick,
  missingSlots,
  type PresetPicks,
  presetById,
} from '../composition-presets'

const ref = (stableId: string): CompositionSourceRef => ({ addonId: 'ha', stableId })

function requirePreset(id: string): CompositionPreset {
  const found = presetById(id)
  if (found === null) throw new Error(`no ${id} preset`)
  return found
}

const fountain = requirePreset('pet-fountain')

function allPicks(): PresetPicks {
  return Object.fromEntries(
    fountain.slots.filter((s) => s.optionalGroup === undefined).map((s) => [s.key, ref(s.key)]),
  )
}

describe('the preset registry', () => {
  it('has unique ids and every slot carries its own label key', () => {
    expect(new Set(COMPOSITION_PRESETS.map((p) => p.id)).size).toBe(COMPOSITION_PRESETS.length)
    expect(new Set(fountain.slots.map((s) => s.key)).size).toBe(fountain.slots.length)
  })

  it('builds nothing while a required slot is empty', () => {
    const { pump: _pump, ...rest } = allPicks()
    expect(fountain.build(rest)).toBeNull()
    expect(missingSlots(fountain, rest).map((s) => s.key)).toEqual(['pump'])
  })

  it('builds the fountain without a filter', () => {
    const composition = fountain.build(allPicks())
    expect(composition?.target).toMatchObject({ kind: 'new' })
    expect(composition?.features.map((f) => f.cap)).toEqual(['pet-fountain'])
  })

  it('treats the filter as a pair: one half alone builds nothing, both add the consumable', () => {
    const half = { ...allPicks(), filterChanged: ref('button.filter') }
    expect(fountain.build(half)).toBeNull()
    expect(missingSlots(fountain, half).map((s) => s.key)).toEqual(['filterDaysRemaining'])
    const both = { ...half, filterDaysRemaining: ref('sensor.filter') }
    expect(fountain.build(both)?.features.map((f) => f.cap)).toEqual([
      'pet-fountain',
      'consumables',
    ])
  })

  it('anchors suggestions on the first slot picked, in slot order', () => {
    expect(firstPick(fountain, {})).toBeNull()
    expect(firstPick(fountain, { pump: ref('p'), waterLevel: ref('w') })).toEqual(ref('w'))
  })
})

function device(
  id: number,
  stableId: string,
  over: Partial<CandidateDevice> = {},
): CandidateDevice {
  return {
    id,
    name: stableId,
    addonId: 'ha',
    stableId,
    type: DeviceType.Sensor,
    location: '',
    isCamera: false,
    integration: null,
    parentDeviceId: null,
    primaryChildEntityId: null,
    role: null,
    ...over,
  }
}

describe('entity suggestions', () => {
  const fleet: readonly CandidateDevice[] = [
    device(1, 'box', { type: DeviceType.Container, name: 'Fountain box' }),
    device(2, 'a', { parentDeviceId: 1 }),
    device(3, 'b', { parentDeviceId: 1 }),
    device(4, 'stranger', { parentDeviceId: 9 }),
    device(5, 'room-a', { location: 'Kitchen' }),
    device(6, 'room-b', { location: 'Kitchen' }),
    device(7, 'elsewhere', { location: 'Garage' }),
  ]

  it('suggests the siblings in the same container, never the container, and not the anchor on request', () => {
    const room = entitySuggestions(fleet, ref('a'), false)
    expect([...(room?.ids ?? [])]).toEqual([3])
    expect(room?.location).toBe('Fountain box')
    expect([...(entitySuggestions(fleet, ref('a'), true)?.ids ?? [])].toSorted()).toEqual([2, 3])
  })

  it('falls back to the location when the anchor has no container', () => {
    const room = entitySuggestions(fleet, ref('room-a'), false)
    expect([...(room?.ids ?? [])]).toEqual([6])
    expect(room?.location).toBe('Kitchen')
  })

  it('suggests nothing without an anchor or when nothing relates to it', () => {
    expect(entitySuggestions(fleet, null, false)).toBeNull()
    expect(entitySuggestions(fleet, ref('elsewhere'), false)).toBeNull()
  })

  it('lists every non-container device as a candidate and drops those already taken', () => {
    expect(deviceCandidates(fleet).map((c) => c.deviceId)).not.toContain(1)
    const taken = new Set(['ha/a'])
    expect(deviceCandidates(fleet, taken).map((c) => c.deviceId)).not.toContain(2)
  })
})
