/**
 * Span sources for the camera-sensors authority. Timeout is
 * `motionCooldownMs`. A cooldown control exists only when the declaration
 * has one — motion does not.
 */
import {
  type CameraSensorMode,
  type CompositionSourceRef,
  type DeviceInfo,
  INITIAL_SPAN,
  type LevelSample,
  type SpanCompiled,
  stepSpan,
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
} from '@camstack/ui-library'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCapIndex } from '../assignments/use-cap-index'
import { useLiveValue } from '../assignments/use-live-value'
import { toPickerDevices, type WireableCatalog } from '../source-picker-model'
import { vocabularyFieldLabel } from '../vocabulary-field-label'
import { eventDeclarationCaps, eventSourceFromWireable } from './event-fit'
import { eventPickerItems, eventPickerLockedIds } from './event-picker'
import { spanApplyFromForm, type SpanFormSource } from './event-form'

export interface EventSpanDialogProps {
  readonly open: boolean
  readonly mode: 'add' | 'change'
  readonly title: string
  readonly cap: string
  readonly targetId: string
  readonly host: DeviceInfo
  readonly target: CompositionSourceRef
  readonly timeoutMs: number
  readonly cooldownMs: number | null
  readonly sourceModes: readonly CameraSensorMode[]
  readonly sources: readonly SpanFormSource[]
  readonly canSave: boolean
  readonly onClose: () => void
  readonly onSave: (compiled: SpanCompiled) => void
}

function listStateOf(status: 'pending' | 'error' | 'success'): DeviceListState {
  if (status === 'pending') return 'pending'
  if (status === 'error') return 'failed'
  return 'answered'
}

