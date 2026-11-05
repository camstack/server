import type { AddonDeclaration, IntegrationRole } from '@camstack/types'

const INSTANCES_CAP = 'integration-instances'

/** The manifest fields the role is decided from. */
export interface IntegrationRoleSource {
  readonly integrationRole?: AddonDeclaration['integrationRole']
  /** `describe().role` of the addon's `integration-instances` provider, when it has one. */
  readonly describedRole?: IntegrationRole | undefined
  readonly capabilities?: ReadonlyArray<string | { readonly name: string }>
}

/**
 * What an addon entry brings, in this order: the manifest's explicit `integrationRole` (an
 * override), the `role` its `integration-instances` provider describes, and only for an addon
 * still on the legacy rows, the capabilities the entry declares (`integration-instances` means
 * service connections, anything else devices).
 */
export function resolveIntegrationRole(source: IntegrationRoleSource): IntegrationRole {
  if (source.integrationRole !== undefined) return source.integrationRole
  if (source.describedRole !== undefined) return source.describedRole
  const keepsInstances = (source.capabilities ?? []).some(
    (c) => (typeof c === 'string' ? c : c.name) === INSTANCES_CAP,
  )
  return keepsInstances ? 'services' : 'devices'
}

/** True when the entry's devices belong on the Integrations page. */
export function bringsDevices(role: IntegrationRole): boolean {
  return role === 'devices'
}
