/**
 * CapabilityService — NestJS-injectable wrapper around the CapabilityRegistry.
 *
 * Server services inject this instead of accessing the registry directly.
 * The registry reference is set once during boot by AddonRegistryService.
 */

import type { CapabilityRegistry } from '@camstack/system'

export class CapabilityService {
  private registry: CapabilityRegistry | null = null

  /** Called once during boot by AddonRegistryService to wire the registry */
  setRegistry(registry: CapabilityRegistry): void {
    this.registry = registry
  }

  /** Get the underlying registry (may be null before boot completes) */
  getRegistry(): CapabilityRegistry | null {
    return this.registry
  }

  /** Get the active singleton provider for a capability */
  getSingleton<T>(capability: string): T | null {
    return this.registry?.getSingleton<T>(capability) ?? null
  }

  /**
   * Resolve the hub-local provider honoring the 'hub' per-node singleton override.
   * Delegates to `CapabilityRegistry.getSingletonForNode` so the in-process lookup
   * respects per-node overrides set by the operator.
   */
  getSingletonForNode<T>(capability: string, nodeId: string): T | null {
    return this.registry?.getSingletonForNode<T>(capability, nodeId) ?? null
  }

  /** Get the addon ID of the active singleton provider for a capability */
  getSingletonAddonId(capability: string): string | null {
    return this.registry?.getSingletonAddonId(capability) ?? null
  }

  /** Get all active collection providers for a capability */
  getCollection<T>(capability: string): readonly T[] {
    return this.registry?.getCollection<T>(capability) ?? []
  }

  /**
   * Like {@link getCollection} but returns `[addonId, provider]` tuples
   * so callers can attribute work back to the contributing addon —
   * required by the addon-widgets static file route to validate that
   * the requested `addonId` is a registered widget provider.
   */
  getCollectionEntries<T>(capability: string): readonly (readonly [string, T])[] {
    return this.registry?.getCollectionEntries<T>(capability) ?? []
  }

  /** Resolve a singleton provider for a specific device (with per-device override support) */
  resolveForDevice<T>(capability: string, deviceId: string): T | null {
    return this.registry?.resolveForDevice<T>(capability, deviceId) ?? null
  }

  /** Resolve collection providers for a specific device (with per-device filter support) */
  resolveCollectionForDevice<T>(capability: string, deviceId: string): readonly T[] {
    return this.registry?.resolveCollectionForDevice<T>(capability, deviceId) ?? []
  }
}
