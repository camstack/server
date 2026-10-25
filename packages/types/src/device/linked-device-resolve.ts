/**
 * Which devices a camera's LINKED set resolves to — the pure rules, with no
 * store and no provider context.
 *
 * They live in `@camstack/types` rather than in the device-manager builtin
 * because two surfaces need the SAME answer and a second copy would be a
 * second definition of what a room contains: the hub's boot backfill, and the
 * admin UI's per-room rebuild. Moving them here also keeps that button a
 * framework-free change — a new cap method would only reach a node through a
 * published `@camstack/server` and a restart (D16), which is not what a
 * convenience button is worth.
 */
import { DeviceType } from './device-type.js'
import { resolveContainerPrimaryChild } from './container-primary-child.js'

/** The device fields the pure resolver consumes (subset of `DeviceInfo`). */
export interface LinkCandidate {
  readonly id: number
  readonly parentDeviceId: number | null
  readonly location: string | null
  readonly type: DeviceType
  /**
   * The child identity a container's stored pick is matched against. A NOT
   * NULL column, so `slim` carries it — which is the whole reason the pick is
   * keyed on it (see `ContainerChildRef.stableId`).
   */
  readonly stableId: string
  /** The container's own operator pick, when one was made. */
  readonly primaryChildEntityId?: string | null
  /**
   * The child's `DeviceRole`. Ranked ABOVE `type` when a container picks the
   * child it stands for, because `DeviceType` cannot tell a door contact from a
   * battery reading — Home Assistant maps both to `Sensor`. A first-class meta
   * column, so `slim` carries it.
   */
  readonly role?: string | null | undefined
  /** Operator-facing name — used for the namesake tiebreak. Also a column. */
  readonly name?: string
}

/**
 * Resolve one candidate id to the ids it should actually contribute to a
 * linked set: itself, unless it is a CONTAINER, in which case its own
 * children (recursively expanded the same way — a container-of-containers
 * is vanishingly unlikely per `DeviceType.Container`'s contract, but this
 * costs nothing to handle). `visited` guards a pathological parent-cycle in
 * persisted data from recursing forever; a candidate already on the current
 * expansion path is dropped rather than re-expanded.
 *
 * This is the STRUCTURAL, location-independent way a container's child
 * becomes reachable: the device-tree "children of the camera" rule and a
 * persisted manual pick are parentDeviceId chains, never location-based —
 * a container named there is excluded by expanding into whatever it
 * actually contains, regardless of what its (or its children's) `location`
 * column holds.
 */
export function expandContainer(
  id: number,
  byId: ReadonlyMap<number, LinkCandidate>,
  byParent: ReadonlyMap<number, readonly LinkCandidate[]>,
  visited: ReadonlySet<number>,
  out: Set<number>,
): void {
  if (visited.has(id)) return
  const candidate = byId.get(id)
  if (!candidate) return
  if (candidate.type !== DeviceType.Container) {
    out.add(id)
    return
  }
  const nextVisited = new Set(visited)
  nextVisited.add(id)
  const children = byParent.get(id) ?? []
  // ONE child, not all of them. A container groups a defining actuator with its
  // auxiliaries — a climate plus battery, link-quality, schedule, two "last
  // seen" and three temperature entities — and contributing every one of them
  // gave the operator a dozen rows for one appliance, none of which WAS the
  // appliance. "Expand it" and "expand it into everything" are different
  // answers; only the first is a list anybody can use.
  //
  // The choice is `resolveContainerPrimaryChild`, the same rule admin-ui
  // renders a container AS, so the two surfaces name the same child.
  //
  // The operator's stored pick wins; priority only decides in its absence.
  //
  // Both halves survive the `slim` projection this module must use: the pick
  // is a column on the CONTAINER's row, and `stableId` is a column on each
  // child's. That matters — keying the match on `sourceInfo.id` instead would
  // have needed the config blob `slim` deliberately does not read (a measured
  // 36 814 queries/minute), and 677 of 925 live container children have a
  // `sourceInfo.id` that differs from their `stableId`, so it would have
  // missed the pick three times in four while looking like it worked.
  const primary = resolveContainerPrimaryChild(
    children.map((c) => ({
      id: c.id,
      stableId: c.stableId,
      type: c.type,
      ...(c.role !== undefined && c.role !== null ? { role: c.role } : {}),
      ...(c.name !== undefined ? { name: c.name } : {}),
    })),
    byId.get(id)?.primaryChildEntityId,
    byId.get(id)?.name,
  )
  if (primary !== null) expandContainer(primary.id, byId, byParent, nextVisited, out)
}

/**
 * What the retired `auto` mode (pre-D356) added beyond the device-tree
 * children: every non-container candidate sharing the camera's location, a
 * container child standing in for its container's PRIMARY child.
 *
 * Two callers, both WRITERS, never the read path: the one-shot boot backfill
 * that materialises it into the manual list
 * (`linked-devices-manual-backfill.ts`), and the admin UI's per-room rebuild.
 * Both ask "what does this room contain", and a second copy of the answer is
 * how two surfaces start disagreeing about a room.
 *
 * A camera with NO location answers `[]`. A caller that would WRITE that must
 * refuse instead: emptying a list because nobody set the room is the silent
 * drop D391 names.
 */
export function legacyAutoLinkIds(params: {
  readonly selfId: number
  readonly selfLocation: string | null
  readonly candidates: readonly LinkCandidate[]
}): readonly number[] {
  const { selfId, selfLocation, candidates } = params
  if (selfLocation === null || selfLocation.length === 0) return []
  const byId = new Map<number, LinkCandidate>(candidates.map((c) => [c.id, c]))
  const byParent = new Map<number, LinkCandidate[]>()
  for (const c of candidates) {
    if (c.parentDeviceId === null) continue
    const siblings = byParent.get(c.parentDeviceId)
    if (siblings) siblings.push(c)
    else byParent.set(c.parentDeviceId, [c])
  }
  const ids = new Set<number>()
  const expand = (id: number): void => expandContainer(id, byId, byParent, new Set(), ids)
  for (const c of candidates) {
    if (c.type === DeviceType.Container) continue
    if (c.location !== selfLocation) continue
    if (c.parentDeviceId === selfId) continue
    const parent = c.parentDeviceId !== null ? byId.get(c.parentDeviceId) : undefined
    if (parent !== undefined && parent.type === DeviceType.Container) {
      expand(parent.id)
      continue
    }
    ids.add(c.id)
  }
  ids.delete(selfId)
  return [...ids]
}
