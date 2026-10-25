import type { ShcClient } from './shc-client.js'
import type { ShcDeviceSummary } from './shc-types.js'

export interface ShcConnectionSurface {
  readonly devices: readonly ShcDeviceSummary[]
  readonly client: ShcClient
}

/** In-process resolver: integrationId → live SHC connection surface. */
export class ShcConnectionResolver {
  readonly #surfaces: Map<string, ShcConnectionSurface> = new Map()

  set(integrationId: string, surface: ShcConnectionSurface | null): void {
    if (surface === null) {
      this.#surfaces.delete(integrationId)
      return
    }
    this.#surfaces.set(integrationId, surface)
  }

  has(integrationId: string): boolean {
    return this.#surfaces.has(integrationId)
  }

  devices(integrationId: string): readonly ShcDeviceSummary[] {
    return this.#surfaces.get(integrationId)?.devices ?? []
  }

  getClient(integrationId: string): ShcClient | null {
    return this.#surfaces.get(integrationId)?.client ?? null
  }

  list(): readonly { readonly id: string }[] {
    return Array.from(this.#surfaces.keys()).map((id) => ({ id }))
  }

  clear(): void {
    for (const surface of this.#surfaces.values()) {
      surface.client.close()
    }
    this.#surfaces.clear()
  }
}

export const shcConnections = new ShcConnectionResolver()
