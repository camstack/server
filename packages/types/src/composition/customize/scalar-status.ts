/**
 * Assignment-status projection for one scalar target (D936, D315, D393).
 * Pending and unknown are unanswered reads. A failed read never becomes 0.
 * A confirmed-gone source releases a replacement to native and leaves an
 * added field assigned.
 */
import type { CompositionFieldsFeature, CompositionSourceRef } from '../composition.js'
import type { CustomizeAssignmentStatus } from './override-draft.js'
import { decodeScalarOverride } from './scalar-decode.js'

export type ScalarRead<T> =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown'; readonly reason: string | null }
  | { readonly kind: 'known'; readonly value: T }

export type ScalarSourcePresence = 'pending' | 'present' | 'absent' | 'unknown'

export interface ScalarStatusInput {
  readonly cap: string
  readonly targetId: string
  readonly device: CompositionSourceRef
  readonly stored: ScalarRead<CompositionFieldsFeature | null>
  readonly sourcePresence: ScalarSourcePresence
  readonly sourceUnknownReason: string | null
}

export interface ScalarAssignmentProjection {
  readonly text: string
  readonly status: CustomizeAssignmentStatus
}

export function projectScalarAssignment(input: ScalarStatusInput): ScalarAssignmentProjection {
  if (input.stored.kind === 'pending') return unanswered(input.targetId, 'pending', null)
  if (input.stored.kind === 'unknown') {
    return unanswered(input.targetId, 'unknown', input.stored.reason ?? 'unknown')
  }
  if (input.stored.value === null) return native(input.targetId)
  const decoded = decodeScalarOverride({
    feature: input.stored.value,
    device: input.device,
    cap: input.cap,
    targetId: input.targetId,
  })
  if (decoded === null) {
    return {
      text: 'unknown',
      status: status(input.targetId, true, 'assigned', 'unavailable', 'not-canonical'),
    }
  }
  return projectDecoded(
    input,
    decoded.apply,
    sourceLabel(decoded.draft.source.cap, decoded.draft.source.fieldPath),
  )
}

function projectDecoded(
  input: ScalarStatusInput,
  apply: 'add' | 'replace',
  label: string,
): ScalarAssignmentProjection {
  if (input.sourcePresence === 'pending') {
    return { text: 'pending', status: status(input.targetId, true, 'assigned', 'stale', null) }
  }
  if (input.sourcePresence === 'unknown') {
    return {
      text: 'unknown',
      status: status(
        input.targetId,
        true,
        'assigned',
        'stale',
        input.sourceUnknownReason ?? 'unknown',
      ),
    }
  }
  if (input.sourcePresence === 'absent' && apply === 'replace') {
    return {
      text: 'Native · source missing',
      status: status(input.targetId, true, 'native', 'released', 'source-missing'),
    }
  }
  if (input.sourcePresence === 'absent') {
    return {
      text: `Assigned · ${label}`,
      status: status(input.targetId, true, 'assigned', 'unavailable', 'source-missing'),
    }
  }
  return {
    text: `Assigned · ${label}`,
    status: status(input.targetId, true, 'assigned', 'active', null),
  }
}

function native(targetId: string): ScalarAssignmentProjection {
  return { text: 'Native', status: status(targetId, false, 'native', 'active', null) }
}

function unanswered(
  targetId: string,
  text: 'pending' | 'unknown',
  reason: string | null,
): ScalarAssignmentProjection {
  const state = text === 'pending' ? 'unavailable' : 'stale'
  return { text, status: status(targetId, false, 'native', state, reason) }
}

function sourceLabel(cap: string, fieldPath: string): string {
  return `${cap}.${fieldPath}`
}

function status(
  targetId: string,
  configured: boolean,
  source: CustomizeAssignmentStatus['source'],
  state: CustomizeAssignmentStatus['state'],
  reason: string | null,
): CustomizeAssignmentStatus {
  return { targetId, configured, source, state, reason }
}
