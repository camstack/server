import type { HeroMeasurement, HeroMeasurementQuantity } from '@camstack/types'
import { type ReactElement, useEffect, useState } from 'react'
import { useUiText } from '../../../contexts/ui-text'
import { useUnitPreferences } from '../../../contexts/unit-preferences'
import { useDeviceManagerGetDevice } from '../../../generated/system-hooks'
import { formatLastSeen } from '../../../lib/format-last-seen'
import { pickText } from '../../hero-model/hero-model-view'
import {
  measurementText,
  type MeasurementText,
  type ReadingDisplaySubject,
  useHeroLang,
} from '../../hero-model/measurement-display'
import { useRoleDisplayDefaults } from '../../device-item/role-display-defaults-context'
import { measurementVisual } from '../scenes/sensor/model'
import { readingStateOf } from '../scenes/sensor/pie-model'
import { SensorGridCard } from '../scenes/sensor/SensorGridCard'
import { type PieReading, SensorPieCard } from '../scenes/sensor/SensorPieCard'
import type { CardOrientation } from '../shell/model'
import { quantityLabel } from './measurement-label'
import { measurementSinceText } from './measurement-since'
import { SensorTrend } from './SensorTrend'
import { DeviceHistoryView } from '../../device-history/DeviceHistoryView'
import { useCardCommon } from './use-card-common'

/** Two readings of one quantity would share a key: the index keeps them apart. */
const idOf = (m: HeroMeasurement, index: number): string => `${m.quantity}-${String(index)}`

export interface MeasuredPieCardProps {
  readonly deviceId: number
  readonly canActuate: boolean
  readonly shown: readonly HeroMeasurement[]
  /** Seven or more readings: tiles instead of wedges. */
  readonly grid?: boolean
  readonly orientation?: CardOrientation
  readonly showName: boolean
  readonly onDrawn?: (drawn: boolean) => void
}

/** The newest moment any reading was observed; `null` = none was. */
function latestSince(all: readonly HeroMeasurement[]): number | null {
  const moments = all.flatMap((m) => (m.since === null ? [] : [m.since]))
  return moments.length === 0 ? null : Math.max(...moments)
}

/** A sensor with several readings: the pie (or, past six, the grid), and the history behind each reading. */
export function MeasuredPieCard({
  deviceId,
  canActuate,
  shown,
  grid = false,
  orientation,
  showName,
  onDrawn,
}: MeasuredPieCardProps): ReactElement {
  useEffect(() => {
    onDrawn?.(true)
  }, [onDrawn])
  const t = useUiText()
  const lang = useHeroLang()
  const unitPreferences = useUnitPreferences()
  const roleDefaults = useRoleDisplayDefaults()
  const card = useCardCommon({ deviceId, canActuate })
  const device = useDeviceManagerGetDevice({ deviceId }, { staleTime: 60_000 })
  const subject: ReadingDisplaySubject | null =
    device.data === undefined || device.data === null
      ? null
      : {
          role: device.data.role ?? null,
          ...(device.data.display === undefined ? {} : { display: device.data.display }),
        }
  const [selected, setSelected] = useState<string | null>(null)

  const textOf = (m: HeroMeasurement): MeasurementText =>
    measurementText({
      measurement: m,
      lang,
      subject,
      unitPreferences,
      roleDefaults,
    })
  const readingOf = (m: HeroMeasurement, index: number): PieReading => {
    const text = textOf(m)
    return {
      id: idOf(m, index),
      quantity: m.quantity,
      value: text.value,
      unit: text.unit,
      label: quantityLabel(t, m.quantity),
      state: readingStateOf(m),
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
  }
  const lead = shown[0]
  const ago = formatLastSeen(latestSince(shown), t)
  const picked = shown.findIndex((m, i) => idOf(m, i) === selected)
  const pickedMeasurement = picked < 0 ? undefined : shown[picked]

  const model = {
    common: card.common,
    state: {
      label: lead === undefined ? '' : pickText(lead.word, lang),
      since: null,
      tone: lead === undefined ? ('muted' as const) : lead.tone,
    },
    readings: shown.map(readingOf),
    updated: ago === null ? null : t('uiLibrary.sensorPie.updated', 'Updated · {{ago}}', { ago }),
  }
  const detail =
    pickedMeasurement === undefined ? null : (
      <ReadingHistory
        deviceId={deviceId}
        measurement={pickedMeasurement}
        since={measurementSinceText(pickedMeasurement, t)}
      />
    )
  const common = {
    model,
    actions: card.actions,
    showName,
    selectedId: pickedMeasurement === undefined ? null : selected,
    onSelect: (id: string) => setSelected((current) => (current === id ? null : id)),
    detail,
    ...(orientation === undefined ? {} : { orientation }),
  }
  return grid ? <SensorGridCard {...common} /> : <SensorPieCard {...common} />
}

interface ReadingHistoryProps {
  readonly deviceId: number
  readonly measurement: HeroMeasurement
  readonly since: string | null
}

/** The state series of a reading that is on/off rather than a number (no trend line). */
export const STATE_READING_HISTORY_KEY: Readonly<Partial<Record<HeroMeasurementQuantity, string>>> =
  {
    motion: 'cap:motion.detected',
    contact: 'cap:contact.entryOpen',
  }

/** One reading's value and the last day of it; a state reading shows ITS series only, never the device's whole History. */
function ReadingHistory({ deviceId, measurement, since }: ReadingHistoryProps): ReactElement {
  const t = useUiText()
  const seriesKey = measurement.historyKey ?? STATE_READING_HISTORY_KEY[measurement.quantity]
  // The chart is the device-history view of this one series: it says itself
  // whether the read is pending, absent or empty (D315), never a blank.
  const chart =
    seriesKey === undefined ? null : (
      <DeviceHistoryView deviceId={deviceId} seriesKeys={[seriesKey]} fixedWindow="24h" />
    )
  return (
    <div className="flex w-full flex-col items-center gap-2" data-testid="dc-pie-history">
      <span className="text-sm font-medium text-foreground">
        {quantityLabel(t, measurement.quantity)}
      </span>
      {since === null ? null : <span className="text-xs text-foreground-muted">{since}</span>}
      {chart ?? (
        <span className="text-xs text-foreground-muted" data-testid="dc-pie-no-history">
          {t('uiLibrary.sensorPie.noHistory', 'No history is kept for this reading.')}
        </span>
      )}
    </div>
  )
}
