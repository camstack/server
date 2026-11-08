import type { IScopedLogger } from '@camstack/types'
import { vi } from 'vitest'
import { isIntegrationInstancesProvider } from '../../../core/addon/integration-instances-provider'
import {
  type InstanceLifecycleDeps,
  withInstanceLifecycle,
} from '../../../core/addon/instance-lifecycle'

/** The slice of a spec harness a seed create needs. */
export interface SeedCreateWorld {
  readonly registry: unknown
  readonly log: unknown
  /** The provider of another addon (a broker owner); the seeded addon's own one by default. */
  readonly providerFor?: (addonId: string) => unknown
}

export interface SeedCreateInput {
  readonly addonId: string
  readonly name: string
  readonly settings?: Record<string, unknown>
  readonly kind?: string
  readonly originStableId?: string
  readonly info?: Record<string, unknown>
}

/**
 * Create an integration the way an addon seeds the one it owns: `integration-instances.createInstance`
 * with a `seed`, stamped as the addon itself by the transport.
 */
export async function seedCreate(
  world: SeedCreateWorld,
  provider: unknown,
  input: SeedCreateInput,
  stampedAs: string = input.addonId,
): Promise<{ id: string }> {
  if (!isIntegrationInstancesProvider(provider)) throw new Error('not an instances provider')
  const instances = provider
  const deps: InstanceLifecycleDeps = {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- spec doubles for the registry and the logger
    logger: world.log as IScopedLogger,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- spec double
    integrations: () => world.registry as ReturnType<InstanceLifecycleDeps['integrations']>,
    deviceManager: () => null,
    eventBus: { emit: vi.fn() },
    providerFor: (addonId) => {
      const other = world.providerFor?.(addonId) ?? instances
      return isIntegrationInstancesProvider(other) ? other : null
    },
    holders: () => [],
    manifestRole: () => undefined,
  }
  const wrapped = withInstanceLifecycle(input.addonId, instances, deps)
  const call = {
    name: input.name,
    seed: { info: input.info ?? {} },
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.originStableId !== undefined ? { originStableId: input.originStableId } : {}),
    ...(input.settings !== undefined ? { values: input.settings } : {}),
  }
  return wrapped.createInstance(Object.assign({}, call, { callerAddonId: stampedAs }))
}
