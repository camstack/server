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
 * Add the live children to the stored map. MERGE only: a child that is no longer
 * live keeps its entry, because that is exactly the entry that recognises its
 * deletion. An entry leaves the map only through {@link dismissDeletedChildren}
 * or {@link pruneChildDeviceIds} (the entity is gone from HA).
 */
export function mergeChildDeviceIds(
  stored: Readonly<Record<string, number>>,
  live: Readonly<Record<string, number>>,
): Record<string, number> {
  return { ...stored, ...live }
}

/** Drop the entries of entities that are no longer part of the container. */
export function pruneChildDeviceIds(
  map: Readonly<Record<string, number>>,
  entityIds: ReadonlySet<string>,
): Record<string, number> {
  return Object.fromEntries(Object.entries(map).filter(([entityId]) => entityIds.has(entityId)))
}

/**
 * The one dismissal both the re-sync and the probe run: read the tombstones and
 * dismiss. A failed read throws: the caller changes nothing and says so.
 */
export async function settleDeletedChildren<E extends { readonly entityId: string }>(
  state: DismissalState<E>,
  listDeleted: () => Promise<readonly { readonly deviceId: number }[]>,
): Promise<DismissalResult<E> | null> {
  if (Object.keys(state.childDeviceIds).length === 0) return null
  const deleted = await listDeleted()
  return dismissDeletedChildren(state, new Set(deleted.map((t) => t.deviceId)))
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

/** A stored config value read as an entity to device id map; anything else is empty. */
export function parseChildDeviceIds(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, number> = {}
  for (const [entityId, id] of Object.entries(value)) {
    if (typeof id === 'number' && Number.isInteger(id)) out[entityId] = id
  }
  return out
}

/** A stored config value read as a list of strings; anything else is empty. */
export function parseStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
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
