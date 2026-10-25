/**
 * Which child a container is rendered AS — this surface's name for the shared
 * rule.
 *
 * The list and the resolution used to live here, in a COPY that carried a
 * comment asking the Home Assistant adoption mapping and the viewer's panel to
 * stay in sync with it. Three lists and three comments is not one rule, it is
 * three chances to drift. Both now come from `@camstack/types`, which all of
 * them already depend on; what remains here is the adapter for this module's
 * historical `ChildRef` shape.
 */

import { CONTAINER_CHILD_PRIORITY, resolveContainerPrimaryChild } from '@camstack/types'

/** The shared precedence, under this module's historical name. */
export const PRIORITY: readonly string[] = CONTAINER_CHILD_PRIORITY

export interface ChildRef {
  readonly id: number
  readonly entityId: string
  readonly type: string
  /** `DeviceRole`, ranked ABOVE `type` — see `CONTAINER_CHILD_ROLE_PRIORITY`. */
  readonly role?: string | undefined
  /** Operator-facing name — used for the namesake tiebreak. */
  readonly name?: string | undefined
}

/**
 * Resolve a container's primary child: the operator's pick when it still
 * matches a live child, else the highest-priority type.
 *
 * `entityId` here is `sourceInfo?.id ?? stableId` (see `containerChildToRef`).
 * The shared resolver matches its canonical `stableId` key first and accepts
 * that legacy value too, so a pick stored under either keeps resolving.
 */
export function resolvePrimaryChild(
  children: readonly ChildRef[],
  overrideEntityId: string | undefined,
  containerName?: string,
): ChildRef | null {
  const picked = resolveContainerPrimaryChild(
    children.map((c) => ({
      id: c.id,
      stableId: c.entityId,
      type: c.type,
      ...(c.role !== undefined ? { role: c.role } : {}),
      ...(c.name !== undefined ? { name: c.name } : {}),
    })),
    overrideEntityId,
    containerName,
  )
  return picked === null ? null : (children.find((c) => c.id === picked.id) ?? null)
}
