/**
 * The process-local copy of the on/off state of the instances this process serves (D1066).
 *
 * The hub registry row, keyed by (addon, integration id) like a device, is the ONLY stored switch of
 * an instance. An addon keeps no field of its own: it learns the state from the registry once at boot
 * ({@link hydrateInstanceSwitches}) and afterwards from the hub's `setInstanceEnabled` notification,
 * which {@link RecordIntegrationInstances} turns into {@link recordInstanceSwitch}. A read inside a
 * method the hub calls into is therefore a memory read, never a call back to the hub.
 *
 * An id nobody stated reads as on: a freshly created instance, or an addon that booted before the
 * registry answered.
 */
import type { DefinedRecordKind } from '../records/record-kind.js'

const SWITCHES = new Map<string, boolean>()

/** The switch of `id` as this process knows it; on when never stated. */
export function isInstanceOn(id: string): boolean {
  return SWITCHES.get(id) !== false
}

/** Record the state a notification or a registry read stated for `id`. */
export function recordInstanceSwitch(id: string, enabled: boolean): void {
  SWITCHES.set(id, enabled)
}

/** Forget `id` (the instance was deleted). */
export function forgetInstanceSwitch(id: string): void {
  SWITCHES.delete(id)
}

/** Seed the store from the registry rows of this addon; a row states what the registry holds. */
export function hydrateInstanceSwitches(
  rows: readonly { readonly id: string; readonly enabled: boolean }[],
): void {
  for (const row of rows) SWITCHES.set(row.id, row.enabled)
}

/** Spec seam: start from an empty store. */
export function clearInstanceSwitches(): void {
  SWITCHES.clear()
}

/** An instance kind an addon serves through {@link RecordIntegrationInstances}. */
export interface ServedInstanceKind {
  readonly kind: DefinedRecordKind
  /** Fire the helper's switch listeners for every instance of its kind that is off in the store. */
  readonly reapplyOff: () => Promise<void>
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
