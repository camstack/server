import type { HomeComApiClient, HomeComSystemSnapshot } from './homecom-api-client.js'
import type { HomeComHeatingCircuit } from './homecom-domain-mapping.js'
import { gatewayDeviceName } from '@dominevo/types'
import { zoneNativeId } from './homecom-zone.js'

export interface HomeComDiscoverableDevice {
  readonly nativeId: string
  readonly name: string
  readonly kind: 'heating-circuit' | 'dhw' | 'heat-pump' | 'gateway' | 'zone'
  /** The gateway id of the heating circuit, or of the zone for a `zone` row. */
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
  /** Read the gateway now; the core's state refresh calls it (D1062). */
  readonly refresh?: () => Promise<void>
}

export class HomeComConnectionResolver {
  readonly #surfaces: Map<string, HomeComConnectionSurface> = new Map()
  readonly #snapshotSubs: Map<string, Set<() => void>> = new Map()

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

  /** The read-the-gateway function of an integration's surface, or null when it is not connected (D1062). */
  getRefresh(integrationId: string): (() => Promise<void>) | null {
    return this.#surfaces.get(integrationId)?.refresh ?? null
  }

  /** Subscribe a device to the integration's new snapshots. Returns the unsubscribe. */
  onSnapshot(integrationId: string, cb: () => void): () => void {
    const set = this.#snapshotSubs.get(integrationId) ?? new Set<() => void>()
    set.add(cb)
    this.#snapshotSubs.set(integrationId, set)
    return () => {
      const current = this.#snapshotSubs.get(integrationId)
      current?.delete(cb)
      if (current?.size === 0) this.#snapshotSubs.delete(integrationId)
    }
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
    for (const cb of this.#snapshotSubs.get(integrationId) ?? []) cb()
  }

  clear(): void {
    this.#snapshotSubs.clear()
    this.#surfaces.clear()
  }
}

/** Native id of the gateway pick: a Gateway device, sibling of the circuits. */
export const HOMECOM_GATEWAY_NATIVE_ID = 'gateway:0'

function gatewayDiscoverable(snapshot: HomeComSystemSnapshot): HomeComDiscoverableDevice {
  return {
    nativeId: HOMECOM_GATEWAY_NATIVE_ID,
    name: gatewayDeviceName('Bosch HomeCom', snapshot.deviceType),
    kind: 'gateway',
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

/** A zone with a readable value; one zone is the "Zone configuration", several are told apart. */
function zoneDiscoverable(zoneId: string, only: boolean): HomeComDiscoverableDevice {
  return {
    nativeId: zoneNativeId(zoneId),
    name: only ? 'Zone configuration' : `Zone ${zoneId}`,
    kind: 'zone',
    circuitId: zoneId,
  }
}

function dhwDiscoverable(name: string): HomeComDiscoverableDevice {
  return { nativeId: 'dhw:0', name, kind: 'dhw' }
}

/**
 * The gateway itself is always the first pick. A gateway with a heat pump is one more pick. A boiler still offers each circuit
 * and the hot-water row on its own.
 */
export function buildDiscoverables(snapshot: HomeComSystemSnapshot): HomeComDiscoverableDevice[] {
  const circuits = snapshot.circuits.map(circuitDiscoverable)
  const zones = (snapshot.bridge?.zones ?? []).map((zone, _i, all) =>
    zoneDiscoverable(zone.id, all.length === 1),
  )
  if (snapshot.heatPump !== undefined) {
    const children = [
      ...circuits,
      ...(snapshot.dhw === null ? [] : [dhwDiscoverable(HOMECOM_HOT_WATER_CHILD_NAME)]),
      ...zones,
    ]
    return [
      gatewayDiscoverable(snapshot),
      { nativeId: 'hp:0', name: 'Heat pump', kind: 'heat-pump', children },
    ]
  }
  return [
    gatewayDiscoverable(snapshot),
    ...circuits,
    ...(snapshot.dhw === null ? [] : [dhwDiscoverable(BOILER_DHW_NAME)]),
  ]
}

export const homeComConnections = new HomeComConnectionResolver()
