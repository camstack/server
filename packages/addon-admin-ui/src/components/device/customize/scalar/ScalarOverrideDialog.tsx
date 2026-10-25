/**
 * Add or change one scalar override: one source device, a compatible field,
 * declaration transforms, and a live preview. Same-room devices share a
 * location group in the picker and nothing is preselected.
 */
import type { CompositionFieldsFeature, CompositionSourceRef, DeviceInfo } from '@camstack/types'
import {
  Button,
  DevicePicker,
  type DeviceListState,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  type PickerItem,
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  readPath,
  toPickerDevices,
  type PickerDevice,
  type WireableCatalog,
} from '../source-picker-model'
import { ScalarPreviewLine } from './ScalarPreviewLine'
import { ScalarTransformControls } from './ScalarTransformControls'
import { scalarFitReasonI18nKey } from './scalar-reason'
import {
  scalarFieldFit,
  scalarFieldOffers,
  type ScalarFieldFit,
  type ScalarFieldOffer,
} from './scalar-fit'
import {
  defaultScalarTransform,
  scalarControl,
  scalarFeatureFromForm,
  type ScalarFormSource,
  type ScalarTransformDraft,
} from './scalar-form'
import { previewScalarOverride } from './scalar-preview'
import { vocabularyFieldLabel } from '../vocabulary-field-label'

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

function listStateOf(status: 'pending' | 'error' | 'success'): DeviceListState {
  if (status === 'pending') return 'pending'
  if (status === 'error') return 'failed'
  return 'answered'
}

export function ScalarOverrideDialog(props: ScalarOverrideDialogProps): ReactNode {
  const { t } = useTranslation()
  const heading =
    props.mode === 'change'
      ? t('customize.scalar.changeTitle', { title: props.title })
      : t('customize.scalar.addTitle', { title: props.title })
  return (
    <Dialog open={props.open} onOpenChange={(next) => (next ? undefined : props.onClose())}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body" aria-label={heading}>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
        </DialogHeader>
        {props.open && <DialogForm {...props} heading={heading} />}
      </DialogContent>
    </Dialog>
  )
}

function DialogForm(props: ScalarOverrideDialogProps & { readonly heading: string }): ReactNode {
  const { t, i18n } = useTranslation()
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
  const room =
    typeof props.host.location === 'string' && props.host.location.length > 0
      ? props.host.location
      : null
  const pickDevice = (id: number): void => {
    const next = fleet.find((row) => row.id === id)
    if (next === undefined) return
    setDevice(next)
    setFieldKey(null)
    setTransform({ kind: 'identity' })
  }
  const pickField = (offer: ScalarFieldOffer): void => {
    const nextFit = scalarFieldFit(props.cap, props.targetId, offer)
    if (!nextFit.ok) return
    setFieldKey(fieldId(offer))
    setTransform(defaultScalarTransform(nextFit))
  }
  return (
    <>
      <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
        <section className="flex flex-col gap-1" aria-label={t('customize.scalar.stepDevice')}>
          <h3 className="text-[11px] font-medium text-foreground-muted">
            {t('customize.scalar.stepDevice')}
          </h3>
          {device !== null ? (
            <p className="flex flex-wrap items-center gap-2 text-xs text-foreground">
              {device.name}
              <Button variant="ghost" size="sm" onClick={() => setDevice(null)}>
                {t('customize.scalar.changeDevice')}
              </Button>
            </p>
          ) : (
            <>
              {devices.status === 'error' ? (
                <ErrorBox
                  title={t('customize.picker.devicesFailed')}
                  message={devices.error?.message ?? ''}
                />
              ) : (
                <DevicePicker
                  devices={pickerItems(fleet, props.host.id)}
                  listState={listStateOf(devices.status)}
                  value={[]}
                  selection="single"
                  {...(room !== null ? { groupBy: 'location' as const } : {})}
                  onChange={(next) => {
                    const id = next[0]
                    if (id !== undefined) pickDevice(id)
                  }}
                  noun="device"
                  showAll
                  testId="scalar-device-picker"
                />
              )}
            </>
          )}
        </section>
        {device !== null && (
          <section className="flex flex-col gap-1" aria-label={t('customize.scalar.stepField')}>
            <h3 className="text-[11px] font-medium text-foreground-muted">
              {t('customize.scalar.stepField')}
            </h3>
            {wireable.status === 'pending' && (
              <p role="status" className="text-[11px] text-foreground-subtle">
                {t('customize.picker.loadingFields')}
              </p>
            )}
            {wireable.status === 'error' && (
              <ErrorBox
                title={t('customize.picker.fieldsFailed')}
                message={wireable.error?.message ?? ''}
              />
            )}
            {wireable.status === 'success' && (
              <ul className="flex flex-col gap-1">
                {offers.map((offer) => {
                  const verdict = scalarFieldFit(props.cap, props.targetId, offer)
                  const id = fieldId(offer)
                  return (
                    <li key={id} className="flex flex-wrap items-center gap-2 text-[11px]">
                      <label className="flex items-center gap-2 text-foreground">
                        <input
                          type="radio"
                          name="scalar-field"
                          checked={fieldKey === id}
                          disabled={!verdict.ok}
                          onChange={() => pickField(offer)}
                        />
                        <span>
                          {vocabularyFieldLabel(offer.cap, offer.path, i18n.language)}
                          {offer.unit !== null ? ` (${offer.unit})` : ''}
                        </span>
                      </label>
                      {!verdict.ok && (
                        <span className="text-foreground-subtle">
                          {t(scalarFitReasonI18nKey(verdict.reason))}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )}
        {fit !== null && fit.ok && (
          <ScalarTransformControls
            control={scalarControl(fit.transforms)}
            transforms={fit.transforms}
            unit={fit.sourceUnit}
            value={transform}
            onChange={setTransform}
          />
        )}
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
  fit: ScalarFieldFit,
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

function pickerItems(
  fleet: readonly PickerDevice[],
  hostId: number,
): readonly PickerItem<number>[] {
  return fleet
    .filter((row) => row.id !== hostId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      ...(row.location !== null ? { location: row.location } : {}),
    }))
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
