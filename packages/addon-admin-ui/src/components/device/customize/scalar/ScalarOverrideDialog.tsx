/**
 * Add or change one scalar override via the shared source selector (D944 §5).
 */
import type { CompositionFieldsFeature, CompositionSourceRef, DeviceInfo } from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SourceSelector } from '../source-selector/SourceSelector'
import {
  readPath,
  toPickerDevices,
  type PickerDevice,
  type WireableCatalog,
} from '../source-picker-model'
import { ScalarPreviewLine } from './ScalarPreviewLine'
import { scalarFieldFit, scalarFieldOffers, type ScalarFieldOffer } from './scalar-fit'
import {
  scalarFeatureFromForm,
  type ScalarFormSource,
  type ScalarTransformDraft,
} from './scalar-form'
import { previewScalarOverride } from './scalar-preview'

export interface ScalarDialogSeed {
  readonly source: ScalarFormSource
  readonly transform: ScalarTransformDraft
}

export interface ScalarOverrideDialogProps {
  readonly open: boolean
  readonly mode: 'add' | 'change'
  readonly title: string
  readonly cap: string
  readonly targetId: string
  readonly host: DeviceInfo
  readonly target: CompositionSourceRef
  readonly apply: 'add' | 'replace'
  readonly seed: ScalarDialogSeed | null
  readonly canSave: boolean
  readonly onClose: () => void
  readonly onSave: (feature: CompositionFieldsFeature) => void
}

export function ScalarOverrideDialog(props: ScalarOverrideDialogProps): ReactNode {
  const { t } = useTranslation()
  const heading =
    props.mode === 'change'
      ? t('customize.scalar.changeTitle', { title: props.title })
      : t('customize.scalar.addTitle', { title: props.title })
  return (
    <Dialog open={props.open} onOpenChange={(next) => (next ? undefined : props.onClose())}>
      <DialogContent width="xl" placement="sheet-on-mobile" scroll="body" aria-label={heading}>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
        </DialogHeader>
        {props.open && <DialogForm {...props} heading={heading} />}
      </DialogContent>
    </Dialog>
  )
}

function DialogForm(props: ScalarOverrideDialogProps & { readonly heading: string }): ReactNode {
  const { t } = useTranslation()
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
  const offers = scalarFieldOffers(catalog, snapshot.status === 'success' ? snapshot.data : null)
  const [fieldKey, setFieldKey] = useState<string | null>(seedFieldKey(props.seed))
  const [transform, setTransform] = useState<ScalarTransformDraft>(
    props.seed?.transform ?? { kind: 'identity' },
  )
  const fieldPick =
    fieldKey === null
      ? null
      : (() => {
          const [cap, path] = fieldKey.split('.')
          if (cap === undefined || path === undefined) return null
          return { cap, path }
        })()
  const selected = offers.find((offer) => fieldId(offer) === fieldKey) ?? null
  const fit = selected === null ? null : scalarFieldFit(props.cap, props.targetId, selected)
  const source =
    selected === null || fit === null || !fit.ok ? null : formSource(device, selected, fit, catalog)
  const feature =
    source === null
      ? null
      : scalarFeatureFromForm({
          cap: props.cap,
          targetId: props.targetId,
          device: props.target,
          apply: props.apply,
          source,
          transform,
        })
  const sourceValue =
    selected === null || snapshot.status !== 'success' || device === null
      ? undefined
      : readPath(snapshot.data[selected.cap], selected.path)
  const preview =
    source === null
      ? null
      : snapshot.status === 'pending'
        ? ({ kind: 'pending' } as const)
        : previewScalarOverride({
            cap: props.cap,
            targetId: props.targetId,
            device: props.target,
            apply: props.apply,
            source,
            transform,
            sourceValue,
            nowMs: Date.now(),
          })
  return (
    <>
      <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
        <SourceSelector
          kind="scalar"
          enabled={props.open}
          hostId={props.host.id}
          destination={{
            cap: props.cap,
            targetId: props.targetId,
            title: props.title,
          }}
          device={device}
          field={fieldPick}
          transform={transform}
          onDeviceChange={(next) => {
            setDevice(next)
            setFieldKey(null)
            setTransform({ kind: 'identity' })
          }}
          onFieldChange={(next) => {
            if (next === null) {
              setFieldKey(null)
              return
            }
            setFieldKey(`${next.cap}.${next.path}`)
          }}
          onTransformChange={setTransform}
        />
        {preview !== null && <ScalarPreviewLine preview={preview} />}
      </DialogBody>
      <DialogFooter className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={props.onClose}>
          {t('customize.scalar.cancel')}
        </Button>
        <Button
          data-testid="scalar-save-override"
          disabled={!props.canSave || feature === null}
          onClick={() => {
            if (feature !== null) props.onSave(feature)
          }}
        >
          {t('customize.scalar.save')}
        </Button>
      </DialogFooter>
    </>
  )
}

function fieldId(offer: ScalarFieldOffer): string {
  return `${offer.cap}.${offer.path}`
}

function formSource(
  device: PickerDevice | null,
  offer: ScalarFieldOffer,
  fit: { readonly sourceUnit: string | null },
  catalog: WireableCatalog,
): ScalarFormSource | null {
  if (device === null) return null
  if (offer.kind !== 'boolean' && offer.kind !== 'number' && offer.kind !== 'string') return null
  const cap = catalog.caps.find((entry) => entry.cap === offer.cap)
  const changedAt =
    offer.kind === 'boolean' && cap?.fields.some((field) => field.path === 'lastChangedAt')
      ? 'lastChangedAt'
      : null
  return {
    addonId: device.addonId,
    stableId: device.stableId,
    cap: offer.cap,
    fieldPath: offer.path,
    valueKind: offer.kind,
    sourceUnit: fit.sourceUnit,
    changedAtField: changedAt,
  }
}

function seedDevice(
  seed: ScalarDialogSeed | null,
  fleet: readonly PickerDevice[],
): PickerDevice | null {
  if (seed === null) return null
  return (
    fleet.find(
      (row) => row.addonId === seed.source.addonId && row.stableId === seed.source.stableId,
    ) ?? null
  )
}

function seedFieldKey(seed: ScalarDialogSeed | null): string | null {
  if (seed === null) return null
  return `${seed.source.cap}.${seed.source.fieldPath}`
}
