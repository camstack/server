import { DeviceType, type HeroMeasurement } from '@camstack/types'
import { type ReactElement, type ReactNode, useEffect } from 'react'
import { useUiText } from '../../../contexts/ui-text'
import { MeasuredPieCard } from './MeasuredPieCard'
import {
  useDeviceManagerGetDevice,
  useHeroLayoutGetHeroModel,
} from '../../../generated/system-hooks'
import { pickText } from '../../hero-model/hero-model-view'
import {
  type ReadingDisplaySubject,
  useHeroLang,
  useMeasurementText,
} from '../../hero-model/measurement-display'
import { useHeroLiveRefresh } from '../../hero-model/use-hero-live-refresh'
import type { CardOrientation } from '../shell/model'
import { measurementVisual, type SensorCardModel } from '../scenes/sensor/model'
import { type SensorLayout, sensorLayoutOf } from '../scenes/sensor/pie-model'
import { SensorCard } from '../scenes/sensor/SensorCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { measurementSinceText } from './measurement-since'
import { SensorTrend } from './SensorTrend'
import { useCardCommon } from './use-card-common'

export interface ConnectedSensorCardProps extends ConnectedCardProps {
  /**
   * Drawn when the device is not a sensor card (its hero model has no measurement,
   * or a row to set) or the model could not be read. Nothing while it is loading.
   */
  readonly fallback?: ReactNode
  /** Drawn while the model loads (default nothing). */
  readonly placeholder?: ReactNode
  /** Told `true` once the sensor card is drawn; a fallback reports for itself. */
  readonly onDrawn?: (drawn: boolean) => void
}

/**
 * A sensor drawn from the hero model's measurements inside the shared card: one
 * reading is the single-measurement scene (#514), two to six the pie, seven or
 * more a grid (`sensorLayoutOf` decides, from the count alone).
 */
export function ConnectedSensorCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
  fallback = null,
  placeholder = null,
  onDrawn,
}: ConnectedSensorCardProps): ReactNode {
  const model = useHeroLayoutGetHeroModel({ deviceId, canActuate })
  useHeroLiveRefresh(deviceId, model.refetch)
  // Only a sensor is drawn as its readings: a fan or a plug that also has a temperature
  // binding carries `measurements` for its own card's readout row, and keeps its hero.
  const device = useDeviceManagerGetDevice({ deviceId }, { staleTime: 60_000 })
  const layout: SensorLayout | null =
    model.status === 'pending' ||
    model.status === 'error' ||
    model.data === null ||
    device.data?.type !== DeviceType.Sensor
      ? null
      : sensorLayoutOf(model.data)
  // The measured card reports `true`. A settled fallback has no child to report
  // it, and pending is still the placeholder — not a card.
  useEffect(() => {
    if (model.status === 'pending' || device.isPending) return
    if (layout === null) onDrawn?.(false)
  }, [layout, model.status, device.isPending, onDrawn])
  if (model.status === 'pending' || device.isPending) return placeholder
  if (layout === null) return fallback
  if (layout.kind === 'pie' || layout.kind === 'grid') {
    return (
      <MeasuredPieCard
        deviceId={deviceId}
        canActuate={canActuate}
        shown={layout.shown}
        grid={layout.kind === 'grid'}
        showName={showName}
        {...(orientation === undefined ? {} : { orientation })}
        {...(onDrawn === undefined ? {} : { onDrawn })}
      />
    )
  }
  return (
    <MeasuredSensorCard
      deviceId={deviceId}
      canActuate={canActuate}
      measurement={layout.measurement}
      showName={showName}
      {...(orientation === undefined ? {} : { orientation })}
      {...(onDrawn === undefined ? {} : { onDrawn })}
    />
  )
}

interface MeasuredSensorCardProps {
  readonly deviceId: number
  readonly canActuate: boolean
  readonly measurement: HeroMeasurement
  readonly orientation?: CardOrientation
  readonly showName: boolean
  readonly onDrawn?: (drawn: boolean) => void
}

function MeasuredSensorCard({
  deviceId,
  canActuate,
  measurement,
  orientation,
  showName,
  onDrawn,
}: MeasuredSensorCardProps): ReactElement {
  useEffect(() => {
    onDrawn?.(true)
  }, [onDrawn])
  const t = useUiText()
  const lang = useHeroLang()
  const card = useCardCommon({ deviceId, canActuate })
  const device = useDeviceManagerGetDevice({ deviceId }, { staleTime: 60_000 })
  const subject: ReadingDisplaySubject | null =
    device.data === undefined || device.data === null
      ? null
      : {
          role: device.data.role ?? null,
          ...(device.data.display === undefined ? {} : { display: device.data.display }),
        }
  const text = useMeasurementText(measurement, lang, subject)
  const sensor: SensorCardModel = {
    common: card.common,
    reading: {
      quantity: measurement.quantity,
      icon: measurement.icon,
      value: text.value,
      unit: text.unit,
    },
    state: {
      label: pickText(measurement.word, lang),
      since: measurementSinceText(measurement, t),
      tone: measurement.tone,
    },
    visual: measurementVisual(measurement),
  }
  const trend =
    measurement.historyKey === null || measurement.reading === null ? null : (
      <SensorTrend
        deviceId={deviceId}
        historyKey={measurement.historyKey}
        label={text.value}
        reading={measurement.reading}
        subject={subject}
      />
    )
  return (
    <SensorCard
      model={sensor}
      actions={card.actions}
      showName={showName}
      trend={trend}
      {...(orientation === undefined ? {} : { orientation })}
    />
  )
}
