import { isNotReported } from '@camstack/types'
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
import type { FanReading } from '../scenes/fan/model'
import { quantityLabel } from './measurement-label'

const NONE: readonly FanReading[] = []

/**
 * What a device that is not a sensor measures (a fan's temperature and humidity
 * bindings), as the operator reads it: name and value with its unit in their
 * display units. A reading with no data is "—", never 0 (D393). Empty until the
 * hero model answers, and for a device that measures nothing.
 */
export function useMeasurementReadings(deviceId: number): readonly FanReading[] {
  const t = useUiText()
  const lang = useHeroLang()
  const unitPreferences = useUnitPreferences()
  const roleDefaults = useRoleDisplayDefaults()
  const model = useHeroLayoutGetHeroModel({ deviceId, canActuate: false })
  const device = useDeviceManagerGetDevice({ deviceId }, { staleTime: 60_000 })
  const measurements = model.data?.measurements
  if (measurements === undefined) return NONE
  const subject: ReadingDisplaySubject | null =
    device.data === undefined || device.data === null
      ? null
      : {
          role: device.data.role ?? null,
          ...(device.data.display === undefined ? {} : { display: device.data.display }),
        }
  return measurements.map((m, index) => {
    const text = measurementText({
      measurement: m,
      lang,
      subject,
      unitPreferences,
      roleDefaults,
    })
    const empty = m.reading === null && isNotReported(m.value)
    return {
      id: `${m.quantity}-${String(index)}`,
      name: quantityLabel(t, m.quantity),
      value: empty || text.unit === null ? text.value : `${text.value} ${text.unit}`,
    }
  })
}
