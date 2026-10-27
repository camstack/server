/**
 * The helper form stores a template, never an expression (D944 phase 1a).
 */

import {
  compileHelper,
  type GroupHelperSpec,
  type GroupTemplate,
  groupTemplate,
  type HelperMember,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  canSaveDraft,
  commandResultsFromSnapshot,
  draftForTemplate,
  draftFromHelper,
  type HelperFormDraft,
  groupStatusFromSnapshot,
  helperTemplateGroups,
  isHelperComposition,
  memberPresence,
  namedExcluded,
  outputReading,
  refusalFromMessage,
  sharedCapsView,
  specFromDraft,
  withActive,
  withAggregate,
  withAppliance,
  withTemplate,
} from '../helper-form-model'

const porch: HelperMember = {
  source: { addonId: 'provider-homeassistant', stableId: 'sensor.porch' },
  cap: 'temperature-sensor',
  fieldPath: 'celsius',
}

const garden: HelperMember = {
  source: { addonId: 'provider-homeassistant', stableId: 'sensor.garden' },
  cap: 'temperature-sensor',
  fieldPath: 'celsius',
}

function temperature(members: readonly HelperMember[]): GroupHelperSpec {
  return { kind: 'group', templateId: 'temperature', aggregate: 'mean', members: [...members] }
}

describe('helper template groups', () => {
  it('offers readings and binary sensors, and hides templates the composer cannot run', () => {
    expect(helperTemplateGroups()).toEqual([
      {
        id: 'readings',
        templateIds: [
          'temperature',
          'humidity',
          'pressure',
          'illuminance',
          'power',
          'energy',
          'battery',
          'numeric',
        ],
      },
      {
        id: 'binary',
        templateIds: ['motion', 'contact', 'leak', 'smoke', 'occupancy', 'binary'],
      },
      { id: 'actuators', templateIds: ['switch', 'light'] },
      { id: 'appliances', templateIds: ['appliance'] },
    ])
  })

  it('stores the active criterion on a switch group and not on a temperature group', () => {
    const draft = draftForTemplate('switch')
    expect(draft?.active).toBe('at-least-one')
    expect(draft?.aggregate).toBe('any')
    if (draft === null) return
    const all = withActive(draft, 'all')
    expect(all.aggregate).toBe('all')
    const stored = specFromDraft(all)
    expect(stored?.kind).toBe('group')
    if (stored?.kind !== 'group') return
    expect(stored.active).toBe('all')
    const back = draftFromHelper(stored, 'Porch', '')
    if (back?.kind !== 'group') throw new Error('expected the switch group')
    expect(back.active).toBe('all')
    expect(draftForTemplate('temperature')?.active).toBeNull()
    const temperature = specFromDraft(draftForTemplate('temperature') ?? draft)
    expect(temperature?.kind).toBe('group')
    if (temperature?.kind !== 'group') return
    expect(temperature.active).toBeUndefined()
  })

  it('does not treat an unanswered member as a light with no shared controls', () => {
    expect(
      sharedCapsView([
        { kind: 'ready', caps: ['switch', 'brightness', 'color'], features: [] },
        { kind: 'pending' },
      ]),
    ).toEqual({ kind: 'pending' })
    expect(
      sharedCapsView([
        { kind: 'ready', caps: ['switch', 'brightness', 'color'], features: ['light-color-rgb'] },
        { kind: 'ready', caps: ['switch', 'brightness'], features: [] },
      ]),
    ).toEqual({ kind: 'ready', caps: ['switch', 'brightness'], modes: [] })
  })

  it('reads a per-member command result and leaves an absent slice as none', () => {
    expect(commandResultsFromSnapshot({ kind: 'answered', caps: {} })).toEqual({ kind: 'none' })
    expect(commandResultsFromSnapshot({ kind: 'pending' })).toEqual({ kind: 'pending' })
    expect(
      commandResultsFromSnapshot({
        kind: 'answered',
        caps: {
          'group-commands': {
            results: [
              {
                deviceId: 2,
                cap: 'switch',
                method: 'setState',
                ok: false,
                error: 'relay refused',
                at: 5,
              },
            ],
          },
        },
      }).kind,
    ).toBe('rows')
  })

  it('starts a temperature group on mean and a power group on sum', () => {
    expect(draftForTemplate('temperature')?.aggregate).toBe('mean')
    expect(draftForTemplate('power')?.aggregate).toBe('sum')
    expect(draftForTemplate('motion')?.aggregate).toBe('any')
  })

  it('ignores a reducer the template does not offer', () => {
    const draft = draftForTemplate('motion')
    expect(draft).not.toBeNull()
    if (draft === null) return
    expect(withAggregate(draft, 'mean').aggregate).toBe('any')
    expect(withAggregate(draft, 'all').aggregate).toBe('all')
  })

  it('keeps every choice when the template stays, and resets them when it changes', () => {
    const draft = draftForTemplate('temperature')
    expect(draft).not.toBeNull()
    if (draft === null) return
    const named = { ...draft, name: 'Front door', aggregate: 'max' as const, members: [porch] }
    expect(withTemplate(named, 'temperature')).toBe(named)
    const next = withTemplate(named, 'humidity')
    expect(next.templateId).toBe('humidity')
    expect(next.name).toBe('')
    expect(next.members).toEqual([])
    expect(next.aggregate).toBe('mean')
  })
})

