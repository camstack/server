/**
 * The `systemEvent` condition widget — the authoring surface of ONE system
 * family (D637): device events, system, or alarm.
 *
 * Shape: the family's grouped kind multi-select, then only the narrowing
 * filters the family carries AND its selected kinds can use. The value logic is
 * pure and lives in `notification-system-events.ts`; this file is the DOM.
 *
 * Device scope is ONE field (`RuleScopeField`, D641): "All | Only these | All
 * except these" over the device picker — the same convention as the rule's
 * conditions tab. `deviceIds` in Only, `excludeDeviceIds` in Except, nothing
 * in All. Alarm rules that filter by camera offer Only (never Except).
 *
 * The node and package pickers are `NodeScopePicker` / `PackagePicker`
 * (`scope-pickers.tsx`): a node id is minted by the cluster and a package name
 * by the registry, so there is no free text. They read `nodes.directory` and
 * `addons.listPackages` — never `nodes.topology`, which walks the whole cluster
 * (32–51 s, D315) — and a stored id the list lacks stays a removable chip (D49).
 * (`NodeScopePicker` is deliberately not the library's `NodePicker` pill bar.)
 *
 * The last selected kind cannot be unticked: a rule with no kinds classifies
 * `mixed`, and the family would flip mid-edit.
 */

import type { NcSystemEventCondition, NcSystemEventFamily } from '@camstack/types'
import {
  isSystemEventFamily,
  NC_CONSUMABLE_LOW_PERCENT_DEFAULT,
  NC_SYSTEM_EVENT_FAMILIES,
  ruleKindSpec,
} from '@camstack/types'
import { Input, Select, Button } from '@camstack/ui-library'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type { RuleCameraOption } from './notification-condition-fields'
import type { DeviceFleetView } from './device-fleet-view'
import type { PickerDevice } from './device-picker-model'
import { DevicePicker } from './DevicePicker'
import { DevicesWidenWarning } from './device-selection-rows'
import { HINT_CLASS, LABEL_CLASS } from './notification-condition-widgets'
import { pickerDeviceOf } from './NotificationRuleDevices'
import type { RuleDeviceOption } from './rule-device-filter'
import { OptionListField } from './notification-rule-pickers'
import {
  batteryKindsNarrowedByType,
  NC_CONSUMABLE_THRESHOLD_MAX,
  NC_CONSUMABLE_THRESHOLD_MIN,
  NC_DEVICE_TYPE_OPTIONS,
  parseConsumableThreshold,
  patchSystemEventFilters,
  systemEventFilterVisibilityFor,
  systemEventKindGroupsFor,
  systemEventKindLabel,
  systemEventGroupOptions,
  systemEventOptionSelected,
  toggleSystemEventOption,
} from './notification-system-events'
import { projectRuleScope, type RuleScopeDraft, ruleScopeDraftOf } from './rule-scope-model'
import { RuleScopeField } from './RuleScopeField'
import { NodeScopePicker, PackagePicker } from './scope-pickers'
import { useHubRuleSchemaVerdict } from './hub-rule-schema-probe'
import { useTranslation } from 'react-i18next'

/** Where the cluster-wide battery threshold and reminder interval live: the
 *  hub's addon settings, section "Battery & offline alerts" of the post-analysis
 *  addon (`pipeline-analytics/settings-schema.ts`). There is no per-section deep
 *  link. The CONSUMABLE threshold is this rule's own field (D642). */
const DEVICE_ALERT_SETTINGS_HREF = '/system/settings'
/** The notification page's Alarm tab (`AdminTabs` reads `?tab=`). */
const ALARM_SETTINGS_HREF = '/system/notifications?tab=alarm'
const LINK_CLASS = 'text-primary underline-offset-2 hover:underline'

export interface SystemEventFieldProps {
  /** The one family this rule authors — never `mixed` (D637). */
  readonly family: NcSystemEventFamily
  readonly value: NcSystemEventCondition | undefined
  readonly cameras: readonly RuleCameraOption[]
  /** EVERY device (type, room, container) — what the include/exclude pickers
   *  list. Absent → the cameras. */
  readonly allDevices?: readonly RuleDeviceOption[]
  /** The whole fleet, and whether it ANSWERED — what a selected id is judged
   *  against (D315). */
  readonly fleet: DeviceFleetView
  /** Whether the rule as OPENED filtered on devices — seeds the widening
   *  warning so it survives a remount. */
  readonly savedHadDevices: boolean
  readonly onChange: (next: NcSystemEventCondition | undefined) => void
  /**
   * The rule is a scheduled STATE SUMMARY (D647): a paired class then means
   * the bad state at the scheduled time, not each change (D906).
   */
  readonly summary?: boolean
}

