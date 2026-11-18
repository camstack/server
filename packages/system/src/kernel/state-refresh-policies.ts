/**
 * The providers' state-refresh policies (D1062), as the hub process knows them.
 *
 * A provider states its policy where it registers a device's
 * `device-state-refresh` cap (`ctx.registerNativeCap(cap, provider, {
 * stateRefresh })`). The policy reaches this registry by the road the
 * command-hold options take (D1061): an in-process registration writes here
 * directly (source `in-process`), a forked child carries it on its cap
 * descriptors and the UDS parent replaces the child's whole set on every
 * register frame and drops it when the child goes (source `child:<id>`).
 *
 * The device-manager's scheduler subscribes and reconciles its schedules on
 * every change. Memory only: a restart re-registers every cap.
 */
import type { StateRefreshPolicy } from '@camstack/types'
import type { ChildCapDescriptor } from './transport/child-cap-protocol.js'

/** The cap a policy is stated on. */
export const STATE_REFRESH_CAP = 'device-state-refresh'

/** One device's policy, as a source reports it. */
export interface StateRefreshPolicyEntry {
  readonly deviceId: number
  /** The addon that registered the device's refresh cap. */
  readonly addonId: string
  readonly policy: StateRefreshPolicy
}

/** The source key of an in-process registration. */
export const IN_PROCESS_REFRESH_SOURCE = 'in-process'

/** The source key of a forked child's registrations. */
export function childRefreshSource(childId: string): string {
  return `child:${childId}`
}

/** The policies a child's cap descriptors carry, one entry per device. */
export function childStateRefreshEntries(
  childId: string,
  caps: readonly ChildCapDescriptor[],
): StateRefreshPolicyEntry[] {
  const out: StateRefreshPolicyEntry[] = []
  for (const cap of caps) {
    if (cap.capName !== STATE_REFRESH_CAP) continue
    if (cap.deviceId === undefined || cap.stateRefresh === undefined) continue
    out.push({ deviceId: cap.deviceId, addonId: cap.addonId ?? childId, policy: cap.stateRefresh })
  }
  return out
}

/** Told after every change, with the whole current set. */
export type StateRefreshPolicyListener = () => void

export class StateRefreshPolicyRegistry {
  private readonly bySource = new Map<string, Map<number, StateRefreshPolicyEntry>>()
  private readonly listeners = new Set<StateRefreshPolicyListener>()

  /** Record (or replace) one device's policy from `source`. */
  set(source: string, entry: StateRefreshPolicyEntry): void {
    const perSource = new Map(this.bySource.get(source) ?? [])
    perSource.set(entry.deviceId, entry)
    this.bySource.set(source, perSource)
    this.changed()
  }

  /** Forget one device's policy from `source`. */
  delete(source: string, deviceId: number): void {
    const perSource = this.bySource.get(source)
    if (perSource === undefined || !perSource.has(deviceId)) return
    const next = new Map(perSource)
    next.delete(deviceId)
    if (next.size === 0) this.bySource.delete(source)
    else this.bySource.set(source, next)
    this.changed()
  }

  /** Replace everything `source` reported with `entries` (an empty list forgets the source). */
  replaceSource(source: string, entries: readonly StateRefreshPolicyEntry[]): void {
    const had = this.bySource.has(source)
    if (entries.length === 0) {
      this.bySource.delete(source)
      if (had) this.changed()
      return
    }
    this.bySource.set(source, new Map(entries.map((e) => [e.deviceId, e] as const)))
    this.changed()
  }

  /** Every device's policy (a device registered by two sources keeps the first). */
  entries(): readonly StateRefreshPolicyEntry[] {
    const seen = new Map<number, StateRefreshPolicyEntry>()
    for (const perSource of this.bySource.values()) {
      for (const entry of perSource.values()) {
        if (!seen.has(entry.deviceId)) seen.set(entry.deviceId, entry)
      }
    }
    return [...seen.values()]
  }

  /** One device's policy, or `undefined` when its provider did not migrate. */
  get(deviceId: number): StateRefreshPolicyEntry | undefined {
    for (const perSource of this.bySource.values()) {
      const found = perSource.get(deviceId)
      if (found !== undefined) return found
    }
    return undefined
  }

  subscribe(listener: StateRefreshPolicyListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A listener's failure is its own; the registry stays consistent.
      }
    }
  }
}

let registry: StateRefreshPolicyRegistry | undefined

/** The process-wide registry. */
export function getStateRefreshPolicyRegistry(): StateRefreshPolicyRegistry {
  registry ??= new StateRefreshPolicyRegistry()
  return registry
}

/** Test seam: forget every policy. */
export function __resetStateRefreshPolicyRegistryForTests(): void {
  registry = undefined
}
