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
import { buildHmCandidates } from './homematic-discovery.js'
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
 * Minimal broker snapshot the adoption provider needs from the registry's
 * `list()` result. The single `id` field is enough to iterate brokers and
 * look up their facades.
 */
export interface HmAdoptionBrokerInfo {
  readonly id: string
}

/**
 * Narrow registry surface consumed by the adoption provider. Both the real
 * {@link HmBrokerRegistry} (structurally) and lightweight test fakes satisfy
 * this interface without casts.
 */
export interface HmAdoptionRegistry {
  getFacade(id: string): HmAdoptionFacade | null
  list(): readonly HmAdoptionBrokerInfo[]
}

/** All injected dependencies for {@link buildHmAdoptionProvider}. Nothing coupled to addon-ctx. */
export interface HmAdoptionProviderDeps {
  /** Narrow registry surface: list all brokers + resolve a raw facade by id. */
  readonly registry: HmAdoptionRegistry
  /** Resolve the brokerId for a given integrationId (reads integration settings on demand). */
  readonly getBrokerIdForIntegration: (integrationId: string) => Promise<string>
  /**
   * Return all CamStack devices that were adopted from a Homematic source.
   * The provider filters to those whose `config.system === 'homematic'`.
   */
  readonly listAdoptedHomematic: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  /** Create one adopted CamStack device. The addon wires this to resolve the
   *  Device class from `type`, stamp the stableId, and call kernel.devices.create. */
  readonly adoptDevice: (input: {
    readonly hmAddress: string
    readonly brokerId: string
    readonly integrationId: string
    readonly type: DeviceType
    readonly name: string
  }) => Promise<{ readonly deviceId: number; readonly accessoryDeviceIds: readonly number[] }>
  /**
   * Create ONE standalone top-level CamStack device for a single Homematic
   * entity (the `'entities'` granularity). The addon wires this to mint a
   * collision-free entity stableId and call `kernel.devices.create` with the
   * cap-re-derive child dispatcher class. Returns the new device id.
   */
  readonly adoptStandaloneEntity: (input: {
    readonly hmAddress: string
    readonly key: string
    readonly brokerId: string
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

/** The two granularity filters this provider advertises. `devices` adopts a
 *  whole CCU device as a Container; `entities` adopts ONE functional entity
 *  (a single channel / sensor / diagnostic / update) as a standalone device. */
const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Devices', isDefault: true } as const
const ENTITIES_FILTER: AdoptionFilter = { id: 'entities', label: 'Entities' } as const

/** Granularity filter id selecting the per-entity (standalone) candidate set. */
const ADOPTION_FILTER_ENTITIES = 'entities'

/** Compose the entity-level `childNativeId` (`<hmAddress>#<entityKey>`). */
function entityNativeId(hmAddress: string, key: string): string {
  return `${hmAddress}#${key}`
}

/** Parse `<hmAddress>#<entityKey>` back into its parts. The first `#` splits;
 *  an entity `key` never contains `#`. Returns null when the shape is wrong. */
function parseEntityNativeId(nativeId: string): { hmAddress: string; key: string } | null {
  const hash = nativeId.indexOf('#')
  if (hash <= 0 || hash === nativeId.length - 1) return null
  return { hmAddress: nativeId.slice(0, hash), key: nativeId.slice(hash + 1) }
}

/**
 * Build a `hmAddress → CamStack deviceId` map for a single broker.
 * Entries whose `config.system !== 'homematic'` or whose
 * `config.brokerId !== brokerId` are excluded so the adopted-state
 * overlay is scoped to the correct CCU.
 */
async function adoptedMapForBroker(
  brokerId: string,
  listAdoptedHomematic: HmAdoptionProviderDeps['listAdoptedHomematic'],
): Promise<ReadonlyMap<string, number>> {
  const all = await listAdoptedHomematic()
  const map = new Map<string, number>()
  for (const device of all) {
    if (device.config['system'] === 'homematic' && device.config['brokerId'] === brokerId) {
      // Skip standalone-entity rows (they carry `hmEntityKey`): this map is
      // the DEVICES-granularity overlay and must point at Container parents
      // only. Without this guard an entity adopted from the same physical CCU
      // device would overwrite the Container's id (last-write-wins on the
      // shared `hmAddress`), so the devices candidate would report the wrong
      // `adoptedDeviceId`. Mirrors the inverse guard in adoptedEntityMapForBroker.
      const entityKey = device.config['hmEntityKey']
      if (typeof entityKey === 'string' && entityKey.length > 0) continue
      const addr = String(device.config['hmAddress'])
      map.set(addr, device.id)
    }
  }
  return map
}

/**
 * Build a `<hmAddress>#<entityKey> → CamStack deviceId` map of STANDALONE entity
 * devices for a broker. A standalone entity device carries the `hmEntityKey`
 * marker (set only on the `entities` adoption path) plus `system==='homematic'`
 * and the matching `brokerId`. A Container parent (no `hmEntityKey`) does NOT
 * count — both granularities coexist for the same device.
 */
async function adoptedEntityMapForBroker(
  brokerId: string,
  listAdoptedHomematic: HmAdoptionProviderDeps['listAdoptedHomematic'],
): Promise<ReadonlyMap<string, number>> {
  const all = await listAdoptedHomematic()
  const map = new Map<string, number>()
  for (const device of all) {
    const cfg = device.config
    if (cfg['system'] !== 'homematic') continue
    if (cfg['brokerId'] !== brokerId) continue
    const key = cfg['hmEntityKey']
    if (typeof key !== 'string' || key.length === 0) continue
    const addr = String(cfg['hmAddress'])
    map.set(entityNativeId(addr, key), device.id)
  }
  return map
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Construct the `device-adoption` cap provider for the Homematic addon.
 *
 * Implements the READ side of {@link IDeviceAdoptionProvider} fully.
 * The WRITE side (`adopt`, `release`, `resync`) is stubbed for Task 2.3
 * and throws clearly-marked errors.
 *
 * Pure builder: all side-effecting deps are injected so the returned
 * object is unit-testable without a real addon context.
 */
export function buildHmAdoptionProvider(deps: HmAdoptionProviderDeps): IDeviceAdoptionProvider {
  const {
    registry,
    getBrokerIdForIntegration,
    listAdoptedHomematic,
    adoptDevice,
    adoptStandaloneEntity,
    removeDevice,
    findDeviceConfig,
    listLocations,
    assignLocation,
    logger,
  } = deps

  // ── Read helpers ──────────────────────────────────────────────────────────

  /** Fetch every device candidate for a broker (no paging, no text filter). */
  async function allCandidatesForBroker(brokerId: string): Promise<DiscoveredChildDevice[]> {
    const facade = registry.getFacade(brokerId)
    const devices = facade?.devices() ?? []
    const adopted = await adoptedMapForBroker(brokerId, listAdoptedHomematic)
    return buildHmCandidates({ brokerId, devices, adopted })
  }

  /**
   * Fetch every per-ENTITY candidate for a broker (the `entities` granularity):
   * a FLAT list — one candidate per functional entity across all the broker's
   * devices. `childNativeId = <hmAddress>#<entityKey>`; `alreadyAdopted` is true
   * only when a STANDALONE device for that entity already exists.
   */
  async function allEntityCandidatesForBroker(brokerId: string): Promise<DiscoveredChildDevice[]> {
    const facade = registry.getFacade(brokerId)
    const devices = facade?.devices() ?? []
    const customEntities = facade?.customEntities() ?? []
    const adopted = await adoptedEntityMapForBroker(brokerId, listAdoptedHomematic)
    const out: DiscoveredChildDevice[] = []
    for (const device of devices) {
      const deviceName = device.name ?? device.address
      const entitiesForDevice = customEntities.filter((e) => e.device === device.address)
      for (const spec of deriveHmEntitySpecs(device, entitiesForDevice)) {
        const childNativeId = entityNativeId(device.address, spec.key)
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

  /** True when the granularity `filter` selects the per-entity candidate set. */
  function isEntitiesFilter(filter: string | undefined): boolean {
    return filter === ADOPTION_FILTER_ENTITIES
  }

  /** One adopted-entry shape, shared by both granularity adopt paths. */
  type AdoptedEntry = {
    readonly childNativeId: string
    readonly parentDeviceId: number
    readonly accessoryDeviceIds: readonly number[]
  }

  /**
   * `entities` granularity adopt: import each `<hmAddress>#<entityKey>` as a
   * STANDALONE top-level device (`parentDeviceId === <newId>`, no accessory
   * children). For each id we resolve the live device + its custom entities,
   * re-derive its specs, find the spec with the requested `key`, build the
   * standalone config (spec config + provenance + entity marker), and call the
   * injected `adoptStandaloneEntity` creator. Best-effort CCU-room location
   * import mirrors the devices path. Partial success is allowed; all-fail throws.
   */
  async function adoptEntities(args: {
    integrationId: string
    brokerId: string
    facade: HmAdoptionFacade
    childNativeIds: readonly string[]
    perCandidate: Record<string, { name?: string }> | undefined
    importLocations: boolean | undefined
  }): Promise<{ adopted: AdoptedEntry[] }> {
    const { integrationId, brokerId, facade, childNativeIds, perCandidate, importLocations } = args
    const devices = facade.devices()
    const customEntities = facade.customEntities()

    const importEnabled =
      importLocations === true && listLocations !== undefined && assignLocation !== undefined
    let known: readonly string[] = importEnabled ? await listLocations() : []

    const adopted: AdoptedEntry[] = []
    let failures = 0

    for (const nativeId of childNativeIds) {
      try {
        const parsed = parseEntityNativeId(nativeId)
        if (parsed === null) {
          logger.warn('homematic adopt entity: malformed childNativeId — skipping', {
            meta: { nativeId, brokerId },
          })
          failures++
          continue
        }
        const { hmAddress, key } = parsed
        const dev = devices.find((d) => d.address === hmAddress)
        if (dev === undefined) {
          logger.warn('homematic adopt entity: device not found on broker — skipping', {
            meta: { hmAddress, key, brokerId },
          })
          failures++
          continue
        }
        const entitiesForDevice = customEntities.filter((e) => e.device === hmAddress)
        const spec = deriveHmEntitySpecs(dev, entitiesForDevice).find((s) => s.key === key)
        if (spec === undefined) {
          logger.warn('homematic adopt entity: entity key not found on device — skipping', {
            meta: { hmAddress, key, brokerId },
          })
          failures++
          continue
        }

        const name = perCandidate?.[nativeId]?.name ?? `${dev.name ?? hmAddress} · ${spec.name}`
        const config: Record<string, unknown> = {
          ...spec.config,
          system: 'homematic',
          brokerId,
          hmAddress,
          hmEntityKey: spec.key,
          address: hmAddress,
          integrationId,
          name,
        }

        const { deviceId } = await adoptStandaloneEntity({
          hmAddress,
          key: spec.key,
          brokerId,
          integrationId,
          deviceType: spec.deviceType,
          role: spec.role,
          name,
          config,
        })

        // Best-effort CCU-room location import (never fails the adopt).
        const room = dev.rooms?.[0]
        if (importEnabled && room !== undefined) {
          try {
            known = await assignLocation(deviceId, room, known)
          } catch (err: unknown) {
            logger.warn('homematic adopt entity: location import failed (non-fatal)', {
              meta: { hmAddress, key, brokerId, deviceId, room, error: errMsg(err) },
            })
          }
        }

        adopted.push({ childNativeId: nativeId, parentDeviceId: deviceId, accessoryDeviceIds: [] })
      } catch (err: unknown) {
        logger.warn('homematic adopt entity: failed to adopt entity', {
          meta: { nativeId, brokerId, error: errMsg(err) },
        })
        failures++
      }
    }

    if (adopted.length === 0 && failures > 0) {
      throw new Error(`homematic adopt: all ${failures} entity adopt(s) failed`)
    }
    return { adopted }
  }

  // ── Provider ──────────────────────────────────────────────────────────────

  return {
    // ── Filters ──────────────────────────────────────────────────────────

    listCandidateFilters: async (_input) => {
      return { filters: [DEVICES_FILTER, ENTITIES_FILTER] }
    },

    // ── Candidate list ────────────────────────────────────────────────────

    listCandidates: async ({ integrationId, page, pageSize, filter, filterText }) => {
      const brokerId = await getBrokerIdForIntegration(integrationId)
      // Granularity branch: `entities` returns a flat per-entity candidate list;
      // `devices` (or undefined) keeps the device-Container candidate path.
      const cands = isEntitiesFilter(filter)
        ? await allEntityCandidatesForBroker(brokerId)
        : await allCandidatesForBroker(brokerId)

      const filtered = applyCandidateTextFilter(cands, filterText)

      // Paginate (1-based page).
      const start = (page - 1) * pageSize
      const slice = filtered.slice(start, start + pageSize)

      return { candidates: slice, totalCount: filtered.length, page, pageSize }
    },

    // ── Single candidate ──────────────────────────────────────────────────

    getCandidate: async ({ integrationId, childNativeId }) => {
      const brokerId = await getBrokerIdForIntegration(integrationId)
      // `getCandidate` carries no granularity `filter` in the cap input; resolve
      // across BOTH the device and the entity candidate sets so an entity-level
      // `<addr>#<key>` id and a device-level `<addr>` id both resolve.
      const deviceCands = await allCandidatesForBroker(brokerId)
      const deviceHit = deviceCands.find((c) => c.childNativeId === childNativeId)
      if (deviceHit !== undefined) return deviceHit
      const entityCands = await allEntityCandidatesForBroker(brokerId)
      return entityCands.find((c) => c.childNativeId === childNativeId) ?? null
    },

    // ── Status ────────────────────────────────────────────────────────────

    getStatus: async () => {
      try {
        const brokers = registry.list()
        let candidateCount = 0
        for (const broker of brokers) {
          const facade = registry.getFacade(broker.id)
          const devices = facade?.devices() ?? []
          const adopted = await adoptedMapForBroker(broker.id, listAdoptedHomematic)
          candidateCount += buildHmCandidates({ brokerId: broker.id, devices, adopted }).length
        }

        const allAdopted = await listAdoptedHomematic()
        const adoptedCount = allAdopted.filter((d) => d.config['system'] === 'homematic').length

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

    // ── Refresh ───────────────────────────────────────────────────────────

    refresh: async ({ integrationId }) => {
      const brokerId = await getBrokerIdForIntegration(integrationId)

      const facade = registry.getFacade(brokerId)
      const devices = facade?.devices() ?? []
      const adopted = await adoptedMapForBroker(brokerId, listAdoptedHomematic)
      const candidateCount = buildHmCandidates({ brokerId, devices, adopted }).length

      const allAdopted = await listAdoptedHomematic()
      const adoptedCount = allAdopted.filter(
        (d) => d.config['system'] === 'homematic' && d.config['brokerId'] === brokerId,
      ).length

      return {
        lastDiscoveryAt: Date.now(),
        candidateCount,
        adoptedCount,
        lastError: null,
      } satisfies AdoptionStatus
    },

    // ── Write side ────────────────────────────────────────────────────────

    adopt: async ({ integrationId, childNativeIds, filter, perCandidate, importLocations }) => {
      const brokerId = await getBrokerIdForIntegration(integrationId)
      const facade = registry.getFacade(brokerId)
      if (facade === null) {
        throw new Error(`homematic adopt: broker ${brokerId} not connected`)
      }

      // `entities` granularity: import each `<addr>#<key>` as a STANDALONE
      // top-level device (no Container). `devices` (or undefined) keeps the
      // Container path below.
      if (isEntitiesFilter(filter)) {
        return adoptEntities({
          integrationId,
          brokerId,
          facade,
          childNativeIds,
          perCandidate,
          importLocations,
        })
      }

      const devices = facade.devices()

      const adopted: AdoptedEntry[] = []
      let failures = 0

      // Location import is enabled only when the operator requested it AND the
      // addon wired both location deps. The known-locations registry is fetched
      // ONCE per adopt call and threaded through the loop so a label created for
      // an earlier candidate is reused for a later one (no duplicate labels).
      const importEnabled =
        importLocations === true && listLocations !== undefined && assignLocation !== undefined
      let known: readonly string[] = importEnabled ? await listLocations() : []

      for (const hmAddress of childNativeIds) {
        try {
          const dev = devices.find((d) => d.address === hmAddress)
          if (dev === undefined) {
            logger.warn('homematic adopt: device not found on broker — skipping', {
              meta: { hmAddress, brokerId },
            })
            failures++
            continue
          }

          const type = inferHmDeviceType(dev)
          if (type === DeviceType.Generic) {
            logger.warn('homematic adopt: device maps to Generic type — skipping', {
              meta: { hmAddress, brokerId, deviceType: dev.type },
            })
            failures++
            continue
          }

          const name = perCandidate?.[hmAddress]?.name ?? dev.name ?? hmAddress

          const { deviceId, accessoryDeviceIds } = await adoptDevice({
            hmAddress,
            brokerId,
            integrationId,
            type,
            name,
          })

          // Best-effort: import the device's first CCU room as a CamStack
          // location. NEVER fails the adopt — a location error is logged and
          // the known-locations registry is left unchanged.
          const room = dev.rooms?.[0]
          if (importEnabled && room !== undefined) {
            try {
              known = await assignLocation(deviceId, room, known)
            } catch (err: unknown) {
              logger.warn('homematic adopt: location import failed (non-fatal)', {
                meta: { hmAddress, brokerId, deviceId, room, error: errMsg(err) },
              })
            }
          }

          adopted.push({ childNativeId: hmAddress, parentDeviceId: deviceId, accessoryDeviceIds })
        } catch (err: unknown) {
          logger.warn('homematic adopt: failed to adopt device', {
            meta: { hmAddress, brokerId, error: errMsg(err) },
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

      const brokerId = String(cfg['brokerId'])
      const hmAddress = String(cfg['hmAddress'])
      const facade = registry.getFacade(brokerId)
      const dev = facade?.devices().find((d) => d.address === hmAddress)

      if (dev === undefined) {
        throw new Error(
          `homematic resync: device ${hmAddress} no longer present on broker ${brokerId}`,
        )
      }

      // The Container derives its children LIVE from the facade on each spawn,
      // so a structural drift reconcile (re-derive + applyDerivedSpec per
      // child, mirroring the HA reconciler) is a follow-up task. For now the
      // resync confirms the device is still present on the broker and reports
      // no structural change.
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
