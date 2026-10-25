import { DeviceRole, DeviceType } from '@camstack/types'
import type { HmChannel, HmCustomEntity, HmDevice } from 'nodehomematic'
import { mapHmDeviceChannels } from '../homematic-mapping.js'
import {
  mapFirmwareUpdate,
  mapMaintenanceChannel,
  type HmDerivedEntity,
} from '../homematic-diagnostics-mapping.js'
import { ACTUATOR_CAP_NAMES, keyEventVocabulary } from './hm-cold-start.js'

/**
 * SHARED per-entity derivation — the single source of truth for which functional
 * entities a Homematic physical device decomposes into (actuators / sensors /
 * ONE event-emitter / diagnostics / firmware-update) and how each is typed +
 * configured.
 *
 * Both adoption granularities consume this:
 *   - `'devices'` — {@link HmContainerDevice.getAccessoryChildren} wraps each
 *     spec into an `AccessoryChildSpec` (Container parent + accessory children).
 *   - `'entities'` — the adoption provider materialises ONE standalone top-level
 *     device per spec (no Container).
 *
 * Pure + facade-independent: the caller passes the device's typed custom
 * entities (the Container reads `facade.customEntities()`; the discovery /
 * preview path passes `[]` because it has no facade — actuators then derive
 * nothing for preview, which is acceptable display-only behaviour).
 *
 * The `key` is the stable per-entity suffix — IDENTICAL to the Container's
 * `stableIdSuffix` and the discovery preview key, so a preview, a container
 * child, and a standalone entity all line up on the same scheme:
 *   - actuator   → `act-<channelAddress>`
 *   - sensor     → `sensor-<channelAddress>`
 *   - events     → `events`
 *   - diagnostic → `maint-*` (the diagnostic entity key)
 *   - update     → `update`
 */
export interface HmEntitySpec {
  /** Stable per-entity suffix (`act-<chan>` / `sensor-<chan>` / `events` /
   *  `maint-*` / `update`). */
  readonly key: string
  readonly deviceType: DeviceType
  readonly role: DeviceRole | null
  readonly capabilities: readonly string[]
  readonly name: string
  /**
   * Per-child config blob. Carries ONLY the entity-shaped fields (channel,
   * capabilities, role, unit, sourceParams, kind, eventTypes) — the caller
   * stamps `system` / `brokerId` / `integrationId` / `address` (+ adoption
   * markers) on top.
   */
  readonly config: Record<string, unknown>
}

/** Actuator-entity kind discriminant carried on the child config. */
type HmActuatorKind = 'switch' | 'cover' | 'light' | 'lock' | 'climate'

const MAINTENANCE_CHANNEL_TYPE = 'MAINTENANCE'

/**
 * Map a custom-entity kind to the actuator discriminant + its CamStack cap +
 * CamStack DeviceType. Returns null for kinds with no actuator wiring.
 */
function actuatorInfo(
  kind: HmCustomEntity['kind'],
): { kind: HmActuatorKind; capName: string; type: DeviceType } | null {
  switch (kind) {
    case 'switch':
      return { kind: 'switch', capName: 'switch', type: DeviceType.Switch }
    case 'cover':
    case 'blind':
      return { kind: 'cover', capName: 'cover', type: DeviceType.Cover }
    case 'light':
      return { kind: 'light', capName: 'switch', type: DeviceType.Light }
    case 'lock':
      return { kind: 'lock', capName: 'lock-control', type: DeviceType.Lock }
    case 'climate':
      return { kind: 'climate', capName: 'climate-control', type: DeviceType.Thermostat }
    default:
      return null
  }
}

/**
 * The cover KIND of an actuator: a `blind` custom entity is a blind (slat
 * tilt), a plain `cover` entity is the roller shutter (HmIP-BROLL). Exporters
 * read it; every other actuator has no role.
 */
function actuatorRole(kind: HmCustomEntity['kind']): DeviceRole | null {
  if (kind === 'blind') return DeviceRole.CoverBlind
  if (kind === 'cover') return DeviceRole.CoverShutter
  return null
}

/** Actuator specs from the library's typed custom entities (correct channel). */
function deriveActuatorSpecs(customEntities: readonly HmCustomEntity[]): HmEntitySpec[] {
  const out: HmEntitySpec[] = []
  for (const entity of customEntities) {
    const info = actuatorInfo(entity.kind)
    if (info === null) continue
    out.push({
      key: `act-${entity.channel}`,
      deviceType: info.type,
      role: actuatorRole(entity.kind),
      capabilities: [info.capName],
      name: `${entity.kind} ${entity.channel}`,
      config: { channel: entity.channel, kind: info.kind, capabilities: [info.capName] },
    })
  }
  return out
}

