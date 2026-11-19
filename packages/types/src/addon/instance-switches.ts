/**
 * The process-local copy of the on/off state of the instances this process serves (D1066).
 *
 * The hub registry row, keyed by (addon, integration id) like a device, is the ONLY stored switch of
 * an instance. An addon keeps no field of its own: it learns the state from the registry at boot
 * ({@link hydrateInstanceSwitches}) and afterwards from the hub's `setInstanceEnabled` notification
 * ({@link recordRegistrySwitch}). A read inside a method the hub calls into is therefore a memory
 * read, never a call back to the hub.
 *
 * Fail closed: while an addon of this process has begun hydrating and the registry has not answered
 * ({@link beginHydration} without {@link hydrateInstanceSwitches}), an id nobody stated reads as OFF.
 * Once every hydration answered, an id nobody stated is a fresh instance and reads as on.
 */
import type { DefinedRecordKind } from '../records/record-kind.js'

const SWITCHES = new Map<string, boolean>()
/** The ids the registry is known to hold a row for (hydrated, or told by the hub). */
const ROWS = new Set<string>()
/** The addons that began hydrating and have not been answered yet. */
const PENDING = new Set<string>()

/** An addon is about to ask the registry for its rows: until it is answered, unknown ids are off. */
export function beginHydration(ownerId: string): void {
  PENDING.add(ownerId)
}

/** The switch of `id` as this process knows it; unknown reads off until hydrated, then on. */
export function isInstanceOn(id: string): boolean {
  const stated = SWITCHES.get(id)
  return stated === undefined ? PENDING.size === 0 : stated
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
}

/** Seed the store from the registry rows of `ownerId`; the registry answered, so the owner is known. */
export function hydrateInstanceSwitches(
  rows: readonly { readonly id: string; readonly enabled: boolean }[],
): void {
  for (const row of rows) recordRegistrySwitch(row.id, row.enabled)
}

/** The addon's boot has built every instance kind and read the registry: unknown ids now read on. */
export function settleHydration(ownerId: string): void {
  PENDING.delete(ownerId)
}

/** Spec seam: start from an empty store. */
export function clearInstanceSwitches(): void {
  SWITCHES.clear()
  ROWS.clear()
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
}

/** The instance kinds announced for `ownerId` so far. */
export function servedInstanceKindsOf(ownerId: string): readonly ServedInstanceKind[] {
  return [...(KINDS.get(ownerId)?.values() ?? [])]
}

/** Spec seam: forget every served kind announced so far. */
export function clearServedInstanceKinds(): void {
  KINDS.clear()
}