describe('editing a stored helper', () => {
  it('reopens the spec as the template, not as an expression', () => {
    const spec = temperature([porch, garden])
    const draft = draftFromHelper(spec, 'Front door', 'Porch')
    if (draft?.kind !== 'group') throw new Error('expected the temperature group')
    expect(draft.templateId).toBe('temperature')
    expect(draft.aggregate).toBe('mean')
    expect(draft.members).toEqual([porch, garden])
    const roundTrip = specFromDraft(draft)
    if (roundTrip?.kind !== 'group') return
    expect(roundTrip.members[0]?.source).not.toBe(spec.members[0]?.source)
    const compiled = compileHelper(spec)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(isHelperComposition(compiled.composition)).toBe(true)
    const free = { ...compiled.composition, helper: undefined }
    expect(isHelperComposition(free)).toBe(false)
  })
})

describe('refusals', () => {
  it('shows mixed-quantity by its code and the server reason', () => {
    const text =
      'core-blocks: the composition "Front door" was refused — helper.members [mixed-quantity]: a numeric group requires one quantity; members report temperature and humidity'
    expect(refusalFromMessage(text)).toEqual([
      {
        path: 'helper.members',
        code: 'mixed-quantity',
        message: 'a numeric group requires one quantity; members report temperature and humidity',
      },
    ])
  })

  it('keeps an unnamed failure as the message the server sent', () => {
    expect(refusalFromMessage('network down')).toEqual([
      { path: '', code: 'refused', message: 'network down' },
    ])
  })
})

describe('group status on the device page', () => {
  it('reads N of M from group-status and does not turn a missing reading into 0', () => {
    const template = draftForTemplate('temperature')
    expect(template).not.toBeNull()
    const reading = outputReading(
      { kind: 'answered', caps: { 'temperature-sensor': { celsius: null } } },
      requireTemplate('temperature'),
    )
    expect(reading).toEqual({ kind: 'empty' })
    expect(
      outputReading(
        { kind: 'answered', caps: { 'temperature-sensor': { celsius: 21.4 } } },
        requireTemplate('temperature'),
      ),
    ).toEqual({ kind: 'number', value: 21.4, unit: '°C' })
    expect(
      groupStatusFromSnapshot({
        kind: 'answered',
        caps: { 'group-status': { included: 2, excluded: 1, total: 3 } },
      }),
    ).toEqual({ kind: 'ready', included: 2, excluded: 1, total: 3 })
    expect(groupStatusFromSnapshot({ kind: 'pending' })).toEqual({ kind: 'pending' })
    expect(groupStatusFromSnapshot({ kind: 'answered', caps: {} })).toEqual({ kind: 'absent' })
  })

  it('names excluded members and does not call an unanswered member excluded', () => {
    expect(memberPresence({ fleet: 'pending', deviceOnline: false, field: 'empty' })).toBe(
      'unknown',
    )
    expect(memberPresence({ fleet: 'answered', deviceOnline: false, field: 'value' })).toBe(
      'excluded',
    )
    expect(memberPresence({ fleet: 'answered', deviceOnline: true, field: 'value' })).toBe(
      'reporting',
    )
    expect(memberPresence({ fleet: 'answered', deviceOnline: null, field: 'missing' })).toBe(
      'excluded',
    )
    expect(
      namedExcluded([
        { name: 'Porch', presence: 'reporting' },
        { name: 'Garden', presence: 'unknown' },
      ]),
    ).toEqual({ kind: 'pending' })
    expect(
      namedExcluded([
        { name: 'Porch', presence: 'reporting' },
        { name: 'Garden', presence: 'excluded' },
      ]),
    ).toEqual({ kind: 'named', names: ['Garden'] })
  })
})

