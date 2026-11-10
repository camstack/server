/**
 * #483 / #487 — the rule editor reads the notifier's field declaration
 * (`TargetKind.caps` → `deliverableFields`) for the targets the rule selects:
 * the union decides what the rule-level form shows, each target's own panel
 * shows only its own fields, and an override the target cannot deliver is
 * never saved.
 */
import type { Target, TargetKindCaps } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildRuleInput, emptyRuleForm } from '../notification-rules.helpers'
import type { DeliveryKindRef } from '../rule-form-delivery'
import {
  fieldSupportForSelection,
  overridesForSave,
  targetFieldsOf,
  writeTargetOverride,
  writeTargetParam,
} from '../rule-form-target-settings'

const PUSH_CAPS: TargetKindCaps = {
  attachments: { mediaTypes: ['image'], mode: 'both', max: 1 },
  actions: 3,
  levels: [
    { id: 'low', label: 'Low', ordinal: 1 },
    { id: 'high', label: 'High', ordinal: 5 },
  ],
  format: ['text'],
  clickUrl: true,
  sound: false,
  ttl: false,
  bodyMaxLen: 4096,
}

/** A speaker that says a title and nothing else — one level, no priority. */
const SPEAKER_CAPS: TargetKindCaps = {
  text: { title: true, body: false },
  attachments: { mediaTypes: [], mode: 'url', max: 0 },
  actions: 0,
  levels: [{ id: 'default', label: 'Announce', ordinal: 3 }],
  format: ['text'],
  clickUrl: false,
  sound: false,
  ttl: false,
  bodyMaxLen: 250,
}

const KINDS: readonly DeliveryKindRef[] = [
  { kind: 'push', addonId: 'notifiers', caps: PUSH_CAPS },
  { kind: 'speaker', addonId: 'speakers', caps: SPEAKER_CAPS },
]

function target(id: string, name: string, kind: string, addonId: string): Target {
  return { id, name, kind, addonId, enabled: true, config: {} }
}

const TARGETS: readonly Target[] = [
  target('phone', 'Family phones', 'push', 'notifiers'),
  target('echo', 'Kitchen Echo', 'speaker', 'speakers'),
  target('mystery', 'Old relay', 'gone', 'removed-addon'),
]

describe('fieldSupportForSelection', () => {
  it('a rule addressing only the speaker shows the title alone', () => {
    const support = fieldSupportForSelection(['echo'], TARGETS, KINDS)
    expect(support.get('title')?.shown).toBe(true)
    expect(support.get('body')?.shown).toBe(false)
    expect(support.get('priority')?.shown).toBe(false)
    expect(support.get('attachments')?.shown).toBe(false)
    expect(support.get('actions')?.shown).toBe(false)
  })

  it('a mixed selection shows the union, naming the target that drops each field', () => {
    const support = fieldSupportForSelection(['phone', 'echo'], TARGETS, KINDS)
    expect(support.get('body')).toMatchObject({ shown: true, droppedBy: ['Kitchen Echo'] })
    expect(support.get('title')).toMatchObject({ shown: true, droppedBy: [] })
  })

  it('a target whose kind the catalog did not describe narrows nothing', () => {
    const support = fieldSupportForSelection(['echo', 'mystery'], TARGETS, KINDS)
    expect(support.get('body')?.shown).toBe(true)
  })

  it('a kind ref without caps (catalog answered without them) is unknown, not "delivers nothing"', () => {
    const fieldsOf = targetFieldsOf(TARGETS, [{ kind: 'speaker', addonId: 'speakers' }])
    expect(fieldsOf('echo')).toBeUndefined()
  })
})

describe('overridesForSave', () => {
  it('an unsupported override cannot be set: the speaker body and priority are dropped', () => {
    const saved = overridesForSave(
      ['echo'],
      { echo: { template: { title: 'Gate', body: 'never spoken' }, priority: 5 } },
      targetFieldsOf(TARGETS, KINDS),
    )
    expect(saved).toEqual({ echo: { template: { title: 'Gate' } } })
  })

  it('an override for a target no longer selected is not saved', () => {
    const saved = overridesForSave(
      ['phone'],
      { phone: { priority: 1 }, echo: { template: { title: 'Gate' } } },
      targetFieldsOf(TARGETS, KINDS),
    )
    expect(saved).toEqual({ phone: { priority: 1 } })
  })

  it('buildRuleInput carries the sanitized map, and `{}` when nothing is set', () => {
    const form = {
      ...emptyRuleForm(),
      name: 'Gate',
      targetIds: ['phone', 'echo'],
      targetOverrides: { echo: { template: { title: 'Gate', body: 'x' } } },
    }
    expect(
      buildRuleInput(form, undefined, [], targetFieldsOf(TARGETS, KINDS)).targetOverrides,
    ).toEqual({
      echo: { template: { title: 'Gate' } },
    })
    expect(buildRuleInput({ ...form, targetOverrides: {} }).targetOverrides).toEqual({})
  })
})

describe('writing one target', () => {
  it('writeTargetOverride sets and clears one target without touching the others', () => {
    const one = writeTargetOverride({ phone: { priority: 1 } }, 'echo', { priority: 4 })
    expect(one).toEqual({ phone: { priority: 1 }, echo: { priority: 4 } })
    expect(writeTargetOverride(one, 'echo', undefined)).toEqual({ phone: { priority: 1 } })
  })

  it('writeTargetParam writes that target alone, and drops an emptied entry', () => {
    const one = writeTargetParam({ phone: { sound: 'a' } }, 'echo', 'volume', 3)
    expect(one).toEqual({ phone: { sound: 'a' }, echo: { volume: 3 } })
    expect(writeTargetParam(one, 'echo', 'volume', undefined)).toEqual({ phone: { sound: 'a' } })
  })
})
