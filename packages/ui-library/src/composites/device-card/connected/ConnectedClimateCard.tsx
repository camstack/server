import { DeviceType, type HvacMode } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import type { CardGlyph } from '../icons'
import type { ClimateRole } from '../illustrations/ClimateRoleGlyph'
import { ClimateCard } from '../scenes/climate/ClimateCard'
import { type ClimateChoice, deriveClimateActivity } from '../scenes/climate/model'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'

const MODE_GLYPH: Readonly<Partial<Record<HvacMode, CardGlyph>>> = {
  heat: 'heat',
  cool: 'cool',
  auto: 'auto',
  heat_cool: 'auto',
  fan_only: 'fanOnly',
  dry: 'dry',
}

const DEFAULT_MIN = 16
const DEFAULT_MAX = 30
const DEFAULT_STEP = 0.5

/** What draws the heat or the cold, from what the device IS and binds. */
export function climateRoleOf(deviceType: string | null, hasValve: boolean): ClimateRole {
  if (hasValve) return 'radiator'
  if (deviceType === DeviceType.Thermostat) return 'thermostat'
  if (deviceType === DeviceType.Heater) return 'heater'
  return 'ac'
}

const titled = (id: string): string =>
  id.length === 0 ? id : `${id.slice(0, 1).toUpperCase()}${id.slice(1).replaceAll('_', ' ')}`

function plainChoice(value: string | null, ids: readonly string[]): ClimateChoice {
  return { value, options: ids.map((id) => ({ id, label: titled(id) })) }
}

/** The climate card of a real device, from its `climate-control` slice. */
export function ConnectedClimateCard({
  deviceId,
  canActuate = true,
  orientation,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const { common, actions, deviceType } = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(dev?.state.climateControl)
  const { display, applyOptimisticAction } = useOptimisticSlice(slice, { enabled: true })
  const cap = dev?.climateControl
  if (cap === undefined || display === undefined) return null

  const on = display.mode !== 'off'
  const modeLabel: Readonly<Record<HvacMode, string>> = {
    off: t('uiLibrary.deviceCard.off', 'Off'),
    heat: t('uiLibrary.deviceCard.climate.modes.heat', 'Heat'),
    cool: t('uiLibrary.deviceCard.climate.modes.cool', 'Cool'),
    auto: t('uiLibrary.deviceCard.climate.modes.auto', 'Auto'),
    heat_cool: t('uiLibrary.deviceCard.climate.modes.auto', 'Auto'),
    fan_only: t('uiLibrary.deviceCard.climate.modes.fan', 'Fan'),
    dry: t('uiLibrary.deviceCard.climate.modes.dry', 'Dry'),
  }
  const modes = display.availableModes.filter((m) => m !== 'off')
  const target = display.target
  const current = display.currentTemp
  const cooling =
    display.mode === 'cool' ||
    ((display.mode === 'auto' || display.mode === 'heat_cool') &&
      target !== null &&
      current !== null &&
      target < current)
  const setFan = cap.setFanMode
  const setPreset = cap.setPreset
  const setSwing = cap.setSwingVertical
  return (
    <ClimateCard
      orientation={orientation}
      model={{
        common,
        role: climateRoleOf(deviceType, dev?.heatingValve !== undefined),
        on,
        activity: deriveClimateActivity({ on, cooling, target, current }),
        since: null,
        current,
        flow: null,
        humidity: display.currentHumidity,
        target:
          target === null
            ? null
            : {
                value: target,
                min: display.minTemp ?? DEFAULT_MIN,
                max: display.maxTemp ?? DEFAULT_MAX,
                step: display.tempStep ?? DEFAULT_STEP,
                label: null,
              },
        mode:
          modes.length === 0
            ? null
            : {
                value: on ? display.mode : null,
                options: modes.map((m) => {
                  const glyph = MODE_GLYPH[m]
                  return glyph === undefined
                    ? { id: m, label: modeLabel[m] }
                    : { id: m, label: modeLabel[m], glyph }
                }),
              },
        fan:
          setFan === undefined || display.availableFanModes.length === 0
            ? null
            : plainChoice(display.fanMode, display.availableFanModes),
        swing: setSwing === undefined ? null : display.swingVertical,
        preset:
          setPreset === undefined || display.availablePresets.length === 0
            ? null
            : plainChoice(display.preset, display.availablePresets),
        heatCool: null,
      }}
      actions={{
        ...actions,
        onPower: (next) => {
          const mode: HvacMode = next ? (display.lastActiveMode ?? modes[0] ?? 'auto') : 'off'
          applyOptimisticAction({ mode }, () => cap.setMode({ mode }))
        },
        onTarget: (value) =>
          applyOptimisticAction({ target: value }, () => cap.setTarget({ target: value })),
        onMode: (id) => {
          const mode = modes.find((m) => m === id)
          if (mode !== undefined) applyOptimisticAction({ mode }, () => cap.setMode({ mode }))
        },
        onFan: (fanMode) => {
          if (setFan !== undefined) applyOptimisticAction({ fanMode }, () => setFan({ fanMode }))
        },
        onSwing: (swing) => {
          if (setSwing !== undefined) {
            applyOptimisticAction({ swingVertical: swing }, () => setSwing({ on: swing }))
          }
        },
        onPreset: (preset) => {
          if (setPreset !== undefined)
            applyOptimisticAction({ preset }, () => setPreset({ preset }))
        },
        onHeatCool: () => undefined,
      }}
    />
  )
}
