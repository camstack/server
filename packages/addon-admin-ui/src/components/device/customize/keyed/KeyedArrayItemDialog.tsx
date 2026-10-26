/**
 * Add or change one keyed-array item. Source device, field and transform are
 * the scalar dialog's steps; the item name, key and fixed traits come first.
 */
import type { CompositionSourceRef, DeviceInfo, KeyedArrayLiteral } from '@camstack/types'
import { evaluateExpressionSource } from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { itemKeyFromLabel } from '../item-key'
import {
  readPath,
  toPickerDevices,
  type PickerDevice,
  type WireableCatalog,
} from '../source-picker-model'
import { ScalarPreviewLine } from '../scalar/ScalarPreviewLine'
import type { ScalarPreview } from '../scalar/scalar-preview'
import type { ScalarTransformDraft } from '../scalar/scalar-form'
import { SourceSelector, type SourceFieldPick } from '../source-selector/SourceSelector'
import {
  defaultEnumMapping,
  defaultKeyedTransform,
  keyedItemFromForm,
  literalChoices,
  requiredLiteralPaths,
  statusOutputs,
  type KeyedFormSource,
} from './keyed-form'
import {
  keyedFieldFit,
  keyedFieldOffers,
  keyedTargetFields,
  keyedTraits,
  type KeyedFieldOffer,
  type KeyedFit,
} from './keyed-fit'

export interface KeyedDialogSeed {
  readonly key: string
  readonly label: string
  readonly fieldPath: string
  readonly literals: readonly KeyedArrayLiteral[]
  readonly source: KeyedFormSource
  readonly transform: ScalarTransformDraft
}

export interface KeyedArrayItemDialogProps {
  readonly open: boolean
  readonly mode: 'add' | 'change'
  readonly cap: string
  readonly targetId: string
  readonly host: DeviceInfo
  readonly target: CompositionSourceRef
  readonly apply: 'add' | 'replace'
  readonly seed: KeyedDialogSeed | null
  readonly canSave: boolean
  readonly onClose: () => void
  readonly onSave: (feature: NonNullable<ReturnType<typeof keyedItemFromForm>>, key: string) => void
}

const FIELD_LABEL: Readonly<Record<string, string>> = {
  level: 'customize.keyed.field.level',
  'remaining.value': 'customize.keyed.field.remaining',
  status: 'customize.keyed.field.status',
}

export function KeyedArrayItemDialog(props: KeyedArrayItemDialogProps): ReactNode {
  const { t } = useTranslation()
  const heading =
    props.mode === 'change' ? t('customize.keyed.changeTitle') : t('customize.keyed.addTitle')
  return (
    <Dialog open={props.open} onOpenChange={(next) => (next ? undefined : props.onClose())}>
      <DialogContent width="xl" placement="sheet-on-mobile" scroll="body" aria-label={heading}>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
        </DialogHeader>
        {props.open && <ItemForm {...props} heading={heading} />}
      </DialogContent>
    </Dialog>
  )
}

