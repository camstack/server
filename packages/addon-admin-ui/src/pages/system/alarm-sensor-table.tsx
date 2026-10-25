/**
 * One arm mode's sensors: what each opening reads NOW, whether the arm check
 * looks at it, and the switch that says whether it blocks arming.
 *
 * What a row says and what its switch writes is decided in
 * `alarm-sensor-table-model.ts`; this file only draws it.
 *
 *  - The list is the shared `DeviceList` (generic mode), the same chrome as
 *    the Devices page: a Type filter on the left, the search on the right, ONE
 *    table sorted by name. Zone and location are a muted line under the name,
 *    never a grouping (operator, 2026-10-02). On a phone the Type and
 *    "Checked when arming" columns are hidden, so Name, State and the switch fit.
 *  - State and coverage are a SHORT word in a `Badge`; a note appears only when
 *    there is something to add (offline, removed, unreadable).
 *  - The switch ON means "blocks arming". A press sends ONE edit for ONE
 *    device (`onSwitch`) — the page owns the write and refuses a second one
 *    while one is in flight, so this table never builds a list.
 *  - D315: a state cell says "Checking…" until the sensors read ANSWERED; a
 *    failed read says so (once above the list, with Retry); "closed" is only
 *    ever a reading. The zone is named only from an answered zones read.
 *  - Q2 (operator, 2026-10-02): a sensor no rule of the mode covers is not a
 *    row (the model drops it). The exception is an uncovered sensor the mode's
 *    non-blocking list still holds: the row is muted and its coverage cell says
 *    so; its switch stays usable, so the stored entry can be removed (D49).
 *  - D49: a listed id the device list no longer holds is still a row
 *    ("Removed"), so it can be switched off the list.
 */

import type { AlarmArmMode } from '@camstack/types'
import {
  Badge,
  Button,
  DeviceList,
  type DeviceListColumn,
  Switch,
  useUiText,
} from '@camstack/ui-library'
import { adminUiText } from '../../i18n/ui-text-bridge'
import { Loader2 } from 'lucide-react'
import type { ComponentProps } from 'react'
import {
  type AlarmCoverageCell,
  type AlarmSensorCell,
  type AlarmSensorRow,
  type AlarmSwitchWrite,
} from './alarm-sensor-table-model'
import { typeLabel } from './device-filter-bar'
import { type PickerZonesRead, pickerLocationKey } from './device-picker-model'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

export interface AlarmSensorTableProps {
  readonly mode: AlarmArmMode
  readonly rows: readonly AlarmSensorRow[]
  /** Retry of a FAILED sensors read; null otherwise. */
  readonly sensorsRetry: (() => void) | null
  /** The write in flight anywhere on the page (one at a time across modes). */
  readonly inFlight: AlarmSwitchWrite | null
  readonly onSwitch: (
    row: AlarmSensorRow,
    kind: 'blocks' | 'secureOnArm',
    nextValue: boolean,
  ) => void
  readonly zones: PickerZonesRead
  readonly disabled: boolean
}

/** "Zona giorno · Sala" — the zone only from an ANSWERED zones read (D315); "" for neither. */
export function zoneLocationLabel(
  location: string | null | undefined,
  zones: PickerZonesRead,
): string {
  const place = location?.trim() ?? ''
  if (place === '') return ''
  if (zones.state === 'answered') {
    const key = pickerLocationKey(place)
    const zone = zones.zones.find((z) => z.locationKeys.includes(key))
    if (zone !== undefined) return `${zone.label} · ${place}`
  }
  return place
}

/** What a cell shows: a short word for the badge and, when there is more to say, a line under it. */
export interface CellWords {
  readonly word: string
  readonly note: string | null
}

function sensorWords(cell: AlarmSensorCell): CellWords {
  switch (cell.kind) {
    case 'checking':
      return { word: i18n.t('system.alarmSensorTable.cellChecking'), note: null }
    case 'hub-too-old':
      return {
        word: i18n.t('system.alarmSensorTable.cellUnknown'),
        note: i18n.t('system.alarmSensorTable.cellHubTooOld'),
      }
    case 'read-failed':
      return {
        word: i18n.t('system.alarmSensorTable.cellUnknown'),
        note: i18n.t('system.alarmSensorTable.cellReadFailedError', { error: cell.error }),
      }
    case 'open':
    case 'closed':
      return {
        word: cell.word,
        note: cell.offline ? i18n.t('system.alarmSensorTable.cellOfflineLastKnown') : null,
      }
    case 'unknown':
      return {
        word: i18n.t('system.alarmSensorTable.cellUnknown'),
        note:
          cell.why === 'not-answered'
            ? i18n.t('system.alarmSensorTable.cellNotAnswered')
            : cell.why === 'read-failed'
              ? i18n.t('system.alarmSensorTable.cellReadFailed')
              : i18n.t('system.alarmSensorTable.cellNoState'),
      }
    case 'not-opening':
      return { word: i18n.t('system.alarmSensorTable.cellNotOpening'), note: null }
    case 'removed':
      return {
        word: i18n.t('system.alarmSensorTable.cellRemoved'),
        note: i18n.t('system.alarmSensorTable.cellRemovedNote'),
      }
  }
}

