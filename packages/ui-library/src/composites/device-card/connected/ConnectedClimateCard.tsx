import type { HvacMode } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useDeviceCommand } from '../../../hooks/use-device-command'
import { ClimateCard } from '../scenes/climate/ClimateCard'
import { climateModelOf } from './climate-model'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { PrimaryTrend } from './PrimaryTrend'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

/**
 * The climate card of a real device: its `climate-control` slice, its
 * `heating-valve` slice, or both. A valve that only reports still draws.
 */
export function ConnectedClimateCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const { common, actions, role, fail, succeed } = useCardCommon({
    deviceId,
    canActuate,
  })
  const slice = useDeviceStateSlice(
    dev?.climateControl === undefined ? undefined : dev.state.climateControl,
  )
  const valveSlice = useDeviceStateSlice(
    dev?.heatingValve === undefined ? undefined : dev.state.heatingValve,
  )
  const display = slice
  const runCommand = useDeviceCommand()
  // A refused command says why on the card, like the shared mutations.
  const command = reportedCommand(runCommand, { fail, succeed })
  if (dev === undefined || dev === null) return null
  const cap = dev.climateControl
  // A bound climate cap whose slice has not answered yet is not a valve-only device.
  if (cap !== undefined && display === undefined) return null

  const modeLabel: Readonly<Record<HvacMode, string>> = {
    off: t('uiLibrary.deviceCard.off', 'Off'),
    heat: t('uiLibrary.deviceCard.climate.modes.heat', 'Heat'),
    cool: t('uiLibrary.deviceCard.climate.modes.cool', 'Cool'),
    auto: t('uiLibrary.deviceCard.climate.modes.auto', 'Auto'),
    heat_cool: t('uiLibrary.deviceCard.climate.modes.auto', 'Auto'),
    fan_only: t('uiLibrary.deviceCard.climate.modes.fan', 'Fan'),
    dry: t('uiLibrary.deviceCard.climate.modes.dry', 'Dry'),
  }
  const scene = climateModelOf({
    role,
    climate: cap === undefined ? undefined : display,
    valve: dev.heatingValve === undefined ? undefined : (valveSlice ?? null),
    commands: {
      targetRange: cap?.setTargetRange !== undefined,
      fanMode: cap?.setFanMode !== undefined,
      preset: cap?.setPreset !== undefined,
      swingVertical: cap?.setSwingVertical !== undefined,
      swingHorizontal: cap?.setSwingHorizontal !== undefined,
    },
    modeLabel: (mode) => modeLabel[mode],
  })
  if (scene === null) return null

  const modes = display?.availableModes.filter((m) => m !== 'off') ?? []
  return (
    <ClimateCard
      orientation={orientation}
      showName={showName}
      trend={<PrimaryTrend deviceId={deviceId} label={common.name} />}
      model={{ common, ...scene }}
      actions={{
        ...actions,
        onPower: (next) => {
          if (cap === undefined) return
          const mode: HvacMode = next ? (display?.lastActiveMode ?? modes[0] ?? 'auto') : 'off'
          command(() => cap.setMode({ mode }))
        },
        onTarget: (value) => {
          if (cap === undefined) return
          command(() => cap.setTarget({ target: value }))
        },
        onRange: (targetLow, targetHigh) => {
          const setRange = cap?.setTargetRange
          if (setRange === undefined) return
          command(() => setRange({ targetLow, targetHigh }))
        },
        onMode: (id) => {
          const mode = modes.find((m) => m === id)
          if (cap !== undefined && mode !== undefined) command(() => cap.setMode({ mode }))
        },
        onFan: (fanMode) => {
          const setFan = cap?.setFanMode
          if (setFan !== undefined) command(() => setFan({ fanMode }))
        },
        onSwing: (swing) => {
          const setSwing = cap?.setSwingVertical
          if (setSwing !== undefined) command(() => setSwing({ on: swing }))
        },
        onSwingHorizontal: (swing) => {
          const setSwing = cap?.setSwingHorizontal
          if (setSwing !== undefined) command(() => setSwing({ on: swing }))
        },
        onPreset: (preset) => {
          const setPreset = cap?.setPreset
          if (setPreset !== undefined) command(() => setPreset({ preset }))
        },
        onHeatCool: () => undefined,
      }}
    />
  )
}
