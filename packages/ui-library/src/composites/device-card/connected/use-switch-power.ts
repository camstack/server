/**
 * A real device's power, the way every card reads it: `switch` is the one
 * on/off control (D1042) — a light, a fan, a heater and a plug all turn on and
 * off through it — and `timed-run`, which every device with a switch binds
 * (D1097), is the switch's timer.
 */
import { timedRunLimitOf } from '@camstack/types'
import { timedRunQuickCalls, timedRunQuickView } from '../../device-controls/timed-run-quick-model'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useDeviceCommand } from '../../../hooks/use-device-command'
import type { SwitchTimerActions, SwitchTimerModel } from '../parts/switch-timer-model'
import { sinceText } from './since-text'
import type { CardCommonResult } from './use-card-common'
import { reportedCommand } from './use-command-notice'

export interface SwitchPower extends SwitchTimerActions {
  /** False when the device binds no `switch`: the card draws no power control. */
  readonly bound: boolean
  /** Undefined until the slice answered; null when the switch reports no state. */
  readonly on: boolean | null | undefined
  readonly since: string | null
  readonly timer: SwitchTimerModel | null
  readonly onPower: (on: boolean) => void
}

export interface SwitchPowerInput {
  readonly deviceId: number
  readonly card: Pick<CardCommonResult, 'deviceType' | 'role' | 'fail' | 'succeed'>
}

export function useSwitchPower({ deviceId, card }: SwitchPowerInput): SwitchPower {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const slice = useDeviceStateSlice(dev?.switch === undefined ? undefined : dev.state.switch)
  const run = useDeviceStateSlice(dev?.timedRun === undefined ? undefined : dev.state.timedRun)
  const display = slice
  const runCommand = useDeviceCommand()
  const cap = dev?.switch
  const timedRun = dev?.timedRun
  const limit = card.deviceType === null ? null : timedRunLimitOf(card.deviceType, card.role)
  const quick =
    timedRun === undefined || run === undefined || limit === null || limit.unit !== 'min'
      ? null
      : timedRunQuickView(limit, run)
  const timer: SwitchTimerModel | null =
    quick === null
      ? null
      : { defaultMinutes: quick.saved, maxMinutes: quick.max, endsAt: quick.activeUntil }
  const calls = timedRun === undefined ? null : timedRunQuickCalls(timedRun, 'min')
  const unbound = (): Promise<never> => Promise.reject(new Error('timed-run is not bound'))
  const report = { fail: card.fail, succeed: card.succeed }
  return {
    bound: cap !== undefined,
    on: display === undefined ? undefined : display.on,
    since: sinceText(display?.lastChangedAt, Date.now(), t) ?? null,
    timer,
    onPower: (on) => reportedCommand(runCommand, report)(() => cap?.setState({ on })),
    // The control says a refusal itself, so these hand the promise back instead of the card notice.
    onTimerStart: (minutes) => calls?.run(minutes) ?? unbound(),
    onTimerSave: (minutes) => calls?.save(minutes) ?? unbound(),
    onTimerStop: () => calls?.stop() ?? unbound(),
  }
}
