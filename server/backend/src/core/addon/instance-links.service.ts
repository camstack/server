/**
 * The hub's index of instance links (D1013 rule 5). Every `integration-instances` holder's
 * `describe().links` says which body field of which kind holds the id of an instance of another
 * function cap; the OWNER of the target refuses `deleteInstance` while a link still names it,
 * with an `InstanceInUseError` naming the users. The link lives on the consumer: nothing here
 * stores a second copy of it.
 */
import {
  assertInstanceUnused,
  fieldUserFinder,
  type IIntegrationInstancesProvider,
  type InstanceUserFinder,
  type IntegrationInstanceLink,
} from '@camstack/types'
import { isIntegrationInstancesProvider } from './integration-instances-provider.js'

export const INTEGRATION_INSTANCES_CAP = 'integration-instances'

/** One holder of `integration-instances`, as the registry lists it. */
export interface InstanceHolder {
  readonly addonId: string
  readonly provider: IIntegrationInstancesProvider
}

/** A declared link and the holder whose instances carry it. */
export interface InstanceLinkEdge extends IntegrationInstanceLink {
  readonly holderId: string
}

/** The registry surface the index reads. */
export interface InstanceHolderRegistry {
  getCollectionEntries(capability: string): readonly (readonly [string, unknown])[]
}

/** The holders of `integration-instances` the registry knows right now. */
export function holdersOf(registry: InstanceHolderRegistry): readonly InstanceHolder[] {
  const holders: InstanceHolder[] = []
  for (const [addonId, provider] of registry.getCollectionEntries(INTEGRATION_INSTANCES_CAP)) {
    if (isIntegrationInstancesProvider(provider)) holders.push({ addonId, provider })
  }
  return holders
}

export class InstanceLinksIndex {
  constructor(private readonly holders: () => readonly InstanceHolder[]) {}

  /** Every link every holder declares, read when asked (a holder can appear at any time). */
  async edges(): Promise<readonly InstanceLinkEdge[]> {
    const out: InstanceLinkEdge[] = []
    for (const holder of this.holders()) {
      const description = await holder.provider.describe()
      for (const link of description.links ?? []) out.push({ ...link, holderId: holder.addonId })
    }
    return out
  }

  /**
   * One finder per link that points at an instance of function cap `cap` whose kind is one of
   * `kinds` (a link naming no kind points at any). Each reads the consumer's own listed rows.
   */
  async findersFor(cap: string, kinds: readonly string[]): Promise<readonly InstanceUserFinder[]> {
    const finders: InstanceUserFinder[] = []
    for (const edge of await this.edges()) {
      if (edge.to.cap !== cap) continue
      if (edge.to.kind !== undefined && !kinds.includes(edge.to.kind)) continue
      const holder = this.holders().find((h) => h.addonId === edge.holderId)
      if (holder === undefined) continue
      finders.push(
        fieldUserFinder({
          kind: edge.kind,
          field: edge.field,
          list: async () =>
            (await holder.provider.listInstances()).filter(
              (row) => row.kind === undefined || row.kind === edge.kind,
            ),
        }),
      )
    }
    return finders
  }
}

/**
 * Refuse while a declared link names instance `id` of `provider`. The target's function cap and
 * kind come from its own `describe().kinds`; a provider with no kinds is no link target. A
 * consumer that cannot be read REFUSES: a destructive step never goes ahead on a failed read (D49).
 */
export async function assertInstanceDeletable(
  provider: IIntegrationInstancesProvider,
  index: InstanceLinksIndex,
  id: string,
): Promise<void> {
  const instance = await provider.getInstance({ id })
  const description = await provider.describe()
  const kind = (description.kinds ?? []).find((k) => k.id === instance?.kind)
  if (kind === undefined) return
  const names = kind.brokerKind === undefined ? [kind.id] : [kind.id, kind.brokerKind]
  await assertInstanceUnused(id, await index.findersFor(kind.functionCap, names))
}

/** `provider` with a `deleteInstance` that refuses while a declared link names the instance. */
export function guardInstanceDeletes(
  provider: IIntegrationInstancesProvider,
  index: InstanceLinksIndex,
): IIntegrationInstancesProvider {
  const guarded: IIntegrationInstancesProvider['deleteInstance'] = async (input) => {
    await assertInstanceDeletable(provider, index, input.id)
    return provider.deleteInstance(input)
  }
  return new Proxy(provider, {
    get(target, prop) {
      if (prop === 'deleteInstance') return guarded
      const value: unknown = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Adds the hub half of create and delete (`withInstanceLifecycle`) around a registered provider. */
export type InstanceLifecycleWrap = (
  addonId: string,
  provider: IIntegrationInstancesProvider,
) => IIntegrationInstancesProvider

/**
 * What the registry should hold for `provider` registered under `capName`: a holder of
 * `integration-instances` comes back guarded (a delete refused while a link names it, D1013) and,
 * when `lifecycle` is given, carrying the hub half of create and delete for an instance that
 * brings devices (epic #440 H3). Anything else comes back unchanged. One call site per way a
 * provider reaches the registry (in-process context, forked-runner proxy).
 */
export function registeredProviderFor(
  capName: string,
  provider: unknown,
  registry: InstanceHolderRegistry,
  lifecycle?: { readonly addonId: string; readonly wrap: InstanceLifecycleWrap | null },
): unknown {
  if (capName !== INTEGRATION_INSTANCES_CAP || !isIntegrationInstancesProvider(provider)) {
    return provider
  }
  const holders = () => holdersOf(registry)
  const guarded = guardInstanceDeletes(provider, new InstanceLinksIndex(holders))
  return lifecycle?.wrap == null ? guarded : lifecycle.wrap(lifecycle.addonId, guarded)
}
