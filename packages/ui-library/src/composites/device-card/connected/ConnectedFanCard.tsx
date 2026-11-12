import type { FanPreset } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useFanPresetsApplyPreset, useFanPresetsGetPresets } from '../../../generated/system-hooks'
import { useCapabilityPresence } from '../../../hooks/use-capability-presence'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { FanCard } from '../scenes/fan/FanCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { fanPresetChoice, fanPresetFailure, fanSliceModel } from './fan-model'
import { useCardCommon } from './use-card-common'
import { reportedCall } from './use-command-notice'
import { useSwitchPower } from './use-switch-power'

const NO_PRESETS: readonly FanPreset[] = []

/**
 * The fan card of a real device: power through `switch` (D1042), the rest
 * through `fan-control` (speed, presets, direction, oscillation and its axes,
 * D1034) and the saved presets of `fan-presets`. A `switch` with the role
 * `switch-fan` is the same card with power alone.
 */
export function ConnectedFanCard({
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
  const power = useSwitchPower({ deviceId, optimistic, card })
  const fan = useDeviceStateSlice(dev?.fanControl === undefined ? undefined : dev.state.fanControl)
  const presetsPresence = useCapabilityPresence('fan-presets')
  const saved = useFanPresetsGetPresets(
    { deviceId },
    { enabled: presetsPresence === 'present' && dev?.fanControl !== undefined },
  )
  const apply = useFanPresetsApplyPreset()
  if (!power.bound || power.on === undefined) return null
  const send = reportedCall(card)
  const cap = dev?.fanControl
  const slices = fanSliceModel({
    fan,
    saved: saved.data ?? NO_PRESETS,
    commands: {
      speed: cap?.setPercentage !== undefined,
      preset: cap?.setPreset !== undefined,
      direction: cap?.setDirection !== undefined,
      oscillating: cap?.setOscillating !== undefined,
      axis: cap?.setOscillationAxis !== undefined,
    },
  })
  return (
    <FanCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        on: power.on,
        since: power.since,
        timer: power.timer,
        ...slices,
      }}
      actions={{
        ...card.actions,
        onPower: power.onPower,
        onTimerStart: power.onTimerStart,
        onTimerStop: power.onTimerStop,
        onSpeed: (speed) => send(() => cap?.setPercentage?.({ speed })),
        onDirection: (direction) => send(() => cap?.setDirection?.({ direction })),
        onOscillating: (oscillating) => send(() => cap?.setOscillating?.({ oscillating })),
        onAxis: (axis, patch) =>
          send(async () => {
            const result = await cap?.setOscillationAxis?.({ axis, ...patch })
            if (result?.status === 'refused') throw new Error(result.detail)
          }),
        onPreset: (id) => {
          const choice = fanPresetChoice(id)
          if (choice === null) return
          if (choice.kind === 'device') {
            send(() => cap?.setPreset?.({ preset: choice.preset }))
            return
          }
          send(async () => {
            const result = await apply.mutateAsync({ deviceId, presetId: choice.presetId })
            const failure = fanPresetFailure(result)
            if (failure !== null)
              throw new Error(
                t(
                  'uiLibrary.deviceCard.fan.presetIncomplete',
                  'preset not fully applied: {{fields}}',
                  {
                    fields: failure,
                  },
                ),
              )
          })
        },
      }}
    />
  )
}
