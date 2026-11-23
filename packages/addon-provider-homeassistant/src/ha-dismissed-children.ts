/**
 * A container child the operator deleted stays deleted.
 *
 * A Container's children are an accessory PROJECTION of its persisted
 * `entities[]`: the kernel spawns whatever the list names, so a child the
 * operator removed (a tombstone, D865) came back as a NEW device on the next
 * reprobe or re-sync. The container therefore remembers the deletion in its own
 * config: the entity moves from `entities` to `dismissedEntityIds`, and every
 * later sync filters the fresh HA inventory through that list.
 *
 * The deleted child's row is gone, so the entity is recognised through
 * `childDeviceIds` (entity id to numeric device id, stamped by the re-sync while
 * the child still exists) matched against the tombstoned device ids.
 */

export interface DismissalState<E extends { readonly entityId: string }> {
  readonly entities: readonly E[]
  readonly childDeviceIds: Readonly<Record<string, number>>
  readonly dismissedEntityIds: readonly string[]
}

export interface DismissalResult<E extends { readonly entityId: string }>
  extends DismissalState<E> {
  /** The entities newly dismissed by this call. */
  readonly dismissed: readonly string[]
}

/** The entity to device id map of the live children of `parentStableId`. */
export function childDeviceIdsByEntity(
  parentStableId: string,
  children: readonly { readonly id: number; readonly stableId: string }[],
): Record<string, number> {
  const prefix = `${parentStableId}-`
  const out: Record<string, number> = {}
  for (const child of children) {
    if (child.stableId.startsWith(prefix)) out[child.stableId.slice(prefix.length)] = child.id
  }
  return out
}

/**
 * Dismiss the entities whose recorded child was deleted. Returns `null` when
 * nothing was deleted, so the caller writes nothing.
 */
export function dismissDeletedChildren<E extends { readonly entityId: string }>(
  state: DismissalState<E>,
  tombstonedDeviceIds: ReadonlySet<number>,
): DismissalResult<E> | null {
  const dismissed = Object.entries(state.childDeviceIds)
    .filter(([, deviceId]) => tombstonedDeviceIds.has(deviceId))
    .map(([entityId]) => entityId)
  if (dismissed.length === 0) return null
  const gone = new Set(dismissed)
  return {
    entities: state.entities.filter((e) => !gone.has(e.entityId)),
    childDeviceIds: Object.fromEntries(
      Object.entries(state.childDeviceIds).filter(([entityId]) => !gone.has(entityId)),
    ),
    dismissedEntityIds: [...new Set([...state.dismissedEntityIds, ...dismissed])],
    dismissed,
  }
}

/** The fresh HA inventory without what the operator deleted. */
export function withoutDismissed<E extends { readonly entityId: string }>(
  entities: readonly E[],
  dismissedEntityIds: readonly string[],
): E[] {
  if (dismissedEntityIds.length === 0) return [...entities]
  const gone = new Set(dismissedEntityIds)
  return entities.filter((e) => !gone.has(e.entityId))
}
