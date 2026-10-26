/**
 * Pick the device and value that feed a Customize extension (D944 §5). The left
 * column is the ui-library `DevicePicker`; Build-your-self helpers (D944 §3)
 * import this component next — they must not grow a second device list.
 */
import type { CameraSensorMode, CustomizeEventEdge } from '@camstack/types'
import {
  Button,
  type DeviceListState,
  DevicePicker,
  ErrorBox,
  Input,
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import { ChevronDown } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCapIndex } from '../assignments/use-cap-index'
import { keyedFieldFit } from '../keyed/keyed-fit'
import type { Known } from '../known'
import { ScalarTransformControls } from '../scalar/ScalarTransformControls'
import { type ScalarFieldFit, scalarFieldFit } from '../scalar/scalar-fit'
import {
  defaultScalarTransform,
  type ScalarTransformDraft,
  scalarControl,
} from '../scalar/scalar-form'
import { type PickerDevice, toPickerDevices, type WireableCatalog } from '../source-picker-model'

type DeviceSnapshot = Readonly<Record<string, Readonly<Record<string, unknown>>>>

import { ModeLine } from '../event/event-mode-line'
import { vocabularyCapTitle, vocabularyFieldLabel } from '../vocabulary-field-label'
import { SourceSelectorMembers, type SourceSelectorMembersProps } from './SourceSelectorMembers'
import {
  type EventPickedRow,
  removeEventPick,
  syncDeclaredEventPick,
  updateEventPickMode,
} from './source-selector-event-add'
import { EventEdgeField, NumberSecondsField } from './source-selector-event-params'
import { wireableFieldsForDestination } from './source-selector-fields'
import {
  groupSourceValues,
  indexCapsForDestination,
  partitionSourceDevices,
  type SourceCandidateDevice,
  type SourceCompatibility,
  type SourceDestination,
  type SourceWireableField,
} from './source-selector-model'
import { compatiblePickerItems } from './source-selector-parent-detail'

export type { EventPickedRow }

export interface SourceFieldPick {
  readonly cap: string
  readonly path: string
}

export interface SourceSelectorScalarProps {
  readonly kind: 'scalar'
  readonly destination: SourceDestination
  readonly hostId: number
  readonly enabled: boolean
  readonly device: PickerDevice | null
  readonly field: SourceFieldPick | null
  readonly transform: ScalarTransformDraft
  readonly onDeviceChange: (device: PickerDevice | null) => void
  readonly onFieldChange: (field: SourceFieldPick | null) => void
  readonly onTransformChange: (next: ScalarTransformDraft) => void
}

export interface SourceSelectorKeyedProps {
  readonly kind: 'keyed'
  readonly destination: SourceDestination
  readonly hostId: number
  readonly enabled: boolean
  readonly device: PickerDevice | null
  readonly field: SourceFieldPick | null
  readonly fieldPath: string
  readonly transform: ScalarTransformDraft
  readonly onDeviceChange: (device: PickerDevice | null) => void
  readonly onFieldChange: (field: SourceFieldPick | null) => void
  readonly onTransformChange: (next: ScalarTransformDraft) => void
}

export interface SourceSelectorFormulaProps {
  readonly kind: 'formula'
  readonly destination: SourceDestination
  readonly hostId: number
  readonly enabled: boolean
  readonly device: PickerDevice | null
  readonly field: SourceFieldPick | null
  readonly onDeviceChange: (device: PickerDevice | null) => void
  readonly onFieldChange: (field: SourceFieldPick | null) => void
}

export interface SourceSelectorEventProps {
  readonly kind: 'event'
  readonly shape: 'pulse' | 'span'
  readonly destination: SourceDestination
  readonly hostId: number
  readonly enabled: boolean
  readonly devicePickerTestId: string
  readonly device: PickerDevice | null
  readonly picked: readonly EventPickedRow[]
  readonly onDeviceChange: (device: PickerDevice | null) => void
  readonly onPickedChange: (rows: readonly EventPickedRow[]) => void
  readonly edges: readonly CustomizeEventEdge[]
  readonly edge: CustomizeEventEdge
  readonly onEdgeChange: (edge: CustomizeEventEdge) => void
  readonly debounceSec: number
  readonly onDebounceSecChange: (seconds: number) => void
  readonly sourceModes: readonly CameraSensorMode[]
  readonly timeoutSec: number
  readonly onTimeoutSecChange: (seconds: number) => void
  readonly cooldownSec: number | null
  readonly onCooldownSecChange: (seconds: number) => void
}

