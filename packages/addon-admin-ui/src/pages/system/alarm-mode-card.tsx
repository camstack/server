/**
 * One arm mode, as the content of its tab: a line of badges (what it covers,
 * what is not notified), its three delays on one row, and its sensors.
 *
 * No paragraphs (operator, 2026-10-02): the words that used to explain the
 * mode live in the badges' tooltips, and what is open now is the State column
 * of the sensor list only — never a second "N open" badge.
 *
 * The sensor list (`alarm-sensor-table.tsx`) lists every opening a rule of
 * this mode covers; a camera is never listed — it can never refuse an arm.
 * Each row's switch writes ONE membership of this mode's non-blocking list
 * (the page owns the write). Which devices are openings is one bounded
 * household bindings read; while it is pending the tab says it is checking,
 * and when it failed (an older hub) it says it could not check and offers a
 * retry — never "no opening" (D315).
 */

import {
  NC_ALARM_DEFAULT_TRIGGERED_DURATION_SEC,
  type NcAlarmDelayField,
  type NcAlarmModeCoverage,
  type NcAlarmNotifyField,
  type NcAlarmPostTriggeredAction,
  NcAlarmPostTriggeredActionSchema,
  type NcAlarmSettings,
  type NcSchedule,
  resolveModeDelays,
  resolveModeNotifyPolicy,
} from '@camstack/types'
import { Badge, Button, Switch } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { Loader2, RotateCcw } from 'lucide-react'
import { ALARM_DELAY_META, DelayField } from './alarm-delay-field'
import { ScheduleField } from './notification-schedule-field'
import {
  type AlarmDeviceNames,
  type NonBlockingEmptyLine,
  type NonBlockingOptionsView,
  nonBlockingEmptyLine,
  nonBlockingOptions,
} from './alarm-nonblocking.helpers'
import { AlarmSensorTable } from './alarm-sensor-table'
import {
  type AlarmSensorRow,
  type AlarmSwitchWrite,
  alarmSensorTableState,
} from './alarm-sensor-table-model'
import type { PickerZonesRead } from './device-picker-model'
import {
  coverageIsEmpty,
  coverageSummary,
  type NcAlarmLiveView,
  nonBlockingFor,
  skippedSummary,
} from './notification-alarm.helpers'

/** Where the "which covered devices are openings" read is. */
export type AlarmOpeningsCheck =
  | { readonly status: 'answered'; readonly openingIds: ReadonlySet<number> }
  | { readonly status: 'pending' }
  | { readonly status: 'failed'; readonly error: string; readonly retry: () => void }

interface AlarmModeCardProps {
  readonly coverage: NcAlarmModeCoverage
  readonly live: NcAlarmLiveView | undefined
  readonly settings: NcAlarmSettings
  /** Fleet names with the removed / unanswered rules (`alarmDeviceNames`). */
  readonly names: AlarmDeviceNames
  readonly openingsCheck: AlarmOpeningsCheck
  /** One row per candidate opening of this mode (`alarmSensorRows`). */
  readonly rows: readonly AlarmSensorRow[]
  /** Retry of a FAILED sensors read; null otherwise. */
  readonly sensorsRetry: (() => void) | null
  readonly inFlight: AlarmSwitchWrite | null
  readonly onSwitch: (
    row: AlarmSensorRow,
    kind: 'blocks' | 'secureOnArm',
    nextValue: boolean,
  ) => void
  readonly zones: PickerZonesRead
  /** A typed value, or "Use default", for ONE of this mode's delays (the page decides the edit). */
  readonly onDelayEdit: (field: NcAlarmDelayField, next: number | 'default') => void
  /** Post-siren action override, or "Use default". */
  readonly onPostTriggeredEdit: (next: NcAlarmPostTriggeredAction | 'default') => void
  /** Activation schedule for this mode (`undefined` = always allowed). */
  readonly onScheduleEdit: (next: NcSchedule | undefined) => void
  /** One of the mode's notification switches (D706) on or off. */
  readonly onNotifyEdit: (field: NcAlarmNotifyField, next: boolean) => void
  readonly disabled: boolean
}

interface ModeNotifySwitchesProps {
  readonly coverage: NcAlarmModeCoverage
  readonly settings: NcAlarmSettings
  readonly disabled: boolean
  readonly onNotifyEdit: (field: NcAlarmNotifyField, next: boolean) => void
}

