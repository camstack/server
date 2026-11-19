/**
 * The process-local copy of the on/off state of the instances this process serves (D1066).
 *
 * The hub registry row, keyed by (addon, integration id) like a device, is the ONLY stored switch of
 * an instance. An addon keeps no field of its own: it learns the state from the registry at boot
 * ({@link hydrateInstanceSwitches}) and afterwards from the hub's `setInstanceEnabled` notification
 * ({@link recordRegistrySwitch}). A read inside a method the hub calls into is therefore a memory
 * read, never a call back to the hub.
 *
 * Fail closed, per owner: while an addon that serves an instance kind has not been answered by the
 * registry, an id of that addon nobody stated reads as OFF. Once it answered, an id nobody stated is
 * a fresh instance and reads as on. An addon with no instance kind is never held back.
 */
import type { DefinedRecordKind } from '../records/record-kind.js'

const SWITCHES = new Map<string, boolean>()
/** The ids the registry is known to hold a row for (hydrated, or told by the hub). */
const ROWS = new Set<string>()
/** The owner addon of an id, learned from its rows and from the helper that serves it. */
const OWNER_OF = new Map<string, string>()
/** The addons whose registry read answered at least once. */
const ANSWERED = new Set<string>()
/** The addons whose boot has begun reading the registry: only they can be held back. */
const HYDRATING = new Set<string>()
/**
 * The addons that serve an instance kind and have not been answered by the registry yet. Scoped
 * per owner: one addon's failed read never turns off another addon's instances, and an addon that
 * serves no instance kind never enters it.
 */
const PENDING = new Set<string>()

/**
 * An addon's boot is about to read the registry for its rows. From now on, until the registry
 * answers, its served instance kinds (already built or built later in its boot) fail closed. A
 * helper used with no addon boot around it (a spec, a tool) is never held back.
 */
export function beginHydration(ownerId: string): void {
  if (ANSWERED.has(ownerId)) return
  HYDRATING.add(ownerId)
  if (KINDS.has(ownerId)) PENDING.add(ownerId)
}

/** The helper of `ownerId` serves `id`: its fail-closed window is that owner's, not the process's. */
export function claimInstance(ownerId: string, id: string): void {
  OWNER_OF.set(id, ownerId)
}

/** Whether `ownerId` still waits for the registry to answer (it serves a kind and has no rows yet). */
export function isHydrationPending(ownerId: string): boolean {
  return PENDING.has(ownerId)
}

/** The owners still waiting for the registry. */
export function pendingHydrationOwners(): readonly string[] {
  return [...PENDING]
}

/**
 * The switch of `id` as this process knows it. An id nobody stated reads off while ITS owner waits
 * for the registry, on afterwards (a fresh instance). An id with no known owner reads off while any
 * owner waits.
 */
export function isInstanceOn(id: string): boolean {
  const stated = SWITCHES.get(id)
  if (stated !== undefined) return stated
  const owner = OWNER_OF.get(id)
  return owner === undefined ? PENDING.size === 0 : !PENDING.has(owner)
}

/** Record a state this process holds for `id` (a local mirror; the registry may not have a row yet). */
export function recordInstanceSwitch(id: string, enabled: boolean): void {
  SWITCHES.set(id, enabled)
}

/** Record what the hub told: the registry holds a row of `id` in this state. */
export function recordRegistrySwitch(id: string, enabled: boolean): void {
  SWITCHES.set(id, enabled)
  ROWS.add(id)
}

/** Whether the registry is known to hold a row for `id`. */
export function hasRegistryRow(id: string): boolean {
  return ROWS.has(id)
}

/** The state this process holds for `id`, or undefined when it holds none. */
export function statedInstanceSwitch(id: string): boolean | undefined {
  return SWITCHES.get(id)
}

/** Forget `id` (the instance was deleted). */
export function forgetInstanceSwitch(id: string): void {
  SWITCHES.delete(id)
  ROWS.delete(id)
  OWNER_OF.delete(id)
}

/** Seed the store from the registry rows of `ownerId`; the registry answered, so the owner is known. */
export function hydrateInstanceSwitches(
  ownerId: string,
  rows: readonly { readonly id: string; readonly enabled: boolean }[],
): void {
  ANSWERED.add(ownerId)
  for (const row of rows) {
    recordRegistrySwitch(row.id, row.enabled)
    OWNER_OF.set(row.id, ownerId)
  }
}

/** The addon's boot has built every instance kind and read the registry: unknown ids now read on. */
export function settleHydration(ownerId: string): void {
  PENDING.delete(ownerId)
}

/** Spec seam: start from an empty store. */
export function clearInstanceSwitches(): void {
  SWITCHES.clear()
  ROWS.clear()
  OWNER_OF.clear()
  ANSWERED.clear()
  HYDRATING.clear()
  PENDING.clear()
}

/** A record of a served kind with no registry row: adopted with the state it effectively had. */
export interface UnrowedInstance {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
}

/** An instance kind an addon serves through {@link RecordIntegrationInstances}. */
export interface ServedInstanceKind {
  readonly kind: DefinedRecordKind
  /** Tell the helper's switch listeners the state of every instance of its kind, on and off. */
  readonly reapply: () => Promise<void>
  /** The records of this kind the registry holds no row for, with the state this process holds. */
  readonly unrowed: () => Promise<readonly UnrowedInstance[]>
}

const KINDS = new Map<string, Map<string, ServedInstanceKind>>()

/**
 * A helper announces the kind it serves, by owner addon. The one-time body-to-registry move
 * (D1066) walks exactly these kinds, so an addon needs no list of its own: a record kind IS an
 * instance kind precisely when a helper wraps it.
 */
export function registerServedInstanceKind(ownerId: string, served: ServedInstanceKind): void {
  const owned = KINDS.get(ownerId) ?? new Map<string, ServedInstanceKind>()
  owned.set(served.kind.name, served)
  KINDS.set(ownerId, owned)
  if (HYDRATING.has(ownerId) && !ANSWERED.has(ownerId)) PENDING.add(ownerId)
}

/** The instance kinds announced for `ownerId` so far. */
export function servedInstanceKindsOf(ownerId: string): readonly ServedInstanceKind[] {
  return [...(KINDS.get(ownerId)?.values() ?? [])]
}

/** Spec seam: forget every served kind announced so far. */
export function clearServedInstanceKinds(): void {
  KINDS.clear()
}
