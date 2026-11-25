import type { HeroMeasurement, HeroMeasurementQuantity } from '@camstack/types'
import { type ReactElement, useEffect, useState } from 'react'
import { useUiText, type UiTextFn } from '../../../contexts/ui-text'
import { useUnitPreferences } from '../../../contexts/unit-preferences'
import { useDeviceManagerGetDevice } from '../../../generated/system-hooks'
import { formatLastSeen } from '../../../lib/format-last-seen'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../primitives/dialog'
import { pickText } from '../../hero-model/hero-model-view'
import {
  measurementText,
  type MeasurementText,
  type ReadingDisplaySubject,
  useHeroLang,
} from '../../hero-model/measurement-display'
import { useRoleDisplayDefaults } from '../../device-item/role-display-defaults-context'
import { CardReadings } from '../parts/Readings'
import { readingStateOf } from '../scenes/sensor/pie-model'
import { type PieReading, SensorPieCard } from '../scenes/sensor/SensorPieCard'
import type { CardOrientation } from '../shell/model'
import { measurementSinceText } from './measurement-since'
import { SensorTrend } from './SensorTrend'
import { DeviceHistoryView } from '../../device-history/DeviceHistoryView'
import { useCardCommon } from './use-card-common'

/** The short name of a quantity, under its value in the pie. */
function quantityLabel(t: UiTextFn, quantity: HeroMeasurementQuantity): string {
  switch (quantity) {
    case 'temperature':
      return t('uiLibrary.sensorPie.quantity.temperature', 'Temperature')
    case 'humidity':
      return t('uiLibrary.sensorPie.quantity.humidity', 'Humidity')
    case 'power':
      return t('uiLibrary.sensorPie.quantity.power', 'Power')
    case 'contact':
      return t('uiLibrary.sensorPie.quantity.contact', 'Contact')
    case 'motion':
      return t('uiLibrary.sensorPie.quantity.motion', 'Motion')
    case 'illuminance':
      return t('uiLibrary.sensorPie.quantity.illuminance', 'Light')
    case 'text':
      return t('uiLibrary.sensorPie.quantity.text', 'State')
  }
}

/** Two readings of one quantity would share a key: the index keeps them apart. */
const idOf = (m: HeroMeasurement, index: number): string => `${m.quantity}-${String(index)}`

export interface MeasuredPieCardProps {
  readonly deviceId: number
  readonly canActuate: boolean
  readonly shown: readonly HeroMeasurement[]
  readonly hidden: readonly HeroMeasurement[]
  readonly orientation?: CardOrientation
  readonly showName: boolean
  readonly onDrawn?: (drawn: boolean) => void
}

/** The newest moment any reading was observed; `null` = none was. */
function latestSince(all: readonly HeroMeasurement[]): number | null {
  const moments = all.flatMap((m) => (m.since === null ? [] : [m.since]))
  return moments.length === 0 ? null : Math.max(...moments)
}

/** A sensor with several readings: the pie, and the history / list dialogs behind its wedges. */
export function MeasuredPieCard({
  deviceId,
  canActuate,
  shown,
  hidden,
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
  const [listOpen, setListOpen] = useState(false)

  const all = [...shown, ...hidden]
  const textOf = (m: HeroMeasurement): MeasurementText =>
    measurementText({ measurement: m, lang, subject, unitPreferences, roleDefaults })
  const readingOf = (m: HeroMeasurement, index: number): PieReading => {
    const text = textOf(m)
    return {
      id: idOf(m, index),
      quantity: m.quantity,
      value: text.value,
      unit: text.unit,
      label: quantityLabel(t, m.quantity),
      state: readingStateOf(m),
    }
  }
  const lead = shown[0]
  const ago = formatLastSeen(latestSince(all), t)
  const picked = shown.findIndex((m, i) => idOf(m, i) === selected)
  const pickedMeasurement = picked < 0 ? undefined : shown[picked]

  return (
    <>
      <SensorPieCard
        model={{
          common: card.common,
          state: {
            label: lead === undefined ? '' : pickText(lead.word, lang),
            since: null,
            tone: lead === undefined ? 'muted' : lead.tone,
          },
          readings: shown.map(readingOf),
          overflow: hidden.map((m, i) => readingOf(m, shown.length + i)),
          updated:
            ago === null ? null : t('uiLibrary.sensorPie.updated', 'Updated · {{ago}}', { ago }),
        }}
        actions={card.actions}
        showName={showName}
        selectedId={pickedMeasurement === undefined ? null : selected}
        onSelect={(id) => setSelected((current) => (current === id ? null : id))}
        detail={
          pickedMeasurement === undefined ? null : (
            <ReadingHistory
              deviceId={deviceId}
              measurement={pickedMeasurement}
              text={textOf(pickedMeasurement)}
              subject={subject}
              since={measurementSinceText(pickedMeasurement, t)}
            />
          )
        }
        onOverflow={() => setListOpen(true)}
        {...(orientation === undefined ? {} : { orientation })}
      />
      <Dialog open={listOpen} onOpenChange={setListOpen}>
        <DialogContent width="sm">
          <DialogHeader>
            <DialogTitle>{t('uiLibrary.sensorPie.readings', 'Readings')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <CardReadings
              testId="dc-pie-readings"
              items={all.map((m, i) => {
                const text = textOf(m)
                const empty = readingStateOf(m) === 'empty'
                return {
                  id: idOf(m, i),
                  label: quantityLabel(t, m.quantity),
                  value: empty
                    ? null
                    : text.unit === null
                      ? text.value
                      : `${text.value} ${text.unit}`,
                }
              })}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface ReadingHistoryProps {
  readonly deviceId: number
  readonly measurement: HeroMeasurement
  readonly text: MeasurementText
  readonly subject: ReadingDisplaySubject | null
  readonly since: string | null
}

/** The state series of a reading that is on/off rather than a number (no trend line). */
export const STATE_READING_HISTORY_KEY: Readonly<Partial<Record<HeroMeasurementQuantity, string>>> =
  {
    motion: 'cap:motion.detected',
    contact: 'cap:contact.entryOpen',
  }

/** One reading's value and the last day of it; a state reading shows ITS series only, never the device's whole History. */
function ReadingHistory({
  deviceId,
  measurement,
  text,
  subject,
  since,
}: ReadingHistoryProps): ReactElement {
  const t = useUiText()
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
  const stateKey = STATE_READING_HISTORY_KEY[measurement.quantity]
  const states =
    stateKey === undefined ? null : (
      <DeviceHistoryView deviceId={deviceId} seriesKeys={[stateKey]} />
    )
  return (
    <div className="flex w-full flex-col items-center gap-2" data-testid="dc-pie-history">
      <span className="text-sm font-medium text-foreground">
        {quantityLabel(t, measurement.quantity)}
      </span>
      {since === null ? null : <span className="text-xs text-foreground-muted">{since}</span>}
      {trend ?? states ?? (
        <span className="text-xs text-foreground-muted" data-testid="dc-pie-no-history">
          {t('uiLibrary.sensorPie.noHistory', 'No history is kept for this reading.')}
        </span>
      )}
    </div>
  )
}
