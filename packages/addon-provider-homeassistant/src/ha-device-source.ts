import { z } from 'zod'

/** Typed projection of the HA source references persisted in a device's
 *  config blob. Presence of a valid projection IS the proof of adoption. */
export interface HaDeviceSource {
  readonly system: 'homeassistant'
  readonly brokerId: string
  readonly haDeviceId?: string
  readonly entityId?: string
  readonly referenceEntityId?: string | null
  readonly capabilities: readonly string[]
  readonly role?: string
  readonly childDeviceIds: readonly number[]
  readonly unitOfMeasurement?: string
  readonly deviceClass?: string
  readonly integrationId?: string
  /** HA `options` attribute — captured at adoption for select / input_select
   *  entities so the control slice can be seeded before the first state-push. */
  readonly options?: readonly string[]
  /** Mapping-derived DeviceFeature flags (e.g. `lock-open` from a lock's
   *  `supported_features` OPEN bit). Surfaced on `device.features` so the UI
   *  gates feature-specific affordances (the lock "Open door" button, …). */
  readonly features?: readonly string[]
}

/**
 * Shared zod fields merged into the placeholder + child device schemas.
 *
 * Note: `brokerId` is intentionally REQUIRED — every HA-adopted device
 * persists one at adoption time and this object is only ever merged into
 * schemas that parse HA device blobs. For null-safe "is this an HA device?"
 * detection on arbitrary blobs (where `brokerId` may be absent), use
 * `readHaSource` (returns null) — do NOT use `z.object(haSourceSchemaFields).parse`.
 */
export const haSourceSchemaFields = {
  system: z.literal('homeassistant').optional(),
  brokerId: z.string(),
  haDeviceId: z.string().optional(),
  entityId: z.string().optional(),
  referenceEntityId: z.string().nullable().optional(),
  capabilities: z.array(z.string()).default([]),
  role: z.string().optional(),
  childDeviceIds: z.array(z.number()).default([]),
  unitOfMeasurement: z.string().optional(),
  deviceClass: z.string().optional(),
  integrationId: z.string().optional(),
  options: z.array(z.string()).optional(),
  features: z.array(z.string()).optional(),
  /** Sibling meter sensors whose readings this entity carries as `power-meter` (D951). */
  meterEntities: z
    .object({
      power: z.string().optional(),
      energy: z.string().optional(),
      voltage: z.string().optional(),
      current: z.string().optional(),
    })
    .optional(),
}

/** Project a persisted config blob into a typed source, or null when the
 *  blob is not an HA-adopted device (no brokerId). */
export function readHaSource(config: Record<string, unknown>): HaDeviceSource | null {
  const brokerId = config['brokerId']
  if (typeof brokerId !== 'string' || brokerId.length === 0) return null
  const caps = Array.isArray(config['capabilities'])
    ? config['capabilities'].filter((c): c is string => typeof c === 'string')
    : []
  const childIds = Array.isArray(config['childDeviceIds'])
    ? config['childDeviceIds'].filter((n): n is number => typeof n === 'number')
    : []
  const refRaw = config['referenceEntityId']
  const rawOpts = config['options']
  const opts: readonly string[] | undefined =
    Array.isArray(rawOpts) && rawOpts.length > 0
      ? rawOpts.filter((o): o is string => typeof o === 'string')
      : undefined
  const rawFeatures = config['features']
  const feats: readonly string[] | undefined =
    Array.isArray(rawFeatures) && rawFeatures.length > 0
      ? rawFeatures.filter((f): f is string => typeof f === 'string')
      : undefined

  const out: HaDeviceSource = {
    system: 'homeassistant',
    brokerId,
    capabilities: caps,
    childDeviceIds: childIds,
    ...(typeof config['haDeviceId'] === 'string' ? { haDeviceId: config['haDeviceId'] } : {}),
    ...(typeof config['entityId'] === 'string' ? { entityId: config['entityId'] } : {}),
    ...(refRaw === null ? { referenceEntityId: null } : {}),
    ...(typeof refRaw === 'string' ? { referenceEntityId: refRaw } : {}),
    ...(typeof config['role'] === 'string' ? { role: config['role'] } : {}),
    ...(typeof config['unitOfMeasurement'] === 'string'
      ? { unitOfMeasurement: config['unitOfMeasurement'] }
      : {}),
    ...(typeof config['deviceClass'] === 'string' ? { deviceClass: config['deviceClass'] } : {}),
    ...(typeof config['integrationId'] === 'string'
      ? { integrationId: config['integrationId'] }
      : {}),
    ...(opts !== undefined ? { options: opts } : {}),
    ...(feats !== undefined ? { features: feats } : {}),
  }
  return out
}
