import { adminUiText } from '../../i18n/ui-text-bridge'
/**
 * Which devices a mode's non-blocking picker offers, and what every alarm line
 * calls a device.
 *
 * MIRRORS THE PHONE (`camstack/src/components/notifications/
 * alarm-settings-model.ts`): the picker offers OPENINGS — devices bound to
 * `contact`, `cover` or `lock-control`, the same three caps the hub's
 * `alarm-openings.ts` reads — and, since D636, EVERY opening of the
 * household rather than only the ones the mode's rules cover. An opening no
 * rule of the mode covers is listed and marked "never blocks": listing it is
 * harmless, and hiding it sent the operator off to author a rule just to see
 * a window here. Which devices are openings is ONE targeted read,
 * `deviceManager.listDeviceIdsByCaps` (ids only). Until it answers, or when it
 * fails (an older hub without the method), only devices the hub already read
 * (openings by construction) and ids already listed are offered, and the card
 * says so (D315). A listed id is never dropped by a read (D49).
 */

import { type DeviceListState, resolveSelectedDevices } from './device-selection'
import { orphanDeviceLabel } from './device-selection-rows'
import type { NcAlarmLiveView } from './notification-alarm.helpers'
import i18n from '../../i18n/index'

/** The caps whose state can refuse an arm — the hub's `NcAlarmOpeningCap`. */
export const ALARM_OPENING_CAP_NAMES: readonly string[] = [
  'contact',
  'cover',
  'lock-control',
  'switch',
]

/** Every id the hub read under ANY mode — open, or an unreadable opening. */
function hubOpeningIds(live: NcAlarmLiveView | undefined): ReadonlySet<number> {
  const ids = new Set<number>()
  for (const row of live?.openings ?? []) {
    for (const d of row.devices) ids.add(d.deviceId)
    for (const id of row.unknown) ids.add(id)
  }
  return ids
}

export interface NonBlockingOptionsInput {
  readonly live: NcAlarmLiveView | undefined
  readonly listed: readonly number[]
  /** Every opening of the household (the scan); null while that is not known. */
  readonly openingIds: ReadonlySet<number> | null
}

export interface NonBlockingOptionsView {
  readonly ids: readonly number[]
  /** The household scan has not answered (pending or failed). */
  readonly unresolved: boolean
}

/**
 * What one mode's picker offers: EVERY opening of the household — what the
 * hub read under any mode (open, or an opening it could not read) and every
 * device the scan found bound to an opening cap — plus every id already
 * listed, so a stale pick can still be removed (D49). An opening no rule of
 * this mode covers is offered too (D636); the sensor table's coverage column
 * says it never blocks.
 */
export function nonBlockingOptions(input: NonBlockingOptionsInput): NonBlockingOptionsView {
  const ids = new Set<number>(hubOpeningIds(input.live))
  for (const id of input.openingIds ?? []) ids.add(id)
  for (const id of input.listed) ids.add(id)
  const sorted = [...ids].toSorted((a, b) => a - b)
  return {
    ids: sorted,
    unresolved: input.openingIds === null,
  }
}

/**
 * Why a picker offers nothing, when it KNOWS: the household has no opening
 * (contact, cover or lock) at all. Null while the scan has not answered —
 * "none" is a claim only an answer can make (D315).
 */
export type NonBlockingEmptyLine = 'no-opening'

export function nonBlockingEmptyLine(view: NonBlockingOptionsView): NonBlockingEmptyLine | null {
  if (view.ids.length > 0 || view.unresolved) return null
  return 'no-opening'
}

// ── Names ───────────────────────────────────────────────────────────

export type AlarmDeviceNamer = (id: number) => string

/**
 * What an alarm line calls a device: the name the hub read it open under, the
 * fleet's name, "Device #<id> — removed" when the ANSWERED fleet lacks it,
 * and a plain "Device #<id>" while the fleet has not answered (D315) — the
 * same words every admin device picker uses (`orphanDeviceLabel`).
 */
export interface AlarmDeviceNames {
  readonly nameOf: AlarmDeviceNamer
  /** True only when the ANSWERED fleet lacks the id (and the hub did not name it). */
  readonly isRemoved: (id: number) => boolean
}

export function alarmDeviceNames(
  fleet: ReadonlyMap<number, string>,
  state: DeviceListState,
  openNames: ReadonlyMap<number, string> = new Map(),
): AlarmDeviceNames {
  const rows = [...fleet].map(([id, name]) => ({ id, name }))
  const openName = (id: number): string | null => {
    const name = openNames.get(id)?.trim()
    return name === undefined || name === '' ? null : name
  }
  const rowOf = (id: number) => resolveSelectedDevices([id], rows, state)[0]
  return {
    nameOf: (id) => {
      const row = rowOf(id)
      return (
        openName(id) ??
        (row === undefined
          ? i18n.t('uiLibrary.devicePicker.deviceId', { id })
          : orphanDeviceLabel(row, 'device', adminUiText))
      )
    },
    isRemoved: (id) => openName(id) === null && rowOf(id)?.removed === true,
  }
}

export function alarmDeviceNamer(
  fleet: ReadonlyMap<number, string>,
  state: DeviceListState,
  openNames: ReadonlyMap<number, string> = new Map(),
): AlarmDeviceNamer {
  return alarmDeviceNames(fleet, state, openNames).nameOf
}

/** A device as the HUB names it on a refusal, an exclusion or an opening. */
export interface HubNamedDevice {
  readonly deviceId: number
  readonly name: string
}

/** A device row the HUB named — never blank. */
export function hubDeviceName(device: HubNamedDevice): string {
  const name = device.name.trim()
  return name === '' ? i18n.t('uiLibrary.devicePicker.deviceId', { id: device.deviceId }) : name
}

/**
 * The first line of a refused arm. A refusal whose blocking list is EMPTY
 * (every device it held against the arm has since become unreadable) gets
 * its own words: "these are open:" over nothing reads as a rendering bug.
 */
export function refusalHeadline(blockingCount: number): string {
  return blockingCount === 0
    ? i18n.t('helpers.alarmNonblocking.refusedNoName')
    : i18n.t('helpers.alarmNonblocking.refusedOpen')
}
