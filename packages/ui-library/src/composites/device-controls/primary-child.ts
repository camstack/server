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

import {
  CONTAINER_CHILD_PRIORITY,
  resolveContainerPrimaryChild,
  type ContainerPrimaryChildPreference,
} from '@camstack/types'

/** The shared precedence, under this module's historical name. */
export const PRIORITY: readonly string[] = CONTAINER_CHILD_PRIORITY

export interface ChildRef {
  readonly id: number
  readonly entityId: string
  /**
   * The child's own `stableId` — the key a pick is persisted under. Distinct
   * from `entityId` whenever the integration populates `sourceInfo.id`
   * (ESPHome children do), so it must travel separately.
   */
  readonly stableId?: string | undefined
  readonly type: string
  /** `DeviceRole`, ranked ABOVE `type` — see `CONTAINER_CHILD_ROLE_PRIORITY`. */
  readonly role?: string | undefined
  /** Operator-facing name — used for the namesake tiebreak. */
  readonly name?: string | undefined
}

/**
 * Resolve a container's primary child: the operator's pick when it still
 * matches a live child, else the container's declared preference, else the
 * type's declaration, else the highest-priority type. `containerType` is required so a caller cannot skip the declaration.
 *
 * `entityId` here is `sourceInfo?.id ?? stableId` (see `containerChildToRef`);
 * `stableId` is the child's own. The shared resolver matches the canonical
 * `stableId` key first and accepts the `entityId` as the legacy value, so a pick stored under either keeps resolving.
 */
export function resolvePrimaryChild(
  children: readonly ChildRef[],
  overrideEntityId: string | undefined,
  containerName: string | undefined,
  containerType: string | undefined,
  preference: ContainerPrimaryChildPreference | undefined,
): ChildRef | null {
  const picked = resolveContainerPrimaryChild(
    children.map((c) => ({
      id: c.id,
      stableId: c.stableId ?? c.entityId,
      entityId: c.entityId,
      type: c.type,
      ...(c.role !== undefined ? { role: c.role } : {}),
      ...(c.name !== undefined ? { name: c.name } : {}),
    })),
    overrideEntityId,
    containerName,
    containerType,
    preference,
  )
  return picked === null ? null : (children.find((c) => c.id === picked.id) ?? null)
}
