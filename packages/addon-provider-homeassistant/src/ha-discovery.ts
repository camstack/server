import {
  DeviceType,
  type DiscoveryCandidate,
  type SourceInfo,
  type EnumSensorDateTimeFormat,
} from '@camstack/types'
import { mapHaEntityToCamStack } from './ha-domain-mapping.js'
import type { HaEntityState } from './ha-types.js'
import type { HaEntityCategory } from './ha-discovery-types.js'

/**
 * Raw shapes returned by HA WS registry endpoints.
 * These are internal to this module — callers pass `Record<string, unknown>[]`
 * from `sendMessage` and we narrow inside the function.
 */
interface HaDeviceRegistryEntry {
  readonly id: string
  readonly name: string | null
  readonly name_by_user: string | null
  readonly disabled_by: string | null
}

interface HaEntityRegistryEntry {
  readonly entity_id: string
  readonly device_id: string | null
  readonly device_class: string | null
  readonly original_device_class: string | null
  readonly disabled_by: string | null
  /** HA `entity_category` — `'config' | 'diagnostic' | null`. Drives the
   *  accordion section the adopted child renders in. */
  readonly entity_category: HaEntityCategory | null
}

/**
 * One entity entry in the Container config's `entities` array.
 * Mirrors the shape expected by `HaContainerDevice.getAccessoryChildren()`.
 */
export interface HaContainerEntityEntry {
  readonly entityId: string
  readonly deviceType: string
  readonly capabilities: readonly string[]
  readonly role?: string
  readonly unitOfMeasurement?: string
  readonly deviceClass?: string
  /** HA `options` attribute — present on select / input_select entities.
   *  Captured at adoption so the control slice is seeded immediately. */
  readonly options?: readonly string[]
  /** HA friendly_name for this entity — used as the child device name.
   *  Falls back to entityId when not present. */
  readonly name?: string
  /** Locale-render shape for a `DateTimeSensor`-role enum sensor — seeded into
   *  the cap slice by the child so the UI renders the ISO `value` formatted. */
  readonly dateTimeFormat?: EnumSensorDateTimeFormat
  /** HA `entity_category` — omitted when null (the common control case).
   *  Drives the accordion section the adopted child renders in. */
  readonly entityCategory?: HaEntityCategory
}

export interface BuildDiscoveryCandidatesInput {
  readonly brokerId: string
  readonly integrationId: string | undefined
  /** Raw `config/device_registry/list` response from HA WS. */
  readonly devices: readonly Record<string, unknown>[]
  /** Raw `config/entity_registry/list` response from HA WS. */
  readonly entities: readonly Record<string, unknown>[]
  readonly states: Record<string, HaEntityState>
}

function toDeviceEntry(raw: Record<string, unknown>): HaDeviceRegistryEntry | null {
  const id = typeof raw['id'] === 'string' ? raw['id'] : null
  if (!id) return null
  return {
    id,
    name: typeof raw['name'] === 'string' ? raw['name'] : null,
    name_by_user: typeof raw['name_by_user'] === 'string' ? raw['name_by_user'] : null,
    disabled_by: typeof raw['disabled_by'] === 'string' ? raw['disabled_by'] : null,
  }
}

function toEntityEntry(raw: Record<string, unknown>): HaEntityRegistryEntry | null {
  const entity_id = typeof raw['entity_id'] === 'string' ? raw['entity_id'] : null
  if (!entity_id) return null
  const rawCategory = raw['entity_category']
  const entity_category: HaEntityCategory | null =
    rawCategory === 'config' || rawCategory === 'diagnostic' ? rawCategory : null
  return {
    entity_id,
    device_id: typeof raw['device_id'] === 'string' ? raw['device_id'] : null,
    device_class: typeof raw['device_class'] === 'string' ? raw['device_class'] : null,
    original_device_class:
      typeof raw['original_device_class'] === 'string' ? raw['original_device_class'] : null,
    disabled_by: typeof raw['disabled_by'] === 'string' ? raw['disabled_by'] : null,
    entity_category,
  }
}