const NOTIFY_SWITCHES: readonly {
  readonly field: NcAlarmNotifyField
  readonly key: 'duringEntryDelay' | 'rewatched' | 'ignored'
}[] = [
  { field: 'notifyDuringEntryDelay', key: 'duringEntryDelay' },
  { field: 'notifySensorRewatched', key: 'rewatched' },
  { field: 'notifySensorIgnored', key: 'ignored' },
]

/**
 * What this mode notifies besides its own alarm rows (D706, D735). All default OFF: the
 * entry-delay notification is the one push of an entry delay, and a bypassed sensor that
 * rejoins the watch, or that really moved and was ignored, is logged, not sent.
 */
function ModeNotifySwitches({
  coverage,
  settings,
  disabled,
  onNotifyEdit,
}: ModeNotifySwitchesProps) {
  const { t } = useTranslation()
  const policy = resolveModeNotifyPolicy(settings, coverage.mode)
  return (
    <div className="space-y-2" data-testid={`alarm-notify-${coverage.mode}`}>
      <label className="block text-[11px] font-medium text-foreground">
        {t('notificationRules.alarmNotify.title')}
      </label>
      {NOTIFY_SWITCHES.map(({ field, key }) => (
        <div key={field} className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-foreground">{t(`notificationRules.alarmNotify.${key}`)}</p>
            <p className="text-[10px] text-foreground-subtle">
              {t(`notificationRules.alarmNotify.${key}Hint`)}
            </p>
          </div>
          <Switch
            checked={policy[field]}
            onCheckedChange={(next) => onNotifyEdit(field, next)}
            disabled={disabled}
            data-testid={`alarm-notify-${coverage.mode}-${field}`}
            aria-label={t(`notificationRules.alarmNotify.${key}`)}
          />
        </div>
      ))}
    </div>
  )
}

interface ModeBadgesProps {
  readonly coverage: NcAlarmModeCoverage
  readonly rows: readonly AlarmSensorRow[]
  readonly names: AlarmDeviceNames
}

/**
 * Coverage + skipped only. Open/closed lives in the sensor table — a second
 * "N open" badge next to the same rows was the same fact twice.
 */
function ModeBadges({ coverage, rows, names }: ModeBadgesProps) {
  const { t } = useTranslation()
  const covered = rows.filter((r) => r.coverage.kind.startsWith('arm-checked')).length
  const summary = coverageSummary(coverage, names.nameOf)
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid={`alarm-badges-${coverage.mode}`}
    >
      {coverageIsEmpty(coverage) ? (
        <Badge variant="warning" title={summary} data-testid="alarm-arms-nothing">
          {t(
            'system.alarmModeCard.armsNothingNoEnabledRule',
            'Arms nothing — no enabled rule is gated on this mode',
          )}
        </Badge>
      ) : (
        <Badge variant="default" title={summary} data-testid="alarm-covers">
          {t('system.alarmModeCard.checksSensors', { count: covered })}
        </Badge>
      )}
      {coverage.skippedDevices.length > 0 ? (
        <Badge
          variant="warning"
          title={skippedSummary(coverage.skippedDevices, names.nameOf)}
          data-testid="alarm-skipped"
        >
          {t('system.alarmModeCard.notNotified', { count: coverage.skippedDevices.length })}
        </Badge>
      ) : null}
    </div>
  )
}

function openingIdsOf(check: AlarmOpeningsCheck): ReadonlySet<number> | null {
  return check.status === 'answered' ? check.openingIds : null
}

interface OpeningsCheckLineProps {
  readonly check: AlarmOpeningsCheck
  readonly view: NonBlockingOptionsView
}

/** Said while the household openings read has not answered. */
function OpeningsCheckLine({ check, view }: OpeningsCheckLineProps) {
  const { t } = useTranslation()
  if (!view.unresolved) return null
  if (check.status === 'pending') {
    return (
      <p
        className="flex items-center gap-1 text-xs text-foreground-subtle"
        data-testid="alarm-openings-checking"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        {t(
          'system.alarmModeCard.checkingWhichDevicesAreOpenings',
          'Checking which devices are openings…',
        )}
      </p>
    )
  }
  if (check.status === 'failed') {
    return (
      <div
        className="flex flex-wrap items-center gap-2 text-xs text-warning"
        data-testid="alarm-openings-check-failed"
      >
        <span>{t('system.alarmModeCard.openingsCheckFailed', { error: check.error })}</span>
        <Button type="button" size="sm" variant="outline" onClick={check.retry}>
          {t('common.retry', 'Retry')}
        </Button>
      </div>
    )
  }
  return null
}

