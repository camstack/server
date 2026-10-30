import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  IDeviceAdoptionProvider,
  AdoptionStatus,
  AdoptionFilter,
  DeviceRole,
} from '@camstack/types'
import type { DiscoveredChildDevice } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import type { HmCustomEntity } from 'nodehomematic'
import type { HmDiscoverable } from './homematic-discovery.js'
import {
  buildCcuGatewayCandidate,
  buildHmCandidates,
  deviceNativeId,
  entityNativeId,
  gatewayNativeId,
  parseNativeId,
} from './homematic-discovery.js'
import { inferHmDeviceType } from './homematic-mapping.js'
import { deriveHmEntitySpecs } from './devices/hm-entity-spec.js'

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/**
 * Minimal facade surface the adoption provider reads from a CCU connection.
 * Using a narrow interface (rather than the concrete `Homematic` class) keeps
 * test fakes structurally compatible without any casts.
 */
export interface HmAdoptionFacade {
  devices(): readonly HmDiscoverable[]
  /**
   * The library's typed actuator custom entities (correct channel) — needed by
   * the `entities` granularity to derive actuator specs. The real `Homematic`
   * facade exposes this; test fakes return `[]`.
   */
  customEntities(): readonly HmCustomEntity[]
}

/**
 * Narrow registry surface consumed by the adoption provider. Both the real
 * {@link HmClientRegistry} (structurally) and lightweight test fakes satisfy
 * this interface without casts.
 */
export interface HmAdoptionRegistry {
  getFacade(integrationId: string): HmAdoptionFacade | null
  list(): readonly string[]
  has(integrationId: string): boolean
  getName(integrationId: string): string | null
}

