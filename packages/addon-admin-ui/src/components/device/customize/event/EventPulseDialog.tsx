/**
 * One pulse source: a device, its rising field, and the debounce. Presses
 * inside the debounce are one pulse. A level that is already high is not.
 */
import {
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  type DeviceInfo,
  INITIAL_PULSE,
  SOURCE_CAP_CHANGED_AT_FIELD,
  type LevelSample,
  stepPulse,
} from '@camstack/types'
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
  Input,
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCapIndex } from '../assignments/use-cap-index'
import {
  readPath,
  toPickerDevices,
  type PickerDevice,
  type WireableCatalog,
} from '../source-picker-model'
import { vocabularyFieldLabel } from '../vocabulary-field-label'
import { eventDeclarationCaps, eventSourceFromWireable } from './event-fit'
import { eventPickerItems, eventPickerLockedIds } from './event-picker'
import { pulseFeatureFromForm, type PulseFormSource } from './event-form'

export interface EventPulseDialogProps {
  readonly open: boolean
  readonly mode: 'add' | 'change'
  readonly title: string
  readonly cap: string
  readonly targetId: string
  readonly host: DeviceInfo
  readonly target: CompositionSourceRef
  readonly enabled: boolean
  readonly debounceMs: number
  readonly seed: PulseFormSource | null
  readonly canSave: boolean
  readonly onClose: () => void
  readonly onSave: (feature: CompositionFieldsFeature) => void
}

function listStateOf(status: 'pending' | 'error' | 'success'): DeviceListState {
  if (status === 'pending') return 'pending'
  if (status === 'error') return 'failed'
  return 'answered'
}