/** Sensor specs (one per sensor channel) + ONE event-emitter spec over the
 *  union of key channels. Skips actuator caps (custom-entity-driven). */
function deriveSensorAndEventSpecs(device: Pick<HmDevice, 'channels'>): HmEntitySpec[] {
  const out: HmEntitySpec[] = []
  const keyChannels: HmChannel[] = []
  for (const { channel, mapping } of mapHmDeviceChannels(device)) {
    const sensorCaps: string[] = []
    let isEvent = false
    for (const capName of mapping.capabilities) {
      if (capName === 'event-emitter') {
        isEvent = true
        continue
      }
      if (ACTUATOR_CAP_NAMES.has(capName)) continue
      sensorCaps.push(capName)
    }
    if (isEvent) keyChannels.push(channel)
    if (sensorCaps.length > 0) {
      out.push({
        key: `sensor-${channel.address}`,
        deviceType: DeviceType.Sensor,
        role: mapping.role,
        capabilities: sensorCaps,
        name: `Sensor ${channel.address}`,
        config: {
          channel: channel.address,
          capabilities: sensorCaps,
          ...(mapping.role !== null ? { role: mapping.role } : {}),
        },
      })
    }
  }
  if (keyChannels.length > 0) {
    const eventTypes = [...keyEventVocabulary(keyChannels)]
    out.push({
      key: 'events',
      deviceType: DeviceType.EventEmitter,
      role: null,
      capabilities: ['event-emitter'],
      name: 'Buttons',
      config: { capabilities: ['event-emitter'], eventTypes },
    })
  }
  return out
}

/** Diagnostic specs from the MAINTENANCE channel. */
function deriveDiagnosticSpecs(
  device: Pick<HmDevice, 'channels'>,
  address: string,
): HmEntitySpec[] {
  const maintenanceChannel = device.channels.find(
    (c) => c.type?.toUpperCase() === MAINTENANCE_CHANNEL_TYPE,
  )
  const channelAddress = maintenanceChannel?.address ?? `${address}:0`
  return mapMaintenanceChannel(device).map((entity) => diagnosticSpec(entity, channelAddress))
}

function diagnosticSpec(entity: HmDerivedEntity, channelAddress: string): HmEntitySpec {
  return {
    key: entity.key,
    deviceType: entity.deviceType,
    role: entity.role,
    capabilities: [...entity.capabilities],
    name: entity.name,
    config: {
      channel: channelAddress,
      capabilities: [...entity.capabilities],
      sourceParams: [...(entity.sourceParams ?? [])],
      ...(entity.role !== null ? { role: entity.role } : {}),
      ...(entity.unit !== undefined ? { unit: entity.unit } : {}),
    },
  }
}

/** Firmware Update spec (if the device carries a firmware descriptor). */
function deriveUpdateSpec(
  device: Pick<HmDevice, 'firmware' | 'availableFirmware' | 'updatable' | 'firmwareUpdateState'>,
): HmEntitySpec[] {
  const update = mapFirmwareUpdate(device)
  if (!update) return []
  return [
    {
      key: update.key,
      deviceType: update.deviceType,
      role: update.role,
      capabilities: [...update.capabilities],
      name: update.name,
      config: { capabilities: [...update.capabilities] },
    },
  ]
}

/**
 * Structural subset of `HmDevice` {@link deriveHmEntitySpecs} reads. A `Pick`
 * keeps the signature tight while staying compatible with live `HmDevice`
 * instances, the adoption `HmDiscoverable`, and test fixtures — no call-site cast.
 */
export type HmEntitySpecSource = Pick<
  HmDevice,
  'address' | 'channels' | 'firmware' | 'availableFirmware' | 'updatable' | 'firmwareUpdateState'
>

/**
 * Derive the full per-entity spec list for a single Homematic device. ONE pure
 * function reused by the Container (`'devices'` granularity) and the standalone
 * entity adoption (`'entities'` granularity). `customEntities` are the device's
 * typed actuator entities from the facade (`[]` for the facade-less preview).
 */
export function deriveHmEntitySpecs(
  device: HmEntitySpecSource,
  customEntities: readonly HmCustomEntity[],
): readonly HmEntitySpec[] {
  return [
    ...deriveActuatorSpecs(customEntities),
    ...deriveSensorAndEventSpecs(device),
    ...deriveDiagnosticSpecs(device, device.address),
    ...deriveUpdateSpec(device),
  ]
}
