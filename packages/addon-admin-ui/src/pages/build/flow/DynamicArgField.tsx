/**
 * An open arg of a device command. A `dynamic` offer is a list the device
 * knows, so it is read here and handed to `ArgField` as a select; every other
 * offer, and a list that could not be read, goes through unchanged.
 */

import type { LooseVocabOpenArg, VocabLocale } from '@camstack/types'
import { ArgField, type ScopeVariable } from './ArgField'
import type { StepArgValue } from './command-vocab'
import { isDynamicOffer } from './dynamic-offer'
import { useDynamicChoices } from './use-dynamic-choices'

export interface DynamicArgFieldProps {
  readonly deviceId: number
  readonly cap: string
  readonly arg: LooseVocabOpenArg
  readonly locale: VocabLocale
  readonly variables: readonly ScopeVariable[]
  readonly value: StepArgValue
  readonly onChange: (next: StepArgValue) => void
}

export function DynamicArgField({ deviceId, cap, arg, ...rest }: DynamicArgFieldProps) {
  const choices = useDynamicChoices(deviceId, cap, isDynamicOffer(arg.offer) ? arg.offer : null)
  return <ArgField arg={arg} choices={choices} {...rest} />
}
