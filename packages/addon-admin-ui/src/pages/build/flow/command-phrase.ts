/**
 * A stored command step as the sentence the operator reads on the row: the
 * action's vocabulary phrase with `{device}` and every open arg filled in —
 * "Open Kitchen blind to 40 %".
 */
import { findVocabAction, REPEAT_ITEM_VAR, vocabularyActionsForDevice } from '@camstack/types'
import type { ActionTarget, LooseVocabOpenArg, ResolvedVocabAction } from '@camstack/types'
import { type CommandStep, matchCommand, splitPhrase, type StepArgValue } from './command-vocab'
import { TRIGGER_DEVICE_VAR } from './command-vocab'

/** How a target is named in a sentence. */
export interface TargetWords {
  readonly deviceName: (id: number) => string
  readonly triggerDevice: string
  readonly roundDevice: string
  /** A domain target (every device of a type or a room). */
  readonly someDevices: string
}

/**
 * The action `actionId` with its wording resolved, as a device of `deviceType`
 * would offer it; `undefined` for an id the vocabulary does not know.
 */
export function resolvedActionById(
  actionId: string,
  deviceType: string | undefined,
): ResolvedVocabAction | undefined {
  const found = findVocabAction(actionId)
  if (found === undefined) return undefined
  return vocabularyActionsForDevice([found.cap], deviceType).find((a) => a.id === actionId)
}

export function targetName(target: ActionTarget, words: TargetWords): string {
  if (target.kind === 'devices') return target.ids.map(words.deviceName).join(', ')
  if (target.kind === 'var') {
    if (target.name === TRIGGER_DEVICE_VAR) return words.triggerDevice
    if (target.name === REPEAT_ITEM_VAR) return words.roundDevice
    return `{${target.name}}`
  }
  return words.someDevices
}

function argText(arg: LooseVocabOpenArg, value: StepArgValue, locale: 'en' | 'it'): string {
  if (value.kind === 'var') return `{${value.name}}`
  const offer = arg.offer
  if (offer.kind === 'enum') {
    const choice = offer.values.find((v) => v.value === value.value)
    return choice === undefined ? String(value.value) : choice.label[locale]
  }
  return String(value.value)
}

/** The sentence for a step, or null while it names no known action. */
export function describeCommandStep(
  step: CommandStep,
  locale: 'en' | 'it',
  words: TargetWords,
  deviceType: string | undefined,
): string | null {
  if (step.actionId === '') return null
  const action = resolvedActionById(step.actionId, deviceType)
  if (action === undefined) return null
  const match = matchCommand([action], step)
  const name = targetName(step.target, words)
  return splitPhrase(action.phrase[locale])
    .map((token) => {
      if (token.kind === 'text') return token.text
      if (token.key === 'device') return name
      const arg = action.openArgs.find((a) => a.key === token.key)
      const value = match?.values[token.key]
      return arg === undefined || value === undefined
        ? `{${token.key}}`
        : argText(arg, value, locale)
    })
    .join('')
}
