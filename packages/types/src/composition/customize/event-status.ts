/**
 * Assignment status for a pulse feature and a span's camera-sensors
 * authority (D936, D315, D49). Pending and unreadable are not an empty list.
 */
import type { CompositionFieldsFeature, CompositionSourceRef } from '../composition.js'
import type {
  CameraSensorAttachment,
  CameraSensorMode,
  CameraSensorsStatus,
} from '../../pipeline/camera-sensors.js'
import { decodePulseOverride } from './event-decode.js'
import type { CustomizeAssignmentStatus } from './override-draft.js'
import type { ScalarRead, ScalarSourcePresence } from './scalar-status.js'

export interface PulseStatusInput {
  readonly cap: string
  readonly targetId: string
  readonly device: CompositionSourceRef
  readonly timestampPath: string
  readonly counterPath: string
  readonly apply: 'add' | 'replace'
  readonly stored: ScalarRead<CompositionFieldsFeature | null>
  readonly sourcePresence: ScalarSourcePresence
  readonly sourceUnknownReason: string | null
}

export interface PulseAssignmentProjection {
  readonly text: string
  readonly status: CustomizeAssignmentStatus
}

export interface SpanSensorRow {
  readonly key: string
  readonly addonId: string
  readonly stableId: string
  readonly name: string
  readonly mode: CameraSensorMode
  readonly state: CameraSensorAttachment['state']
  readonly reason: string | null
}

export interface SpanAssignmentProjection {
  readonly text: string
  readonly writable: boolean
  readonly rows: readonly SpanSensorRow[]
  readonly status: CustomizeAssignmentStatus
}

export type SpanRead =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown'; readonly reason: string | null }
  | { readonly kind: 'known'; readonly value: CameraSensorsStatus }

export function projectPulseAssignment(input: PulseStatusInput): PulseAssignmentProjection {
  if (input.stored.kind === 'pending') return held(input.targetId, 'pending', null)
  if (input.stored.kind === 'unknown') {
    return held(input.targetId, 'unknown', input.stored.reason ?? 'unknown')
  }
  if (input.stored.value === null) return native(input.targetId)
  const decoded = decodePulseOverride({
    feature: input.stored.value,
    device: input.device,
    cap: input.cap,
    targetId: input.targetId,
    timestampPath: input.timestampPath,
    counterPath: input.counterPath,
  })
  if (decoded === null) {
    return {
      text: 'unknown',
      status: row(input.targetId, true, 'assigned', 'unavailable', 'not-canonical'),
    }
  }
  if (input.sourcePresence === 'pending') {
    return { text: 'pending', status: row(input.targetId, true, 'assigned', 'stale', null) }
  }
  if (input.sourcePresence === 'unknown') {
    return {
      text: 'unknown',
      status: row(
        input.targetId,
        true,
        'assigned',
        'stale',
        input.sourceUnknownReason ?? 'unknown',
      ),
    }
  }
  if (input.sourcePresence === 'absent' && input.apply === 'replace') {
    return {
      text: 'Native · source missing',
      status: row(input.targetId, true, 'native', 'released', 'source-missing'),
    }
  }
  if (input.sourcePresence === 'absent') {
    return {
      text: 'Assigned · source missing',
      status: row(input.targetId, true, 'assigned', 'unavailable', 'source-missing'),
    }
  }
  const source = decoded.draft.sources[0]
  const label = source === undefined ? 'assigned' : `${source.cap}.${source.fieldPath}`
  return {
    text: `Assigned · ${label}`,
    status: row(input.targetId, true, 'assigned', 'active', null),
  }
}

export function projectSpanAssignment(
  targetId: string,
  stored: SpanRead,
): SpanAssignmentProjection {
  if (stored.kind === 'pending') {
    return {
      text: 'pending',
      writable: false,
      rows: [],
      status: row(targetId, false, 'native', 'unavailable', null),
    }
  }
  if (stored.kind === 'unknown') {
    return {
      text: 'unknown',
      writable: false,
      rows: [],
      status: row(targetId, false, 'native', 'stale', stored.reason ?? 'unknown'),
    }
  }
  if (stored.value.state === 'unreadable') {
    return {
      text: 'unreadable',
      writable: false,
      rows: [],
      status: row(targetId, false, 'assigned', 'unavailable', stored.value.reason),
    }
  }
  if (stored.value.state === 'not-configured') {
    return {
      text: 'Native',
      writable: true,
      rows: [],
      status: row(targetId, false, 'native', 'active', null),
    }
  }
  const rows = stored.value.sensors.map(sensorRow)
  const reason = spanReason(stored.value)
  return {
    text: rows.length === 0 ? 'Native' : 'Assigned',
    writable: true,
    rows,
    status: row(targetId, rows.length > 0, 'assigned', 'active', reason),
  }
}

function spanReason(status: Extract<CameraSensorsStatus, { state: 'configured' }>): string | null {
  if (status.notForwarded !== undefined) return status.notForwarded
  if (status.notEnforced !== undefined) return status.notEnforced
  const fault = status.sensors.map(attachmentReason).find((reason) => reason !== null)
  return fault ?? null
}

function sensorRow(sensor: CameraSensorAttachment): SpanSensorRow {
  return {
    key: `${sensor.addonId}/${sensor.stableId}`,
    addonId: sensor.addonId,
    stableId: sensor.stableId,
    name:
      sensor.state === 'missing' || sensor.state === 'unreadable' ? sensor.stableId : sensor.name,
    mode: sensor.mode,
    state: sensor.state,
    reason: attachmentReason(sensor),
  }
}

function attachmentReason(sensor: CameraSensorAttachment): string | null {
  switch (sensor.state) {
    case 'ready':
      return null
    case 'offline':
    case 'missing':
    case 'unsupported':
    case 'unreadable':
      return sensor.reason
  }
}

function native(targetId: string): PulseAssignmentProjection {
  return { text: 'Native', status: row(targetId, false, 'native', 'active', null) }
}

function held(
  targetId: string,
  text: 'pending' | 'unknown',
  reason: string | null,
): PulseAssignmentProjection {
  const state = text === 'pending' ? 'unavailable' : 'stale'
  return { text, status: row(targetId, false, 'native', state, reason) }
}

function row(
  targetId: string,
  configured: boolean,
  source: CustomizeAssignmentStatus['source'],
  state: CustomizeAssignmentStatus['state'],
  reason: string | null,
): CustomizeAssignmentStatus {
  return { targetId, configured, source, state, reason }
}
