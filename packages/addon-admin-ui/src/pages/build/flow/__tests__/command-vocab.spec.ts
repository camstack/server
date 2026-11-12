import {
  type ActionTarget,
  AutomationCommandStepSchema,
  vocabularyActionsForDevice,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildCommandStep,
  type CommandStep,
  commonVocabActions,
  defaultArgValues,
  firstArgIssue,
  isRoundTarget,
  matchCommand,
  ROUND_TARGET,
  singleDeviceOf,
  splitPhrase,
  vocabLocale,
} from '../command-vocab'

const ACTIONS = vocabularyActionsForDevice(['pet-feeder', 'switch'])

function action(id: string) {
  const found = ACTIONS.find((a) => a.id === id)
  if (found === undefined) throw new Error(`no vocabulary action ${id}`)
  return found
}

const FEEDER: ActionTarget = { kind: 'devices', ids: [201] }

describe('command-vocab', () => {
  it('splits a phrase into text and slots', () => {
    expect(splitPhrase('Dispense {grams} from {device}')).toEqual([
      { kind: 'text', text: 'Dispense ' },
      { kind: 'slot', key: 'grams' },
      { kind: 'text', text: ' from ' },
      { kind: 'slot', key: 'device' },
    ])
  })

  it('round-trips a step by action id: step -> command + values -> step', () => {
    const step: CommandStep = {
      kind: 'command',
      target: { kind: 'devices', ids: [201] },
      actionId: 'petFeeder.feed',
      args: { grams: 45 },
      argUnits: { grams: 'g' },
    }
    const match = matchCommand(ACTIONS, step)
    expect(match?.action.id).toBe('petFeeder.feed')
    expect(match?.values).toEqual({ grams: { kind: 'fixed', value: 45, unit: 'g' } })
    if (match === null) return
    const rebuilt = buildCommandStep(match.action, step.target, match.values)
    expect(rebuilt).toEqual(step)
    // The stored step names no cap and no method, and passes the schema.
    expect(Object.keys(rebuilt).toSorted()).toEqual([
      'actionId',
      'argUnits',
      'args',
      'kind',
      'target',
    ])
    expect(AutomationCommandStepSchema.safeParse(rebuilt).success).toBe(true)
  })

  it('stores only the OPEN args: a baked arg is the action, not the step', () => {
    const on = buildCommandStep(action('switch.on'), { kind: 'devices', ids: [5] }, {})
    expect(on).toEqual({
      kind: 'command',
      target: { kind: 'devices', ids: [5] },
      actionId: 'switch.on',
    })
  })

  it('keeps the unit the person picked for a quantity arg through the round trip', () => {
    const step: CommandStep = {
      kind: 'command',
      target: { kind: 'devices', ids: [201] },
      actionId: 'petFeeder.feed',
      args: { grams: 56.699 },
      argUnits: { grams: 'oz' },
    }
    const match = matchCommand(ACTIONS, step)
    expect(match?.values).toEqual({ grams: { kind: 'fixed', value: 56.699, unit: 'oz' } })
    if (match === null) return
    expect(buildCommandStep(match.action, FEEDER, match.values)).toEqual(step)
  })

  it('a fresh quantity arg starts in the unit the method stores, never bare', () => {
    expect(defaultArgValues(action('petFeeder.feed'))['grams']).toMatchObject({ unit: 'g' })
  })

  it('keeps a variable reference through the round trip', () => {
    const step: CommandStep = {
      kind: 'command',
      target: { kind: 'devices', ids: [201] },
      actionId: 'petFeeder.feed',
      args: { grams: { $var: 'grams' } },
    }
    const match = matchCommand(ACTIONS, step)
    expect(match?.values['grams']).toEqual({ kind: 'var', name: 'grams' })
    if (match === null) return
    expect(buildCommandStep(match.action, FEEDER, match.values)).toEqual(step)
  })

  it('does not claim an action the target does not offer', () => {
    const step: CommandStep = {
      kind: 'command',
      target: { kind: 'devices', ids: [5] },
      actionId: 'cover.open',
    }
    expect(matchCommand(ACTIONS, step)).toBeNull()
  })

  it('names the single device of a target, and nothing for several or a variable', () => {
    expect(singleDeviceOf({ target: { kind: 'devices', ids: [3] } })).toBe(3)
    expect(singleDeviceOf({ target: { kind: 'devices', ids: [3, 4] } })).toBeNull()
    expect(singleDeviceOf({ target: { kind: 'var', name: 'deviceId' } })).toBeNull()
  })

  it('starts a number arg at its minimum and names an out-of-range value', () => {
    const feed = action('petFeeder.feed')
    const defaults = defaultArgValues(feed)
    expect(defaults['grams']?.kind).toBe('fixed')
    expect(firstArgIssue(feed, { grams: { kind: 'fixed', value: 1_000_000 } })?.issue).toBe('above')
    expect(firstArgIssue(feed, { grams: { kind: 'fixed', value: Number.NaN } })?.issue).toBe(
      'empty',
    )
    expect(firstArgIssue(feed, { grams: { kind: 'var', name: 'grams' } })).toBeNull()
  })

  it('reads the locale from the UI language', () => {
    expect(vocabLocale('it-IT')).toBe('it')
    expect(vocabLocale('en')).toBe('en')
  })
})

describe('the device of this round (#500)', () => {
  const FEEDER_AND_SWITCH = vocabularyActionsForDevice(['pet-feeder', 'switch'])
  const SWITCH_ONLY = vocabularyActionsForDevice(['switch'])
  const ids = (list: readonly { readonly id: string }[]) => list.map((a) => a.id).toSorted()

  it('offers only the commands every device of the loop has', () => {
    const common = commonVocabActions([FEEDER_AND_SWITCH, SWITCH_ONLY])
    expect(ids(common)).toEqual(ids(SWITCH_ONLY))
    expect(common.some((a) => a.cap === 'pet-feeder')).toBe(false)
  })

  it('offers nothing for an empty loop or when one device has no command', () => {
    expect(commonVocabActions([])).toEqual([])
    expect(commonVocabActions([SWITCH_ONLY, []])).toEqual([])
  })

  it('leaves out a command whose argument is answered per device', () => {
    const heater = vocabularyActionsForDevice(['water-heater', 'switch'])
    const dynamic = heater.filter((a) => a.openArgs.some((arg) => arg.offer.kind === 'dynamic'))
    expect(dynamic.length).toBeGreaterThan(0)
    const common = commonVocabActions([heater, heater])
    expect(common.length).toBeGreaterThan(0)
    for (const a of dynamic) expect(ids(common)).not.toContain(a.id)
  })

  it('writes and reads back a step aimed at the device of the round', () => {
    const on = SWITCH_ONLY[0]
    if (on === undefined) throw new Error('no switch command')
    const step = buildCommandStep(on, ROUND_TARGET, defaultArgValues(on))
    expect(step.target).toEqual({ kind: 'var', name: 'item' })
    expect(isRoundTarget(step)).toBe(true)
    expect(matchCommand(SWITCH_ONLY, step)?.action.id).toBe(on.id)
    expect(isRoundTarget({ target: { kind: 'var', name: 'deviceId' } })).toBe(false)
  })
})
