import {
  ALL_CAPABILITY_DEFINITIONS,
  type CompositionFieldsFeature,
  type CompositionForwardCommand,
  type CompositionSourceRef,
  petFountainFromEntitiesComposition,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  argOf,
  choiceOf,
  commandOfDraft,
  commandRows,
  defaultChoice,
  forwardableCaps,
  forwardableMethods,
  inputFieldsOf,
  parseStructuredArg,
  rowDraftOf,
  rowProblems,
  unservedMethods,
  withArg,
  withRowCommand,
} from '../command-model'

const ref = (stableId: string): CompositionSourceRef => ({
  addonId: 'provider-homeassistant',
  stableId,
})

const SOURCES = {
  waterLevel: ref('sensor.level'),
  waterVolume: ref('sensor.volume'),
  pump: ref('switch.pump'),
  pumpInterval: ref('switch.cycle'),
  pumpOnMinutes: ref('number.on'),
  pumpOffMinutes: ref('number.off'),
  lastDrink: ref('sensor.last'),
  currentHourDrink: ref('sensor.hour'),
  last24hDrink: ref('sensor.day'),
  todayDrink: ref('sensor.today'),
  clearDaily: ref('button.clear'),
  filter: { daysRemaining: ref('sensor.filter'), changed: ref('button.filter') },
}

function def(name: string) {
  const found = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === name)
  if (found === undefined) throw new Error(`no capability ${name}`)
  return found
}

function featureOf(cap: string): CompositionFieldsFeature {
  const feature = petFountainFromEntitiesComposition(SOURCES).features.find((f) => f.cap === cap)
  if (feature === undefined || feature.kind !== 'fields') throw new Error(`no feature ${cap}`)
  return feature
}

const PRESS = (stableId: string): CompositionForwardCommand => ({
  kind: 'forward',
  source: ref(stableId),
  cap: 'button',
  method: 'press',
})

describe('commandRows', () => {
  it('lists every method the built cap serves, in the cap order, with its stored forward', () => {
    const rows = commandRows(def('pet-fountain'), featureOf('pet-fountain'))
    expect(rows.map((r) => r.method)).toEqual([
      'setPump',
      'setPumpInterval',
      'setPumpOnMinutes',
      'setPumpOffMinutes',
      'resetDailyConsumption',
    ])
    expect(rows.every((r) => r.command !== null && !r.orphan)).toBe(true)
  })

  it('lists an item reset as a row of its own, keyed by the item', () => {
    const rows = commandRows(def('consumables'), featureOf('consumables'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'reset', itemKey: 'filter', id: 'items.filter.reset' })
    expect(rows[0]?.command?.cap).toBe('button')
  })

  it('shows a method with no command as an empty row, and says which are unserved', () => {
    const feature = withRowCommand(
      featureOf('pet-fountain'),
      commandRows(def('pet-fountain'), featureOf('pet-fountain'))[0]!,
      null,
    )
    const rows = commandRows(def('pet-fountain'), feature)
    expect(rows[0]?.command).toBeNull()
    expect(unservedMethods(def('pet-fountain'), feature)).toEqual(['setPump'])
  })

  it('keeps a stored command for a method the cap does not serve, as an orphan row', () => {
    const feature: CompositionFieldsFeature = {
      ...featureOf('pet-fountain'),
      commands: { ...featureOf('pet-fountain').commands, setNothing: PRESS('button.x') },
    }
    const orphan = commandRows(def('pet-fountain'), feature).find((r) => r.orphan)
    expect(orphan?.method).toBe('setNothing')
    const problems = rowProblems(def('pet-fountain'), feature, 0, orphan!, orphan!.command)
    expect(problems.map((p) => p.code)).toContain('command-method-unknown')
  })
})

describe('withRowCommand', () => {
  it('sets one method command and keeps every other', () => {
    const feature = featureOf('pet-fountain')
    const rows = commandRows(def('pet-fountain'), feature)
    const next = withRowCommand(feature, rows[4]!, PRESS('button.other'))
    expect(next.commands?.['resetDailyConsumption']).toEqual(PRESS('button.other'))
    expect(next.commands?.['setPump']).toEqual(feature.commands?.['setPump'])
    expect(Object.keys(next.commands ?? {})).toEqual(Object.keys(feature.commands ?? {}))
    expect(next.fields).toBe(feature.fields)
  })

  it('drops the commands key when the last command goes', () => {
    const only: CompositionFieldsFeature = {
      kind: 'fields',
      cap: 'pet-fountain',
      fields: {},
      commands: { setPump: PRESS('button.a') },
    }
    const row = commandRows(def('pet-fountain'), only).find((r) => r.method === 'setPump')!
    expect('commands' in withRowCommand(only, row, null)).toBe(false)
  })

  it('sets and clears an item reset without touching the item fields', () => {
    const feature = featureOf('consumables')
    const row = commandRows(def('consumables'), feature)[0]!
    const changed = withRowCommand(feature, row, PRESS('button.new'))
    expect(changed.items?.['filter']?.reset).toEqual(PRESS('button.new'))
    expect(changed.items?.['filter']?.fields).toBe(feature.items?.['filter']?.fields)
    const cleared = withRowCommand(feature, row, null)
    expect(cleared.items?.['filter'] !== undefined && 'reset' in cleared.items['filter']).toBe(
      false,
    )
    expect(cleared.items?.['filter']?.label).toBe('Filter')
  })
})

