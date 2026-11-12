import { type ColorStatus, DeviceFeature } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import type { LightRgb } from '../illustrations/LightIllustration'
import { hsvRgb, kelvinRgb, kelvinToMired, miredToKelvin } from '../scenes/light/model'
import { LightCard } from '../scenes/light/LightCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'
import { reportedCall } from './use-command-notice'
import { useSwitchPower } from './use-switch-power'

/** The colour a `color` slice shines with, whatever its mode; null when it reports none. */
export function lightColorOf(color: ColorStatus | null | undefined): LightRgb | null {
  if (color === null || color === undefined) return null
  if (color.mode === 'rgb') return color.rgb ?? null
  if (color.mode === 'hsv')
    return color.hsv === undefined ? null : hsvRgb(color.hsv.h, color.hsv.s, 100)
  return color.colorTemperature === undefined
    ? null
    : kelvinRgb(miredToKelvin(color.colorTemperature))
}

/**
 * The light card of a real device: power through `switch` (D1042), the level
 * through `brightness`, colour and white through `color` — each popover only
 * when the device declares that colour feature.
 */
export function ConnectedLightCard({
  deviceId,
  canActuate = true,
  orientation,
  optimistic = true,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const power = useSwitchPower({ deviceId, optimistic, card })
  const brightness = useDeviceStateSlice(
    dev?.brightness === undefined ? undefined : dev.state.brightness,
  )
  const color = useDeviceStateSlice(dev?.color === undefined ? undefined : dev.state.color)
  if (!power.bound || power.on === undefined) return null
  const send = reportedCall(card)
  const colorCap = dev?.color
  const has = (feature: DeviceFeature): boolean => card.features.includes(feature)
  const palette =
    colorCap !== undefined && (has(DeviceFeature.LightColorRgb) || has(DeviceFeature.LightColorHsv))
  const white = colorCap !== undefined && has(DeviceFeature.LightColorMired)
  return (
    <LightCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        on: power.on,
        since: power.since,
        brightness: dev?.brightness === undefined ? null : (brightness?.level ?? null),
        color: lightColorOf(color),
        palette,
        white: white
          ? {
              kelvin:
                color?.mode === 'mired' && color.colorTemperature !== undefined
                  ? miredToKelvin(color.colorTemperature)
                  : null,
            }
          : null,
      }}
      actions={{
        ...card.actions,
        onPower: power.onPower,
        onBrightness: (level) => send(() => dev?.brightness?.setBrightness({ level })),
        onColor: (rgb) => send(() => colorCap?.setColor({ color: { mode: 'rgb', rgb } })),
        onWhite: (kelvin) =>
          send(() =>
            colorCap?.setColor({
              color: { mode: 'mired', colorTemperature: kelvinToMired(kelvin) },
            }),
          ),
      }}
    />
  )
}