export function listedUncoveredWords(): string {
  return i18n.t('system.alarmSensorTable.listedUncovered')
}

function coverageWords(row: AlarmSensorRow): CellWords {
  if (row.listedUncovered)
    return { word: i18n.t('system.alarmSensorTable.cellNo'), note: listedUncoveredWords() }
  return coverageCellWords(row.coverage)
}

function coverageCellWords(cell: AlarmCoverageCell): CellWords {
  switch (cell.kind) {
    case 'arm-checked':
      return { word: i18n.t('system.alarmSensorTable.cellYes'), note: null }
    case 'arm-checked-skipped': {
      const why =
        cell.reason === 'detection-off'
          ? i18n.t('system.alarmSensorTable.detectionOff')
          : cell.reason
      return {
        word: i18n.t('system.alarmSensorTable.cellSkipped'),
        note: i18n.t('system.alarmSensorTable.cellSkippedNote', { why }),
      }
    }
    case 'unscoped':
      return {
        word: i18n.t('system.alarmSensorTable.cellAllDevices'),
        note: i18n.t('system.alarmSensorTable.cellNeverBlocks'),
      }
    case 'not-covered':
      return {
        word: i18n.t('system.alarmSensorTable.cellNo'),
        note: i18n.t('system.alarmSensorTable.cellNeverBlocks'),
      }
  }
}

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>['variant']>

function sensorVariant(cell: AlarmSensorCell): BadgeVariant {
  switch (cell.kind) {
    case 'open':
    case 'read-failed':
    case 'hub-too-old':
    case 'removed':
      return 'warning'
    case 'closed':
    case 'checking':
    case 'unknown':
    case 'not-opening':
      return 'default'
  }
}

function coverageVariant(row: AlarmSensorRow): BadgeVariant {
  if (row.listedUncovered) return 'default'
  switch (row.coverage.kind) {
    case 'arm-checked':
      return 'success'
    case 'arm-checked-skipped':
      return 'warning'
    case 'unscoped':
    case 'not-covered':
      return 'default'
  }
}

interface WordsCellProps {
  readonly name: 'state' | 'coverage'
  readonly variant: BadgeVariant
  readonly words: CellWords
}

/** A badge with its short word and, under it when there is one, the note as plain text. */
function WordsCell({ name, variant, words }: WordsCellProps) {
  return (
    <span data-testid={`alarm-cell-${name}`} className="flex flex-col items-start gap-0.5">
      <Badge variant={variant} data-testid={`alarm-cell-${name}-badge`}>
        {words.word}
      </Badge>
      {words.note === null ? null : (
        <span
          className="text-[10px] text-foreground-subtle"
          data-testid={`alarm-cell-${name}-note`}
        >
          {words.note}
        </span>
      )}
    </span>
  )
}

/** Hidden below `sm`: the phone keeps Name, State and the switch. */
const WIDE_ONLY = 'hidden sm:table-cell'