describe('rowProblems — the validator, by name', () => {
  const feature = featureOf('pet-fountain')
  const rows = commandRows(def('pet-fountain'), feature)
  const setPump = rows[0]!
  const setOnMinutes = rows[2]!

  it('has none for the preset forwards', () => {
    for (const row of rows) {
      expect(rowProblems(def('pet-fountain'), feature, 0, row, row.command)).toEqual([])
    }
  })

  it('refuses a source method that is a query', () => {
    const command: CompositionForwardCommand = {
      kind: 'forward',
      source: ref('switch.pump'),
      cap: 'switch',
      method: 'getState',
    }
    const codes = rowProblems(def('pet-fountain'), feature, 0, setPump, command).map((p) => p.code)
    expect(codes).toEqual(['command-source-unknown'])
  })

  it('names an argument the source method does not take', () => {
    const command: CompositionForwardCommand = {
      kind: 'forward',
      source: ref('switch.pump'),
      cap: 'switch',
      method: 'setState',
      args: { on: { $input: 'on' }, speed: 3 },
    }
    const problems = rowProblems(def('pet-fountain'), feature, 0, setPump, command)
    expect(problems.map((p) => p.code)).toContain('command-input-unknown')
    expect(problems.find((p) => p.code === 'command-input-unknown')?.message).toContain('speed')
  })

  it('names a required source input nothing provides', () => {
    const command: CompositionForwardCommand = {
      kind: 'forward',
      source: ref('number.on'),
      cap: 'control',
      method: 'setValue',
      args: {},
    }
    const codes = rowProblems(def('pet-fountain'), feature, 0, setOnMinutes, command).map(
      (p) => p.code,
    )
    expect(codes).toContain('command-input-missing')
  })
})

describe('source methods and inputs come from the definitions', () => {
  it('offers mutations only, never a query or a system method', () => {
    const methods = forwardableMethods(def('switch'))
    expect(methods).toContain('setState')
    expect(methods).not.toContain('getState')
  })

  it('offers only caps that have a callable mutation', () => {
    const names = forwardableCaps(['switch', 'device-status', 'unknown-cap']).map((d) => d.name)
    expect(names).toContain('switch')
    expect(names).not.toContain('unknown-cap')
  })

  it('reads the input fields of a method, without the source device id', () => {
    const fields = inputFieldsOf(def('switch'), 'setState')
    expect(fields.map((f) => f.name)).not.toContain('deviceId')
    expect(fields.find((f) => f.name === 'on')).toMatchObject({ required: true, type: 'boolean' })
    expect(inputFieldsOf(def('control'), 'setValue').find((f) => f.name === 'control')?.type).toBe(
      'structured',
    )
  })
})

describe('the args template', () => {
  it('maps a choice to its wire form and back', () => {
    expect(argOf({ kind: 'input', field: 'minutes' })).toEqual({ $input: 'minutes' })
    expect(choiceOf({ $input: 'minutes' })).toEqual({ kind: 'input', field: 'minutes' })
    expect(choiceOf(true)).toEqual({ kind: 'constant', value: true })
    expect(choiceOf({ kind: 'numeric' })).toEqual({
      kind: 'structured',
      value: { kind: 'numeric' },
    })
  })

  it('starts a field from the caller input of the same name, else a typed constant', () => {
    const on = { name: 'on', required: true, type: 'boolean' as const }
    expect(defaultChoice(on, ['on'])).toEqual({ kind: 'input', field: 'on' })
    expect(defaultChoice(on, [])).toEqual({ kind: 'constant', value: true })
  })

  it('sets and removes one field without touching the others', () => {
    const args = withArg({ a: 1 }, 'b', { $input: 'x' })
    expect(args).toEqual({ a: 1, b: { $input: 'x' } })
    expect(withArg(args, 'a', undefined)).toEqual({ b: { $input: 'x' } })
  })

  it('parses a structured value and refuses text that is not one', () => {
    expect(parseStructuredArg('{"kind":"numeric","value":{"$input":"minutes"}}')).toEqual({
      kind: 'numeric',
      value: { $input: 'minutes' },
    })
    expect(parseStructuredArg('{not json')).toBeNull()
    expect(parseStructuredArg('null')).toBeNull()
  })

  it('builds the forward only once the source, cap and method are all chosen', () => {
    expect(commandOfDraft(rowDraftOf(null))).toBeNull()
    const draft = { source: ref('switch.pump'), cap: 'switch', method: '', args: undefined }
    expect(commandOfDraft(draft)).toBeNull()
    expect(commandOfDraft({ ...draft, method: 'setState' })).toEqual({
      kind: 'forward',
      source: ref('switch.pump'),
      cap: 'switch',
      method: 'setState',
    })
  })
})
