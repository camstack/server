/**
 * The one per-camera knob of the scheduled battery refresh (D847), declared
 * beside its reader (`resolveBatteryRefreshIntervalMs`, used by the camera):
 * `scripts/check-settings-key-has-reader.ts` fails a key that is only declared.
 */
import type { ConfigUISchema } from '@camstack/types'
import {
  BATTERY_REFRESH_MINUTES_DEFAULT,
  BATTERY_REFRESH_MINUTES_KEY,
  BATTERY_REFRESH_MINUTES_MAX,
  BATTERY_REFRESH_OFF,
} from './battery-hourly-refresh.js'

export const BATTERY_REFRESH_SECTION_ID = 'battery-refresh'

export const BATTERY_REFRESH_MINUTES_DESCRIPTION =
  'A camera that slept the whole window is woken once to refresh. 0 turns the scheduled refresh off.'

/** Battery cameras only: a mains camera keeps its facts fresh on its own socket. */
export function buildBatteryRefreshDeviceSection(input: {
  readonly isBattery: boolean
}): readonly ConfigUISchema['sections'][number][] {
  if (!input.isBattery) return []
  return [
    {
      id: BATTERY_REFRESH_SECTION_ID,
      tab: 'general',
      title: 'Scheduled refresh',
      columns: 1,
      fields: [
        {
          type: 'number',
          key: BATTERY_REFRESH_MINUTES_KEY,
          label: 'Refresh window (min)',
          description: BATTERY_REFRESH_MINUTES_DESCRIPTION,
          default: BATTERY_REFRESH_MINUTES_DEFAULT,
          min: BATTERY_REFRESH_OFF,
          max: BATTERY_REFRESH_MINUTES_MAX,
          step: 5,
        },
      ],
    },
  ]
}
