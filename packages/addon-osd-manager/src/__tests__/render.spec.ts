import { type OsdSlotBinding, OsdSlotBindingSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type OsdFacts, renderSlot } from '../render.js'
import type { TemplateOutcome } from '../template-context.js'

const CAMERA = 101

function facts(rendered: Record<string, TemplateOutcome> = {}): OsdFacts {
  return {
    atMs: Date.UTC(2026, 7, 7, 9, 5, 0),
    deviceState: () => undefined,
    rendered: new Map(Object.entries(rendered)),
  }
}

function binding(patch: Partial<OsdSlotBinding>): OsdSlotBinding {
  return OsdSlotBindingSchema.parse({ source: { kind: 'static', text: '' }, ...patch })
}

const TEMPLATE_BINDING = binding({ source: { kind: 'template', templateId: 'tpl' } })

describe('renderSlot', () => {
  it('reports unbound rather than pretending the slot is empty', () => {
    expect(renderSlot('text-1', null, CAMERA, facts(), undefined)).toMatchObject({
      outcome: 'unbound',
    })
  })

  it('reports disabled', () => {
    expect(
      renderSlot('text-1', binding({ enabled: false }), CAMERA, facts(), undefined),
    ).toMatchObject({ outcome: 'disabled' })
  })

  it('writes blank text for a none source and the text of a static one', () => {
    expect(
      renderSlot('text-1', binding({ source: { kind: 'none' } }), CAMERA, facts(), undefined),
    ).toMatchObject({ outcome: 'written', text: '' })
    expect(
      renderSlot(
        'text-1',
        binding({ source: { kind: 'static', text: 'GATE' } }),
        CAMERA,
        facts(),
        undefined,
      ),
    ).toMatchObject({ outcome: 'written', text: 'GATE' })
  })

  it('writes the text the hub rendered for the named template, cut to the firmware ceiling', () => {
    const f = facts({ tpl: { ok: true, text: ' 21.5°C garage ' } })
    expect(renderSlot('text-1', TEMPLATE_BINDING, CAMERA, f, undefined)).toMatchObject({
      outcome: 'written',
      text: '21.5°C garage',
    })
    expect(renderSlot('text-1', TEMPLATE_BINDING, CAMERA, f, undefined, 8)).toMatchObject({
      text: '21.5°...',
    })
  })

  it('keeps the last text, and says why, when the template did not render', () => {
    const refused = facts({ tpl: { ok: false, reason: 'render refused (timeout): slow' } })
    expect(renderSlot('text-1', TEMPLATE_BINDING, CAMERA, refused, '21°C')).toEqual({
      slotId: 'text-1',
      outcome: 'unreadable',
      text: '21°C',
      reason: 'render refused (timeout): slow',
    })
    expect(renderSlot('text-1', TEMPLATE_BINDING, CAMERA, facts(), undefined)).toMatchObject({
      outcome: 'unreadable',
      reason: expect.stringContaining('missing'),
    })
  })

  it('names the reason when the gate is closed (blank text)', () => {
    const closed = binding({
      source: { kind: 'static', text: 'GATE' },
      conditions: { deviceState: { deviceId: 9, states: ['on'] } },
    })
    expect(renderSlot('text-1', closed, CAMERA, facts(), undefined)).toMatchObject({
      outcome: 'gated',
      text: '',
    })
  })

  it('reports unchanged when the render matches what we last wrote, written once it moves', () => {
    const f = facts({ tpl: { ok: true, text: '21°C' } })
    expect(renderSlot('text-1', TEMPLATE_BINDING, CAMERA, f, '21°C')).toMatchObject({
      outcome: 'unchanged',
    })
    expect(renderSlot('text-1', TEMPLATE_BINDING, CAMERA, f, '20°C')).toMatchObject({
      outcome: 'written',
      text: '21°C',
    })
  })
})