function ItemForm(props: KeyedArrayItemDialogProps & { readonly heading: string }): ReactNode {
  const { t, i18n } = useTranslation()
  const traits = keyedTraits(props.cap, props.targetId)
  const fields = keyedTargetFields(props.cap, props.targetId)
  const [label, setLabel] = useState(props.seed?.label ?? '')
  const [key, setKey] = useState(props.seed?.key ?? '')
  const [keyTouched, setKeyTouched] = useState(props.mode === 'change')
  const [fieldPath, setFieldPath] = useState(props.seed?.fieldPath ?? fields[0]?.path ?? '')
  const [traitValues, setTraitValues] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(
      traits.map((trait) => [
        trait.path,
        props.seed?.literals.find((literal) => literal.path === trait.path)?.value ??
          trait.defaultValue,
      ]),
    ),
  )
  const [unit, setUnit] = useState(
    props.seed?.literals.find((literal) => literal.path === 'remaining.kind')?.value ??
      literalChoices(props.cap, props.targetId, 'remaining.value', 'remaining.kind')[0] ??
      '',
  )
  const devices = useDeviceManagerListAll({ projection: 'slim' })
  const fleet = useMemo(
    () => (devices.status === 'success' ? toPickerDevices(devices.data) : []),
    [devices.status, devices.data],
  )
  const seeded = seedDevice(props.seed, fleet)
  const [device, setDevice] = useState<PickerDevice | null>(null)
  const [seededOnce, setSeededOnce] = useState(false)
  if (!seededOnce && seeded !== null) {
    setDevice(seeded)
    setSeededOnce(true)
  }
  const wireable = useDeviceManagerGetWireableFields({ deviceId: device?.id ?? 0 })
  const snapshot = useDeviceStateGetSnapshot({ deviceId: device?.id ?? 0 })
  const catalog: WireableCatalog = wireable.status === 'success' ? wireable.data : { caps: [] }
  const offers = keyedFieldOffers(catalog, snapshot.status === 'success' ? snapshot.data : null)
  const [fieldKey, setFieldKey] = useState<string | null>(
    props.seed === null ? null : `${props.seed.source.cap}.${props.seed.source.fieldPath}`,
  )
  const [transform, setTransform] = useState<ScalarTransformDraft>(
    props.seed?.transform ?? { kind: 'identity' },
  )
  const [mapping, setMapping] = useState<Readonly<Record<string, string | null>>>(() =>
    props.seed?.transform.kind === 'enum-map' ? props.seed.transform.mapping : {},
  )
  const selected = offers.find((offer) => `${offer.cap}.${offer.path}` === fieldKey) ?? null
  const fit =
    selected === null ? null : keyedFieldFit(props.cap, props.targetId, fieldPath, selected)
  const itemKey = keyTouched ? key : itemKeyFromLabel(label)
  const literals = formLiterals(props.cap, props.targetId, fieldPath, traitValues, unit)
  const source = formSource(device, selected, fit, mapping, transform)
  const feature =
    source === null
      ? null
      : keyedItemFromForm({
          cap: props.cap,
          targetId: props.targetId,
          device: props.target,
          apply: props.apply,
          key: itemKey,
          label,
          fieldPath,
          source,
          transform: source.transform,
          literals,
        })
  const preview = previewOf(
    feature,
    itemKey,
    fieldPath,
    selected,
    snapshot.status === 'success' ? snapshot.data : null,
  )
  const applyFieldPick = (pick: SourceFieldPick | null): void => {
    if (pick === null) {
      setFieldKey(null)
      return
    }
    const offer = offers.find((row) => row.cap === pick.cap && row.path === pick.path)
    if (offer === undefined) return
    const verdict = keyedFieldFit(props.cap, props.targetId, fieldPath, offer)
    pickOffer(offer, verdict)
  }
  const onLabel = (value: string): void => {
    setLabel(value)
    if (!keyTouched) setKey(itemKeyFromLabel(value))
  }
  return (
    <>
      <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
        <label className="flex flex-col gap-1 text-xs text-foreground">
          {t('customize.keyed.name')}
          <Input value={label} onChange={(event) => onLabel(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground">
          {t('customize.keyed.key')}
          <Input
            value={itemKey}
            disabled={props.mode === 'change'}
            onChange={(event) => {
              setKeyTouched(true)
              setKey(event.target.value)
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground">
          {t('customize.keyed.assignField')}
          <Select
            value={fieldPath}
            options={fields.map((field) => ({
              value: field.path,
              label: t(FIELD_LABEL[field.path] ?? field.path),
            }))}
            onChange={(event) => {
              setFieldPath(event.target.value)
              setDevice(null)
              setFieldKey(null)
              setTransform({ kind: 'identity' })
            }}
          />
        </label>
        {traits.map((trait) => (
          <label key={trait.path} className="flex flex-col gap-1 text-xs text-foreground">
            {t(`customize.keyed.trait.${trait.path}`)}
            <Select
              value={traitValues[trait.path] ?? trait.defaultValue}
              options={trait.values.map((value) => ({
                value,
                label: t(`customize.keyed.value.${value}`),
              }))}
              onChange={(event) =>
                setTraitValues((current) => ({ ...current, [trait.path]: event.target.value }))
              }
            />
          </label>
        ))}
        {requiredLiteralPaths(props.cap, props.targetId, fieldPath).map((path) => (
          <label key={path} className="flex flex-col gap-1 text-xs text-foreground">
            {t('customize.keyed.unit')}
            <Select
              value={unit}
              options={literalChoices(props.cap, props.targetId, fieldPath, path).map((value) => ({
                value,
                label: t(`customize.keyed.value.${value}`),
              }))}
              onChange={(event) => setUnit(event.target.value)}
            />
          </label>
        ))}
        <SourceSelector
          kind="keyed"
          enabled={props.open}
          hostId={props.host.id}
          fieldPath={fieldPath}
          destination={{
            cap: props.cap,
            targetId: props.targetId,
            fieldPath,
            title: t(FIELD_LABEL[fieldPath] ?? fieldPath),
          }}
          device={device}
          field={fieldPickOf(fieldKey)}
          transform={transform}
          onDeviceChange={(next) => {
            setDevice(next)
            setFieldKey(null)
            setTransform({ kind: 'identity' })
          }}
          onFieldChange={applyFieldPick}
          onTransformChange={setTransform}
        />
        {fit?.ok === true && fit.mode === 'enum' && selected !== null && (
          <EnumMapRows
            values={selected.enumValues}
            outputs={statusOutputs(props.cap, props.targetId, fieldPath)}
            mapping={mapping}
            onChange={setMapping}
          />
        )}
        {preview !== null && <ScalarPreviewLine preview={preview} />}
      </DialogBody>
      <DialogFooter className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={props.onClose}>
          {t('customize.scalar.cancel')}
        </Button>
        <Button
          data-testid="keyed-save-item"
          disabled={!props.canSave || feature === null || itemKey === ''}
          onClick={() => {
            if (feature !== null) props.onSave(feature, itemKey)
          }}
        >
          {t('customize.keyed.save')}
        </Button>
      </DialogFooter>
    </>
  )

  function pickOffer(offer: KeyedFieldOffer, verdict: KeyedFit): void {
    if (!verdict.ok) return
    setFieldKey(`${offer.cap}.${offer.path}`)
    if (verdict.mode === 'enum') {
      const next = defaultEnumMapping(
        offer.enumValues,
        statusOutputs(props.cap, props.targetId, fieldPath),
      )
      setMapping(next)
      setTransform({ kind: 'enum-map', mapping: { ...next } })
      return
    }
    setTransform(defaultKeyedTransform(verdict))
  }
}

function EnumMapRows(props: {
  readonly values: readonly string[]
  readonly outputs: readonly string[]
  readonly mapping: Readonly<Record<string, string | null>>
  readonly onChange: (mapping: Readonly<Record<string, string | null>>) => void
}): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1">
      {props.values.map((value) => (
        <label key={value} className="flex flex-wrap items-center gap-2 text-xs text-foreground">
          {value}
          <Select
            value={props.mapping[value] ?? ''}
            options={[
              { value: '', label: t('customize.keyed.unmapped') },
              ...props.outputs.map((output) => ({
                value: output,
                label: t(`customize.keyed.value.${output}`),
              })),
            ]}
            onChange={(event) =>
              props.onChange({
                ...props.mapping,
                [value]: event.target.value === '' ? null : event.target.value,
              })
            }
          />
        </label>
      ))}
    </div>
  )
}

function formLiterals(
  cap: string,
  targetId: string,
  fieldPath: string,
  traits: Readonly<Record<string, string>>,
  unit: string,
): readonly KeyedArrayLiteral[] {
  const fromTraits = Object.entries(traits).map(([path, value]) => ({ path, value }))
  const units = requiredLiteralPaths(cap, targetId, fieldPath).flatMap((path) =>
    unit === '' ? [] : [{ path, value: unit }],
  )
  return [...fromTraits, ...units]
}

function formSource(
  device: PickerDevice | null,
  offer: KeyedFieldOffer | null,
  fit: KeyedFit | null,
  mapping: Readonly<Record<string, string | null>>,
  transform: ScalarTransformDraft,
): (KeyedFormSource & { readonly transform: ScalarTransformDraft }) | null {
  if (device === null || offer === null || fit === null || !fit.ok) return null
  if (fit.mode === 'enum') {
    if (Object.keys(mapping).length === 0) return null
    return {
      addonId: device.addonId,
      stableId: device.stableId,
      cap: offer.cap,
      fieldPath: offer.path,
      valueKind: 'enum',
      transform: { kind: 'enum-map', mapping: { ...mapping } },
    }
  }
  return {
    addonId: device.addonId,
    stableId: device.stableId,
    cap: offer.cap,
    fieldPath: offer.path,
    valueKind: 'number',
    transform,
  }
}

function previewOf(
  feature: ReturnType<typeof keyedItemFromForm>,
  key: string,
  fieldPath: string,
  offer: KeyedFieldOffer | null,
  snapshot: Readonly<Record<string, Readonly<Record<string, unknown>>>> | null,
): ScalarPreview | { readonly kind: 'pending' } | null {
  if (feature === null || offer === null) return null
  const field = feature.items?.[key]?.fields[fieldPath]
  if (field === undefined) return { kind: 'failed', reason: 'compile' } // i18n-ignore: preview reason code
  if (snapshot === null) return { kind: 'pending' }
  const sourceValue = readPath(snapshot[offer.cap], offer.path)
  if (field.kind === 'from') return valueText(sourceValue)
  if (field.kind !== 'expression') return { kind: 'failed', reason: 'compile' } // i18n-ignore: preview reason code
  const bound = binding(sourceValue)
  if (bound === undefined) return { kind: 'failed', reason: 'no-value' } // i18n-ignore: preview reason code
  const evaluated = evaluateExpressionSource(field.expr, { x: bound }, Date.now())
  if (!evaluated.ok) return { kind: 'failed', reason: evaluated.error }
  return valueText(evaluated.value)
}

function valueText(
  value: unknown,
):
  | { readonly kind: 'value'; readonly text: string }
  | { readonly kind: 'failed'; readonly reason: string } {
  if (typeof value === 'number' && Number.isFinite(value))
    return { kind: 'value', text: String(value) }
  if (typeof value === 'string' && value.length > 0) return { kind: 'value', text: value }
  return { kind: 'failed', reason: 'empty' } // i18n-ignore: preview reason code
}

function binding(value: unknown): number | string | boolean | null | undefined {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (value === null) return null
  return undefined
}

function fieldPickOf(fieldKey: string | null): SourceFieldPick | null {
  if (fieldKey === null) return null
  const dot = fieldKey.indexOf('.')
  if (dot <= 0) return null
  return { cap: fieldKey.slice(0, dot), path: fieldKey.slice(dot + 1) }
}

function seedDevice(
  seed: KeyedDialogSeed | null,
  fleet: readonly PickerDevice[],
): PickerDevice | null {
  if (seed === null) return null
  return (
    fleet.find(
      (row) => row.addonId === seed.source.addonId && row.stableId === seed.source.stableId,
    ) ?? null
  )
}
