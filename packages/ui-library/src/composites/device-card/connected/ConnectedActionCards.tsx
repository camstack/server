import type { AutomationControlStatus, ScriptRunnerStatus } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import { AutomationCard, ButtonCard, ScriptCard } from '../scenes/action/ActionCards'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { sinceText } from './since-text'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

/** A `button`: fire-only, so the card is a press and nothing else. */
export function ConnectedButtonCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const cap = dev?.button
  if (cap === undefined) return null
  return (
    <ButtonCard
      orientation={orientation}
      showName={showName}
      model={{ common: card.common, pressable: card.implements('button', 'press') }}
      actions={{
        ...card.actions,
        onPress: () => {
          Promise.resolve(cap.press({})).then(card.succeed, card.fail)
        },
      }}
    />
  )
}

/** A script (`script-runner`): run and stop; 0 on `lastRunAt` means it never ran. */
export function ConnectedScriptCard({
  deviceId,
  canActuate = true,
  orientation,
  optimistic = true,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(
    dev?.scriptRunner === undefined ? undefined : dev.state.scriptRunner,
  )
  const { display, applyOptimisticAction } = useOptimisticSlice<ScriptRunnerStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.scriptRunner
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(applyOptimisticAction, card)
  return (
    <ScriptCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        running: display.isRunning,
        lastRun: sinceText(display.lastRunAt, Date.now(), t) ?? null,
        lastError: display.lastError,
        runnable: card.implements('script-runner', 'run'),
        stoppable: card.implements('script-runner', 'stop'),
      }}
      actions={{
        ...card.actions,
        onRun: () => send({ isRunning: true }, () => cap.run({})),
        onStop: () => send({ isRunning: false }, () => cap.stop({})),
      }}
    />
  )
}

/**
 * An automation (`automation-control`): enable / disable and a manual run.
 * `isRunning` is never written by the provider, so the card does not claim it.
 */
export function ConnectedAutomationCard({
  deviceId,
  canActuate = true,
  orientation,
  optimistic = true,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(
    dev?.automationControl === undefined ? undefined : dev.state.automationControl,
  )
  const { display, applyOptimisticAction } = useOptimisticSlice<AutomationControlStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.automationControl
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(applyOptimisticAction, card)
  const has = (method: string): boolean => card.implements('automation-control', method)
  return (
    <AutomationCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        enabled: display.enabled,
        lastTriggered: sinceText(display.lastTriggeredAt, Date.now(), t) ?? null,
        lastError: display.lastError,
        switchable: has('enable') && has('disable'),
        triggerable: has('trigger'),
      }}
      actions={{
        ...card.actions,
        onEnabled: (enabled) =>
          send({ enabled }, () => (enabled ? cap.enable({}) : cap.disable({}))),
        onTrigger: () => send({}, () => cap.trigger({})),
      }}
    />
  )
}
