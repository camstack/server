import { z } from 'zod'
import { DeviceType, DeviceRole, EnumSensorDateTimeFormatSchema } from '@camstack/types'

/**
 * HA-specific discovery data types — addon-internal.
 *
 * These shapes were formerly the `ha-discovery` cap's data schemas.
 * That cap was removed in favour of the generic `device-adoption`
 * cap, so these types are no longer a public cap surface — they live
 * here as the HA addon's own discovery model. The `HaDiscoveryService`
 * produces them and `haDeviceToCandidate` adapts an `HaDiscoveredDevice`
 * onto the shared `DiscoveredChildDevice` the `device-adoption` cap
 * surfaces.
 */

/**
 * Synthetic `haDeviceId` bucket for `entity_registry` rows with
 * `device_id === null` (helpers, template sensors, `daily` statistics, …).
 * Flattened into the Entities adoption tab / standalone reconcile; never
 * shown as a Devices-tab candidate.
 */
export const HA_ORPHAN_ENTITIES_DEVICE_ID = '__ha_orphan_entities__'

/**
 * Mapping result for one entity — what the adoption flow would do
 * with this entity if the operator adopts the HA device. Computed at
 * discovery time so the UI can preview the materialisation without
 * a separate round-trip.
 */
/** HA `entity_category` values that group an entity into a non-control section.
 *  HA's own nomenclature: `config` → Configuration, `diagnostic` → Diagnostic.
 *  A `null` category (the common case) means a normal control. */
export type HaEntityCategory = 'config' | 'diagnostic'

const HaEntityMappingSchema = z
  .object({
    /** CamStack DeviceType for the accessory child. */
    deviceType: z.enum(DeviceType),
    /** Optional CamStack DeviceRole sub-role (e.g. `ContactSensor` for
     *  a binary_sensor with `device_class: door`). */
    role: z.enum(DeviceRole).nullable(),
    /** Capability names the accessory child will register
     *  (`switch` / `temperature-sensor` / …). UI may render the cap
     *  badges to help the operator decide what to hide. */
    capabilities: z.array(z.string()).readonly(),
    /** Mapping-derived DeviceFeature flags (e.g. `lock-open`). Persisted onto
     *  the child's `device.features` so the UI gates feature affordances. */
    features: z.array(z.string()).readonly().optional(),
    /** Locale-render shape for a `DateTimeSensor`-role enum sensor
     *  (`device_class=timestamp` → `'datetime'`, `date` → `'date'`). Threaded
     *  onto the child config so the enum-sensor device seeds it into the cap
     *  slice. Absent for every non-DateTimeSensor mapping. */
    dateTimeFormat: EnumSensorDateTimeFormatSchema.optional(),
  })
  .nullable()

export const HaDiscoveredEntitySchema = z.object({
  /** Fully-qualified HA entity id (`switch.kitchen`). */
  entityId: z.string(),
  /** HA domain — first segment of entity_id (`switch` / `light` /
   *  `sensor` / `binary_sensor` / `cover` / …). */
  domain: z.string(),
  /** Operator-visible friendly name (HA `friendly_name` attribute or
   *  the entity_id when missing). */
  name: z.string(),
  /** Current state value (e.g. `'on'`, `'21.5'`, `'open'`). */
  state: z.string(),
  /** HA `device_class` attribute when present — drives the role +
   *  cap mapping for sensors / binary_sensors / covers. */
  deviceClass: z.string().nullable(),
  /** HA `unit_of_measurement` attribute when present. */
  unitOfMeasurement: z.string().nullable(),
  /** Area name for this entity — the entity's own HA area if set, else its
   *  parent device's area. Null when neither is assigned. */
  area: z.string().nullable().default(null),
  /** HA `options` attribute — present on `select` / `input_select` entities.
   *  Captured at discovery so the adopt handler can persist them alongside
   *  other entity config fields. Absent on non-select entities. */
  options: z.array(z.string()).nullable().default(null),
  /** HA `entity_category` — `config` / `diagnostic` / null (a normal control).
   *  Drives the accordion section the adopted child renders in. Null/absent for
   *  the common control case. */
  entityCategory: z.enum(['config', 'diagnostic']).nullable().default(null),
  /** Pre-computed CamStack mapping. `null` when the entity's domain
   *  has no supported mapping (the operator may still adopt the
   *  parent — the entity will be skipped or surfaced as a fallback). */
  mappedTo: HaEntityMappingSchema,
  /** When `true`, the entity was already materialised as a CamStack
   *  accessory child under a prior adoption — surfaced so the UI can
   *  highlight existing wiring. */
  alreadyAdopted: z.boolean(),
  /** When `alreadyAdopted === true`, the kernel-assigned accessory
   *  child id. */
  adoptedCamDeviceId: z.number().int().nonnegative().nullable(),
})
export type HaDiscoveredEntity = z.infer<typeof HaDiscoveredEntitySchema>

export const HaDiscoveredDeviceSchema = z.object({
  /** Stable HA `device_registry` id — survives renames + restarts. */
  haDeviceId: z.string(),
  /** Operator-visible name (HA device `name` or first entity's
   *  friendly_name when device has none). */
  name: z.string(),
  /** Area name from HA `area_registry` join. Null when unassigned. */
  area: z.string().nullable(),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  swVersion: z.string().nullable(),
  /** Dominant integration / platform domain for this device, derived from its
   *  entities' HA `entity_registry.platform` (e.g. `dreame_vacuum`). Generic /
   *  helper platforms (`unifi` / `hacs` / `hassio`) are excluded when a real
   *  platform is available. Null when the device has no entities. */
  integration: z.string().nullable().default(null),
  /** Convenience field — count of `entities[]`. */
  entityCount: z.number().int().nonnegative(),
  /** Every entity HA's `entity_registry` links to this device. The
   *  list survives row collapse — full devices are returned so
   *  accordion expansion is a no-roundtrip render. */
  entities: z.array(HaDiscoveredEntitySchema).readonly(),
  /** Whether this HA device has an active CamStack adoption. */
  alreadyAdopted: z.boolean(),
  /** When `alreadyAdopted === true`, the kernel-assigned parent id. */
  adoptedCamDeviceId: z.number().int().nonnegative().nullable(),
})
export type HaDiscoveredDevice = z.infer<typeof HaDiscoveredDeviceSchema>

export const HaDiscoveryStatusSchema = z.object({
  /** Last refresh timestamp (ms epoch) — null when never refreshed. */
  lastDiscoveryAt: z.number().int().nonnegative().nullable(),
  /** Count of HA devices in the discovery cache (across all brokers). */
  deviceCount: z.number().int().nonnegative(),
  /** Count of HA devices currently materialised as CamStack parent
   *  devices. */
  adoptedCount: z.number().int().nonnegative(),
  /** Last error message from a refresh attempt. */
  lastError: z.string().nullable(),
})
export type HaDiscoveryStatus = z.infer<typeof HaDiscoveryStatusSchema>

export { HaEntityMappingSchema }