export type SourceSelectorProps =
  | SourceSelectorScalarProps
  | SourceSelectorKeyedProps
  | SourceSelectorFormulaProps
  | SourceSelectorEventProps
  | SourceSelectorMembersProps

type SingleSelectorProps = Exclude<SourceSelectorProps, SourceSelectorMembersProps>

function listStateOf(
  devices: 'pending' | 'error' | 'success',
  capIndex: Known<ReadonlyMap<number, readonly string[]>>,
): DeviceListState {
  if (devices === 'pending' || capIndex.kind === 'pending') return 'pending'
  if (devices === 'error') return 'failed'
  return 'answered'
}

function toCandidates(
  fleet: readonly PickerDevice[],
  capIndex: ReadonlyMap<number, readonly string[]>,
): readonly SourceCandidateDevice[] {
  return fleet.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    location: row.location,
    parentDeviceId: row.parentDeviceId,
    addonId: row.addonId,
    stableId: row.stableId,
    caps: capIndex.get(row.id) ?? [],
  }))
}

function compatibilityLabel(
  compatibility: SourceCompatibility,
  t: (key: string, opts?: Record<string, string>) => string,
): string {
  if (compatibility.kind === 'direct') return t('customize.sourceSelector.direct')
  if (compatibility.kind === 'conversion') {
    return t('customize.sourceSelector.withConversion', {
      name: t(`customize.scalar.transform.${conversionKey(compatibility.name)}`),
    })
  }
  return ''
}

function conversionKey(name: 'threshold' | 'scale' | 'invert' | 'enum-map'): string {
  if (name === 'scale') return 'linear'
  if (name === 'enum-map') return 'enumMap'
  return name
}

export function SourceSelector(props: SourceSelectorProps): ReactNode {
  if (props.kind === 'members') return <SourceSelectorMembers {...props} />
  return <SourceSelectorSingle {...props} />
}