/** Write the active scope mode onto `deviceIds` / `excludeDeviceIds`. */
function applySystemEventDeviceScope(
  value: NcSystemEventCondition | undefined,
  draft: RuleScopeDraft<number>,
): NcSystemEventCondition | undefined {
  const saved = projectRuleScope(draft)
  return patchSystemEventFilters(value, {
    deviceIds: saved.include,
    excludeDeviceIds: saved.exclude,
  })
}

export function SystemEventField({
  family,
  value,
  cameras,
  allDevices,
  fleet,
  savedHadDevices,
  onChange,
  summary = false,
}: SystemEventFieldProps) {
  const { t } = useTranslation()
  const kinds = useMemo(() => value?.kinds ?? [], [value])
  // A system rule's devices are EVERY device — liveness, batteries and
  // consumables are device facts, and a vacuum is not a camera (D636).
  const pickable = useMemo(
    (): readonly PickerDevice[] =>
      allDevices !== undefined ? allDevices.map(pickerDeviceOf) : cameras,
    [allDevices, cameras],
  )
  const alarmCameras = useMemo(
    (): readonly PickerDevice[] =>
      cameras.map((camera) => ({ id: camera.id, name: camera.name, type: 'camera' })),
    [cameras],
  )
  const visible = systemEventFilterVisibilityFor(family, kinds)
  // D642 review I2: an old hub strips the threshold and refuses the tank
  // kinds without a word. Asked only by the family that has them.
  const hubSchema = useHubRuleSchemaVerdict(family === 'device-events')
  // On an alarm rule `deviceIds` is the CAMERA whose rule set the alarm off.
  const isAlarm = family === 'alarm'
  const [deviceScope, setDeviceScope] = useState(() =>
    ruleScopeDraftOf(value?.deviceIds, value?.excludeDeviceIds),
  )
  const [savedScope] = useState(() => ruleScopeDraftOf(value?.deviceIds, value?.excludeDeviceIds))
  const deviceNames = useMemo(() => {
    const names = new Map<number, string>()
    for (const device of isAlarm ? alarmCameras : pickable) {
      names.set(device.id, device.name)
    }
    return names
  }, [alarmCameras, isAlarm, pickable])

  const changeDeviceScope = (next: RuleScopeDraft<number>): void => {
    setDeviceScope(next)
    onChange(applySystemEventDeviceScope(value, next))
  }

  return (
    <div className="mt-1 space-y-3" data-testid="system-event-field">
      <p className={HINT_CLASS} data-testid="system-event-class-hint">
        {summary
          ? t(
              'system.notificationSystemEventField.summaryClassHint',
              'At the scheduled time you get the list of what is in the bad state, not each change.',
            )
          : t(
              'system.notificationSystemEventField.instantClassHint',
              'A paired event tells you both when it goes wrong and when it comes back.',
            )}
      </p>
      {systemEventKindGroupsFor(family).map((group) => (
        <div key={group.id}>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle">
            {group.label}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {systemEventGroupOptions(group, summary).map((option) => {
              const selected = systemEventOptionSelected(kinds, option)
              const label =
                option.noSnapshot === true
                  ? `${option.label} — ${t('system.notificationSystemEventField.noSnapshot', 'no state snapshot, reports nothing')}`
                  : option.label
              return (
                <Button
                  variant="unstyled"
                  key={option.key}
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  aria-label={label}
                  onClick={() => onChange(toggleSystemEventOption(value, option, family))}
                  className={
                    selected
                      ? 'rounded-md border border-primary bg-primary/10 px-2 py-1 text-[11px] text-primary'
                      : 'rounded-md border border-border px-2 py-1 text-[11px] text-foreground hover:bg-surface-hover'
                  }
                >
                  {label}
                </Button>
              )
            })}
          </div>
        </div>
      ))}

      {family === 'device-events' && (
        <p className={HINT_CLASS} data-testid="system-event-device-alert-settings">
          {t(
            'system.notificationSystemEventField.theBatteryThresholdAndThe',
            'The battery threshold and the reminder interval are cluster settings (the consumable threshold is this rule’s own, below):',
          )}{' '}
          <Link
            to={DEVICE_ALERT_SETTINGS_HREF}
            target="_blank"
            rel="noreferrer"
            className={LINK_CLASS}
          >
            {t(
              'system.notificationSystemEventField.settingsBatteryOfflineAlerts',
              'Settings → Battery & offline alerts',
            )}
          </Link>
          .
        </p>
      )}

      {family === 'alarm' && (
        <p className={HINT_CLASS} data-testid="system-event-alarm-settings">
          <Link to={ALARM_SETTINGS_HREF} target="_blank" rel="noreferrer" className={LINK_CLASS}>
            {t('system.notificationSystemEventField.alarmSettings', 'Alarm settings')}
          </Link>
          {kinds.includes('alarm-triggered') && (
            <span className="ml-1">{t('system.notificationSystemEventField.alarmPictures')}</span>
          )}
        </p>
      )}

      {hubSchema === 'outdated' && (
        <p
          className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning"
          data-testid="system-event-hub-outdated"
        >
          {t('system.notificationSystemEventField.hubOutdated', {
            percent: NC_CONSUMABLE_LOW_PERCENT_DEFAULT,
          })}
        </p>
      )}
      {hubSchema === 'unknown' && (
        <p className={HINT_CLASS} data-testid="system-event-hub-unchecked">
          {t(
            'system.notificationSystemEventField.couldNotCheckWhetherThis',
            'Could not check whether this hub’s server knows per-rule consumable thresholds and tank alerts.',
          )}
        </p>
      )}

      {visible.consumableThreshold && (
        <div>
          <label className={LABEL_CLASS} htmlFor="system-event-consumable-threshold">
            {t('system.notificationSystemEventField.consumableLowAt', 'Consumable low at (%)')}
          </label>
          <Input
            id="system-event-consumable-threshold"
            data-testid="system-event-consumable-threshold"
            type="number"
            min={NC_CONSUMABLE_THRESHOLD_MIN}
            max={NC_CONSUMABLE_THRESHOLD_MAX}
            step={1}
            placeholder={String(NC_CONSUMABLE_LOW_PERCENT_DEFAULT)}
            value={value?.consumableLowPercent ?? ''}
            className="mt-1 max-w-[8rem]"
            onChange={(e) => {
              const parsed = parseConsumableThreshold(e.target.value)
              if (parsed.kind === 'invalid') return
              onChange(
                patchSystemEventFilters(value, {
                  consumableLowPercent: parsed.kind === 'set' ? parsed.value : undefined,
                }),
              )
            }}
          />
        </div>
      )}

      {visible.deviceTypes && (
        <div>
          <label className={LABEL_CLASS}>
            {t('system.notificationSystemEventField.deviceTypes', 'Device types')}
          </label>
          <OptionListField
            options={NC_DEVICE_TYPE_OPTIONS}
            value={value?.deviceTypes ?? []}
            onChange={(next) => onChange(patchSystemEventFilters(value, { deviceTypes: next }))}
            emptyHint="No device types listed — the rule watches every type."
            placeholder={t('system.notificationSystemEventField.deviceType', 'Device type…')}
          />
        </div>
      )}

      {batteryKindsNarrowedByType(value) && (
        <p
          className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning"
          data-testid="battery-device-types-warning"
        >
          {t(
            'system.notificationSystemEventField.batteryAndConsumableAlertsAre',
            'Battery and consumable alerts are narrowed by device type here. Batteries and consumables belong to sensors, containers, vacuums and mowers — rarely to a camera — so a type filter meant for liveness silences them. Leave the types empty, or put these kinds in a rule of their own.',
          )}
        </p>
      )}

      {visible.devices && (
        <div>
          <RuleScopeField
            draft={deviceScope}
            onChange={changeDeviceScope}
            exceptOffered={visible.excludeDevices}
            plural="devices"
            describe={(id) => deviceNames.get(id) ?? t('uiLibrary.devicePicker.deviceId', { id })}
            testId="system-event-device-scope"
            renderPicker={(pickerValue, pickerChange, mode) => (
              <DevicePicker
                key={mode}
                devices={isAlarm ? alarmCameras : pickable}
                listState={fleet.state}
                fleet={fleet}
                emptyMeansAll
                savedHadDevices={
                  (mode === 'only' ? savedScope.include : savedScope.exclude).length > 0 ||
                  (mode === 'only' && savedHadDevices)
                }
                noun={isAlarm ? 'camera' : 'device'}
                value={pickerValue}
                onChange={pickerChange}
                testId={mode === 'only' ? 'system-event-include' : 'system-event-exclude'}
              />
            )}
          />
          {/* All mode has no picker: still say when the saved rule was narrower. */}
          {savedHadDevices && deviceScope.mode === 'all' && (
            <DevicesWidenWarning noun={isAlarm ? 'camera' : 'device'} />
          )}
        </div>
      )}

      {visible.nodes && (
        <div>
          <label className={LABEL_CLASS}>
            {t('system.notificationSystemEventField.nodes', 'Nodes')}
          </label>
          <NodeScopePicker
            value={value?.nodeIds ?? []}
            onChange={(next) => onChange(patchSystemEventFilters(value, { nodeIds: next }))}
            testId="system-event-nodes"
          />
        </div>
      )}

      {visible.packages && (
        <div>
          <label className={LABEL_CLASS}>
            {t('system.notificationSystemEventField.packages', 'Packages')}
          </label>
          <PackagePicker
            value={value?.packageNames ?? []}
            onChange={(next) => onChange(patchSystemEventFilters(value, { packageNames: next }))}
            testId="system-event-packages"
          />
        </div>
      )}
    </div>
  )
}

