/**
 * The simulator's trigger-specific FIELDS.
 *
 * Split out of `NotificationSimulate.tsx` (past the 800-line ceiling): the page
 * owns the queries, the mutation and the result, this file owns the controls.
 *
 * The rule every section here follows: render ONLY what the chosen subject kind
 * can actually carry. A package phase on an object event, or a sensor kind on a
 * track, is a control `buildSimulateInput` drops on the way to the wire — and a
 * control that silently does nothing is how an operator concludes a feature is
 * broken.
 *
 * Every vocabulary is passed in, never invented: classes come from the NC
 * taxonomy, zones from the camera's own zone picker, event kinds from
 * `listEventKindsBatch` for the selected camera.
 */

import type { EventKindDescriptor, NcTaxonomy } from '@camstack/types'
import { pickerForCondition } from '@camstack/types'
import { Badge, Button, Input, Select, Switch } from '@camstack/ui-library'
import type { RuleCameraOption } from './notification-condition-fields'
import {
  HINT_CLASS,
  LABEL_CLASS,
  TagListField,
  TaxonomyPickerField,
  ZoneListField,
} from './notification-condition-widgets'
import { OptionListField, type PickOption } from './notification-rule-pickers'
import {
  parseOptionalNumberInput,
  toLocalDateTimeValue,
  type NcSimulateFormState,
} from './notification-simulate.helpers'
import { useTranslation } from 'react-i18next'

/** Kind categories a DEVICE-EVENT can be built from (doorbell included). */
const DEVICE_EVENT_CATEGORIES: ReadonlySet<string> = new Set(['sensor', 'control', 'custom'])

export interface SectionProps {
  readonly form: NcSimulateFormState
  readonly cameras: readonly RuleCameraOption[]
  readonly onPatch: (next: Partial<NcSimulateFormState>) => void
}

export interface WhatHappenedProps extends SectionProps {
  readonly taxonomy: NcTaxonomy | undefined
  readonly kinds: readonly EventKindDescriptor[]
  readonly kindsLoading: boolean
}

