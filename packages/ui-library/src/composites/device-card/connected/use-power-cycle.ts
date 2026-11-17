/**
 * A switch's native power cycle, the way the plug card reads it: drawn only when
 * the provider implements `powerCycle` AND its `getOptions` answered
 * `supportsPowerCycle: true` (D1058). A provider that has the method but
 * declares no cycle (a PoE port reached with a local account), a pending read
 * and a failed read all draw nothing — the button appears once the device has
 * said it can.
 */
import type { SwitchOptions } from '@camstack/types'
import { useSwitchGetOptions, useSwitchPowerCycle } from '../../../generated/system-hooks'
import type { CardCommonResult } from './use-card-common'

export interface PowerCycle {
  readonly declared: boolean
  readonly onPowerCycle: () => void
}

export interface PowerCycleInput {
  readonly deviceId: number
  readonly card: Pick<CardCommonResult, 'implements' | 'fail' | 'succeed'>
}

/** True only when the provider has the method and its options answered that it cycles. */
export function powerCycleDeclared(
  implementsCycle: boolean,
  options: SwitchOptions | undefined,
): boolean {
  return implementsCycle && options?.supportsPowerCycle === true
}

export function usePowerCycle({ deviceId, card }: PowerCycleInput): PowerCycle {
  const implementsCycle =
    card.implements('switch', 'powerCycle') && card.implements('switch', 'getOptions')
  const options = useSwitchGetOptions({ deviceId }, { enabled: implementsCycle })
  const cycle = useSwitchPowerCycle()
  return {
    declared: powerCycleDeclared(implementsCycle, options.data),
    onPowerCycle: () => cycle.mutate({ deviceId }, { onSuccess: card.succeed, onError: card.fail }),
  }
}
