import { isNotReported } from '@camstack/types'
import { useState } from 'react'
import { useUiText } from '../../../contexts/ui-text'
import { useUnitPreferences } from '../../../contexts/unit-preferences'
import {
  useDeviceManagerGetDevice,
  useHeroLayoutGetHeroModel,
} from '../../../generated/system-hooks'
import { useRoleDisplayDefaults } from '../../device-item/role-display-defaults-context'
import {
  measurementText,
  type ReadingDisplaySubject,
  useHeroLang,
} from '../../hero-model/measurement-display'
import type { FanReadingOpen } from '../scenes/fan/FanCard'
import type { FanReading } from '../scenes/fan/model'
import { measurementVisual } from '../scenes/sensor/model'
import { measurementSinceText } from './measurement-since'
import { quantityLabel } from './measurement-label'
import { ReadingHistory } from './MeasuredPieCard'
import { SensorTrend } from './SensorTrend'

const NONE: readonly FanReading[] = []

export interface MeasurementReadingsView {
  readonly readings: readonly FanReading[]
  readonly open: FanReadingOpen
}

/**
 * What a device that is not a sensor measures (a fan's temperature and humidity
 * bindings), as the operator reads it: name and value with its unit in their
 * display units. A reading with no data is "—", never 0 (D393). Empty until the
 * hero model answers, and for a device that measures nothing.
 */
export function useMeasurementReadings(deviceId: number): MeasurementReadingsView {
  const t = useUiText()
  const lang = useHeroLang()
  const unitPreferences = useUnitPreferences()
  const roleDefaults = useRoleDisplayDefaults()
  const model = useHeroLayoutGetHeroModel({ deviceId, canActuate: false })
  const device = useDeviceManagerGetDevice({ deviceId }, { staleTime: 60_000 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const measurements = model.data?.measurements
  const idOf = (m: { quantity: string }, index: number): string => `${m.quantity}-${String(index)}`
  const pickedIndex = (measurements ?? []).findIndex((m, i) => idOf(m, i) === selectedId)
  const picked = pickedIndex < 0 ? undefined : measurements?.[pickedIndex]
  const open: FanReadingOpen = {
    selectedId: picked === undefined ? null : selectedId,
    onSelect: (id) => setSelectedId((current) => (current === id ? null : id)),
    detail:
      picked === undefined ? null : (
        <ReadingHistory
          deviceId={deviceId}
          measurement={picked}
          since={measurementSinceText(picked, t)}
        />
      ),
  }
  if (measurements === undefined) return { readings: NONE, open }
  const subject: ReadingDisplaySubject | null =
    device.data === undefined || device.data === null
      ? null
      : {
          role: device.data.role ?? null,
          ...(device.data.display === undefined ? {} : { display: device.data.display }),
        }
  const readings = measurements.map((m, index) => {
    const text = measurementText({
      measurement: m,
      lang,
      subject,
      unitPreferences,
      roleDefaults,
    })
    const empty = m.reading === null && isNotReported(m.value)
    return {
      id: idOf(m, index),
      name: quantityLabel(t, m.quantity),
      value: empty || text.unit === null ? text.value : `${text.value} ${text.unit}`,
      visual: measurementVisual(m),
      trend:
        m.historyKey === null || m.reading === null ? null : (
          <SensorTrend
            deviceId={deviceId}
            historyKey={m.historyKey}
            label={text.value}
            reading={m.reading}
            subject={subject}
            compact
          />
        ),
    }
  })
  return { readings, open }
}
