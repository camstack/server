/**
 * A real device's power, the way every card reads it: `switch` is the one
 * on/off control (D1042) — a light, a fan, a heater and a plug all turn on and
 * off through it — and `timed-run`, when the device binds it and its type and
 * role are offered one (D1033), is the switch's timer.
 */
import { DeviceType, type SwitchStatus, timedRunLimitOf, timedRunMaxIn } from '@camstack/types'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
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
  readonly optimistic: boolean
  readonly card: Pick<CardCommonResult, 'deviceType' | 'role' | 'fail' | 'succeed'>
}

const DEVICE_TYPES: ReadonlySet<string> = new Set(Object.values(DeviceType))
const isDeviceType = (value: string): value is DeviceType => DEVICE_TYPES.has(value)

export function useSwitchPower({ deviceId, optimistic, card }: SwitchPowerInput): SwitchPower {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const slice = useDeviceStateSlice(dev?.switch === undefined ? undefined : dev.state.switch)
  const run = useDeviceStateSlice(dev?.timedRun === undefined ? undefined : dev.state.timedRun)
  const { display, applyOptimisticAction } = useOptimisticSlice<SwitchStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.switch
  const timedRun = dev?.timedRun
  const limit =
    card.deviceType !== null && isDeviceType(card.deviceType)
      ? timedRunLimitOf(card.deviceType, card.role)
      : null
  const timer: SwitchTimerModel | null =
    timedRun === undefined || run === undefined || limit === null || limit.unit !== 'min'
      ? null
      : {
          defaultMinutes:
            run.quickRun?.unit === 'min' ? run.quickRun.duration : limit.quickRunDefault,
          maxMinutes: timedRunMaxIn(limit),
          endsAt: run.activeUntil,
        }
  const report = { fail: card.fail, succeed: card.succeed }
  return {
    bound: cap !== undefined,
    on: display === undefined ? undefined : display.on,
    since: sinceText(display?.lastChangedAt, Date.now(), t) ?? null,
    timer,
    onPower: (on) =>
      reportedCommand(applyOptimisticAction, report)({ on }, () => cap?.setState({ on })),
    onTimerStart: (minutes) =>
      void timedRun?.runFor({ duration: minutes, unit: 'min' }).then(card.succeed, card.fail),
    onTimerStop: () => void timedRun?.cancel({}).then(card.succeed, card.fail),
  }
}
