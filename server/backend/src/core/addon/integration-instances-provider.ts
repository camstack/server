import type {
  IIntegrationInstancesProvider,
  IntegrationInstance,
  IntegrationInstanceKind,
} from '@camstack/types'

/** Structural check for an addon's `integration-instances` provider. */
export function isIntegrationInstancesProvider(
  value: unknown,
): value is IIntegrationInstancesProvider {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'createInstance') === 'function' &&
    typeof Reflect.get(value, 'getInstance') === 'function'
  )
}

/** The minimal registry surface the lookup needs. */
export interface InstancesProviderSource {
  getProviderByAddon<T = unknown>(capabilityName: string, addonId: string): T | null
}

/**
 * The addon's own `integration-instances` provider, or null when it keeps its
 * connection the legacy way (`integration-settings` rows). Its presence is the
 * ONLY routing decision for the integration get / set / create / delete / test
 * and for the form schema.
 */
export function findInstancesProvider(
  registry: InstancesProviderSource,
  addonId: string,
): IIntegrationInstancesProvider | null {
  const provider = registry.getProviderByAddon('integration-instances', addonId)
  return isIntegrationInstancesProvider(provider) ? provider : null
}

/**
 * The kinds of the provider that are configured for `functionCap` (a page section is the kinds
 * whose `functionCap` it names, D1013). A provider that declares no kinds has no sections.
 */
export async function kindsFor(
  provider: IIntegrationInstancesProvider,
  functionCap: string,
): Promise<readonly IntegrationInstanceKind[]> {
  const description = await provider.describe()
  return (description.kinds ?? []).filter((kind) => kind.functionCap === functionCap)
}

/**
 * The provider's instances of one section: those whose `kind` is one of `kindsFor(functionCap)`.
 * A provider with no kinds is a single-section holder and answers every instance.
 */
export async function instancesOfSection(
  provider: IIntegrationInstancesProvider,
  functionCap: string,
): Promise<readonly IntegrationInstance[]> {
  const description = await provider.describe()
  const all = await provider.listInstances()
  if (description.kinds === undefined || description.kinds.length === 0) return all
  const ids = new Set(
    description.kinds.filter((kind) => kind.functionCap === functionCap).map((kind) => kind.id),
  )
  return all.filter((instance) => instance.kind !== undefined && ids.has(instance.kind))
}
