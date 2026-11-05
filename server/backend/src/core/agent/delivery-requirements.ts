/**
 * Which planned deliveries a node's server can actually run (D989).
 *
 * The hub delivers addon versions to an agent; a version that declares
 * `camstack.requires.server` above what that agent runs would be installed
 * onto a server that cannot host it. Such a delivery is HELD, with the
 * versions on both sides named, and goes through once the node's server has
 * been updated. The same holds for `requires.addons`: a version that needs an
 * addon package newer than the node's live roster holds (or than the same batch
 * delivers) waits. A node that does not report its server version cannot be
 * judged, and an unjudged node never passes a declared minimum.
 */
import {
  describeUnmet,
  unmetRequirements,
  type PackageRequires,
  type UnmetRequirement,
} from '@camstack/types'

export interface DeliveryTarget {
  readonly name: string
  readonly version: string
}

export interface HeldDelivery<T extends DeliveryTarget> {
  readonly target: T
  readonly unmet: readonly UnmetRequirement[]
  readonly reason: string
}

export interface DeliveryRequirementSplit<T extends DeliveryTarget> {
  readonly deliver: readonly T[]
  readonly held: readonly HeldDelivery<T>[]
}

/** One package the node reports it has installed; `version: null` is an unreadable copy. */
export interface RosterEntry {
  readonly name: string
  readonly version: string | null
}

export type RequiresOf = (name: string, version: string) => Promise<PackageRequires | undefined>

export async function splitByNodeRequirements<T extends DeliveryTarget>(
  targets: readonly T[],
  nodeServerVersion: string | null,
  requiresOf: RequiresOf,
  roster: readonly RosterEntry[] = [],
): Promise<DeliveryRequirementSplit<T>> {
  // What the node will hold once this batch lands: its live roster, then the batch on top.
  const addons: Record<string, string | null> = {}
  for (const entry of roster) addons[entry.name] = entry.version
  for (const target of targets) addons[target.name] = target.version
  const deliver: T[] = []
  const held: HeldDelivery<T>[] = []
  for (const target of targets) {
    const unmet = unmetRequirements(await requiresOf(target.name, target.version), {
      server: nodeServerVersion,
      addons,
      wrapper: null,
    }).filter((u) => u.kind === 'server-too-old' || u.kind === 'addon-too-old')
    if (unmet.length === 0) {
      deliver.push(target)
      continue
    }
    held.push({
      target,
      unmet,
      reason: `${target.name}@${target.version} held: ${unmet.map(describeUnmet).join('; ')}`,
    })
  }
  return { deliver, held }
}
