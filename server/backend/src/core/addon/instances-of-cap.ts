/**
 * The hub's resolver of the instances of a function cap (D1013 rule 5). It binds the registry to the
 * one rule in `@camstack/types` (`instancesOfCap`): every holder of `integration-instances` that also
 * provides the cap describes its kinds, and the instances of a kind of that cap are the answer. A
 * holder that cannot answer is reported, never skipped (D315, D49).
 */
import { type InstanceSource, instancesOfCap, type InstancesOfCapResult } from '@camstack/types'
import {
  holdersOf,
  type InstanceHolder,
  type InstanceHolderRegistry,
} from './instance-links.service.js'

/** The registry surface the resolver reads: the collection entries of a cap. */
export type InstancesOfCapRegistry = InstanceHolderRegistry

function holderNamed(registry: InstancesOfCapRegistry, addonId: string): InstanceHolder {
  const holder = holdersOf(registry).find((candidate) => candidate.addonId === addonId)
  if (holder === undefined) throw new Error(`${addonId} no longer holds integration-instances`)
  return holder
}

/** The source over the hub registry. */
export function instanceSourceOver(registry: InstancesOfCapRegistry): InstanceSource {
  return {
    holders: async (cap) => {
      const providers = new Set(registry.getCollectionEntries(cap).map(([addonId]) => addonId))
      return holdersOf(registry)
        .map((holder) => holder.addonId)
        .filter((addonId) => providers.has(addonId))
    },
    describe: (addonId) => holderNamed(registry, addonId).provider.describe(),
    listInstances: (addonId) => holderNamed(registry, addonId).provider.listInstances(),
  }
}

/** The instances of `cap` across every provider, optionally of one kind. */
export function resolveInstancesOfCap(
  registry: InstancesOfCapRegistry,
  cap: string,
  filter: { readonly kind?: string } = {},
): Promise<InstancesOfCapResult> {
  return instancesOfCap(instanceSourceOver(registry), cap, filter)
}
