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
  compileDraft,
  draftForPick,
  draftForTemplate,
  draftFromHelper,
  draftMembers,
  fieldStateOf,
  calculationTileIds,
  mathTileIds,
  sharedMethodsView,
  withDraftMembers,
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
  fieldPath: 'temperature',
}

const garden: HelperMember = {
  source: { addonId: 'provider-homeassistant', stableId: 'sensor.garden' },
  cap: 'temperature-sensor',
  fieldPath: 'temperature',
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
      {
        id: 'actuators',
        templateIds: [
          'switch',
          'light',
          'fan',
          'cover',
          'valve',
          'lock',
          'media-player',
          'climate',
        ],
      },
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
      { kind: 'answered', caps: { 'temperature-sensor': { temperature: null } } },
      requireTemplate('temperature'),
    )
    expect(reading).toEqual({ kind: 'empty' })
    expect(
      outputReading(
        { kind: 'answered', caps: { 'temperature-sensor': { temperature: 21.4 } } },
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
    fieldPath: 'power',
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

const reading = (n: number): HelperMember => ({
  source: { addonId: 'provider-demo', stableId: `sensor.${n}` },
  cap: 'numeric-sensor',
  fieldPath: 'value',
})

describe('math drafts', () => {
  it('offers six math tiles', () => {
    expect(mathTileIds()).toEqual([
      'threshold',
      'sum',
      'difference',
      'ratio',
      'expression',
      'derivative',
    ])
  })

  it('the picker no longer starts a device from sum: it is a readings aggregation', () => {
    expect(calculationTileIds()).toEqual(['threshold', 'difference', 'ratio', 'derivative'])
    expect(withAggregate(draftForTemplate('temperature') as HelperFormDraft, 'sum').aggregate).toBe(
      'sum',
    )
  })

  it('a saved math sum still opens as its arithmetic draft', () => {
    const member = {
      source: { addonId: 'provider-homeassistant', stableId: 'sensor.a' },
      cap: 'temperature-sensor',
      fieldPath: 'temperature',
    }
    const draft = draftFromHelper(
      { kind: 'arithmetic', op: 'sum', inputs: [member, member] },
      'Total',
      '',
    )
    expect(draft?.kind).toBe('arithmetic')
  })

  it('a threshold needs one reading and a low edge that is not above the high edge', () => {
    const draft = draftForPick({ kind: 'threshold' })
    if (draft?.kind !== 'threshold') throw new Error('expected a threshold draft')
    expect(canSaveDraft(draft)).toBe(false)
    const picked = withDraftMembers({ ...draft, high: 25, low: 20 }, [reading(1)])
    expect(canSaveDraft(picked)).toBe(true)
    expect(canSaveDraft({ ...picked, low: 30 } as typeof picked)).toBe(false)
    const spec = specFromDraft(picked)
    expect(spec).toMatchObject({ kind: 'threshold', high: 25, low: 20, onForMs: 0, offForMs: 0 })
    expect(compileDraft(picked).ok).toBe(true)
    expect(draftMembers(picked)).toEqual([reading(1)])
  })

  it('a difference and a ratio take exactly two readings, a sum two or more', () => {
    const difference = draftForPick({ kind: 'arithmetic', op: 'difference' })
    const sum = draftForPick({ kind: 'arithmetic', op: 'sum' })
    if (difference?.kind !== 'arithmetic' || sum?.kind !== 'arithmetic') throw new Error('draft')
    expect(canSaveDraft(withDraftMembers(difference, [reading(1)]))).toBe(false)
    expect(canSaveDraft(withDraftMembers(difference, [reading(1), reading(2)]))).toBe(true)
    expect(canSaveDraft(withDraftMembers(difference, [reading(1), reading(2), reading(3)]))).toBe(
      false,
    )
    expect(canSaveDraft(withDraftMembers(sum, [reading(1)]))).toBe(false)
    expect(canSaveDraft(withDraftMembers(sum, [reading(1), reading(2), reading(3)]))).toBe(true)
  })

  it('an expression names its inputs a, b, c and keeps a name when the list changes', () => {
    const draft = draftForPick({ kind: 'expression' })
    if (draft?.kind !== 'expression') throw new Error('expected an expression draft')
    const two = withDraftMembers({ ...draft, expr: 'a - b' }, [reading(1), reading(2)])
    if (two.kind !== 'expression') throw new Error('kind')
    expect(two.inputs.map((input) => input.name)).toEqual(['a', 'b'])
    const renamed: typeof two = {
      ...two,
      inputs: [{ name: 'inlet', member: reading(1) }, ...two.inputs.slice(1)],
    }
    const three = withDraftMembers(renamed, [reading(1), reading(2), reading(3)])
    if (three.kind !== 'expression') throw new Error('kind')
    expect(three.inputs.map((input) => input.name)).toEqual(['inlet', 'b', 'c'])
    const dropped = withDraftMembers(three, [reading(3), reading(1)])
    if (dropped.kind !== 'expression') throw new Error('kind')
    expect(dropped.inputs.map((input) => [input.name, input.member.source.stableId])).toEqual([
      ['c', 'sensor.3'],
      ['inlet', 'sensor.1'],
    ])
    expect(canSaveDraft({ ...two, expr: '   ' })).toBe(false)
    expect(canSaveDraft(two)).toBe(true)
    expect(compileDraft(two).ok).toBe(true)
  })

  it('a derivative reads one reading over a rolling window per hour by default', () => {
    const draft = draftForPick({ kind: 'derivative' })
    if (draft?.kind !== 'derivative') throw new Error('expected a derivative draft')
    expect(draft.per).toBe('hour')
    expect(draft.window).toEqual({ kind: 'rolling', span: '1h' })
    expect(canSaveDraft(draft)).toBe(false)
    const picked = withDraftMembers(draft, [reading(1)])
    expect(canSaveDraft(picked)).toBe(true)
    expect(specFromDraft(picked)).toMatchObject({ kind: 'derivative', per: 'hour' })
  })

  it('opens a stored math helper back as the same draft', () => {
    const specs = [
      {
        kind: 'threshold',
        source: reading(1),
        high: 3,
        low: 2,
        onForMs: 1000,
        offForMs: 2000,
      },
      { kind: 'arithmetic', op: 'ratio', inputs: [reading(1), reading(2)] },
      {
        kind: 'expression',
        expr: 'a + b',
        inputs: [
          { name: 'a', member: reading(1) },
          { name: 'b', member: reading(2) },
        ],
        output: 'number',
      },
      {
        kind: 'derivative',
        window: { kind: 'rolling', span: '24h' },
        per: 'minute',
        source: reading(1),
      },
    ] as const
    for (const spec of specs) {
      const draft = draftFromHelper(spec, 'Name', '')
      expect(draft, spec.kind).not.toBeNull()
      if (draft === null) continue
      expect(specFromDraft(draft), spec.kind).toEqual(spec)
    }
  })

  it('has a whole phrase for every math tile in both locales', async () => {
    const en = (await import('../../../i18n/en.json')).default.helper.newTitle as Record<
      string,
      string
    >
    const it_ = (await import('../../../i18n/it.json')).default.helper.newTitle as Record<
      string,
      string
    >
    for (const id of mathTileIds()) {
      expect(en[id], id).toBeTruthy()
      expect(it_[id], id).toBeTruthy()
    }
  })
})

describe('actuator groups of every type', () => {
  it('a new type starts with the at-least-one criterion', () => {
    for (const id of ['fan', 'cover', 'valve', 'lock', 'media-player', 'climate'] as const) {
      expect(draftForTemplate(id)?.active, id).toBe('at-least-one')
    }
  })

  it('shares only what every member can take, and stays pending until all answered', () => {
    expect(
      sharedMethodsView('cover', [
        { kind: 'ready', caps: ['cover'], features: ['cover-positionable', 'cover-tilt'] },
        { kind: 'pending' },
      ]),
    ).toEqual({ kind: 'pending' })
    const view = sharedMethodsView('cover', [
      { kind: 'ready', caps: ['cover'], features: ['cover-positionable', 'cover-tilt'] },
      { kind: 'ready', caps: ['cover'], features: ['cover-positionable'] },
    ])
    expect(view).toMatchObject({ kind: 'ready' })
    if (view.kind !== 'ready') return
    expect(view.methods).toEqual(['cover.open', 'cover.close', 'cover.stop', 'cover.setPosition'])
    expect(sharedMethodsView('cover', [{ kind: 'error' }])).toEqual({ kind: 'unavailable' })
  })

  it('reads a state string as a value on a member of a state group', () => {
    const caps = { cover: { state: 'open' } }
    expect(fieldStateOf('success', caps, 'cover', 'state')).toBe('empty')
    expect(fieldStateOf('success', caps, 'cover', 'state', true)).toBe('value')
    expect(fieldStateOf('success', { cover: {} }, 'cover', 'state', true)).toBe('missing')
  })
})
