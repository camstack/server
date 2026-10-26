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
  draftForTemplate,
  draftFromHelper,
  groupStatusFromSnapshot,
  helperTemplateGroups,
  isHelperComposition,
  memberPresence,
  namedExcluded,
  outputReading,
  refusalFromMessage,
  specFromDraft,
  withAggregate,
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
    ])
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

  it('changing template keeps the name and drops members from the previous reading', () => {
    const draft = draftForTemplate('temperature')
    expect(draft).not.toBeNull()
    if (draft === null) return
    const named = { ...draft, name: 'Veranda', room: 'Porch', members: [porch] }
    const next = withTemplate(named, 'humidity')
    expect(next.templateId).toBe('humidity')
    expect(next.name).toBe('Veranda')
    expect(next.room).toBe('Porch')
    expect(next.members).toEqual([])
    expect(next.aggregate).toBe('mean')
  })
})

describe('editing a stored helper', () => {
  it('reopens the spec as the template, not as an expression', () => {
    const spec = temperature([porch, garden])
    const draft = draftFromHelper(spec, 'Veranda', 'Porch')
    expect(draft?.templateId).toBe('temperature')
    expect(draft?.aggregate).toBe('mean')
    expect(draft?.members).toEqual([porch, garden])
    expect(specFromDraft(draft ?? specAsDraft(spec)).members[0]?.source).not.toBe(
      spec.members[0]?.source,
    )
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
      'core-blocks: the composition "Veranda" was refused — helper.members [mixed-quantity]: a numeric group requires one quantity; members report temperature and humidity'
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

function specAsDraft(spec: GroupHelperSpec) {
  return {
    templateId: spec.templateId,
    aggregate: spec.aggregate,
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
