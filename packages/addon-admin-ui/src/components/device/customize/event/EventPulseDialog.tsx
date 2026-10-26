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
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { readPath, type PickerDevice } from '../source-picker-model'
import { SourceSelector, type EventPickedRow } from '../source-selector/SourceSelector'
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

export function EventPulseDialog(props: EventPulseDialogProps): ReactNode {
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
        {props.open ? <PulseForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function PulseForm(props: EventPulseDialogProps): ReactNode {
  const { t } = useTranslation()
  const [picked, setPicked] = useState<readonly EventPickedRow[]>(() =>
    pulsePickedFromSources(props.sources),
  )
  const [device, setDevice] = useState<PickerDevice | null>(null)
  const [edge, setEdge] = useState<CustomizeEventEdge>(props.edge)
  const [debounceSec, setDebounceSec] = useState(props.debounceMs / 1000)
  const sources = pulseSourcesFromPicked(picked)
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
  const firstSource = sources[0] ?? null
  const previewDeviceId = picked[0]?.deviceId ?? 0
  const snapshot = useDeviceStateGetSnapshot({ deviceId: previewDeviceId })
  const sample = levelSample(snapshot.status === 'success' ? snapshot.data : undefined, firstSource)
  const preview = stepPulse(INITIAL_PULSE, sample, Math.round(debounceSec * 1000))
  return (
    <>
      <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
        <p className="text-[11px] text-foreground-muted">{t('customize.event.pulseBody')}</p>
        <SourceSelector
          kind="event"
          shape="pulse"
          enabled={props.open}
          hostId={props.host.id}
          devicePickerTestId="event-pulse-picker"
          destination={{ cap: props.cap, targetId: props.targetId, title: props.title }}
          device={device}
          picked={picked}
          onDeviceChange={setDevice}
          onPickedChange={setPicked}
          edges={props.edges}
          edge={edge}
          onEdgeChange={setEdge}
          debounceSec={debounceSec}
          onDebounceSecChange={setDebounceSec}
          sourceModes={[]}
          timeoutSec={0}
          onTimeoutSecChange={() => undefined}
          cooldownSec={null}
          onCooldownSecChange={() => undefined}
        />
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

function pulsePickedFromSources(sources: readonly PulseFormSource[]): readonly EventPickedRow[] {
  return sources.map((source) => ({
    deviceId: 0,
    addonId: source.addonId,
    stableId: source.stableId,
    cap: source.cap,
    fieldPath: source.fieldPath,
    deviceName: source.stableId,
    changedAtField: source.changedAtField,
  }))
}

function pulseSourcesFromPicked(picked: readonly EventPickedRow[]): readonly PulseFormSource[] {
  return picked.map((row) => ({
    addonId: row.addonId,
    stableId: row.stableId,
    cap: row.cap,
    fieldPath: row.fieldPath,
    changedAtField: row.changedAtField ?? SOURCE_CAP_CHANGED_AT_FIELD[row.cap] ?? 'lastChangedAt',
  }))
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
