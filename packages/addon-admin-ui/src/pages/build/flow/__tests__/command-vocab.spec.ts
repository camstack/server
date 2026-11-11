import { vocabularyActionsForDevice } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildCapStep,
  type CapStep,
  commandId,
  commonVocabActions,
  defaultArgValues,
  firstArgIssue,
  isRoundTarget,
  matchRoundCommand,
  matchVocabCommand,
  ROUND_DEVICE,
  splitPhrase,
  vocabLocale,
} from '../command-vocab'

const ACTIONS = vocabularyActionsForDevice(['pet-feeder', 'switch'])

function action(id: string) {
  const found = ACTIONS.find((a) => a.id === id)
  if (found === undefined) throw new Error(`no vocabulary action ${id}`)
  return found
}

describe('command-vocab', () => {
  it('splits a phrase into text and slots', () => {
    expect(splitPhrase('Dispense {grams} from {device}')).toEqual([
      { kind: 'text', text: 'Dispense ' },
      { kind: 'slot', key: 'grams' },
      { kind: 'text', text: ' from ' },
      { kind: 'slot', key: 'device' },
    ])
  })

  it('round-trips a step with an open arg: step -> command + values -> step', () => {
    const step: CapStep = {
      kind: 'cap',
      deviceId: 201,
      cap: 'pet-feeder',
      method: 'feed',
      args: { grams: 45 },
    }
    const match = matchVocabCommand(ACTIONS, step)
    expect(match?.action.id).toBe('petFeeder.feed')
    // A saved bare number reads in the unit the method stores it in, and saves saying so.
    expect(match?.values).toEqual({ grams: { kind: 'fixed', value: 45, unit: 'g' } })
    if (match === null) return
    expect(buildCapStep(match.action, 201, match.values)).toEqual({
      ...step,
      argUnits: { grams: 'g' },
    })
  })

  it('keeps the unit the person picked for a quantity arg through the round trip', () => {
    const step: CapStep = {
      kind: 'cap',
      deviceId: 201,
      cap: 'pet-feeder',
      method: 'feed',
      args: { grams: 56.699 },
      argUnits: { grams: 'oz' },
    }
    const match = matchVocabCommand(ACTIONS, step)
    expect(match?.values).toEqual({ grams: { kind: 'fixed', value: 56.699, unit: 'oz' } })
    if (match === null) return
    expect(buildCapStep(match.action, 201, match.values)).toEqual(step)
  })

  it('a fresh quantity arg starts in the unit the method stores, never bare', () => {
    expect(defaultArgValues(action('petFeeder.feed'))['grams']).toMatchObject({ unit: 'g' })
  })

  it('keeps a variable reference through the round trip', () => {
    const step: CapStep = {
      kind: 'cap',
      deviceId: 201,
      cap: 'pet-feeder',
      method: 'feed',
      args: { grams: { $var: 'grams' } },
    }
    const match = matchVocabCommand(ACTIONS, step)
    expect(match?.values['grams']).toEqual({ kind: 'var', name: 'grams' })
    if (match === null) return
    expect(buildCapStep(match.action, 201, match.values)).toEqual(step)
  })

  it('tells commands that share a method apart by their baked args', () => {
    const on = matchVocabCommand(ACTIONS, {
      kind: 'cap',
      deviceId: 5,
      cap: 'switch',
      method: 'setState',
      args: { on: true },
    })
    const off = matchVocabCommand(ACTIONS, {
      kind: 'cap',
      deviceId: 5,
      cap: 'switch',
      method: 'setState',
      args: { on: false },
    })
    expect(on?.action.id).toBe('switch.on')
    expect(off?.action.id).toBe('switch.off')
  })

  it('does not claim a step it cannot represent', () => {
    const variableTarget: CapStep = {
      kind: 'cap',
      deviceId: { $var: 'deviceId' },
      cap: 'switch',
      method: 'setState',
      args: { on: true },
    }
    const several: CapStep = { ...variableTarget, deviceId: [1, 2] }
    const unknown: CapStep = { kind: 'cap', deviceId: 5, cap: 'switch', method: 'gone' }
    expect(matchVocabCommand(ACTIONS, variableTarget)).toBeNull()
    expect(matchVocabCommand(ACTIONS, several)).toBeNull()
    expect(matchVocabCommand(ACTIONS, unknown)).toBeNull()
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

  it('ids a command by cap and local id', () => {
    expect(commandId(action('switch.on'))).toBe('switch:switch.on')
  })

  it('reads the locale from the UI language', () => {
    expect(vocabLocale('it-IT')).toBe('it')
    expect(vocabLocale('en')).toBe('en')
  })
})

describe('the device of this round (#500)', () => {
  const FEEDER_AND_SWITCH = vocabularyActionsForDevice(['pet-feeder', 'switch'])
  const SWITCH_ONLY = vocabularyActionsForDevice(['switch'])

  it('offers only the commands every device of the loop has', () => {
    const common = commonVocabActions([FEEDER_AND_SWITCH, SWITCH_ONLY])
    expect(common.map(commandId).toSorted()).toEqual(SWITCH_ONLY.map(commandId).toSorted())
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
    for (const a of dynamic) expect(common.map(commandId)).not.toContain(commandId(a))
  })

  it('writes and reads back a step aimed at the device of the round', () => {
    const on = SWITCH_ONLY[0]
    if (on === undefined) throw new Error('no switch command')
    const step = buildCapStep(on, ROUND_DEVICE, defaultArgValues(on))
    expect(step.deviceId).toEqual({ $var: 'item' })
    expect(isRoundTarget(step)).toBe(true)
    expect(matchVocabCommand(SWITCH_ONLY, step)).toBeNull()
    expect(matchRoundCommand(SWITCH_ONLY, step)?.action.id).toBe(on.id)
  })

  it('reads the stored target shape as the device of the round, and nothing else', () => {
    const base = { kind: 'cap', cap: 'switch', method: 'on' } as const
    expect(isRoundTarget({ ...base, target: { kind: 'var', name: 'item' } })).toBe(true)
    expect(isRoundTarget({ ...base, target: { kind: 'var', name: 'deviceId' } })).toBe(false)
    expect(isRoundTarget({ ...base, deviceId: 4 })).toBe(false)
    expect(matchRoundCommand(SWITCH_ONLY, { ...base, deviceId: 4 })).toBeNull()
  })
})
