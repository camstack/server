import { describe, expect, it } from 'vitest'
import type { OsdSlotBinding, OsdSlotView, OsdSourceOption } from '@camstack/types'
import {
  activeSourceChips,
  cameraOsdStatus,
  defaultActiveSlotId,
  parseSlotContentPanel,
  parseTemplateContentPanel,
  slotTabStatus,
  slotTabStatusLabel,
  cameraStatusLabel,
  cameraStatusTone,
  draftForSlot,
  emptyBindingDraft,
  outcomeLabel,
  outcomeTone,
  sourceOptionFor,
  sourceSummary,
  shouldReseedValueMap,
  suggestedValueMap,
  withoutCondition,
  writableSlots,
} from '../osd-page-model.js'
import { nextValueMapForFieldChange } from '../../components/DeviceStatePickBlock.js'
import { OsdTemplateBindingSchema } from '@camstack/types'

function makeSlot(overrides: Partial<OsdSlotView> & { slotId: string }): OsdSlotView {
  return {
    kind: 'text',
    readOnly: false,
    cameraEnabled: true,
    binding: null,
    ...overrides,
  }
}

function activeBinding(source: OsdSlotBinding['source'], enabled = true): OsdSlotBinding {
  return {
    enabled,
    source,
    template: '${value}',
    maxDecimals: 1,
  }
}

describe('cameraOsdStatus', () => {
  it('is unsupported when the camera publishes no osd cap', () => {
    expect(cameraOsdStatus(false, [])).toBe('unsupported')
  })

  it('is disabled when OSD-capable but no writable slot exists', () => {
    expect(cameraOsdStatus(true, [makeSlot({ slotId: 'time-1', readOnly: true })])).toBe('disabled')
  })

  it('is disabled when every writable slot is unbound or switched off', () => {
    const slots = [
      makeSlot({ slotId: 'text-1', binding: null }),
      makeSlot({ slotId: 'text-2', binding: activeBinding({ kind: 'static', text: 'x' }, false) }),
    ]
    expect(cameraOsdStatus(true, slots)).toBe('disabled')
  })

  it('is enabled when every writable slot has an active binding', () => {
    const slots = [
      makeSlot({ slotId: 'text-1', binding: activeBinding({ kind: 'static', text: 'x' }) }),
      makeSlot({ slotId: 'text-2', binding: activeBinding({ kind: 'clock', pattern: 'HH:mm' }) }),
    ]
    expect(cameraOsdStatus(true, slots)).toBe('enabled')
  })

  it('is partial when only some writable slots are actively bound', () => {
    const slots = [
      makeSlot({ slotId: 'text-1', binding: activeBinding({ kind: 'static', text: 'x' }) }),
      makeSlot({ slotId: 'text-2', binding: null }),
    ]
    expect(cameraOsdStatus(true, slots)).toBe('partial')
  })

  it('labels and tones every status', () => {
    expect(cameraStatusLabel('enabled')).toBe('Enabled')
    expect(cameraStatusLabel('partial')).toBe('Partial')
    expect(cameraStatusTone('enabled')).toBe('success')
    expect(cameraStatusTone('partial')).toBe('warning')
    expect(cameraStatusTone('unsupported')).toBe('default')
  })
})

describe('slotTabStatus / defaultActiveSlotId / writableSlots', () => {
  it('labels a slot as bound, unbound, or readonly', () => {
    expect(slotTabStatus(makeSlot({ slotId: 'time-1', readOnly: true }))).toBe('readonly')
    expect(slotTabStatus(makeSlot({ slotId: 'text-1', binding: null }))).toBe('unbound')
    expect(
      slotTabStatus(
        makeSlot({ slotId: 'text-1', binding: activeBinding({ kind: 'static', text: 'x' }) }),
      ),
    ).toBe('bound')
    expect(slotTabStatusLabel('bound')).toBe('bound')
  })

  it('filters out read-only layers for the single-camera editor', () => {
    const mixed = [
      makeSlot({ slotId: 'time-1', readOnly: true }),
      makeSlot({ slotId: 'text-1', binding: null }),
    ]
    expect(writableSlots(mixed).map((s) => s.slotId)).toEqual(['text-1'])
  })

  it('defaults to the first writable slot, else the first slot', () => {
    const mixed = [
      makeSlot({ slotId: 'time-1', readOnly: true }),
      makeSlot({ slotId: 'text-1', binding: null }),
    ]
    expect(defaultActiveSlotId(mixed)).toBe('text-1')
    expect(defaultActiveSlotId([makeSlot({ slotId: 'time-1', readOnly: true })])).toBe('time-1')
    expect(defaultActiveSlotId([])).toBeUndefined()
  })
})