const POST_TRIGGERED_OPTIONS: readonly {
  readonly value: NcAlarmPostTriggeredAction
  readonly labelKey: string
}[] = [
  { value: 'rearmAfter', labelKey: 'system.alarmModeCard.postRearm' },
  { value: 'disableAfter', labelKey: 'system.alarmModeCard.postDisarm' },
  { value: 'doNothing', labelKey: 'system.alarmModeCard.postNothing' },
]

interface ModeDelaysProps {
  readonly coverage: NcAlarmModeCoverage
  readonly settings: NcAlarmSettings
  readonly disabled: boolean
  readonly onDelayEdit: (field: NcAlarmDelayField, next: number | 'default') => void
  readonly onPostTriggeredEdit: (next: NcAlarmPostTriggeredAction | 'default') => void
  readonly onScheduleEdit: (next: NcSchedule | undefined) => void
}

/** The mode's delays + after-trigger action + activation schedule. */
function ModeDelays({
  coverage,
  settings,
  disabled,
  onDelayEdit,
  onPostTriggeredEdit,
  onScheduleEdit,
}: ModeDelaysProps) {
  const { t } = useTranslation()
  const mode = coverage.mode
  const resolved = resolveModeDelays(settings, mode)
  const actionInherited = resolved.source.postTriggeredAction === 'default'
  const showAfterSec = resolved.postTriggeredAction !== 'doNothing'
  const schedule = (settings.modeDelays ?? []).find((e) => e.mode === mode)?.schedule
  return (
    <div className="space-y-3" data-testid={`alarm-delays-${mode}`}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {ALARM_DELAY_META.filter((meta) => meta.field !== 'triggeredDurationSec').map((meta) => {
          const inherited = resolved.source[meta.field] === 'default'
          return (
            <DelayField
              key={meta.field}
              label={t(meta.labelKey)}
              value={resolved[meta.field]}
              max={meta.max}
              zeroMeans={t(meta.zeroMeansKey)}
              disabled={disabled}
              testId={`alarm-delay-${mode}-${meta.key}`}
              onCommit={(seconds) => onDelayEdit(meta.field, seconds)}
              adornment={
                inherited ? (
                  <Badge
                    variant="default"
                    title={t(
                      'system.alarmModeCard.usesTheSystemDefaultS',
                      'Uses the system default ({{value1}} s)',
                      { value1: settings[meta.field] },
                    )}
                  >
                    {t('system.alarmModeCard.default', 'Default')}
                  </Badge>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    title={t('system.alarmModeCard.useTheDefault', 'Use the default')}
                    aria-label={t(
                      'system.alarmModeCard.useTheDefault2',
                      '{{label}}: use the default',
                      { label: t(meta.labelKey) },
                    )}
                    onClick={() => onDelayEdit(meta.field, 'default')}
                    data-testid={`alarm-delay-${mode}-${meta.key}-default`}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                )
              }
            />
          )
        })}
        <div>
          <label className="mb-1 block text-[11px] font-medium text-foreground">
            {t('system.alarmModeCard.afterTrigger', 'After trigger')}
            {actionInherited ? (
              <Badge
                variant="default"
                className="ml-1.5 align-middle"
                title={t('system.alarmModeCard.usesTheSystemDefault', 'Uses the system default')}
              >
                {t('system.alarmModeCard.default', 'Default')}
              </Badge>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-1 align-middle"
                disabled={disabled}
                title={t('system.alarmModeCard.useTheDefault', 'Use the default')}
                aria-label={t(
                  'system.alarmModeCard.afterTriggerUseTheDefault',
                  'After trigger: use the default',
                )}
                onClick={() => onPostTriggeredEdit('default')}
                data-testid={`alarm-delay-${mode}-post-default`}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
          </label>
          <select
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
            value={resolved.postTriggeredAction}
            disabled={disabled}
            data-testid={`alarm-delay-${mode}-post`}
            onChange={(e) => {
              const parsed = NcAlarmPostTriggeredActionSchema.safeParse(e.target.value)
              if (parsed.success) onPostTriggeredEdit(parsed.data)
            }}
          >
            {POST_TRIGGERED_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
        </div>
        {showAfterSec
          ? ALARM_DELAY_META.filter((meta) => meta.field === 'triggeredDurationSec').map((meta) => {
              const inherited = resolved.source[meta.field] === 'default'
              return (
                <DelayField
                  key={meta.field}
                  label={t(meta.labelKey)}
                  value={resolved[meta.field]}
                  max={meta.max}
                  zeroMeans={t(meta.zeroMeansKey)}
                  disabled={disabled}
                  testId={`alarm-delay-${mode}-${meta.key}`}
                  onCommit={(seconds) => onDelayEdit(meta.field, seconds)}
                  adornment={
                    inherited ? (
                      <Badge
                        variant="default"
                        title={t(
                          'system.alarmModeCard.usesTheSystemDefaultS',
                          'Uses the system default ({{value1}} s)',
                          { value1: settings[meta.field] },
                        )}
                      >
                        {t('system.alarmModeCard.default', 'Default')}
                      </Badge>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        title={t('system.alarmModeCard.useTheDefault', 'Use the default')}
                        aria-label={t(
                          'system.alarmModeCard.useTheDefault2',
                          '{{label}}: use the default',
                          { label: t(meta.labelKey) },
                        )}
                        onClick={() => onDelayEdit(meta.field, 'default')}
                        data-testid={`alarm-delay-${mode}-${meta.key}-default`}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    )
                  }
                />
              )
            })
          : null}
      </div>
      <div data-testid={`alarm-schedule-${mode}`}>
        <label className="mb-1 block text-[11px] font-medium text-foreground">
          {t('system.alarmModeCard.activationSchedule', 'Activation schedule')}
        </label>
        <p className="mb-1 text-[10px] text-foreground-subtle">
          {t(
            'system.alarmModeCard.whenThisModeMayBe',
            'When this mode may be armed. Empty means any day and time.',
          )}
        </p>
        <fieldset disabled={disabled} className="min-w-0 border-0 p-0">
          <ScheduleField
            value={schedule}
            onChange={onScheduleEdit}
            emptyHint="Always allowed — add a window to restrict when this mode can be armed."
          />
        </fieldset>
      </div>
    </div>
  )
}

const EMPTY_LINE: Readonly<Record<NonBlockingEmptyLine, string>> = {
  'no-opening': 'This household has no contact, cover or lock.',
}

export function AlarmModeCard({
  coverage,
  live,
  settings,
  names,
  openingsCheck,
  rows,
  sensorsRetry,
  inFlight,
  onSwitch,
  zones,
  onDelayEdit,
  onPostTriggeredEdit,
  onScheduleEdit,
  onNotifyEdit,
  disabled,
}: AlarmModeCardProps) {
  const { t } = useTranslation()
  const view = nonBlockingOptions({
    live,
    listed: nonBlockingFor(settings, coverage.mode),
    openingIds: openingIdsOf(openingsCheck),
  })
  const emptyLine = nonBlockingEmptyLine(view)
  // "None" is a claim only a whole candidate list can make (D315).
  const tableState = alarmSensorTableState({
    rowCount: rows.length,
    candidatesComplete: !view.unresolved,
  })

  return (
    <div
      className="flex flex-col gap-3"
      data-mode={coverage.mode}
      data-empty={coverageIsEmpty(coverage) ? 'true' : 'false'}
    >
      <ModeBadges coverage={coverage} rows={rows} names={names} />
      <ModeDelays
        coverage={coverage}
        settings={settings}
        disabled={disabled}
        onDelayEdit={onDelayEdit}
        onPostTriggeredEdit={onPostTriggeredEdit}
        onScheduleEdit={onScheduleEdit}
      />
      <p className="text-[10px] text-foreground-subtle" data-testid="alarm-delays-hint">
        {t('system.alarmModeCard.delaysHint', { seconds: NC_ALARM_DEFAULT_TRIGGERED_DURATION_SEC })}
      </p>
      <ModeNotifySwitches
        coverage={coverage}
        settings={settings}
        disabled={disabled}
        onNotifyEdit={onNotifyEdit}
      />
      <div className="flex flex-col gap-2" data-testid={`alarm-nonblocking-${coverage.mode}`}>
        <OpeningsCheckLine check={openingsCheck} view={view} />
        {emptyLine !== null ? (
          <p className="text-xs text-foreground-subtle">{EMPTY_LINE[emptyLine]}</p>
        ) : null}
        {tableState === 'none' && emptyLine === null ? (
          <p className="text-xs text-foreground-subtle" data-testid="alarm-sensors-none">
            {t(
              'system.alarmModeCard.noSensorIsCoveredBy',
              'No sensor is covered by a rule of this mode.',
            )}
          </p>
        ) : null}
        {tableState === 'rows' ? (
          <AlarmSensorTable
            mode={coverage.mode}
            rows={rows}
            sensorsRetry={sensorsRetry}
            inFlight={inFlight}
            onSwitch={onSwitch}
            zones={zones}
            disabled={disabled}
          />
        ) : null}
      </div>
    </div>
  )
}
