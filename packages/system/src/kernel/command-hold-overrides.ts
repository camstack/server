/**
 * The providers' command-hold options (D1061), as the hub process knows them.
 *
 * A provider states its options where it registers a device's native cap
 * (`ctx.registerNativeCap(cap, provider, { commands })`). They reach this
 * registry by the same road the registration does: an in-process registration
 * writes here directly (source `in-process`), a forked child carries them on its
 * cap descriptors and the UDS parent replaces the child's whole set on every
 * register frame and drops it when the child goes (source `child:<id>`). The
 * device-manager's hold reads them; absent = the core default.
 *
 * Memory only, like the holds themselves: a restart re-registers every cap.
 */
import type { CommandHoldOptions } from '@camstack/types'
import type { ChildCapDescriptor } from './transport/child-cap-protocol.js'

/** One device cap's options, as a source reports them. */
export interface CommandHoldOverrideEntry {
  readonly deviceId: number
  readonly capName: string
  readonly commands: CommandHoldOptions
}

/** The source key of an in-process registration. */
export const IN_PROCESS_HOLD_SOURCE = 'in-process'

/** The source key of a forked child's registrations. */
export function childHoldSource(childId: string): string {
  return `child:${childId}`
}

/** The options a child's cap descriptors carry, one entry per device cap. */
export function childCommandHoldEntries(
  caps: readonly ChildCapDescriptor[],
): CommandHoldOverrideEntry[] {
  const out: CommandHoldOverrideEntry[] = []
  for (const cap of caps) {
    if (cap.deviceId === undefined || cap.commandHolds === undefined) continue
    out.push({ deviceId: cap.deviceId, capName: cap.capName, commands: cap.commandHolds })
  }
  return out
}

function keyOf(deviceId: number, capName: string): string {
  return `${deviceId}|${capName}`
}

export class CommandHoldOverrideRegistry {
  private readonly bySource = new Map<string, Map<string, CommandHoldOptions>>()

  /** Record (or replace) one device cap's options from `source`. */
  set(source: string, entry: CommandHoldOverrideEntry): void {
    const perSource = this.bySource.get(source) ?? new Map<string, CommandHoldOptions>()
    perSource.set(keyOf(entry.deviceId, entry.capName), entry.commands)
    this.bySource.set(source, perSource)
  }

  /** Forget one device cap's options from `source`. */
  delete(source: string, deviceId: number, capName: string): void {
    const perSource = this.bySource.get(source)
    if (perSource === undefined) return
    perSource.delete(keyOf(deviceId, capName))
    if (perSource.size === 0) this.bySource.delete(source)
  }

  /** Replace everything `source` reported with `entries` (an empty list forgets the source). */
  replaceSource(source: string, entries: readonly CommandHoldOverrideEntry[]): void {
    if (entries.length === 0) {
      this.bySource.delete(source)
      return
    }
    this.bySource.set(
      source,
      new Map(entries.map((e) => [keyOf(e.deviceId, e.capName), e.commands] as const)),
    )
  }

  /** The options for a device cap, from whichever source registered it; `undefined` = default. */
  get(deviceId: number, capName: string): CommandHoldOptions | undefined {
    const key = keyOf(deviceId, capName)
    for (const perSource of this.bySource.values()) {
      const found = perSource.get(key)
      if (found !== undefined) return found
    }
    return undefined
  }
}

let registry: CommandHoldOverrideRegistry | undefined

/** The process-wide registry. */
export function getCommandHoldOverrideRegistry(): CommandHoldOverrideRegistry {
  registry ??= new CommandHoldOverrideRegistry()
  return registry
}

/** Test seam: forget every option. */
export function __resetCommandHoldOverrideRegistryForTests(): void {
  registry = undefined
}
