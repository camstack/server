/**
 * Which planned deliveries a node's server can actually run (D989).
 *
 * The hub delivers addon versions to an agent; a version that declares
 * `camstack.requires.server` above what that agent runs would be installed
 * onto a server that cannot host it. Such a delivery is HELD, with the
 * versions on both sides named, and goes through once the node's server has
 * been updated. A node that does not report its server version cannot be
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

export type RequiresOf = (name: string, version: string) => Promise<PackageRequires | undefined>

export async function splitByNodeRequirements<T extends DeliveryTarget>(
  targets: readonly T[],
  nodeServerVersion: string | null,
  requiresOf: RequiresOf,
): Promise<DeliveryRequirementSplit<T>> {
  const deliver: T[] = []
  const held: HeldDelivery<T>[] = []
  for (const target of targets) {
    const unmet = unmetRequirements(await requiresOf(target.name, target.version), {
      server: nodeServerVersion,
      // What the node runs of other addons is not known here; only the server binds a delivery.
      addons: {},
      wrapper: null,
    }).filter((u) => u.kind === 'server-too-old')
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