/** All injected dependencies for {@link buildHmAdoptionProvider}. Nothing coupled to addon-ctx. */
export interface HmAdoptionProviderDeps {
  /** Narrow registry surface: the running CCU integrations + their raw facades. */
  readonly registry: HmAdoptionRegistry
  /** Whether the CCU session of `integrationId` is connected (drives the Gateway candidate status). */
  readonly isOnline: (integrationId: string) => boolean
  /**
   * Return all top-level CamStack devices that were adopted from a Homematic
   * source (the CCU box, Containers and standalone entities). The provider
   * filters to those whose `config.system === 'homematic'`.
   */
  readonly listAdopted: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  /** Create the Gateway device of the CCU box (a top-level sibling of the products). */
  readonly adoptGateway: (input: {
    readonly integrationId: string
    readonly nativeId: string
    readonly name: string
  }) => Promise<{ readonly deviceId: number }>
  /** Create one adopted CamStack device (a Container parent plus its accessory children). */
  readonly adoptDevice: (input: {
    readonly hmAddress: string
    readonly integrationId: string
    readonly type: DeviceType
    readonly name: string
  }) => Promise<{ readonly deviceId: number; readonly accessoryDeviceIds: readonly number[] }>
  /**
   * Create ONE standalone top-level CamStack device for a single Homematic
   * entity (the `'entities'` granularity). Returns the new device id.
   */
  readonly adoptStandaloneEntity: (input: {
    readonly hmAddress: string
    readonly key: string
    readonly integrationId: string
    readonly deviceType: DeviceType
    readonly role: DeviceRole | null
    readonly name: string
    readonly config: Record<string, unknown>
  }) => Promise<{ readonly deviceId: number }>
  /** Remove an adopted device (cascades to accessories). */
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  /** Load an adopted device's flat config (for resync). Null if not found. */
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  /** List existing CamStack location labels (for fuzzy-match on import). */
  readonly listLocations?: () => Promise<readonly string[]>
  /** Assign an imported location to a device; returns the (possibly grown) known set. */
  readonly assignLocation?: (
    deviceId: number,
    externalLocation: string,
    known: readonly string[],
  ) => Promise<readonly string[]>
  readonly logger: IScopedLogger
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** The two granularity filters this provider advertises. `devices` adopts the CCU box
 *  (Gateway) and whole CCU devices as Containers; `entities` adopts ONE functional entity
 *  (a single channel / sensor / diagnostic / update) as a standalone device. */
const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Devices', isDefault: true } as const
const ENTITIES_FILTER: AdoptionFilter = { id: 'entities', label: 'Entities' } as const

/** Granularity filter id selecting the per-entity (standalone) candidate set. */
const ADOPTION_FILTER_ENTITIES = 'entities'

/**
 * Native id -> CamStack deviceId for every adopted top-level Homematic device of
 * one integration: the Gateway, the Containers and the standalone entities. A
 * Container carries `hmAddress` only, an entity also `hmEntityKey`, the Gateway
 * its own `nativeId` and no address. Ids are namespaced by the integration, so
 * two CCUs exposing the same address never share a key.
 */
async function adoptedMapForIntegration(
  integrationId: string,
  listAdopted: HmAdoptionProviderDeps['listAdopted'],
): Promise<ReadonlyMap<string, number>> {
  const map = new Map<string, number>()
  for (const device of await listAdopted()) {
    const cfg = device.config
    if (cfg['system'] !== 'homematic' || cfg['integrationId'] !== integrationId) continue
    const address = cfg['hmAddress']
    if (typeof address !== 'string' || address.length === 0) {
      if (cfg['nativeId'] === gatewayNativeId(integrationId)) {
        map.set(gatewayNativeId(integrationId), device.id)
      }
      continue
    }
    const entityKey = cfg['hmEntityKey']
    if (typeof entityKey === 'string' && entityKey.length > 0) {
      map.set(entityNativeId(integrationId, address, entityKey), device.id)
    } else {
      map.set(deviceNativeId(integrationId, address), device.id)
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Construct the `device-adoption` cap provider for the Homematic addon.
 *
 * Per CCU integration it offers the CCU box itself (a {@link DeviceType.Gateway}
 * candidate) and its products (Containers, or standalone entities under the
 * `entities` granularity). The products are siblings of the Gateway, never
 * children of it.
 *
 * Pure builder: all side-effecting deps are injected so the returned
 * object is unit-testable without a real addon context.
 */
export function buildHmAdoptionProvider(deps: HmAdoptionProviderDeps): IDeviceAdoptionProvider {
  const {
    registry,
    listAdopted,
    adoptGateway,
    adoptDevice,
    adoptStandaloneEntity,
    removeDevice,
    findDeviceConfig,
    listLocations,
    assignLocation,
    logger,
  } = deps

  // ── Read helpers ──────────────────────────────────────────────────────────

  /** The Gateway candidate first, then every device candidate of one integration. */
  async function allCandidatesFor(integrationId: string): Promise<DiscoveredChildDevice[]> {
    const devices = registry.getFacade(integrationId)?.devices() ?? []
    const adopted = await adoptedMapForIntegration(integrationId, listAdopted)
    return [
      buildCcuGatewayCandidate({
        integrationId,
        integrationName: registry.getName(integrationId) ?? 'Homematic CCU',
        online: deps.isOnline(integrationId),
        adopted,
      }),
      ...buildHmCandidates({ integrationId, devices, adopted }),
    ]
  }

  /**
   * Every per-ENTITY candidate of one integration (the `entities` granularity):
   * a FLAT list, one candidate per functional entity across all its devices.
   * `alreadyAdopted` is true only when a STANDALONE device for that entity exists.
   */
  async function allEntityCandidatesFor(integrationId: string): Promise<DiscoveredChildDevice[]> {
    const facade = registry.getFacade(integrationId)
    const devices = facade?.devices() ?? []
    const customEntities = facade?.customEntities() ?? []
    const adopted = await adoptedMapForIntegration(integrationId, listAdopted)
    const out: DiscoveredChildDevice[] = []
    for (const device of devices) {
      const deviceName = device.name ?? device.address
      const entitiesForDevice = customEntities.filter((e) => e.device === device.address)
      for (const spec of deriveHmEntitySpecs(device, entitiesForDevice)) {
        const childNativeId = entityNativeId(integrationId, device.address, spec.key)
        const adoptedId = adopted.get(childNativeId) ?? null
        out.push({
          childNativeId,
          name: `${deviceName} · ${spec.name}`,
          type: spec.deviceType,
          status: 'online',
          metadata: device.rooms?.[0] !== undefined ? { externalLocation: device.rooms[0] } : {},
          alreadyAdopted: adoptedId !== null,
          adoptedDeviceId: adoptedId,
          capabilities: [...spec.capabilities],
        })
      }
    }
    return out
  }

  /** Apply the candidate-list text/query narrowing (shared across granularities). */
  function applyCandidateTextFilter(
    cands: readonly DiscoveredChildDevice[],
    filterText: { search?: string; adoptedOnly?: boolean; unadoptedOnly?: boolean } | undefined,
  ): DiscoveredChildDevice[] {
    let filtered = [...cands]
    if (filterText === undefined) return filtered
    const { search, adoptedOnly, unadoptedOnly } = filterText
    if (search !== undefined && search.length > 0) {
      const lower = search.toLowerCase()
      filtered = filtered.filter(
        (c) =>
          c.name.toLowerCase().includes(lower) ||
          (c.metadata.model?.toLowerCase().includes(lower) ?? false) ||
          c.childNativeId.toLowerCase().includes(lower),
      )
    }
    if (adoptedOnly === true) filtered = filtered.filter((c) => c.alreadyAdopted)
    if (unadoptedOnly === true) filtered = filtered.filter((c) => !c.alreadyAdopted)
    return filtered
  }

  /** One adopted-entry shape, shared by every adopt path. */
  type AdoptedEntry = {
    readonly childNativeId: string
    readonly parentDeviceId: number
    readonly accessoryDeviceIds: readonly number[]
  }

  async function countsFor(integrationId: string): Promise<AdoptionStatus> {
    const adopted = await adoptedMapForIntegration(integrationId, listAdopted)
    return {
      lastDiscoveryAt: Date.now(),
      candidateCount: (await allCandidatesFor(integrationId)).length,
      adoptedCount: adopted.size,
      lastError: null,
    }
  }

  /** Best-effort CCU-room location import; never fails the adopt. */
  async function importRoom(args: {
    importEnabled: boolean
    known: readonly string[]
    deviceId: number
    room: string | undefined
    nativeId: string
    integrationId: string
  }): Promise<readonly string[]> {
    const { importEnabled, known, deviceId, room, nativeId, integrationId } = args
    if (!importEnabled || room === undefined || assignLocation === undefined) return known
    try {
      return await assignLocation(deviceId, room, known)
    } catch (err: unknown) {
      logger.warn('homematic adopt: location import failed (non-fatal)', {
        tags: { deviceId },
        meta: { nativeId, integrationId, room, error: errMsg(err) },
      })
      return known
    }
  }

  // ── Provider ──────────────────────────────────────────────────────────────

  return {
    listCandidateFilters: async (_input) => {
      return { filters: [DEVICES_FILTER, ENTITIES_FILTER] }
    },

    listCandidates: async ({ integrationId, page, pageSize, filter, filterText }) => {
      // `entities` returns a flat per-entity list; `devices` (or undefined) the
      // CCU box followed by the device Containers.
      const cands =
        filter === ADOPTION_FILTER_ENTITIES
          ? await allEntityCandidatesFor(integrationId)
          : await allCandidatesFor(integrationId)
      const filtered = applyCandidateTextFilter(cands, filterText)
      const start = (page - 1) * pageSize
      return {
        candidates: filtered.slice(start, start + pageSize),
        totalCount: filtered.length,
        page,
        pageSize,
      }
    },

    getCandidate: async ({ integrationId, childNativeId }) => {
      // `getCandidate` carries no granularity filter: resolve across BOTH sets.
      const hit = (await allCandidatesFor(integrationId)).find(
        (c) => c.childNativeId === childNativeId,
      )
      if (hit !== undefined) return hit
      return (
        (await allEntityCandidatesFor(integrationId)).find(
          (c) => c.childNativeId === childNativeId,
        ) ?? null
      )
    },

    getStatus: async () => {
      try {
        let candidateCount = 0
        let adoptedCount = 0
        for (const integrationId of registry.list()) {
          const counts = await countsFor(integrationId)
          candidateCount += counts.candidateCount
          adoptedCount += counts.adoptedCount
        }
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        } satisfies AdoptionStatus
      } catch (err: unknown) {
        logger.warn('homematic adoption: getStatus failed', { meta: { error: errMsg(err) } })
        return {
          lastDiscoveryAt: null,
          candidateCount: 0,
          adoptedCount: 0,
          lastError: errMsg(err),
        } satisfies AdoptionStatus
      }
    },

    refresh: async ({ integrationId }) => countsFor(integrationId),

    adopt: async ({ integrationId, childNativeIds, perCandidate, importLocations }) => {
      const facade = registry.getFacade(integrationId)
      if (!registry.has(integrationId) || facade === null) {
        logger.warn('homematic adopt: integration is not running — nothing adopted', {
          meta: { integrationId, requested: childNativeIds.length },
        })
        throw new Error(`homematic adopt: integration ${integrationId} is not running`)
      }
      const devices = facade.devices()
      const customEntities = facade.customEntities()

      // The known-locations registry is fetched ONCE per adopt call and threaded
      // through the loop so a label created for an earlier candidate is reused.
      const importEnabled =
        importLocations === true && listLocations !== undefined && assignLocation !== undefined
      let known: readonly string[] = importEnabled && listLocations ? await listLocations() : []

      const adopted: AdoptedEntry[] = []
      let failures = 0

      for (const nativeId of childNativeIds) {
        try {
          const parsed = parseNativeId(integrationId, nativeId)
          if (parsed === null) {
            logger.warn('homematic adopt: malformed or foreign childNativeId — skipping', {
              meta: { nativeId, integrationId },
            })
            failures++
            continue
          }

          if (parsed.kind === 'gateway') {
            const name =
              perCandidate?.[nativeId]?.name ?? registry.getName(integrationId) ?? 'Homematic CCU'
            const { deviceId } = await adoptGateway({ integrationId, nativeId, name })
            adopted.push({
              childNativeId: nativeId,
              parentDeviceId: deviceId,
              accessoryDeviceIds: [],
            })
            continue
          }

          const { hmAddress } = parsed
          const dev = devices.find((d) => d.address === hmAddress)
          if (dev === undefined) {
            logger.warn('homematic adopt: device not found on the CCU — skipping', {
              meta: { hmAddress, integrationId, kind: parsed.kind },
            })
            failures++
            continue
          }

          if (parsed.kind === 'entity') {
            const entitiesForDevice = customEntities.filter((e) => e.device === hmAddress)
            const spec = deriveHmEntitySpecs(dev, entitiesForDevice).find(
              (s) => s.key === parsed.key,
            )
            if (spec === undefined) {
              logger.warn('homematic adopt entity: entity key not found on device — skipping', {
                meta: { hmAddress, key: parsed.key, integrationId },
              })
              failures++
              continue
            }
            const name = perCandidate?.[nativeId]?.name ?? `${dev.name ?? hmAddress} · ${spec.name}`
            const config: Record<string, unknown> = {
              ...spec.config,
              system: 'homematic',
              hmAddress,
              hmEntityKey: spec.key,
              address: hmAddress,
              integrationId,
              name,
            }
            const { deviceId } = await adoptStandaloneEntity({
              hmAddress,
              key: spec.key,
              integrationId,
              deviceType: spec.deviceType,
              role: spec.role,
              name,
              config,
            })
            known = await importRoom({
              importEnabled,
              known,
              deviceId,
              room: dev.rooms?.[0],
              nativeId,
              integrationId,
            })
            adopted.push({
              childNativeId: nativeId,
              parentDeviceId: deviceId,
              accessoryDeviceIds: [],
            })
            continue
          }

          const type = inferHmDeviceType(dev)
          if (type === DeviceType.Generic) {
            logger.warn('homematic adopt: device maps to Generic type — skipping', {
              meta: { hmAddress, integrationId, deviceType: dev.type },
            })
            failures++
            continue
          }
          const name = perCandidate?.[nativeId]?.name ?? dev.name ?? hmAddress
          const { deviceId, accessoryDeviceIds } = await adoptDevice({
            hmAddress,
            integrationId,
            type,
            name,
          })
          known = await importRoom({
            importEnabled,
            known,
            deviceId,
            room: dev.rooms?.[0],
            nativeId,
            integrationId,
          })
          adopted.push({ childNativeId: nativeId, parentDeviceId: deviceId, accessoryDeviceIds })
        } catch (err: unknown) {
          logger.warn('homematic adopt: failed to adopt', {
            meta: { nativeId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`homematic adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await findDeviceConfig(camDeviceId)
      if (cfg === null) {
        throw new Error(`homematic resync: device ${camDeviceId} not found`)
      }
      if (cfg['system'] !== 'homematic') {
        throw new Error(`homematic resync: device ${camDeviceId} is not a Homematic device`)
      }
      const integrationId = String(cfg['integrationId'])
      // The CCU box carries no address and nothing to re-derive.
      if (typeof cfg['hmAddress'] !== 'string') {
        return { changed: false, rebuiltChildren: 0 }
      }
      const hmAddress = cfg['hmAddress']
      const dev = registry
        .getFacade(integrationId)
        ?.devices()
        .find((d) => d.address === hmAddress)
      if (dev === undefined) {
        throw new Error(
          `homematic resync: device ${hmAddress} no longer present on integration ${integrationId}`,
        )
      }
      // The Container derives its children LIVE from the facade on each spawn,
      // so a structural drift reconcile is a follow-up; resync confirms presence.
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
