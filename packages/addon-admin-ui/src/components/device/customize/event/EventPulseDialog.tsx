/**
 * Pulse sources: each picked device is one source, and the edge comes from
 * the declaration. Presses inside the debounce are one pulse.
 */
import {
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  type CustomizeEventEdge,
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
  Select,
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useCapIndex } from '../assignments/use-cap-index'
import {
  readPath,
  toPickerDevices,
  type PickerDevice,
  type WireableCatalog,
} from '../source-picker-model'
import { vocabularyFieldLabel } from '../vocabulary-field-label'
import { eventDeclarationCaps, eventSourceFromWireable, type ActiveField } from './event-fit'
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
  readonly edges: readonly CustomizeEventEdge[]
  readonly edge: CustomizeEventEdge
  readonly sources: readonly PulseFormSource[]
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
  const [rows, setRows] = useState<readonly PulseFormSource[]>(props.sources)
  const [device, setDevice] = useState<PickerDevice | null>(null)
  const [edge, setEdge] = useState<CustomizeEventEdge>(props.edge)
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
  const pending = pulseSourceOf(device, active)
  useCommitPulseSource(pending, setRows, setDevice)
  const sources = pending === null ? rows : mergePulseSources(rows, pending)
  const feature =
    sources.length === 0
      ? null
      : pulseFeatureFromForm({
          cap: props.cap,
          targetId: props.targetId,
          device: props.target,
          enabled: props.enabled,
          debounceMs: Math.round(debounceSec * 1000),
          edges: [edge],
          sources,
        })
  const room =
    typeof props.host.location === 'string' && props.host.location.length > 0
      ? props.host.location
      : null
  const sample = levelSample(snapshot.data, sources[0] ?? null)
  const preview = stepPulse(INITIAL_PULSE, sample, Math.round(debounceSec * 1000))
  return (
    <>
      <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
        <p className="text-[11px] text-foreground-muted">{t('customize.event.pulseBody')}</p>
        <EdgeField edges={props.edges} edge={edge} onChange={setEdge} />
        <PulseSourceList fleet={fleet} rows={rows} onChange={setRows} />
        <PulsePicker
          devices={devices}
          fleet={fleet}
          hostId={props.host.id}
          room={room}
          lockedIds={lockedIds}
          onPick={setDevice}
        />
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

function useCommitPulseSource(
  pending: PulseFormSource | null,
  setRows: Dispatch<SetStateAction<readonly PulseFormSource[]>>,
  setDevice: Dispatch<SetStateAction<PickerDevice | null>>,
): void {
  const key =
    pending === null ? null : `${pending.addonId}/${pending.stableId}/${pending.fieldPath}`
  useEffect(() => {
    if (pending === null || key === null) return
    setRows((current) => mergePulseSources(current, pending))
    setDevice(null)
  }, [key, pending, setDevice, setRows])
}

function pulseSourceOf(
  device: PickerDevice | null,
  active: ActiveField | null,
): PulseFormSource | null {
  if (device === null || active === null || active.changedAtField === null) return null
  return {
    addonId: device.addonId,
    stableId: device.stableId,
    cap: active.cap,
    fieldPath: active.fieldPath,
    changedAtField: active.changedAtField,
  }
}

function mergePulseSources(
  rows: readonly PulseFormSource[],
  pending: PulseFormSource,
): readonly PulseFormSource[] {
  const present = rows.some(
    (row) => row.addonId === pending.addonId && row.stableId === pending.stableId,
  )
  return present ? rows : [...rows, pending]
}

interface EdgeFieldProps {
  readonly edges: readonly CustomizeEventEdge[]
  readonly edge: CustomizeEventEdge
  readonly onChange: (edge: CustomizeEventEdge) => void
}

function EdgeField({ edges, edge, onChange }: EdgeFieldProps): ReactNode {
  const { t } = useTranslation()
  if (edges.length === 0) return null
  return (
    <label className="flex flex-col gap-1 text-[11px] text-foreground">
      {t('customize.event.edge')}
      <Select
        aria-label={t('customize.event.edge')}
        value={edge}
        options={edges.map((item) => ({
          value: item,
          label: t(`customize.event.edgeValue.${item}`),
        }))}
        onChange={(event) => {
          const next = edges.find((item) => item === event.target.value)
          if (next !== undefined) onChange(next)
        }}
      />
    </label>
  )
}

interface PulseSourceListProps {
  readonly fleet: readonly PickerDevice[]
  readonly rows: readonly PulseFormSource[]
  readonly onChange: (rows: readonly PulseFormSource[]) => void
}

function PulseSourceList({ fleet, rows, onChange }: PulseSourceListProps): ReactNode {
  const { t } = useTranslation()
  if (rows.length === 0) return null
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row) => {
        const name =
          fleet.find((item) => item.addonId === row.addonId && item.stableId === row.stableId)
            ?.name ?? row.stableId
        return (
          <li key={`${row.addonId}/${row.stableId}`} className="flex items-center gap-2 text-xs">
            <span className="text-foreground">{name}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onChange(
                  rows.filter(
                    (item) => item.addonId !== row.addonId || item.stableId !== row.stableId,
                  ),
                )
              }
            >
              {t('customize.event.clear')}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

interface PulseDeviceQuery {
  readonly status: 'pending' | 'error' | 'success'
  readonly error?: { readonly message?: string } | null
}

interface PulsePickerProps {
  readonly devices: PulseDeviceQuery
  readonly fleet: readonly PickerDevice[]
  readonly hostId: number
  readonly room: string | null
  readonly lockedIds: readonly number[]
  readonly onPick: (device: PickerDevice) => void
}

function PulsePicker({
  devices,
  fleet,
  hostId,
  room,
  lockedIds,
  onPick,
}: PulsePickerProps): ReactNode {
  const { t } = useTranslation()
  if (devices.status === 'error') {
    return (
      <ErrorBox
        title={t('customize.picker.devicesFailed')}
        message={devices.error?.message ?? ''}
      />
    )
  }
  return (
    <DevicePicker
      devices={eventPickerItems(fleet, hostId)}
      listState={listStateOf(devices.status)}
      value={[]}
      selection="single"
      {...(room !== null ? { groupBy: 'location' as const } : {})}
      lockedIds={lockedIds}
      lockedNote={t('customize.scalar.fit.kind')}
      onChange={(next) => {
        const id = next[0]
        const picked = id === undefined ? undefined : fleet.find((row) => row.id === id)
        if (picked !== undefined) onPick(picked)
      }}
      noun="device"
      showAll
      testId="event-pulse-picker"
    />
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
