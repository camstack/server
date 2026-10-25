import type { HomeComApiClient, HomeComSystemSnapshot } from './homecom-api-client.js'

export interface HomeComDiscoverableDevice {
  readonly nativeId: string
  readonly name: string
  readonly kind: 'heating-circuit' | 'dhw'
  readonly circuitId?: string
}

export interface HomeComConnectionSurface {
  readonly gatewayId: string
  readonly client: HomeComApiClient
  readonly snapshot: HomeComSystemSnapshot
  readonly discoverables: readonly HomeComDiscoverableDevice[]
}

export class HomeComConnectionResolver {
  readonly #surfaces: Map<string, HomeComConnectionSurface> = new Map()

  set(integrationId: string, surface: HomeComConnectionSurface | null): void {
    if (surface === null) {
      this.#surfaces.delete(integrationId)
      return
    }
    this.#surfaces.set(integrationId, surface)
  }

  has(integrationId: string): boolean {
    return this.#surfaces.has(integrationId)
  }

  list(): readonly { readonly id: string }[] {
    return Array.from(this.#surfaces.keys()).map((id) => ({ id }))
  }

  discoverables(integrationId: string): readonly HomeComDiscoverableDevice[] {
    return this.#surfaces.get(integrationId)?.discoverables ?? []
  }

  getClient(integrationId: string): HomeComApiClient | null {
    return this.#surfaces.get(integrationId)?.client ?? null
  }

  getSnapshot(integrationId: string): HomeComSystemSnapshot | null {
    return this.#surfaces.get(integrationId)?.snapshot ?? null
  }

  updateSnapshot(integrationId: string, snapshot: HomeComSystemSnapshot): void {
    const existing = this.#surfaces.get(integrationId)
    if (!existing) return
    this.#surfaces.set(integrationId, {
      ...existing,
      snapshot,
      discoverables: buildDiscoverables(snapshot),
    })
  }

  clear(): void {
    this.#surfaces.clear()
  }
}

export function buildDiscoverables(snapshot: HomeComSystemSnapshot): HomeComDiscoverableDevice[] {
  const out: HomeComDiscoverableDevice[] = []
  for (const circuit of snapshot.circuits) {
    out.push({
      nativeId: `hc:${circuit.id}`,
      name: circuit.name,
      kind: 'heating-circuit',
      circuitId: circuit.id,
    })
  }
  if (snapshot.dhw) {
    out.push({
      nativeId: 'dhw:0',
      name: 'Domestic hot water',
      kind: 'dhw',
    })
  }
  return out
}

export const homeComConnections = new HomeComConnectionResolver()
