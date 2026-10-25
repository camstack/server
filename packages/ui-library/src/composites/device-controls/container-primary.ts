/**
 * Container → primary-child resolution glue.
 *
 * A CONTAINER device hosts N entity-children and renders AS its primary child
 * (same row InlineControl, same detail HeroCard). The choice of primary child:
 *
 *   - DEFAULT: the highest-priority child by type (lock > climate > light > …),
 *     via the pure {@link resolvePrimaryChild} resolver (Task 4.1).
 *   - OVERRIDE: an operator picks a child via the discreet primary-child picker.
 *     The override is persisted on the container's `linkDeviceId` field (the
 *     real, kernel-backed soft-link — see `device-manager.cap.ts` `setLinkDeviceId`).
 *
 * The source of truth for the override is the child's re-sync-stable `entityId`
 * (its `sourceInfo.id`, falling back to `stableId`).
 *
 * DURABLE (preferred): the container persists the chosen child's `entityId`
 * directly on its `primaryChildEntityId` meta field (see
 * `device-manager.setPrimaryChildEntityId`). This survives a re-sync/rename
 * that reallocates the child's numeric id — the resolver matches on entityId.
 *
 * LEGACY (fallback): older picks persist the numeric child id on `linkDeviceId`.
 * At RENDER we re-derive the entityId from the live child set so a re-sync that
 * KEEPS the numeric id still resolves; when the linked numeric id no longer
 * matches any live child (stale link), we pass `undefined` to the resolver → it
 * falls back to the priority default.
 *
 * Resolution prefers `primaryChildEntityId` and only consults `linkDeviceId`
 * when no durable override is present, so existing persisted links keep working.
 */
import type { ChildRef } from './primary-child'
import { resolvePrimaryChild } from './primary-child'

/**
 * Minimal shape this module needs from a child device row. Structurally
 * compatible with `DeviceItemDevice` / `DeviceInfo` — callers pass the raw
 * `getChildren` rows through.
 */
export interface ContainerChild {
  readonly id: number
  readonly stableId: string
  readonly type: string
  readonly sourceInfo?: { readonly id: string } | undefined
  /** `DeviceRole`, ranked above `type` when picking a container's primary. */
  readonly role?: string | null | undefined
  /** Operator-facing name — used for the namesake tiebreak. */
  readonly name?: string | undefined
}

/**
 * Re-sync-stable identity of a child. Prefers the upstream-system dispatch key
 * (`sourceInfo.id` — e.g. HA `entity_id`); falls back to `stableId` for
 * providers that never populated SourceInfo. Both survive a re-sync that may
 * reallocate the numeric `id`.
 */
export function childEntityId(child: ContainerChild): string {
  return child.sourceInfo?.id ?? child.stableId
}

/** Project a raw child row onto the pure resolver's {@link ChildRef} shape. */
export function containerChildToRef(child: ContainerChild): ChildRef {
  return {
    id: child.id,
    entityId: childEntityId(child),
    type: child.type,
    ...(child.role !== undefined && child.role !== null ? { role: child.role } : {}),
    ...(child.name !== undefined ? { name: child.name } : {}),
  }
}

/**
 * Resolve the entityId override from the container's persisted `linkDeviceId`.
 * Returns the linked child's stable entityId, or `undefined` when there is no
 * link or the link is stale (points to a numeric id no longer present) — in
 * which case the resolver falls back to the priority default.
 */
export function overrideEntityIdFromLink(
  children: readonly ContainerChild[],
  linkDeviceId: number | null | undefined,
): string | undefined {
  if (linkDeviceId === null || linkDeviceId === undefined) return undefined
  const linked = children.find((c) => c.id === linkDeviceId)
  return linked === undefined ? undefined : childEntityId(linked)
}

/**
 * Full container → primary-child resolution: project children to refs, resolve
 * the override entityId, and delegate to the pure resolver. Returns `null` for a
 * container with no children (caller degrades gracefully).
 *
 * Override precedence:
 *   1. `primaryChildEntityId` — the DURABLE override (re-sync/rename-stable),
 *      passed straight to the resolver which matches on `entityId`. Wins when a
 *      non-empty string is supplied.
 *   2. `linkDeviceId` — LEGACY numeric override, re-derived to an entityId from
 *      the live child set. Consulted only when there is no durable override.
 *
 * When neither resolves to a live child, the resolver falls back to the
 * priority default.
 */
export function resolveContainerPrimary(
  children: readonly ContainerChild[],
  linkDeviceId: number | null | undefined,
  primaryChildEntityId?: string | null | undefined,
): ChildRef | null {
  const refs = children.map(containerChildToRef)
  const override =
    primaryChildEntityId !== null &&
    primaryChildEntityId !== undefined &&
    primaryChildEntityId !== ''
      ? primaryChildEntityId
      : overrideEntityIdFromLink(children, linkDeviceId)
  return resolvePrimaryChild(refs, override)
}
