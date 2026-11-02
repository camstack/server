import type { IIntegrationInstancesProvider } from '@camstack/types'

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