describe('activeSourceChips', () => {
  const deviceNames = new Map([[7, 'Backyard Sensor']])

  it('ignores unbound and disabled slots', () => {
    const slots = [
      makeSlot({ slotId: 'text-1', binding: null }),
      makeSlot({ slotId: 'text-2', binding: activeBinding({ kind: 'static', text: 'x' }, false) }),
    ]
    expect(activeSourceChips(slots, deviceNames)).toEqual([])
  })

  it('never surfaces the raw slot id', () => {
    const slots = [
      makeSlot({ slotId: 'text-1', binding: activeBinding({ kind: 'static', text: 'x' }) }),
    ]
    const labels = activeSourceChips(slots, deviceNames).map((c) => c.label)
    expect(labels.join(' ')).not.toContain('text-1')
  })

  it('labels a self-referential device-state source as "This camera"', () => {
    const slots = [
      makeSlot({
        slotId: 'text-1',
        binding: activeBinding({
          kind: 'device-state',
          capName: 'thermometer',
          valuePath: 'value',
        }),
      }),
    ]
    expect(activeSourceChips(slots, deviceNames)).toEqual([
      { key: 'device-state:self', label: 'This camera' },
    ])
  })

  it('resolves a linked device by name instead of showing its id', () => {
    const slots = [
      makeSlot({
        slotId: 'text-1',
        binding: activeBinding({
          kind: 'device-state',
          deviceId: 7,
          capName: 'thermometer',
          valuePath: 'value',
        }),
      }),
    ]
    const chips = activeSourceChips(slots, deviceNames)
    expect(chips).toEqual([{ key: 'device-state:7', label: 'Linked: Backyard Sensor' }])
  })

  it('labels recognition sources as person/plate, and clock/static plainly', () => {
    const slots = [
      makeSlot({
        slotId: 'text-1',
        binding: activeBinding({ kind: 'latest-recognition', recognition: 'person' }),
      }),
      makeSlot({
        slotId: 'text-2',
        binding: activeBinding({ kind: 'latest-recognition', recognition: 'plate' }),
      }),
      makeSlot({ slotId: 'text-3', binding: activeBinding({ kind: 'clock', pattern: 'HH:mm' }) }),
      makeSlot({ slotId: 'text-4', binding: activeBinding({ kind: 'static', text: 'hi' }) }),
    ]
    const labels = activeSourceChips(slots, deviceNames).map((c) => c.label)
    expect(labels).toEqual(['Recognized person', 'Recognized plate', 'Clock', 'Static text'])
  })

  it('de-duplicates identical sources across multiple slots', () => {
    const slots = [
      makeSlot({ slotId: 'text-1', binding: activeBinding({ kind: 'clock', pattern: 'HH:mm' }) }),
      makeSlot({ slotId: 'text-2', binding: activeBinding({ kind: 'clock', pattern: 'ss' }) }),
    ]
    expect(activeSourceChips(slots, deviceNames)).toEqual([{ key: 'clock', label: 'Clock' }])
  })

  it('labels named templates by name, not by id', () => {
    const slots = [
      makeSlot({
        slotId: 'text-1',
        binding: activeBinding({
          kind: 'template',
          templateId: 'c93f0a90-0e74-4e0c-a790-084ad195ec84',
        }),
      }),
    ]
    const names = new Map([['c93f0a90-0e74-4e0c-a790-084ad195ec84', 'Temperatura esterna']])
    expect(activeSourceChips(slots, deviceNames, names)).toEqual([
      {
        key: 'template:c93f0a90-0e74-4e0c-a790-084ad195ec84',
        label: 'Temperatura esterna',
      },
    ])
  })
})