export interface MixedSystemEventNoteProps {
  readonly value: NcSystemEventCondition | undefined
}

/**
 * A system rule that is NOT one family (kinds across families, a legacy kind,
 * or none): shown, never edited (D637). Its kinds are listed read-only so the
 * operator can recreate it as single-family rules; nothing here can write to
 * the condition, so opening such a rule never rewrites it.
 */
export function MixedSystemEventNote({ value }: MixedSystemEventNoteProps) {
  const { t } = useTranslation()
  const kinds = value?.kinds ?? []
  return (
    <div
      className="mt-1 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning"
      data-testid="system-event-mixed"
    >
      <p>
        {t(
          'system.notificationSystemEventField.thisRuleIsNotOne',
          'This rule is not one kind of system rule — its events span device events, system and alarm, or it names none. It keeps firing as it is, but it cannot be edited here: recreate it as one rule per kind.',
        )}
      </p>
      {kinds.length > 0 && (
        <p className="mt-1 text-foreground">{kinds.map(systemEventKindLabel).join(', ')}</p>
      )}
    </div>
  )
}

export interface SystemFamilySelectProps {
  readonly family: NcSystemEventFamily
  readonly onChange: (next: NcSystemEventFamily) => void
}

/**
 * Which ONE family a system rule authors (D637). Changing it re-seeds the
 * kinds — it is the only way a rule changes family, and it is explicit.
 */
export function SystemFamilySelect({ family, onChange }: SystemFamilySelectProps) {
  const { t } = useTranslation()
  return (
    <div data-testid="system-family-select">
      <label className="block text-[11px] font-medium text-foreground mb-1">
        {t('system.notificationSystemEventField.kindOfSystemRule', 'Kind of system rule')}
      </label>
      <Select
        value={family}
        aria-label={t(
          'system.notificationSystemEventField.kindOfSystemRule',
          'Kind of system rule',
        )}
        onChange={(e) => {
          const next = e.target.value
          if (isSystemEventFamily(next)) onChange(next)
        }}
        options={NC_SYSTEM_EVENT_FAMILIES.map((f) => ({ value: f, label: ruleKindSpec(f).label }))}
      />
      <p className="text-[10px] text-foreground-subtle mt-1">
        {t(
          'system.notificationSystemEventField.oneRuleAnswersOneQuestion',
          'One rule answers one question: about devices, about the installation, or about the alarm. Changing it starts the event list over.',
        )}
      </p>
    </div>
  )
}