function sensorColumns(props: AlarmSensorTableProps): readonly DeviceListColumn<AlarmSensorRow>[] {
  const { mode, inFlight, onSwitch, zones, disabled } = props
  return [
    {
      key: 'name',
      header: i18n.t('system.alarmSensorTable.name', 'Name'),
      cell: (r) => {
        const place = zoneLocationLabel(r.device.location, zones)
        return (
          <span
            className="flex min-w-0 flex-col"
            data-testid="alarm-cell-name"
            data-muted={r.listedUncovered ? 'true' : undefined}
          >
            <span className="truncate text-xs font-medium text-foreground">{r.device.name}</span>
            {place === '' ? null : (
              <span
                className="truncate text-[10px] text-foreground-subtle"
                data-testid="alarm-cell-zone"
              >
                {place}
              </span>
            )}
          </span>
        )
      },
    },
    {
      key: 'type',
      header: i18n.t('system.alarmSensorTable.type', 'Type'),
      headerClassName: WIDE_ONLY,
      cellClassName: `${WIDE_ONLY} text-[11px] text-foreground-subtle`,
      cell: (r) => typeLabel(r.device.type ?? null, adminUiText),
    },
    {
      key: 'state',
      header: i18n.t('system.alarmSensorTable.state', 'State'),
      cell: (r) => (
        <WordsCell name="state" variant={sensorVariant(r.cell)} words={sensorWords(r.cell)} />
      ),
    },
    {
      key: 'coverage',
      header: i18n.t('system.alarmSensorTable.checkedWhenArming', 'Checked when arming'),
      headerClassName: WIDE_ONLY,
      cellClassName: WIDE_ONLY,
      cell: (r) => (
        <WordsCell name="coverage" variant={coverageVariant(r)} words={coverageWords(r)} />
      ),
    },
    {
      key: 'blocks',
      header: i18n.t('system.alarmSensorTable.blocksArming', 'Blocks arming'),
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      cell: (r) => {
        const busy =
          inFlight !== null &&
          inFlight.mode === mode &&
          inFlight.deviceId === r.device.id &&
          inFlight.kind === 'blocks'
        const waiting = inFlight !== null && !busy
        return (
          <span className="inline-flex items-center justify-end gap-1">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            <Switch
              checked={r.blocks}
              onCheckedChange={(next) => onSwitch(r, 'blocks', next)}
              disabled={disabled}
              data-device-id={String(r.device.id)}
              data-testid="alarm-switch-blocks"
              aria-label={i18n.t(
                'system.alarmSensorTable.blocksArming2',
                'Blocks arming: {{name}}',
                { name: r.device.name },
              )}
              aria-busy={busy ? true : undefined}
              // Not `disabled`: a press is still answered BY NAME (the refusal line).
              aria-disabled={waiting ? true : undefined}
              className={waiting ? 'opacity-50' : undefined}
            />
          </span>
        )
      },
    },
    {
      key: 'secure',
      header: (
        <span
          title={i18n.t(
            'system.alarmSensorTable.closeLockOrTurnOff',
            'Close, lock, or turn off when this mode arms',
          )}
        >
          {i18n.t('system.alarmSensorTable.secureOnArm', 'Secure on arm')}
        </span>
      ),
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      cell: (r) => {
        if (!r.controllable) {
          return <span className="text-[10px] text-foreground-subtle">—</span>
        }
        const busy =
          inFlight !== null &&
          inFlight.mode === mode &&
          inFlight.deviceId === r.device.id &&
          inFlight.kind === 'secureOnArm'
        const waiting = inFlight !== null && !busy
        return (
          <span className="inline-flex items-center justify-end gap-1">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            <Switch
              checked={r.secureOnArm}
              onCheckedChange={(next) => onSwitch(r, 'secureOnArm', next)}
              disabled={disabled}
              data-device-id={String(r.device.id)}
              data-testid="alarm-switch-secure"
              aria-label={i18n.t(
                'system.alarmSensorTable.secureOnArmCloseLock',
                'Secure on arm (close/lock/off): {{name}}',
                { name: r.device.name },
              )}
              title={i18n.t(
                'system.alarmSensorTable.closeLockOrTurnOff',
                'Close, lock, or turn off when this mode arms',
              )}
              aria-busy={busy ? true : undefined}
              aria-disabled={waiting ? true : undefined}
              className={waiting ? 'opacity-50' : undefined}
            />
          </span>
        )
      },
    },
  ]
}

export function AlarmSensorTable(props: AlarmSensorTableProps) {
  const { t } = useTranslation()
  const uiText = useUiText()
  const { mode, rows, sensorsRetry, zones } = props
  return (
    <div className="space-y-2" data-testid={`alarm-sensors-${mode}`}>
      {sensorsRetry !== null ? (
        <div
          className="flex items-center gap-2 text-xs text-warning"
          data-testid="alarm-sensors-failed"
        >
          <span>
            {t(
              'system.alarmSensorTable.couldNotReadTheSensor',
              'Could not read the sensor states.',
            )}
          </span>
          <Button type="button" size="sm" variant="outline" onClick={sensorsRetry}>
            {t('common.retry', 'Retry')}
          </Button>
        </div>
      ) : null}
      <DeviceList<AlarmSensorRow>
        mode="generic"
        items={rows}
        getKey={(r) => String(r.device.id)}
        getSearchText={(r) =>
          [
            r.device.name,
            zoneLocationLabel(r.device.location, zones),
            typeLabel(r.device.type ?? null, uiText),
          ].join(' ')
        }
        getFilterType={(r) => typeLabel(r.device.type ?? null, uiText)}
        columns={sensorColumns(props)}
        rowClassName={(r) => (r.listedUncovered ? 'opacity-60' : '')}
        searchPlaceholder={t('system.alarmSensorTable.searchSensors', 'Search sensors')}
        emptyLabel="No sensor matches."
      />
    </div>
  )
}
