import { vocabularyActionsForDevice } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildCapStep,
  type CapStep,
  commandId,
  defaultArgValues,
  firstArgIssue,
  matchVocabCommand,
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
    expect(match?.values).toEqual({ grams: { kind: 'fixed', value: 45 } })
    if (match === null) return
    expect(buildCapStep(match.action, 201, match.values)).toEqual(step)
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