describe('parseSlotContentPanel / parseTemplateContentPanel', () => {
  it('defaults and accepts known panel ids', () => {
    expect(parseSlotContentPanel(null)).toBe('layer')
    expect(parseSlotContentPanel('binding')).toBe('binding')
    expect(parseSlotContentPanel('nope')).toBe('layer')
    expect(parseTemplateContentPanel(null)).toBe('template')
    expect(parseTemplateContentPanel('bindings')).toBe('bindings')
    expect(parseTemplateContentPanel('nope')).toBe('template')
  })
})

describe('emptyBindingDraft / draftForSlot', () => {
  it('produces a none-source default for unbound slots', () => {
    const draft = emptyBindingDraft()
    expect(draft).toMatchObject({
      enabled: true,
      source: { kind: 'none' },
      template: '${value}',
      maxDecimals: 1,
    })
  })

  it('reuses the saved binding when present', () => {
    const binding: OsdSlotBinding = {
      enabled: true,
      source: { kind: 'static', text: 'hi' },
      template: '${value}',
      maxDecimals: 1,
    }
    const slot: OsdSlotView = {
      slotId: 'text-1',
      kind: 'text',
      readOnly: false,
      cameraEnabled: true,
      binding,
    }
    expect(draftForSlot(slot)).toBe(binding)
  })

  it('falls back to a fresh draft when unbound', () => {
    const slot: OsdSlotView = {
      slotId: 'text-1',
      kind: 'text',
      readOnly: false,
      cameraEnabled: false,
      binding: null,
    }
    expect(draftForSlot(slot)).toEqual(emptyBindingDraft())
  })
})

describe('suggestedValueMap', () => {
  it('is undefined with no source chosen', () => {
    expect(suggestedValueMap(undefined)).toBeUndefined()
  })

  it('seeds ON/OFF for a boolean source', () => {
    const option: OsdSourceOption = {
      deviceId: 1,
      deviceName: 'Front door',
      capName: 'contact',
      valuePath: 'entryOpen',
      label: 'Contact · entryOpen',
      valueType: 'boolean',
    }
    expect(suggestedValueMap(option)).toEqual({ true: 'ON', false: 'OFF' })
  })

  it('seeds identity mapping for an enum source', () => {
    const option: OsdSourceOption = {
      deviceId: 1,
      deviceName: 'Alarm',
      capName: 'alarm-panel',
      valuePath: 'state',
      label: 'Alarm Panel · state',
      valueType: 'enum',
      enumValues: ['armed-away', 'disarmed'],
    }
    expect(suggestedValueMap(option)).toEqual({ 'armed-away': 'armed-away', disarmed: 'disarmed' })
  })

  it('is undefined for a plain number/string source', () => {
    const option: OsdSourceOption = {
      deviceId: 1,
      deviceName: 'Sensor',
      capName: 'thermometer',
      valuePath: 'value',
      label: 'Thermometer · value',
      valueType: 'number',
    }
    expect(suggestedValueMap(option)).toBeUndefined()
  })
})

describe('shouldReseedValueMap / nextValueMapForFieldChange', () => {
  const booleanOpt: OsdSourceOption = {
    deviceId: 1,
    deviceName: 'Door',
    capName: 'contact',
    valuePath: 'entryOpen',
    label: 'Contact',
    valueType: 'boolean',
  }
  const enumOpt: OsdSourceOption = {
    deviceId: 2,
    deviceName: 'Alarm',
    capName: 'alarm-panel',
    valuePath: 'state',
    label: 'Alarm',
    valueType: 'enum',
    enumValues: ['armed', 'disarmed'],
  }

  it('reseeds empty, identity, and prior auto-seed maps', () => {
    expect(shouldReseedValueMap(undefined)).toBe(true)
    expect(shouldReseedValueMap({})).toBe(true)
    expect(shouldReseedValueMap({ armed: 'armed', disarmed: 'disarmed' })).toBe(true)
    expect(shouldReseedValueMap({ true: 'ON', false: 'OFF' }, { true: 'ON', false: 'OFF' })).toBe(
      true,
    )
  })

  it('keeps a custom operator map', () => {
    expect(shouldReseedValueMap({ true: 'MOTION', false: '' })).toBe(false)
  })

  it('seeds the next field without clobbering a custom map', () => {
    expect(nextValueMapForFieldChange(undefined, undefined, booleanOpt)).toEqual({
      true: 'ON',
      false: 'OFF',
    })
    expect(nextValueMapForFieldChange({ true: 'MOTION', false: '' }, booleanOpt, enumOpt)).toEqual({
      true: 'MOTION',
      false: '',
    })
    expect(nextValueMapForFieldChange({ true: 'ON', false: 'OFF' }, booleanOpt, enumOpt)).toEqual({
      armed: 'armed',
      disarmed: 'disarmed',
    })
  })
})