function SourceSelectorSingle(props: SingleSelectorProps): ReactNode {
  const { t, i18n } = useTranslation()
  const [mobileStep, setMobileStep] = useState<'device' | 'value'>('device')
  const [incompatibleOpen, setIncompatibleOpen] = useState(false)
  const [incompatibleValuesOpen, setIncompatibleValuesOpen] = useState(false)
  const devices = useDeviceManagerListAll({ projection: 'slim' })
  const fleet = useMemo(
    () => (devices.status === 'success' ? toPickerDevices(devices.data) : []),
    [devices.status, devices.data],
  )
  const indexCaps = useMemo(() => indexCapsForDestination(props.destination), [props.destination])
  const capIndex = useCapIndex(indexCaps, props.enabled)
  const { compatible, incompatible } = useMemo(() => {
    if (capIndex.kind !== 'known') {
      return {
        compatible: [] as SourceCandidateDevice[],
        incompatible: [] as SourceCandidateDevice[],
      }
    }
    return partitionSourceDevices(
      toCandidates(fleet, capIndex.value),
      props.destination,
      props.hostId,
    )
  }, [capIndex, fleet, props.destination, props.hostId])
  const listState = listStateOf(devices.status, capIndex)
  const deviceId = props.device?.id ?? 0
  const wireable = useDeviceManagerGetWireableFields({ deviceId })
  const snapshot = useDeviceStateGetSnapshot({ deviceId: props.device === null ? 0 : deviceId })
  const catalog: WireableCatalog = wireable.status === 'success' ? wireable.data : { caps: [] }
  const eventShape = props.kind === 'event' ? props.shape : null
  const fields = wireableFieldsForDestination(
    props.destination,
    catalog,
    snapshot.status === 'success',
    snapshot.status === 'success' ? snapshot.data : null,
    props.device,
    eventShape,
  )
  const devicePickerTestId =
    props.kind === 'event' ? props.devicePickerTestId : 'source-selector-device-picker'
  const { groups, incompatible: incompatibleValues } = groupSourceValues(
    fields,
    props.destination,
    i18n.language,
  )
  const fit = fieldFit(props, catalog, snapshot.status === 'success' ? snapshot.data : null)
  const pickDevice = (ids: readonly number[]): void => {
    const id = ids[0]
    if (id === undefined) {
      props.onDeviceChange(null)
      if (props.kind !== 'event') props.onFieldChange(null)
      return
    }
    // The picker reports the current row again when the list re-renders.
    // Clearing the field then drops a radio the operator just chose.
    if (props.device?.id === id) return
    const next = fleet.find((row) => row.id === id) ?? null
    props.onDeviceChange(next)
    if (props.kind !== 'event') props.onFieldChange(null)
    setMobileStep('value')
  }
  const declared = props.kind === 'event' ? (fields[0] ?? null) : null
  const eventBinding = props.kind === 'event' ? props : null
  useEffect(() => {
    if (eventBinding === null || eventBinding.device === null || declared === null) return
    const next = syncDeclaredEventPick(
      eventBinding.picked,
      eventBinding.device,
      { cap: declared.cap, path: declared.path },
      eventBinding.shape,
      eventBinding.sourceModes[0] ?? 'in-addition',
    )
    if (next !== null) eventBinding.onPickedChange(next)
  }, [eventBinding, declared])
  const compatibleDeviceItems = useMemo(
    () => compatiblePickerItems(compatible, fleet),
    [compatible, fleet],
  )
  const deviceColumn = (
    <div className="flex max-h-72 min-h-0 flex-col gap-2 overflow-y-auto sm:max-h-[min(24rem,60vh)]">
      <h3 className="text-[11px] font-medium text-foreground-muted">
        {t('customize.sourceSelector.pickDevice', { title: props.destination.title })}
      </h3>
      {devices.status === 'error' ? (
        <ErrorBox
          title={t('customize.picker.devicesFailed')}
          message={devices.error?.message ?? ''}
        />
      ) : (
        <DevicePicker
          devices={compatibleDeviceItems}
          listState={listState}
          value={props.device === null ? [] : [props.device.id]}
          selection="single"
          groupBy="location"
          onChange={pickDevice}
          noun="device"
          showAll
          testId={devicePickerTestId}
        />
      )}
      {incompatible.length > 0 && (
        <div data-testid="source-incompatible-devices">
          <Button
            variant="ghost"
            size="sm"
            className="h-auto w-full justify-start gap-1 px-0 text-[11px] text-foreground-muted"
            onClick={() => setIncompatibleOpen((open) => !open)}
          >
            <ChevronDown
              className={`size-3 transition-transform ${incompatibleOpen ? 'rotate-180' : ''}`}
            />
            {t('customize.sourceSelector.notCompatibleDevices', { count: incompatible.length })}
          </Button>
          {incompatibleOpen && (
            <ul className="mt-1 flex flex-col gap-0.5 pl-4 text-[11px] text-foreground-subtle">
              {incompatible.map((row) => (
                <li key={row.id}>{row.name}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
  const pickedList =
    props.kind === 'event' && props.picked.length > 0 ? (
      <ul data-testid="source-picked-list" className="flex flex-col gap-2">
        {props.picked.map((row) => (
          <li
            key={`${row.addonId}/${row.stableId}/${row.cap}.${row.fieldPath}`}
            className="flex flex-col gap-1 text-xs"
          >
            <span className="text-foreground">
              {row.deviceName} · {vocabularyFieldLabel(row.cap, row.fieldPath, i18n.language)}
            </span>
            {props.shape === 'span' && row.mode !== undefined && (
              <ModeLine
                mode={row.mode}
                modes={props.sourceModes}
                name={row.stableId}
                onChange={(mode) =>
                  props.onPickedChange(updateEventPickMode(props.picked, row, mode))
                }
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => props.onPickedChange(removeEventPick(props.picked, row))}
            >
              {t('customize.event.clear')}
            </Button>
          </li>
        ))}
      </ul>
    ) : null

  const eventParams =
    props.kind === 'event' ? (
      <div className="flex flex-col gap-2">
        {props.shape === 'pulse' && (
          <>
            <EventEdgeField edges={props.edges} edge={props.edge} onChange={props.onEdgeChange} />
            <label className="flex flex-col gap-1 text-[11px] text-foreground">
              {t('customize.event.debounce')}
              <Input
                type="number"
                aria-label={t('customize.event.debounce')}
                value={Number.isFinite(props.debounceSec) ? props.debounceSec : 0}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (Number.isFinite(next) && next >= 0) props.onDebounceSecChange(next)
                }}
              />
            </label>
          </>
        )}
        {props.shape === 'span' && (
          <>
            <NumberSecondsField
              label={t('customize.event.timeout')}
              value={props.timeoutSec}
              onChange={props.onTimeoutSecChange}
            />
            {props.cooldownSec !== null && (
              <NumberSecondsField
                label={t('customize.event.cooldown')}
                value={props.cooldownSec}
                onChange={props.onCooldownSecChange}
              />
            )}
          </>
        )}
      </div>
    ) : null

  const valueColumn = (
    <div className="flex min-h-0 flex-col gap-2">
      {pickedList}
      {props.device !== null && (
        <h3 className="text-[11px] font-medium text-foreground">{props.device.name}</h3>
      )}
      {props.device === null ? (
        <p className="text-[11px] text-foreground-subtle">
          {t('customize.sourceSelector.noDevice')}
        </p>
      ) : wireable.status === 'pending' ? (
        <p role="status" className="text-[11px] text-foreground-subtle">
          {t('customize.picker.loadingFields')}
        </p>
      ) : wireable.status === 'error' ? (
        <ErrorBox
          title={t('customize.picker.fieldsFailed')}
          message={wireable.error?.message ?? ''}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {props.kind === 'event' ? (
            <DeclaredEventFields
              fields={declared === null ? [] : [declared]}
              language={i18n.language}
              emptyLabel={t('customize.sourceSelector.noStateField')}
            />
          ) : null}
          {props.kind !== 'event' &&
            groups.map((group) => (
              <section key={group.cap} aria-label={group.title}>
                <h4 className="text-[10px] font-medium uppercase tracking-wide text-foreground-muted">
                  {group.title}
                </h4>
                <ul className="mt-1 flex flex-col gap-1">
                  {group.rows.map((row) => {
                    const selected = props.field?.cap === row.cap && props.field.path === row.path
                    return (
                      <li key={`${row.cap}.${row.path}`}>
                        <label className="flex flex-wrap items-center gap-2 text-[11px] text-foreground">
                          <input
                            type="radio"
                            name="source-value"
                            checked={selected}
                            data-testid={`source-value-${row.cap}.${row.path}`}
                            onChange={() => {
                              props.onFieldChange({ cap: row.cap, path: row.path })
                              if (props.kind === 'formula') return
                              const nextFit = fieldFitForRow(
                                props,
                                catalog,
                                snapshot.status === 'success' ? snapshot.data : null,
                                row.cap,
                                row.path,
                              )
                              if (nextFit !== null && nextFit.ok) {
                                props.onTransformChange(defaultScalarTransform(nextFit))
                              }
                            }}
                          />
                          <span>{row.label}</span>
                          <span className="text-foreground-muted">{row.currentText}</span>
                          <span className="text-foreground-subtle">
                            {compatibilityLabel(row.compatibility, t)}
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          {props.kind !== 'event' && incompatibleValues.length > 0 && (
            <div data-testid="source-incompatible-values">
              <Button
                variant="ghost"
                size="sm"
                className="h-auto w-full justify-start gap-1 px-0 text-[11px] text-foreground-muted"
                onClick={() => setIncompatibleValuesOpen((open) => !open)}
              >
                <ChevronDown
                  className={`size-3 transition-transform ${incompatibleValuesOpen ? 'rotate-180' : ''}`}
                />
                {t('customize.sourceSelector.otherValues')}
              </Button>
              {incompatibleValuesOpen && (
                <ul className="mt-1 flex flex-col gap-1 pl-4 text-[11px] text-foreground-subtle">
                  {incompatibleValues.map((row) => (
                    <li key={`${row.cap}.${row.path}`}>
                      {row.label} · {row.currentText}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      {props.kind === 'scalar' && fit !== null && fit.ok && (
        <ScalarTransformControls
          control={scalarControl(fit.transforms)}
          transforms={fit.transforms}
          declared={fit.declared}
          unit={fit.sourceUnit}
          value={props.transform}
          onChange={props.onTransformChange}
        />
      )}
      {props.kind === 'keyed' && fit !== null && fit.ok && props.field !== null && (
        <ScalarTransformControls
          control={scalarControl(fit.transforms)}
          transforms={fit.transforms}
          declared={fit.declared}
          unit={fit.sourceUnit}
          value={props.transform}
          onChange={props.onTransformChange}
        />
      )}
      {eventParams}
    </div>
  )
  return (
    <div
      data-testid="source-selector"
      className="flex flex-col gap-3 sm:grid sm:grid-cols-2 sm:gap-4"
    >
      <div className={mobileStep === 'value' ? 'hidden sm:block' : undefined}>{deviceColumn}</div>
      <div className={mobileStep === 'device' ? 'hidden sm:block' : undefined}>
        {mobileStep === 'value' && (
          <Button
            variant="ghost"
            size="sm"
            className="mb-2 sm:hidden"
            onClick={() => setMobileStep('device')}
          >
            {t('customize.sourceSelector.backToDevices')}
          </Button>
        )}
        {valueColumn}
      </div>
    </div>
  )
}

function fieldFitForRow(
  props: SourceSelectorScalarProps | SourceSelectorKeyedProps,
  catalog: WireableCatalog,
  snapshot: DeviceSnapshot | null,
  cap: string,
  path: string,
): ScalarFieldFit | null {
  if (props.kind === 'keyed') {
    const offers = catalog.caps.flatMap((entry) =>
      entry.fields
        .filter((f) => f.item !== true)
        .map((f) => ({
          cap: entry.cap,
          path: f.path,
          kind: f.kind,
          unit: readUnit(snapshot, entry.cap),
          enumValues: f.enumValues ?? [],
        })),
    )
    const offer = offers.find((row) => row.cap === cap && row.path === path)
    if (offer === undefined) return null
    const verdict = keyedFieldFit(
      props.destination.cap,
      props.destination.targetId,
      props.fieldPath,
      offer,
    )
    if (!verdict.ok || verdict.mode !== 'scalar') return null
    return verdict.fit
  }
  const scalarOffers = catalog.caps.flatMap((entry) =>
    entry.fields
      .filter((f) => f.item !== true)
      .map((f) => ({
        cap: entry.cap,
        path: f.path,
        kind: f.kind,
        unit: readUnit(snapshot, entry.cap),
      })),
  )
  const offer = scalarOffers.find(
    (row) =>
      row.cap === cap &&
      row.path === path &&
      (row.kind === 'boolean' || row.kind === 'number' || row.kind === 'string'),
  )
  if (offer === undefined) return null
  const verdict = scalarFieldFit(props.destination.cap, props.destination.targetId, offer)
  if (!verdict.ok) return null
  return verdict
}

function fieldFit(
  props: SingleSelectorProps,
  catalog: WireableCatalog,
  snapshot: DeviceSnapshot | null,
): ScalarFieldFit | null {
  if (props.kind === 'formula' || props.kind === 'event') return null
  if (props.device === null || props.field === null) return null
  return fieldFitForRow(props, catalog, snapshot, props.field.cap, props.field.path)
}

function readUnit(snapshot: DeviceSnapshot | null, cap: string): string | null {
  if (snapshot === null) return null
  const unit = snapshot[cap]?.unit
  return typeof unit === 'string' && unit.length > 0 ? unit : null
}

interface DeclaredEventFieldsProps {
  readonly fields: readonly SourceWireableField[]
  readonly language: string
  readonly emptyLabel: string
}

/** An event source is the device's declared on/off — shown, not chosen. */
function DeclaredEventFields({
  fields,
  language,
  emptyLabel,
}: DeclaredEventFieldsProps): ReactNode {
  if (fields.length === 0) {
    return <p className="text-[11px] text-foreground-subtle">{emptyLabel}</p>
  }
  return (
    <ul className="flex flex-col gap-1">
      {fields.map((field) => (
        <li
          key={`${field.cap}.${field.path}`}
          data-testid="source-declared-field"
          className="text-[11px] text-foreground"
        >
          <span className="font-medium">{vocabularyCapTitle(field.cap, language)}</span>
          {' · '}
          {vocabularyFieldLabel(field.cap, field.path, language)}{' '}
          <span className="text-foreground-muted">{field.currentText}</span>
        </li>
      ))}
    </ul>
  )
}