function specAsDraft(spec: GroupHelperSpec): HelperFormDraft {
  return {
    kind: 'group',
    templateId: spec.templateId,
    aggregate: spec.aggregate,
    active: spec.active ?? null,
    appliance: null,
    thresholdWatts: 0,
    startDwellMs: 0,
    stopDwellMs: 0,
    name: '',
    room: '',
    members: spec.members,
  }
}

function requireTemplate(id: 'temperature'): GroupTemplate {
  const template = groupTemplate(id)
  if (template === null) throw new Error('missing template')
  return template
}

describe('an appliance from a smart plug', () => {
  const plug: HelperMember = {
    source: { addonId: 'provider-homeassistant', stableId: 'sensor.plug_power' },
    cap: 'power-meter',
    fieldPath: 'watts',
  }

  it('compiles one power reading with the washer defaults and reopens the saved numbers', () => {
    const draft = draftForTemplate('appliance')
    expect(draft?.appliance).toBe('washer')
    expect(draft?.thresholdWatts).toBe(5)
    expect(draft?.startDwellMs).toBe(30_000)
    expect(draft?.stopDwellMs).toBe(600_000)
    expect(canSaveDraft(draft ?? specAsDraft(temperature([porch])))).toBe(false)
    if (draft === null) return
    const filled = { ...draft, name: 'Laundry', members: [plug] }
    expect(canSaveDraft(filled)).toBe(true)
    expect(withTemplate(filled, 'appliance')).toBe(filled)
    const spec = specFromDraft(filled)
    expect(spec?.kind).toBe('appliance')
    if (spec?.kind !== 'appliance') return
    expect(spec.thresholdWatts).toBe(5)
    expect(spec.stopDwellMs).toBe(600_000)
    const compiled = compileHelper(spec)
    expect(compiled.ok).toBe(true)
    const dryer = withAppliance(filled, 'dryer')
    expect(dryer.appliance).toBe('dryer')
    expect(dryer.stopDwellMs).toBe(600_000)
    const reopened = draftFromHelper({ ...spec, thresholdWatts: 8 }, 'Laundry', '')
    if (reopened?.kind !== 'group') throw new Error('expected the appliance draft')
    expect(reopened.thresholdWatts).toBe(8)
    expect(reopened.members).toEqual([plug])
  })
})

describe('the helper dialog title', () => {
  it('has a whole phrase for every template in both locales', async () => {
    const { GROUP_TEMPLATES } = await import('@camstack/types')
    const en = (await import('../../../i18n/en.json')).default.helper.newTitle as Record<
      string,
      string
    >
    const it_ = (await import('../../../i18n/it.json')).default.helper.newTitle as Record<
      string,
      string
    >
    for (const template of GROUP_TEMPLATES) {
      expect(en[template.id], template.id).toBeTruthy()
      expect(it_[template.id], template.id).toBeTruthy()
    }
    expect(en.washer).toBe('New washing machine')
    expect(it_.washer).toBe('Nuova lavatrice')
    expect(en.dryer).toBe('New dryer')
    expect(it_.dryer).toBe('Nuova asciugatrice')
    expect(en.dishwasher).toBe('New dishwasher')
    expect(it_.dishwasher).toBe('Nuova lavastoviglie')
  })
})
