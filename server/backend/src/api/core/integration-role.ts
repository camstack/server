import type { AddonDeclaration, IntegrationRole } from '@camstack/types'

const INSTANCES_CAP = 'integration-instances'

/** The manifest fields the role is decided from. */
export interface IntegrationRoleSource {
  readonly integrationRole?: AddonDeclaration['integrationRole']
  readonly capabilities?: ReadonlyArray<string | { readonly name: string }>
}

/**
 * What an addon entry brings. The explicit `integrationRole` wins; absent, it is derived from
 * the capabilities the entry declares (`integration-instances` means service connections,
 * anything else devices). A dual entry is never derived — it declares `both`.
 */
export function resolveIntegrationRole(source: IntegrationRoleSource): IntegrationRole {
  if (source.integrationRole !== undefined) return source.integrationRole
  const keepsInstances = (source.capabilities ?? []).some(
    (c) => (typeof c === 'string' ? c : c.name) === INSTANCES_CAP,
  )
  return keepsInstances ? 'services' : 'devices'
}

/** True when the entry's devices belong on the Integrations page. */
export function bringsDevices(role: IntegrationRole): boolean {
  return role === 'devices' || role === 'both'
}
