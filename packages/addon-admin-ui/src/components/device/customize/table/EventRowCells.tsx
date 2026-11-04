/**
 * The Value and Source cells of an event row (doorbell, motion). They read the
 * same facts the event editors read — the live last-event state and the stored
 * source link or camera sensors — so the table never claims a placeholder: an
 * unread fact says it is unread (D315), a failed one says it failed (D393).
 */
import {
  compositionSourceKey,
  type DeviceInfo,
  decodePulseOverride,
  projectSpanAssignment,
} from '@camstack/types'
import { Badge, type DeviceNameFields, useDeviceLabel } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { currentComposition } from '../customization-read'
import { featureOf } from '../customization-save'
import { DoorbellRingStatus } from '../event/EventPulseCard'
import { MotionNowLine, SensorRowName, spanRead } from '../event/EventSpanCard'
import { type EventCardTarget, eventBadgeKey, eventCardTargets } from '../event/event-targets'
import { storedRead } from '../scalar/use-scalar-row'
import { candidateFields } from '../source-selector/source-selector-parent-detail'
import type { CameraSensorsRead } from '../use-camera-sensors-presence'
import type { CustomizationHandle } from '../use-customization'
import { vocabularyFieldLabel } from '../vocabulary-field-label'
import type { CustomizeRowSpec } from './customize-rows'

const PLACEHOLDER_DEVICE: DeviceNameFields = {
  id: 0,
  name: '',
  type: 'unknown',
  stableId: '',
  parentDeviceId: null,
}

export interface EventRowProps {
  readonly spec: CustomizeRowSpec
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly sensors: CameraSensorsRead
}

function eventCardOf(cap: string): EventCardTarget | null {
  return eventCardTargets().find((card) => card.cap === cap) ?? null
}

/** The last event or current state, read live from the device. */
export function EventValueCell({ spec, device, handle }: EventRowProps): ReactNode {
  const card = eventCardOf(spec.cap)
  if (card === null) return <UnreadText />
  if (card.pulse !== null) {
    return (
      <DoorbellRingStatus
        deviceId={device.id}
        cap={spec.cap}
        timestampPath={card.pulse.timestampPath}
        counterPath={card.pulse.counterPath}
        startedAt={handle.state.kind === 'present' ? handle.state.view.block.createdAt : null}
      />
    )
  }
  return <MotionNowLine deviceId={device.id} />
}

/** The device the event is read from: the linked source, or the camera's attached sensors. */
export function EventSourceCell(props: EventRowProps): ReactNode {
  const card = eventCardOf(props.spec.cap)
  if (card === null) return <UnreadText />
  if (card.pulse !== null) return <PulseSource {...props} cap={props.spec.cap} view={card.pulse} />
  return <SpanSource {...props} view={card.span} />
}

function UnreadText(): ReactNode {
  const { t } = useTranslation()
  return <span className="text-xs text-foreground-subtle">{t('customize.table.unknown')}</span>
}

function PendingText(): ReactNode {
  const { t } = useTranslation()
  return (
    <span role="status" className="text-xs text-foreground-subtle">
      {t('customize.event.checking')}
    </span>
  )
}

interface PulseSourceProps extends EventRowProps {
  readonly cap: string
  readonly view: NonNullable<EventCardTarget['pulse']>
}

function PulseSource({ cap, view, handle }: PulseSourceProps): ReactNode {
  const { t, i18n } = useTranslation()
  const stored = storedRead(handle, featureOf(currentComposition(handle.state), cap))
  const decoded =
    stored.kind === 'known' && stored.value !== null
      ? decodePulseOverride({
          feature: stored.value,
          device: handle.target,
          cap,
          targetId: view.id,
          timestampPath: view.timestampPath,
          counterPath: view.counterPath,
        })
      : null
  const source = decoded?.draft.sources[0] ?? null
  const devices = useCandidateDevices(source !== null)
  const found =
    source === null || devices.kind !== 'known'
      ? null
      : (devices.value.find(
          (row) =>
            compositionSourceKey({
              addonId: row.addonId,
              stableId: row.stableId,
            }) === compositionSourceKey(source),
        ) ?? null)
  const label = useDeviceLabel(
    found === null ? PLACEHOLDER_DEVICE : candidateFields(found),
    'compact',
  )
  if (stored.kind === 'pending') return <PendingText />
  if (stored.kind === 'unknown') return <UnreadText />
  if (stored.value === null) {
    return (
      <span className="text-xs text-foreground-subtle">{t('customize.scalar.noOverride')}</span>
    )
  }
  if (source === null) {
    // Stored, but a formula this editor did not write: Advanced owns it.
    return <span className="text-xs text-foreground">{t('customize.table.otherFormula')}</span>
  }
  if (devices.kind === 'pending') return <PendingText />
  if (devices.kind === 'unknown') {
    return (
      <span role="alert" className="text-[11px] text-warning">
        {t('customize.scalar.sourceUnreadable')}
      </span>
    )
  }
  if (found === null) return <Badge variant="warning">{t('customize.table.sourceMissing')}</Badge>
  return (
    <span className="text-xs text-foreground">
      {t('customize.table.sourceOf', {
        name: label,
        field: vocabularyFieldLabel(source.cap, source.fieldPath, i18n.language),
      })}
    </span>
  )
}

interface SpanSourceProps extends EventRowProps {
  readonly view: EventCardTarget['span']
}

function SpanSource({ sensors, view }: SpanSourceProps): ReactNode {
  const { t } = useTranslation()
  const fleet = useCandidateDevices(true)
  const read = spanRead(sensors)
  if (view === null) return <UnreadText />
  if (read.kind === 'pending') return <PendingText />
  if (read.kind === 'unknown') return <UnreadText />
  const projection = projectSpanAssignment(view.id, read)
  if (projection.rows.length === 0) {
    return <Badge>{t(eventBadgeKey(projection.text, projection.status.state))}</Badge>
  }
  return (
    <span className="flex flex-col gap-0.5">
      {projection.rows.map((row) => (
        <span key={row.key} className="text-xs text-foreground">
          <SensorRowName row={row} fleet={fleet} />
          {row.reason !== null ? ` — ${t(`customize.motion.state.${row.state}`)}` : ''}
        </span>
      ))}
    </span>
  )
}