describe('OsdTemplateBindingSchema valueMap', () => {
  it('accepts an optional valueMap on a template binding', () => {
    const parsed = OsdTemplateBindingSchema.parse({
      alias: 'm',
      pick: { deviceId: 7 },
      capName: 'motion',
      valuePath: 'detected',
      valueMap: { true: 'MOTION', false: '' },
    })
    expect(parsed.valueMap).toEqual({ true: 'MOTION', false: '' })
  })
})

describe('sourceOptionFor', () => {
  const sources: OsdSourceOption[] = [
    {
      deviceId: 7,
      deviceName: 'Kitchen',
      capName: 'thermometer',
      valuePath: 'value',
      label: 'Thermometer · value',
      valueType: 'number',
    },
  ]

  it('finds the catalog entry a device-state source points at', () => {
    const binding: OsdSlotBinding = {
      enabled: true,
      source: { kind: 'device-state', deviceId: 7, capName: 'thermometer', valuePath: 'value' },
      template: '${value}${unit}',
      maxDecimals: 1,
    }
    expect(sourceOptionFor(sources, binding)?.label).toBe('Thermometer · value')
  })

  it('is undefined for a static/clock source', () => {
    const binding: OsdSlotBinding = {
      enabled: true,
      source: { kind: 'static', text: 'hi' },
      template: '${value}',
      maxDecimals: 1,
    }
    expect(sourceOptionFor(sources, binding)).toBeUndefined()
  })
})

describe('sourceSummary', () => {
  it('reports unbound', () => {
    expect(sourceSummary(null)).toBe('Unbound')
  })

  it('summarizes a static source', () => {
    const binding: OsdSlotBinding = {
      enabled: true,
      source: { kind: 'static', text: 'Hello' },
      template: '${value}',
      maxDecimals: 1,
    }
    expect(sourceSummary(binding)).toBe('Static: "Hello"')
  })

  it('summarizes a clock source', () => {
    const binding: OsdSlotBinding = {
      enabled: true,
      source: { kind: 'clock', pattern: 'HH:mm' },
      template: '${value}',
      maxDecimals: 1,
    }
    expect(sourceSummary(binding)).toBe('Clock (HH:mm)')
  })

  it('summarizes a device-state source', () => {
    const binding: OsdSlotBinding = {
      enabled: true,
      source: { kind: 'device-state', deviceId: 3, capName: 'thermometer', valuePath: 'value' },
      template: '${value}',
      maxDecimals: 1,
    }
    expect(sourceSummary(binding)).toBe('thermometer · value')
  })
})

describe('outcomeLabel / outcomeTone', () => {
  it('labels every outcome', () => {
    expect(outcomeLabel('written')).toBe('Written')
    expect(outcomeLabel('gated')).toBe('Gated (condition closed)')
    expect(outcomeLabel('failed')).toBe('Write failed')
  })

  it('tones failures as danger and steady states as success', () => {
    expect(outcomeTone('failed')).toBe('danger')
    expect(outcomeTone('written')).toBe('success')
    expect(outcomeTone('unchanged')).toBe('success')
    expect(outcomeTone('gated')).toBe('warning')
  })
})

describe('withoutCondition', () => {
  it('is undefined when conditions is already undefined', () => {
    expect(withoutCondition(undefined, 'devices')).toBeUndefined()
  })

  it('drops the named key, collapsing to undefined when nothing remains', () => {
    expect(withoutCondition({ devices: [1, 2] }, 'devices')).toBeUndefined()
  })

  it('keeps other keys', () => {
    expect(
      withoutCondition({ devices: [1], deviceState: { deviceId: 2, states: ['on'] } }, 'devices'),
    ).toEqual({ deviceState: { deviceId: 2, states: ['on'] } })
  })
})
