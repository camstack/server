import type { CapabilityDefinition } from '@camstack/types'

/**
 * A capability a fixture addon registers, named and nothing else. The test
 * harnesses read only `capability.name` and declare the mode themselves, so
 * the definition carries no methods.
 */
export function fixtureCap(name: string): CapabilityDefinition {
  return { name, scope: 'system', mode: 'singleton', methods: {} }
}