export function EventPulseDialog(props: EventPulseDialogProps): ReactNode {
  const { t } = useTranslation()
  const heading =
    props.mode === 'change'
      ? t('customize.scalar.changeTitle', { title: props.title })
      : t('customize.scalar.addTitle', { title: props.title })
  return (
    <Dialog open={props.open} onOpenChange={(next) => !next && props.onClose()}>
      <DialogContent placement="sheet-on-mobile" scroll="body" aria-label={heading}>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
        </DialogHeader>
        {props.open ? <PulseForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function PulseForm(props: EventPulseDialogProps): ReactNode {
  const { t, i18n } = useTranslation()
  const devices = useDeviceManagerListAll({ projection: 'slim' })
  const fleet = devices.status === 'success' ? toPickerDevices(devices.data) : []
  const seeded = seedDevice(props.seed, fleet)
  const [device, setDevice] = useState<PickerDevice | null>(seeded)
  const [debounceSec, setDebounceSec] = useState(props.debounceMs / 1000)
  const wireable = useDeviceManagerGetWireableFields({ deviceId: device?.id ?? 0 })
  const snapshot = useDeviceStateGetSnapshot({ deviceId: device?.id ?? 0 })
  const catalog: WireableCatalog = wireable.status === 'success' ? wireable.data : { caps: [] }
  const declarationCaps = useMemo(
    () => eventDeclarationCaps(props.cap, props.targetId),
    [props.cap, props.targetId],
  )
  const capIndex = useCapIndex(declarationCaps, props.open)
  const lockedIds = useMemo(() => {
    if (capIndex.kind !== 'known') return []
    return eventPickerLockedIds(fleet, props.host.id, capIndex.value, declarationCaps)
  }, [capIndex, fleet, props.host.id, declarationCaps])
  const active =
    device === null ? null : eventSourceFromWireable(catalog, props.cap, props.targetId, 'pulse')
  const source: PulseFormSource | null =
    device === null || active === null || active.changedAtField === null
      ? null
      : {
          addonId: device.addonId,
          stableId: device.stableId,
          cap: active.cap,
          fieldPath: active.fieldPath,
          changedAtField: active.changedAtField,
        }
  const feature =
    source === null
      ? null
      : pulseFeatureFromForm({
          cap: props.cap,
          targetId: props.targetId,
          device: props.target,
          enabled: props.enabled,
          debounceMs: Math.round(debounceSec * 1000),
          sources: [source],
        })
  const room =
    typeof props.host.location === 'string' && props.host.location.length > 0
      ? props.host.location
      : null
  const sample = levelSample(snapshot.data, source)
  const preview = stepPulse(INITIAL_PULSE, sample, Math.round(debounceSec * 1000))
  return (
    <>
      <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
        <p className="text-[11px] text-foreground-muted">{t('customize.event.pulseBody')}</p>
        <section className="flex flex-col gap-1" aria-label={t('customize.scalar.stepDevice')}>
          {device !== null ? (
            <p className="flex flex-wrap items-center gap-2 text-xs text-foreground">
              {device.name}
              <Button variant="ghost" size="sm" onClick={() => setDevice(null)}>
                {t('customize.scalar.changeDevice')}
              </Button>
            </p>
          ) : devices.status === 'error' ? (
            <ErrorBox
              title={t('customize.picker.devicesFailed')}
              message={devices.error?.message ?? ''}
            />
          ) : (
            <DevicePicker
              devices={eventPickerItems(fleet, props.host.id)}
              listState={listStateOf(devices.status)}
              value={[]}
              selection="single"
              {...(room !== null ? { groupBy: 'location' as const } : {})}
              lockedIds={lockedIds}
              lockedNote={t('customize.scalar.fit.kind')}
              onChange={(next) => {
                const id = next[0]
                const picked = id === undefined ? undefined : fleet.find((row) => row.id === id)
                if (picked !== undefined) setDevice(picked)
              }}
              noun="device"
              showAll
              testId="event-pulse-picker"
            />
          )}
        </section>
        {device !== null && active !== null && (
          <p className="text-xs text-foreground">
            {vocabularyFieldLabel(active.cap, active.fieldPath, i18n.language)}
          </p>
        )}
        {device !== null && active === null && wireable.status === 'success' && (
          <p className="text-xs text-foreground-subtle">{t('customize.scalar.fit.kind')}</p>
        )}
        <label className="flex flex-col gap-1 text-[11px] text-foreground">
          {t('customize.event.debounce')}
          <Input
            type="number"
            aria-label={t('customize.event.debounce')}
            value={Number.isFinite(debounceSec) ? debounceSec : 0}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next) && next >= 0) setDebounceSec(next)
            }}
          />
        </label>
        <p role="status" className="text-[11px] text-foreground-subtle">
          {t(previewKey(sample, preview.lastPressedAt))}
        </p>
      </DialogBody>
      <DialogFooter className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={props.onClose}>
          {t('customize.scalar.cancel')}
        </Button>
        <Button
          data-testid="event-save"
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

function previewKey(sample: LevelSample, lastPressedAt: number | null): string {
  if (sample.kind === 'unread') return 'customize.event.previewWaiting'
  if (sample.active && lastPressedAt === null) return 'customize.event.previewAlreadyOn'
  if (lastPressedAt !== null) return 'customize.event.previewCounted'
  return 'customize.event.previewQuiet'
}

function levelSample(
  snapshot: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
  source: PulseFormSource | null,
): LevelSample {
  if (snapshot === undefined || source === null) return { kind: 'unread' }
  const slice = snapshot[source.cap]
  const level = slice === undefined ? undefined : readPath(slice, source.fieldPath)
  const changedAtField = SOURCE_CAP_CHANGED_AT_FIELD[source.cap] ?? source.changedAtField
  const changed = slice === undefined ? undefined : readPath(slice, changedAtField)
  if (typeof level !== 'boolean') return { kind: 'unread' }
  const changedAt = typeof changed === 'number' && Number.isFinite(changed) ? changed : null
  return { kind: 'level', active: level, changedAt }
}

function seedDevice(
  seed: PulseFormSource | null,
  fleet: readonly PickerDevice[],
): PickerDevice | null {
  if (seed === null) return null
  return fleet.find((row) => row.addonId === seed.addonId && row.stableId === seed.stableId) ?? null
}