/**
 * Build `DiscoveryCandidate[]` from raw HA registry snapshots.
 *
 * One candidate per enabled HA physical device. Each candidate is a
 * `DeviceType.Container` whose `prefilledConfig.entities` lists every
 * enabled entity linked to that device, pre-mapped via
 * `mapHaEntityToCamStack`. Entities whose domain has no mapping are
 * silently skipped.
 *
 * `stableId` follows the pattern `ha:<brokerId>:dev:<device.id>` so
 * re-discovery of the same physical device always produces the same id
 * (idempotent adoption guard).
 */
export function buildDiscoveryCandidates(
  input: BuildDiscoveryCandidatesInput,
): readonly DiscoveryCandidate[] {
  const { brokerId, integrationId, devices, entities, states } = input

  // Normalise raw payloads into typed entries.
  const typedDevices: HaDeviceRegistryEntry[] = []
  for (const raw of devices) {
    const entry = toDeviceEntry(raw)
    if (entry) typedDevices.push(entry)
  }

  const typedEntities: HaEntityRegistryEntry[] = []
  for (const raw of entities) {
    const entry = toEntityEntry(raw)
    if (entry) typedEntities.push(entry)
  }

  // Bucket entities by device_id; skip disabled entities (they are inert in HA
  // — no state — so adopting them would surface dead children).
  const entitiesByDevice = new Map<string, HaEntityRegistryEntry[]>()
  for (const ent of typedEntities) {
    if (!ent.device_id) continue
    if (ent.disabled_by !== null) continue
    const bucket = entitiesByDevice.get(ent.device_id)
    if (bucket) {
      bucket.push(ent)
    } else {
      entitiesByDevice.set(ent.device_id, [ent])
    }
  }

  const candidates: DiscoveryCandidate[] = []

  for (const device of typedDevices) {
    if (device.disabled_by !== null) continue

    const entityBucket = entitiesByDevice.get(device.id) ?? []

    const mappedEntities: HaContainerEntityEntry[] = []
    for (const ent of entityBucket) {
      const entityId = ent.entity_id
      const domain = entityId.split('.')[0] ?? entityId
      const attributes = states[entityId]?.attributes ?? {}
      // device_class precedence: entity-registry override → integration default
      // → live state attribute. Energy plugs / ESPHome / Zigbee often surface
      // device_class only in the state attributes; without this fallback they
      // map to enum-sensor and lose their typed role + unit.
      const attrDeviceClass =
        typeof attributes['device_class'] === 'string' ? attributes['device_class'] : null
      const deviceClass = ent.device_class ?? ent.original_device_class ?? attrDeviceClass

      const mapping = mapHaEntityToCamStack({ domain, deviceClass, attributes })
      if (!mapping) continue

      const friendlyName =
        typeof attributes['friendly_name'] === 'string' ? attributes['friendly_name'] : undefined

      const rawOptions = states[entityId]?.attributes?.['options']
      const options: readonly string[] | undefined =
        Array.isArray(rawOptions) && rawOptions.length > 0
          ? (rawOptions as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined

      const entry: HaContainerEntityEntry = {
        entityId,
        deviceType: mapping.deviceType,
        capabilities: mapping.capabilities,
        ...(mapping.role !== null ? { role: mapping.role } : {}),
        ...(states[entityId]?.attributes?.['unit_of_measurement'] !== undefined
          ? { unitOfMeasurement: String(states[entityId]!.attributes['unit_of_measurement']) }
          : {}),
        ...(deviceClass !== null ? { deviceClass } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(mapping.dateTimeFormat !== undefined ? { dateTimeFormat: mapping.dateTimeFormat } : {}),
        ...(friendlyName !== undefined ? { name: friendlyName } : {}),
        ...(ent.entity_category !== null ? { entityCategory: ent.entity_category } : {}),
      }
      mappedEntities.push(entry)
    }

    const stableId = `ha:${brokerId}:dev:${device.id}`
    const suggestedName = device.name_by_user ?? device.name ?? device.id

    const prefilledConfig: Record<string, unknown> = {
      system: 'homeassistant',
      brokerId,
      haDeviceId: device.id,
      ...(integrationId !== undefined ? { integrationId } : {}),
      entities: mappedEntities,
    }

    const sourceInfo: SourceInfo = {
      id: device.id,
      system: 'homeassistant',
    }

    candidates.push({
      stableId,
      type: DeviceType.Container,
      suggestedName,
      prefilledConfig,
      sourceInfo,
    })
  }

  return candidates
}