export function WhatHappenedSection({
  form,
  cameras,
  taxonomy,
  kinds,
  kindsLoading,
  onPatch,
}: WhatHappenedProps) {
  const { t } = useTranslation()
  const deviceIds = form.deviceId === null ? [] : [form.deviceId]
  const classPicker = pickerForCondition('classes', taxonomy)

  if (form.trigger === 'device-event') {
    return (
      <div className="space-y-3 rounded-md border border-border px-3 py-2">
        <div className="text-[11px] font-semibold text-foreground">
          {t('system.notificationSimulateFields.whatHappened', 'What happened')}
        </div>
        <DeviceEventFields form={form} kinds={kinds} loading={kindsLoading} onPatch={onPatch} />
      </div>
    )
  }

  if (form.trigger === 'audio-event') {
    const audioOptions: readonly PickOption[] = kinds
      .filter((k) => k.category === 'audio' && k.level === 'sub')
      .map((k) => ({ value: k.kind, label: k.label }))
    return (
      <div className="space-y-3 rounded-md border border-border px-3 py-2">
        <div className="text-[11px] font-semibold text-foreground">
          {t('system.notificationSimulateFields.whatHappened', 'What happened')}
        </div>
        <div>
          <label className={LABEL_CLASS}>
            {t('system.notificationSimulateFields.audioClasses', 'Audio classes')}
          </label>
          <OptionListField
            options={audioOptions}
            value={form.classNames}
            onChange={(next) => onPatch({ classNames: next })}
            loading={kindsLoading}
            emptyHint={
              form.deviceId === null
                ? 'Pick a camera first — the audio vocabulary is per camera.'
                : 'This camera advertises no audio kinds. The audio classifier is probably off for it.'
            }
            placeholder={t('system.notificationSimulateFields.audioClassId', 'Audio class id…')}
          />
        </div>
        <div>
          <label className={LABEL_CLASS}>
            {t('system.notificationSimulateFields.zones', 'Zones')}
          </label>
          <ZoneListField
            deviceIds={deviceIds}
            cameras={cameras}
            value={form.zones}
            onChange={(next) => onPatch({ zones: next })}
          />
        </div>
      </div>
    )
  }

  if (form.trigger === 'occupancy-event') {
    return (
      <div className="space-y-3 rounded-md border border-border px-3 py-2">
        <div className="text-[11px] font-semibold text-foreground">
          {t('system.notificationSimulateFields.whatHappened', 'What happened')}
        </div>
        <OccupancyFields form={form} cameras={cameras} taxonomy={taxonomy} onPatch={onPatch} />
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-md border border-border px-3 py-2">
      <div className="text-[11px] font-semibold text-foreground">
        {t('system.notificationSimulateFields.whatHappened', 'What happened')}
      </div>
      <div>
        <label className={LABEL_CLASS}>
          {t('system.notificationSimulateFields.detectedClasses', 'Detected classes')}
        </label>
        {classPicker === null ? (
          <TagListField
            value={form.classNames}
            placeholder={t(
              'system.notificationSimulateFields.classIdPersonCar',
              'Class id (person, car…)',
            )}
            onChange={(next) => onPatch({ classNames: next })}
          />
        ) : (
          <TaxonomyPickerField
            picker={classPicker}
            value={form.classNames}
            onChange={(next) => onPatch({ classNames: next })}
          />
        )}
      </div>
      <div>
        <label className={LABEL_CLASS}>
          {t('system.notificationSimulateFields.zonesTheSubjectIsIn', 'Zones the subject is in')}
        </label>
        <ZoneListField
          deviceIds={deviceIds}
          cameras={cameras}
          value={form.zones}
          onChange={(next) => onPatch({ zones: next })}
        />
      </div>
      {form.trigger === 'package-event' && (
        <div className="max-w-[14rem]">
          <label className={LABEL_CLASS}>
            {t('system.notificationSimulateFields.packagePhase', 'Package phase')}
          </label>
          <Select
            value={form.packagePhase}
            options={[
              { value: '', label: t('system.notificationSimulateFields.none', '— none —') },
              {
                value: 'delivered',
                label: t('system.notificationSimulateFields.delivered', 'Delivered'),
              },
              {
                value: 'picked-up',
                label: t('system.notificationSimulateFields.pickedUp', 'Picked up'),
              },
            ]}
            onChange={(e) =>
              onPatch({
                packagePhase:
                  e.target.value === 'delivered'
                    ? 'delivered'
                    : e.target.value === 'picked-up'
                      ? 'picked-up'
                      : '',
              })
            }
          />
        </div>
      )}
    </div>
  )
}

interface DeviceEventFieldsProps {
  readonly form: NcSimulateFormState
  readonly kinds: readonly EventKindDescriptor[]
  readonly loading: boolean
  readonly onPatch: (next: Partial<NcSimulateFormState>) => void
}

/**
 * The device-event fields.
 *
 * Choosing a kind sets BOTH the taxonomy kind id and the linked SOURCE device,
 * because `EventKindDescriptor.source.deviceId` already says which device
 * contributes it. Making the operator guess the doorbell's device id is how the
 * previous manual test procedure produced events attributed to the wrong device.
 */
function DeviceEventFields({ form, kinds, loading, onPatch }: DeviceEventFieldsProps) {
  const { t } = useTranslation()
  const sensorKinds = kinds.filter((k) => DEVICE_EVENT_CATEGORIES.has(k.category))
  const selected = sensorKinds.find((k) => k.kind === form.sensorKind)

  return (
    <>
      <div>
        <label className={LABEL_CLASS}>
          {t('system.notificationSimulateFields.eventKind', 'Event kind')}
        </label>
        <Select
          value={form.sensorKind}
          options={[
            {
              value: '',
              label: loading
                ? t('system.notificationSimulateFields.loadingKinds', 'Loading kinds…')
                : t('system.notificationSimulateFields.pickAKind', '— pick a kind —'),
            },
            ...sensorKinds.map((k) => ({ value: k.kind, label: `${k.label} (${k.category})` })),
          ]}
          onChange={(e) => {
            const kind = sensorKinds.find((k) => k.kind === e.target.value)
            onPatch({
              sensorKind: kind?.kind ?? '',
              sourceDeviceId: kind?.source.deviceId ?? null,
            })
          }}
        />
        {!loading && sensorKinds.length === 0 && (
          <p className={HINT_CLASS}>
            {form.deviceId === null
              ? t(
                  'system.notificationSimulateFields.pickACameraFirstSensor',
                  'Pick a camera first — sensor and control kinds come from the devices linked to it.',
                )
              : t(
                  'system.notificationSimulateFields.thisCameraHasNoLinked',
                  'This camera has no linked sensor or control device, so it can produce no device event. Link one on the camera page first.',
                )}
          </p>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL_CLASS}>
            {t('system.notificationSimulateFields.sourceDevice', 'Source device')}
          </label>
          <Input
            type="number"
            value={form.sourceDeviceId === null ? '' : String(form.sourceDeviceId)}
            placeholder={t(
              'system.notificationSimulateFields.theCameraItself',
              'the camera itself',
            )}
            onChange={(e) =>
              onPatch({ sourceDeviceId: parseOptionalNumberInput(e.target.value) ?? null })
            }
          />
          <p className={HINT_CLASS}>
            {selected === undefined
              ? t(
                  'system.notificationSimulateFields.theLinkedDeviceWhoseState',
                  'The linked device whose state changed. Filled in for you when you pick a kind.',
                )
              : t(
                  'system.notificationSimulateFields.filledInFromContributedBy',
                  'Filled in from "{{label}}" — contributed by device #{{deviceId}} via the {{capName}} capability.',
                  {
                    label: selected.label,
                    deviceId: selected.source.deviceId,
                    capName: selected.source.capName,
                  },
                )}
          </p>
        </div>
        <div>
          <label className={LABEL_CLASS}>
            {t('system.notificationSimulateFields.eventTypeToken', 'Event type token')}
          </label>
          <Input
            value={form.eventType}
            placeholder={t(
              'system.notificationSimulateFields.pressPressLong',
              'press, press_long…',
            )}
            onChange={(e) => onPatch({ eventType: e.target.value })}
          />
          <p className={HINT_CLASS}>
            {t(
              'system.notificationSimulateFields.onlyEventEmitterSourcesCarry',
              'Only event-emitter sources carry one. A passive sensor emits none, and a rule gating on a token would fail closed for it.',
            )}
          </p>
        </div>
      </div>
    </>
  )
}

interface OccupancyFieldsProps extends SectionProps {
  readonly taxonomy: NcTaxonomy | undefined
}

function OccupancyFields({ form, cameras, taxonomy, onPatch }: OccupancyFieldsProps) {
  const { t } = useTranslation()
  const deviceIds = form.deviceId === null ? [] : [form.deviceId]
  // MACRO-ONLY, like the rule editor's occupancy class picker: the snapshot's
  // `byClass` is keyed on macros, so simulating a `car` edge would exercise a
  // scope the live watcher can never count.
  const classPicker = pickerForCondition('occupancy', taxonomy)
  const classOptions = classPicker === null ? [] : classPicker.groups.flatMap((g) => g.options)
  const occupancy = form.occupancy
  const patchOccupancy = (next: Partial<NcSimulateFormState['occupancy']>): void =>
    onPatch({ occupancy: { ...occupancy, ...next } })

  return (
    <>
      <div>
        <label className={LABEL_CLASS}>{t('system.notificationSimulateFields.zone', 'Zone')}</label>
        {/* One zone, not a set — an occupancy edge belongs to exactly one. The
            list picker is reused so the ids come from the camera's real zones. */}
        <ZoneListField
          deviceIds={deviceIds}
          cameras={cameras}
          value={occupancy.zoneId === '' ? [] : [occupancy.zoneId]}
          onChange={(next) => patchOccupancy({ zoneId: next[next.length - 1] ?? '' })}
        />
        <p className={HINT_CLASS}>
          {t(
            'system.notificationSimulateFields.leaveEmptyForTheWhole',
            'Leave empty for the whole frame.',
          )}
        </p>
      </div>
      <div className="max-w-[14rem]">
        <label className={LABEL_CLASS}>
          {t('system.notificationSimulateFields.class', 'Class')}
        </label>
        <Select
          value={occupancy.className}
          options={[
            { value: '', label: t('system.notificationSimulateFields.anyClass', '— any class —') },
            ...classOptions.map((o) => ({ value: o.value, label: o.label })),
          ]}
          onChange={(e) => patchOccupancy({ className: e.target.value })}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[11px] text-foreground-subtle">
          {t('system.notificationSimulateFields.countNow', 'Count now')}
          <Input
            type="number"
            min={0}
            className="w-20"
            value={String(occupancy.count)}
            onChange={(e) =>
              patchOccupancy({ count: parseOptionalNumberInput(e.target.value) ?? 0 })
            }
          />
        </label>
        <label className="text-[11px] text-foreground-subtle">
          {t('system.notificationSimulateFields.countBefore', 'Count before')}
          <Input
            type="number"
            min={0}
            className="w-20"
            value={String(occupancy.previousCount)}
            onChange={(e) =>
              patchOccupancy({ previousCount: parseOptionalNumberInput(e.target.value) ?? 0 })
            }
          />
        </label>
        <label className="text-[11px] text-foreground-subtle">
          {t('system.notificationSimulateFields.threshold', 'Threshold')}
          <Input
            type="number"
            min={1}
            className="w-20"
            value={String(occupancy.threshold)}
            onChange={(e) =>
              patchOccupancy({ threshold: parseOptionalNumberInput(e.target.value) ?? 1 })
            }
          />
        </label>
        <label className="flex items-center gap-2 pb-1 text-[11px] text-foreground">
          <Switch
            checked={occupancy.occupied}
            onCheckedChange={(next) => patchOccupancy({ occupied: next })}
            aria-label={t('system.notificationSimulateFields.occupiedLabel')}
          />
          {t('system.notificationSimulateFields.occupiedLabel', 'Occupied')}
        </label>
      </div>
    </>
  )
}

/** Crossing, bbox, timestamp and provenance — everything a rule can ask for but
 *  most simulations do not need. */
export function AdvancedSection({ form, cameras, onPatch }: SectionProps) {
  const { t } = useTranslation()
  const deviceIds = form.deviceId === null ? [] : [form.deviceId]
  return (
    <details className="rounded-md border border-border px-3 py-2">
      <summary className="cursor-pointer text-[11px] font-semibold text-foreground">
        {t('system.notificationSimulateFields.advanced', 'Advanced')}
      </summary>
      <div className="mt-2 space-y-3">
        {form.trigger === 'object-event' && (
          <div>
            <label className="flex items-center gap-2 text-[11px] font-medium text-foreground">
              <Switch
                checked={form.crossingEnabled}
                onCheckedChange={(next) => onPatch({ crossingEnabled: next })}
                aria-label={t('system.notificationSimulateFields.zoneCrossing', 'zone crossing')}
              />
              {t(
                'system.notificationSimulateFields.thisEventIsAConfirmed',
                'This event is a confirmed zone crossing',
              )}
            </label>
            {form.crossingEnabled && (
              <div className="mt-1 space-y-1.5">
                <div className="max-w-[12rem]">
                  <Select
                    value={form.crossingDirection}
                    options={[
                      {
                        value: 'enter',
                        label: t(
                          'system.notificationSimulateFields.enteredTheZone',
                          'Entered the zone',
                        ),
                      },
                      {
                        value: 'exit',
                        label: t('system.notificationSimulateFields.leftTheZone', 'Left the zone'),
                      },
                    ]}
                    onChange={(e) =>
                      onPatch({ crossingDirection: e.target.value === 'exit' ? 'exit' : 'enter' })
                    }
                  />
                </div>
                <ZoneListField
                  deviceIds={deviceIds}
                  cameras={cameras}
                  value={form.crossingZoneId === '' ? [] : [form.crossingZoneId]}
                  onChange={(next) => onPatch({ crossingZoneId: next[next.length - 1] ?? '' })}
                />
              </div>
            )}
          </div>
        )}

        <div>
          <label className="flex items-center gap-2 text-[11px] font-medium text-foreground">
            <Switch
              checked={form.bboxEnabled}
              onCheckedChange={(next) => onPatch({ bboxEnabled: next })}
              aria-label={t('system.notificationSimulateFields.boundingBox', 'bounding box')}
            />
            {t('system.notificationSimulateFields.carryABoundingBox', 'Carry a bounding box')}
          </label>
          <p className={HINT_CLASS}>
            {t(
              'system.notificationSimulateFields.normalized01TopLeft',
              'Normalized 0–1, top-left origin. Feeds the `customZones` condition and decides how the still is cropped or boxed.',
            )}
          </p>
          {form.bboxEnabled && (
            <div className="mt-1 flex flex-wrap gap-2">
              {(['x', 'y', 'w', 'h'] as const).map((axis) => (
                <label key={axis} className="text-[11px] text-foreground-subtle">
                  {axis}
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    className="w-20"
                    value={String(form.bbox[axis])}
                    onChange={(e) =>
                      onPatch({
                        bbox: {
                          ...form.bbox,
                          [axis]: parseOptionalNumberInput(e.target.value) ?? 0,
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL_CLASS}>
              {t('system.notificationSimulateFields.happenedAt', 'Happened at')}
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="datetime-local"
                value={form.timestampLocal}
                onChange={(e) => onPatch({ timestampLocal: e.target.value })}
              />
              {form.timestampLocal === '' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => onPatch({ timestampLocal: toLocalDateTimeValue(Date.now()) })}
                >
                  {t('system.notificationSimulateFields.set', 'Set')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => onPatch({ timestampLocal: '' })}
                >
                  {t('system.notificationSimulateFields.now', 'Now')}
                </Button>
              )}
            </div>
            <p className={HINT_CLASS}>
              {t(
                'system.notificationSimulateFields.emptyNowSetItTo',
                "Empty = now. Set it to a time inside (or outside) a rule's schedule window to test the schedule without waiting for the hour.",
              )}
            </p>
          </div>
          <div>
            <label className={LABEL_CLASS}>
              {t('system.notificationSimulateFields.detectionSource', 'Detection source')}
            </label>
            <Select
              value={form.source}
              options={[
                {
                  value: '',
                  label: t(
                    'system.notificationSimulateFields.unsetReadsAsPipeline',
                    '— unset (reads as pipeline) —',
                  ),
                },
                {
                  value: 'pipeline',
                  label: t('system.notificationSimulateFields.pipeline', 'Pipeline'),
                },
                {
                  value: 'onboard',
                  label: t('system.notificationSimulateFields.onboardCamera', 'Onboard (camera)'),
                },
                { value: 'sensor', label: t('system.notificationSimulateFields.sensor', 'Sensor') },
                { value: 'audio', label: t('system.notificationSimulateFields.audio', 'Audio') },
              ]}
              onChange={(e) => {
                const raw = e.target.value
                onPatch({
                  source:
                    raw === 'pipeline' || raw === 'onboard' || raw === 'sensor' || raw === 'audio'
                      ? raw
                      : '',
                })
              }}
            />
          </div>
        </div>
      </div>
    </details>
  )
}

interface RunSwitchProps {
  readonly checked: boolean
  readonly label: string
  readonly hint: string
  readonly danger?: boolean
  readonly onChange: (next: boolean) => void
}

export function RunSwitch({ checked, label, hint, danger = false, onChange }: RunSwitchProps) {
  const { t } = useTranslation()
  return (
    <div>
      <label className="flex items-center gap-2 text-[11px] font-medium text-foreground">
        <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
        {label}
        {danger && (
          <Badge variant="danger">
            {t('system.notificationSimulateFields.actuatesDevices', 'actuates devices')}
          </Badge>
        )}
      </label>
      <p className={HINT_CLASS}>{hint}</p>
    </div>
  )
}
