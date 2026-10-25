/**
 * Server-side eligibility for discarding a frozen location's leftover
 * class subtree. Same rules as the admin-ui card: frozen, known class,
 * writable sibling of the same type. The last writable of a type is
 * refused here even if the UI is bypassed.
 */
import type { StorageLocationMode } from '@camstack/types'
import { evictionPolicyOfLocation, mayWriteToLocation } from '@camstack/types'

export const DISCARD_SUBTREES: Readonly<Record<string, readonly string[]>> = {
  eventMedia: ['events'],
  recordingsLow: ['low'],
  recordings: ['high', 'mid'],
}

export interface DiscardLocationRow {
  readonly id: string
  readonly type: string
  /** The state (D385). Absent on a row that predates the stamp — the policy
   *  module folds the legacy pair below for it. */
  readonly mode?: StorageLocationMode
  readonly enabled?: boolean
  readonly config: Readonly<Record<string, unknown>>
  readonly nodeId?: string
}

/** Frozen = the system will not remove this footage on its own: eviction
 *  policy `never` (D385), i.e. `readonly` or `disabled`. A `drain` location is
 *  NOT frozen — the ratchet is already removing it. */
export function locationIsFrozen(location: DiscardLocationRow): boolean {
  return evictionPolicyOfLocation(location) === 'never'
}

export function discardEligible(
  location: DiscardLocationRow,
  siblings: readonly DiscardLocationRow[],
): boolean {
  if (!(location.type in DISCARD_SUBTREES)) return false
  if (!locationIsFrozen(location)) return false
  return siblings.some((s) => {
    if (s.id === location.id) return false
    if (s.type !== location.type) return false
    return mayWriteToLocation(s)
  })
}

export function assertDiscardAllowed(
  location: DiscardLocationRow,
  all: readonly DiscardLocationRow[],
  localNodeId: string,
): void {
  if (
    !discardEligible(
      location,
      all.filter((s) => s.type === location.type),
    )
  ) {
    throw new Error(
      `discard refused: ${location.id} is not a frozen location with a writable sibling of type ${location.type}`,
    )
  }
  const nodeId = location.nodeId ?? 'hub'
  if (nodeId !== localNodeId) {
    throw new Error(
      `discard refused: ${location.id} lives on node ${nodeId}, this process is ${localNodeId}`,
    )
  }
}

export function locationBasePath(location: DiscardLocationRow): string {
  const basePath = location.config['basePath']
  if (typeof basePath !== 'string' || basePath.length === 0) {
    throw new Error(`discard refused: ${location.id} has no basePath`)
  }
  return basePath
}
