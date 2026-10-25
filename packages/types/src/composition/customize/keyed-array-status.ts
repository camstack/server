/**
 * Assignment-status projection for one keyed-array target (D936). Pending and
 * unknown are unanswered reads. A confirmed-gone source leaves an added array
 * assigned: the native rows are a different authority.
 */
import type { CompositionFieldsFeature, CompositionSourceRef } from '../composition.js'
import { readKeyedArrayItems } from './keyed-array-decode.js'
import type { CustomizeAssignmentStatus } from './override-draft.js'
import type { ScalarRead, ScalarSourcePresence } from './scalar-status.js'

export interface KeyedArrayStatusInput {
  readonly cap: string
  readonly targetId: string
  readonly device: CompositionSourceRef
  readonly stored: ScalarRead<CompositionFieldsFeature | null>
  readonly sourcePresence: ScalarSourcePresence
  readonly sourceUnknownReason: string | null
}

export interface KeyedArrayAssignmentProjection {
  readonly text: string
  readonly assignedCount: number
  readonly status: CustomizeAssignmentStatus
}

export function projectKeyedArrayAssignment(
  input: KeyedArrayStatusInput,
): KeyedArrayAssignmentProjection {
  if (input.stored.kind === 'pending') return unanswered(input.targetId, 'pending', null)
  if (input.stored.kind === 'unknown') {
    return unanswered(input.targetId, 'unknown', input.stored.reason ?? 'unknown')
  }
  if (input.stored.value === null) return native(input.targetId)
  const read = readKeyedArrayItems(input.stored.value, input.cap, input.targetId)
  const count = read?.items.filter((item) => item.recognized).length ?? 0
  if (read === null || !read.canonical || count === 0) {
    return {
      text: 'unknown',
      assignedCount: 0,
      status: status(input.targetId, true, 'assigned', 'unavailable', 'not-canonical'),
    }
  }
  return projectDecoded(input, count)
}

function projectDecoded(
  input: KeyedArrayStatusInput,
  count: number,
): KeyedArrayAssignmentProjection {
  const text = `${count} assigned`
  if (input.sourcePresence === 'pending') {
    return {
      text: 'pending',
      assignedCount: count,
      status: status(input.targetId, true, 'assigned', 'stale', null),
    }
  }
  if (input.sourcePresence === 'unknown') {
    return {
      text: 'unknown',
      assignedCount: count,
      status: status(
        input.targetId,
        true,
        'assigned',
        'stale',
        input.sourceUnknownReason ?? 'unknown',
      ),
    }
  }
  if (input.sourcePresence === 'absent') {
    return {
      text,
      assignedCount: count,
      status: status(input.targetId, true, 'assigned', 'unavailable', 'source-missing'),
    }
  }
  return {
    text,
    assignedCount: count,
    status: status(input.targetId, true, 'assigned', 'active', null),
  }
}

function native(targetId: string): KeyedArrayAssignmentProjection {
  return {
    text: 'Native',
    assignedCount: 0,
    status: status(targetId, false, 'native', 'active', null),
  }
}

function unanswered(
  targetId: string,
  text: 'pending' | 'unknown',
  reason: string | null,
): KeyedArrayAssignmentProjection {
  const state = text === 'pending' ? 'unavailable' : 'stale'
  return { text, assignedCount: 0, status: status(targetId, false, 'native', state, reason) }
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
