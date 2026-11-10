import { describe, expect, it } from 'vitest'
import type { OsdSlotBinding, OsdSlotView } from '@camstack/types'
import {
  activeSourceChips,
  cameraOsdStatus,
  defaultActiveSlotId,
  parseSlotContentPanel,
  slotTabStatus,
  slotTabStatusLabel,
  cameraStatusLabel,
  cameraStatusTone,
  draftForSlot,
  emptyBindingDraft,
  outcomeLabel,
  outcomeTone,
  sourceSummary,
  withoutCondition,
  writableSlots,
} from '../osd-page-model.js'

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
      makeSlot({ slotId: 'text-2', binding: activeBinding({ kind: 'template', templateId: 't' }) }),
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
  it('ignores unbound and disabled slots', () => {
    const slots = [
      makeSlot({ slotId: 'text-1', binding: null }),
      makeSlot({ slotId: 'text-2', binding: activeBinding({ kind: 'static', text: 'x' }, false) }),
    ]
    expect(activeSourceChips(slots)).toEqual([])
  })

  it('never surfaces the raw slot id', () => {
    const slots = [
      makeSlot({ slotId: 'text-1', binding: activeBinding({ kind: 'static', text: 'x' }) }),
    ]
    const labels = activeSourceChips(slots).map((c) => c.label)
    expect(labels.join(' ')).not.toContain('text-1')
  })

  it('labels static text plainly', () => {
    const slots = [
      makeSlot({ slotId: 'text-1', binding: activeBinding({ kind: 'static', text: 'hi' }) }),
    ]
    expect(activeSourceChips(slots).map((c) => c.label)).toEqual(['Static text'])
  })

  it('de-duplicates the same template across multiple slots', () => {
    const slots = [
      makeSlot({ slotId: 'text-1', binding: activeBinding({ kind: 'template', templateId: 'a' }) }),
      makeSlot({ slotId: 'text-2', binding: activeBinding({ kind: 'template', templateId: 'a' }) }),
    ]
    expect(activeSourceChips(slots, new Map([['a', 'Outside']]))).toEqual([
      { key: 'template:a', label: 'Outside' },
    ])
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
    expect(activeSourceChips(slots, names)).toEqual([
      {
        key: 'template:c93f0a90-0e74-4e0c-a790-084ad195ec84',
        label: 'Temperatura esterna',
      },
    ])
  })
})

describe('parseSlotContentPanel', () => {
  it('defaults and accepts known panel ids', () => {
    expect(parseSlotContentPanel(null)).toBe('layer')
    expect(parseSlotContentPanel('binding')).toBe('binding')
    expect(parseSlotContentPanel('nope')).toBe('layer')
  })
})

describe('emptyBindingDraft / draftForSlot', () => {
  it('produces a none-source default for unbound slots', () => {
    const draft = emptyBindingDraft()
    expect(draft).toMatchObject({
      enabled: true,
      source: { kind: 'none' },
    })
  })

  it('reuses the saved binding when present', () => {
    const binding: OsdSlotBinding = {
      enabled: true,
      source: { kind: 'static', text: 'hi' },
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

describe('sourceSummary', () => {
  it('reports unbound', () => {
    expect(sourceSummary(null)).toBe('Unbound')
  })

  it('summarizes a static source', () => {
    expect(sourceSummary({ enabled: true, source: { kind: 'static', text: 'Hello' } })).toBe(
      'Static: "Hello"',
    )
  })

  it('names a template source by its template, falling back to the id', () => {
    const binding: OsdSlotBinding = { enabled: true, source: { kind: 'template', templateId: 'a' } }
    expect(sourceSummary(binding, new Map([['a', 'Outside']]))).toBe('Outside')
    expect(sourceSummary(binding)).toBe('a')
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
