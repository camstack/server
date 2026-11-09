import type { HomeComApiClient, HomeComSystemSnapshot } from './homecom-api-client.js'
import type { HomeComHeatingCircuit } from './homecom-domain-mapping.js'

export interface HomeComDiscoverableDevice {
  readonly nativeId: string
  readonly name: string
  readonly kind: 'heating-circuit' | 'dhw' | 'heat-pump'
  readonly circuitId?: string
  /**
   * Set only on a heat-pump pick: one climate child per circuit and the hot
   * water child, created with the heat pump. Absent on a boiler's rows.
   */
  readonly children?: readonly HomeComDiscoverableDevice[]
}

/** Stable id of one HomeCom device. Adoption matches an existing row on this. */
export function homeComStableId(integrationId: string, nativeId: string): string {
  return `homecom:${integrationId}:${nativeId}`
}

/** The hot-water child of a heat pump. A boiler's own row keeps its longer name. */
export const HOMECOM_HOT_WATER_CHILD_NAME = 'Hot water'

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

const BOILER_DHW_NAME = 'Domestic hot water'

function circuitDiscoverable(circuit: HomeComHeatingCircuit): HomeComDiscoverableDevice {
  return {
    nativeId: `hc:${circuit.id}`,
    name: circuit.name,
    kind: 'heating-circuit',
    circuitId: circuit.id,
  }
}

function dhwDiscoverable(name: string): HomeComDiscoverableDevice {
  return { nativeId: 'dhw:0', name, kind: 'dhw' }
}

/**
 * A gateway with a heat pump is one pick. A boiler still offers each circuit
 * and the hot-water row on its own.
 */
export function buildDiscoverables(snapshot: HomeComSystemSnapshot): HomeComDiscoverableDevice[] {
  const circuits = snapshot.circuits.map(circuitDiscoverable)
  if (snapshot.heatPump !== undefined) {
    const children = [
      ...circuits,
      ...(snapshot.dhw === null ? [] : [dhwDiscoverable(HOMECOM_HOT_WATER_CHILD_NAME)]),
    ]
    return [{ nativeId: 'hp:0', name: 'Heat pump', kind: 'heat-pump', children }]
  }
  return [...circuits, ...(snapshot.dhw === null ? [] : [dhwDiscoverable(BOILER_DHW_NAME)])]
}

export const homeComConnections = new HomeComConnectionResolver()
