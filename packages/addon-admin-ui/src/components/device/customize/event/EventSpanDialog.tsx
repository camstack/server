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
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveValue } from '../assignments/use-live-value'
import type { PickerDevice } from '../source-picker-model'
import { SourceSelector, type EventPickedRow } from '../source-selector/SourceSelector'
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

export function EventSpanDialog(props: EventSpanDialogProps): ReactNode {
  const { t } = useTranslation()
  const heading =
    props.mode === 'change'
      ? t('customize.scalar.changeTitle', { title: props.title })
      : t('customize.scalar.addTitle', { title: props.title })
  return (
    <Dialog open={props.open} onOpenChange={(next) => !next && props.onClose()}>
      <DialogContent width="xl" placement="sheet-on-mobile" scroll="body" aria-label={heading}>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
        </DialogHeader>
        {props.open ? <SpanForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function SpanForm(props: EventSpanDialogProps): ReactNode {
  const { t } = useTranslation()
  const [picked, setPicked] = useState<readonly EventPickedRow[]>(() =>
    spanPickedFromSources(props.sources),
  )
  const [device, setDevice] = useState<PickerDevice | null>(null)
  const [timeoutSec, setTimeoutSec] = useState(props.timeoutMs / 1000)
  const [cooldownSec, setCooldownSec] = useState((props.cooldownMs ?? 0) / 1000)
  const sources = spanSourcesFromPicked(picked)
  const compiled = spanApplyFromForm({
    cap: props.cap,
    targetId: props.targetId,
    device: props.target,
    timeoutMs: Math.round(timeoutSec * 1000),
    cooldownMs: props.cooldownMs === null ? undefined : Math.round(cooldownSec * 1000),
    sources,
  })
  const previewRow = picked[0]
  return (
    <>
      <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
        <p className="text-[11px] text-foreground-muted">{t('customize.event.spanBody')}</p>
        <SourceSelector
          kind="event"
          shape="span"
          enabled={props.open}
          hostId={props.host.id}
          devicePickerTestId="event-span-picker"
          destination={{ cap: props.cap, targetId: props.targetId, title: props.title }}
          device={device}
          picked={picked}
          onDeviceChange={setDevice}
          onPickedChange={(rows) =>
            setPicked(
              rows.filter(
                (row) =>
                  !(row.addonId === props.host.addonId && row.stableId === props.host.stableId),
              ),
            )
          }
          edges={[]}
          edge="rising"
          onEdgeChange={() => undefined}
          debounceSec={0}
          onDebounceSecChange={() => undefined}
          sourceModes={props.sourceModes}
          timeoutSec={timeoutSec}
          onTimeoutSecChange={setTimeoutSec}
          cooldownSec={props.cooldownMs === null ? null : cooldownSec}
          onCooldownSecChange={setCooldownSec}
        />
        {previewRow !== undefined && (
          <SpanLevelPreview
            deviceId={previewRow.deviceId}
            cap={previewRow.cap}
            fieldPath={previewRow.fieldPath}
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

function spanPickedFromSources(sources: readonly SpanFormSource[]): readonly EventPickedRow[] {
  return sources.map((source) => ({
    deviceId: 0,
    addonId: source.addonId,
    stableId: source.stableId,
    cap: source.cap,
    fieldPath: source.fieldPath,
    deviceName: source.label.length > 0 ? source.label : source.stableId,
    mode: source.mode,
  }))
}

function spanSourcesFromPicked(picked: readonly EventPickedRow[]): readonly SpanFormSource[] {
  return picked.map((row) => ({
    addonId: row.addonId,
    stableId: row.stableId,
    cap: row.cap,
    fieldPath: row.fieldPath,
    mode: row.mode ?? 'in-addition',
    label: row.deviceName,
  }))
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
