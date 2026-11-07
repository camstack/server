/**
 * Pick the device and value that feed a Customize extension (D944 §5). The left
 * column is the ui-library `DevicePicker`; Build-your-self helpers (D944 §3)
 * import this component next — they must not grow a second device list.
 */
import type { CameraSensorMode, CustomizeEventEdge } from '@camstack/types'
import {
  Button,
  type DeviceListState,
  DeviceName,
  DeviceValueField,
  Input,
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import { type ReactNode, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { SuggestedDevices } from '../assignments/SuggestedDevices'
import { useCapIndex } from '../assignments/use-cap-index'
import { keyedFieldFit, keyedFieldOffers } from '../keyed/keyed-fit'
import type { Known } from '../known'
import { ScalarTransformControls } from '../scalar/ScalarTransformControls'
import { fieldUnit, type ScalarFieldFit, scalarFieldFit } from '../scalar/scalar-fit'
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
import { siblingSuggestions } from './source-selector-siblings'

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
  /** The host's pre-save "would read" line (the transform applied); absent shows what the source reads now. */
  readonly preview?: ReactNode
  /** A suggestion for the transform, drawn right under its fields. */
  readonly proposal?: ReactNode
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
  readonly preview?: ReactNode
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
  readonly preview?: ReactNode
  /** A surface's own validity rule on the device list (keep it referentially stable). */
  readonly deviceFilter?: (device: PickerDevice) => boolean
  /** The host gives a definite height (a fill dialog): both columns take it and scroll on their own. */
  readonly fillHeight?: boolean
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
  const devices = useDeviceManagerListAll({ projection: 'slim' })
  const deviceFilter = props.kind === 'formula' ? props.deviceFilter : undefined
  const fleet = useMemo(() => {
    if (devices.status !== 'success') return []
    const all = toPickerDevices(devices.data)
    return deviceFilter === undefined ? all : all.filter(deviceFilter)
  }, [devices.status, devices.data, deviceFilter])
  const indexCaps = useMemo(() => indexCapsForDestination(props.destination), [props.destination])
  const capIndex = useCapIndex(indexCaps, props.enabled)
  const { compatible } = useMemo(() => {
    if (capIndex.kind !== 'known') {
      return { compatible: [] as SourceCandidateDevice[] }
    }
    return partitionSourceDevices(
      toCandidates(fleet, capIndex.value),
      props.destination,
      props.hostId,
    )
  }, [capIndex, fleet, props.destination, props.hostId])
  const siblings = useMemo(
    () =>
      capIndex.kind === 'known'
        ? siblingSuggestions(compatible, toCandidates(fleet, capIndex.value), props.hostId)
        : null,
    [capIndex, compatible, fleet, props.hostId],
  )
  const listState = listStateOf(devices.status, capIndex)
  const deviceId = props.device?.id ?? 0
  const wireable = useDeviceManagerGetWireableFields({ deviceId })
  const snapshot = useDeviceStateGetSnapshot({
    deviceId: props.device === null ? 0 : deviceId,
  })
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
  const { groups } = groupSourceValues(fields, props.destination, i18n.language)
  const fit = fieldFit(props, catalog, snapshot.status === 'success' ? snapshot.data : null)
  const pickDevice = (id: number | null): void => {
    if (id === null) {
      props.onDeviceChange(null)
      if (props.kind !== 'event') props.onFieldChange(null)
      return
    }
    // The picker reports the current row again when the list re-renders.
    // Clearing the field then drops a radio the operator just chose.
    if (props.device?.id !== id) {
      const next = fleet.find((row) => row.id === id) ?? null
      props.onDeviceChange(next)
      if (props.kind !== 'event') props.onFieldChange(null)
    }
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
  const compatibleDeviceItems = useMemo(() => compatiblePickerItems(compatible), [compatible])
  const fillHeight = props.kind === 'formula' && props.fillHeight === true
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

  const selectedFit =
    props.kind === 'scalar' || props.kind === 'keyed' ? (fit !== null && fit.ok ? fit : null) : null
  const transformControls =
    selectedFit !== null && (props.kind === 'scalar' || props.kind === 'keyed') ? (
      <ScalarTransformControls
        control={scalarControl(selectedFit.transforms)}
        transforms={selectedFit.transforms}
        declared={selectedFit.declared}
        unit={selectedFit.sourceUnit}
        value={props.transform}
        onChange={props.onTransformChange}
      />
    ) : null
  const transform =
    transformControls === null && eventParams === null ? undefined : (
      <>
        {transformControls}
        {eventParams}
      </>
    )
  const chosen = props.kind === 'event' ? null : props.field
  const chosenRow = groups
    .flatMap((g) => g.rows)
    .find((r) => r.cap === chosen?.cap && r.path === chosen.path)
  const preview =
    props.kind !== 'event' && props.preview !== undefined ? (
      props.preview
    ) : chosenRow === undefined ? undefined : (
      <p data-testid="source-preview-reads" className="text-[11px] text-foreground-muted">
        {t('customize.sourceSelector.sourceReads', { value: chosenRow.currentText })}
      </p>
    )
  return (
    <DeviceValueField
      testId="source-selector"
      deviceListTestId={devicePickerTestId}
      fillHeight={fillHeight}
      heading={t('customize.sourceSelector.pickDevice', { title: props.destination.title })}
      devices={compatibleDeviceItems}
      listState={listState}
      suggestions={
        devices.status !== 'error' && siblings !== null ? (
          <SuggestedDevices
            location={siblings.container}
            devices={siblings.devices.map((row) => ({
              id: row.id,
              name: row.name,
              container: null,
              detail: null,
            }))}
            action="use"
            onPick={(id) => pickDevice(id)}
          />
        ) : undefined
      }
      deviceId={props.device?.id ?? null}
      onDeviceChange={pickDevice}
      deviceLabel={
        props.device === null ? null : <DeviceName device={props.device} form="compact" />
      }
      backLabel={
        props.device === null
          ? ''
          : t('customize.sourceSelector.backToDevice', { name: props.device.name })
      }
      valuesState={valuesStateOf(wireable.status, snapshot.status)}
      groups={groups.map((group) => ({
        cap: group.cap,
        title: group.title,
        rows: group.rows.map((row) => ({
          cap: row.cap,
          path: row.path,
          label: row.label,
          valueText: row.currentText,
          fitText: compatibilityLabel(row.compatibility, t),
        })),
      }))}
      rowTestId={(row) => `source-value-${row.cap}.${row.path}`}
      value={chosen}
      onValueChange={(pick) => {
        if (props.kind === 'event') return
        props.onFieldChange(pick)
        if (props.kind === 'formula') return
        const nextFit = fieldFitForRow(
          props,
          catalog,
          snapshot.status === 'success' ? snapshot.data : null,
          pick.cap,
          pick.path,
        )
        if (nextFit !== null && nextFit.ok) props.onTransformChange(defaultScalarTransform(nextFit))
      }}
      valuesBefore={pickedList}
      valuesOverride={
        props.kind === 'event' ? (
          <DeclaredEventFields
            fields={declared === null ? [] : [declared]}
            language={i18n.language}
            emptyLabel={t('customize.sourceSelector.noStateField')}
          />
        ) : undefined
      }
      transform={transform}
      proposal={props.kind === 'scalar' ? props.proposal : undefined}
      alwaysShowPreview={props.kind === 'event'}
      preview={preview}
      noDeviceText={t('customize.sourceSelector.noDevice')}
      noValuesText={t('customize.sourceSelector.noStateField')}
    />
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
    const offers = keyedFieldOffers(catalog, snapshot)
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
        unit: fieldUnit(readUnit(snapshot, entry.cap), entry.cap, f.path),
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

/**
 * A unit comes from the snapshot, so a value is judged only once both reads answered: an unread
 * snapshot is loading, a failed one is failed — never "no value fits" (D315).
 */
function valuesStateOf(
  wireable: 'pending' | 'error' | 'success',
  snapshot: 'pending' | 'error' | 'success',
): 'loading' | 'failed' | 'ready' {
  if (wireable === 'error' || snapshot === 'error') return 'failed'
  return wireable === 'success' && snapshot === 'success' ? 'ready' : 'loading'
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