export function EventSpanDialog(props: EventSpanDialogProps): ReactNode {
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
        {props.open ? <SpanForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function SpanForm(props: EventSpanDialogProps): ReactNode {
  const { t, i18n } = useTranslation()
  const devices = useDeviceManagerListAll({ projection: 'slim' })
  const fleet = devices.status === 'success' ? toPickerDevices(devices.data) : []
  const [sources, setSources] = useState<readonly SpanFormSource[]>(props.sources)
  const [pendingId, setPendingId] = useState<number | null>(null)
  const [pendingMode, setPendingMode] = useState<CameraSensorMode>(
    props.sourceModes[0] ?? 'in-addition',
  )
  const [timeoutSec, setTimeoutSec] = useState(props.timeoutMs / 1000)
  const [cooldownSec, setCooldownSec] = useState((props.cooldownMs ?? 0) / 1000)
  const pending = pendingId === null ? null : (fleet.find((row) => row.id === pendingId) ?? null)
  const wireable = useDeviceManagerGetWireableFields({ deviceId: pending?.id ?? 0 })
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
    pending === null ? null : eventSourceFromWireable(catalog, props.cap, props.targetId, 'span')
  const compiled = spanApplyFromForm({
    cap: props.cap,
    targetId: props.targetId,
    device: props.target,
    timeoutMs: Math.round(timeoutSec * 1000),
    cooldownMs: props.cooldownMs === null ? undefined : Math.round(cooldownSec * 1000),
    sources,
  })
  const room =
    typeof props.host.location === 'string' && props.host.location.length > 0
      ? props.host.location
      : null
  const addPending = (): void => {
    if (pending === null || active === null) return
    if (pending.addonId === props.host.addonId && pending.stableId === props.host.stableId) return
    const next: SpanFormSource = {
      addonId: pending.addonId,
      stableId: pending.stableId,
      cap: active.cap,
      fieldPath: active.fieldPath,
      mode: pendingMode,
      label: pending.name,
    }
    if (sources.some((row) => row.addonId === next.addonId && row.stableId === next.stableId)) {
      setPendingId(null)
      return
    }
    setSources([...sources, next])
    setPendingId(null)
  }
  return (
    <>
      <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
        <p className="text-[11px] text-foreground-muted">{t('customize.event.spanBody')}</p>
        <ModeLine
          mode={pendingMode}
          modes={props.sourceModes}
          name={t('customize.motion.add')}
          onChange={setPendingMode}
        />
        <ul className="flex flex-col gap-2">
          {sources.map((source) => (
            <li
              key={`${source.addonId}/${source.stableId}`}
              className="flex flex-col gap-1 text-xs"
            >
              <span className="text-foreground">
                {source.label.length > 0
                  ? source.label
                  : vocabularyFieldLabel(source.cap, source.fieldPath, i18n.language)}
              </span>
              <ModeLine
                mode={source.mode}
                modes={props.sourceModes}
                name={source.stableId}
                onChange={(mode) =>
                  setSources(
                    sources.map((row) =>
                      row.addonId === source.addonId && row.stableId === source.stableId
                        ? { ...row, mode }
                        : row,
                    ),
                  )
                }
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSources(
                    sources.filter(
                      (row) => row.addonId !== source.addonId || row.stableId !== source.stableId,
                    ),
                  )
                }
              >
                {t('customize.event.clear')}
              </Button>
            </li>
          ))}
        </ul>
        {devices.status === 'error' ? (
          <ErrorBox
            title={t('customize.picker.devicesFailed')}
            message={devices.error?.message ?? ''}
          />
        ) : (
          <DevicePicker
            devices={eventPickerItems(fleet, props.host.id)}
            listState={listStateOf(devices.status)}
            value={pendingId === null ? [] : [pendingId]}
            selection="single"
            {...(room !== null ? { groupBy: 'location' as const } : {})}
            lockedIds={lockedIds}
            lockedNote={t('customize.scalar.fit.kind')}
            onChange={(next) => setPendingId(next[0] ?? null)}
            noun="device"
            showAll
            testId="event-span-picker"
          />
        )}
        {active !== null && (
          <p className="text-[11px] text-foreground-subtle">
            {vocabularyFieldLabel(active.cap, active.fieldPath, i18n.language)}
          </p>
        )}
        <Button variant="secondary" size="sm" disabled={active === null} onClick={addPending}>
          {t('customize.motion.add')}
        </Button>
        <NumberSeconds
          label={t('customize.event.timeout')}
          value={timeoutSec}
          onChange={setTimeoutSec}
        />
        {props.cooldownMs !== null && (
          <NumberSeconds
            label={t('customize.event.cooldown')}
            value={cooldownSec}
            onChange={setCooldownSec}
          />
        )}
        {pending !== null && active !== null && (
          <SpanLevelPreview
            deviceId={pending.id}
            cap={active.cap}
            fieldPath={active.fieldPath}
            timeoutMs={Math.round(timeoutSec * 1000)}
          />
        )}
      </DialogBody>
      <DialogFooter className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={props.onClose}>
          {t('customize.scalar.cancel')}
        </Button>
        <Button
          data-testid="event-save"
          disabled={!props.canSave || compiled === null}
          onClick={() => {
            if (compiled !== null) props.onSave(compiled)
          }}
        >
          {t('customize.scalar.save')}
        </Button>
      </DialogFooter>
    </>
  )
}

function modeOf(value: string, allowed: readonly CameraSensorMode[]): CameraSensorMode | null {
  return allowed.find((mode) => mode === value) ?? null
}

interface ModeLineProps {
  readonly mode: CameraSensorMode
  readonly modes: readonly CameraSensorMode[]
  readonly name: string
  readonly onChange: (mode: CameraSensorMode) => void
}

function ModeLine({ mode, modes, name, onChange }: ModeLineProps): ReactNode {
  const { t } = useTranslation()
  if (modes.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <Select
        aria-label={t('customize.motion.modeFor', { name })}
        value={mode}
        options={modes.map((item) => ({
          value: item,
          label: t(`customize.motion.mode.${item}`),
        }))}
        onChange={(event) => {
          const next = modeOf(event.target.value, modes)
          if (next !== null) onChange(next)
        }}
      />
      <p className="text-[11px] text-foreground-muted">{t(`customize.motion.modeLine.${mode}`)}</p>
    </div>
  )
}

interface NumberSecondsProps {
  readonly label: string
  readonly value: number
  readonly onChange: (value: number) => void
}

function NumberSeconds({ label, value, onChange }: NumberSecondsProps): ReactNode {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-foreground">
      {label}
      <Input
        type="number"
        aria-label={label}
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next) && next >= 0) onChange(next)
        }}
      />
    </label>
  )
}

interface SpanLevelPreviewProps {
  readonly deviceId: number
  readonly cap: string
  readonly fieldPath: string
  readonly timeoutMs: number
}

function SpanLevelPreview({
  deviceId,
  cap,
  fieldPath,
  timeoutMs,
}: SpanLevelPreviewProps): ReactNode {
  const { t } = useTranslation()
  const value = useLiveValue({ deviceId, cap, path: fieldPath })
  const sample: LevelSample =
    value.kind === 'value' && typeof value.value === 'boolean'
      ? { kind: 'level', active: value.value, changedAt: null }
      : { kind: 'unread' }
  const next = stepSpan(INITIAL_SPAN, sample, { timeoutMs, cooldownMs: 0, nowMs: Date.now() })
  return (
    <p role="status" className="text-[11px] text-foreground-subtle">
      {t(spanPreviewKey(sample, next.open))}
    </p>
  )
}

function spanPreviewKey(sample: LevelSample, open: boolean): string {
  if (sample.kind === 'unread') return 'customize.event.previewWaiting'
  if (open) return 'customize.event.previewMotionOn'
  if (sample.active) return 'customize.event.previewSensorOn'
  return 'customize.event.previewMotionOff'
}
