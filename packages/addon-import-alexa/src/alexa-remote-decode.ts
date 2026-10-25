import { z } from 'zod'
import type { AlexaAppliance, AlexaStateValue } from './alexa-client.js'

/**
 * Pure, total decoders translating `alexa-remote2` JSON response bodies into the
 * controller-agnostic shapes the addon consumes ({@link AlexaAppliance} /
 * {@link AlexaStateValue}). NO `alexa-remote2` import — these run against plain
 * data so they are unit-testable with fixtures (mirrors `alexa-domain-mapping`).
 *
 * Every shape is validated with Zod at the boundary (the raw bodies arrive as
 * `unknown` — the shipped lib types leave callback bodies generic), so a partial
 * / unexpected Amazon payload degrades to an empty result instead of throwing.
 */

// ── getSmarthomeDevicesV2 → appliances ───────────────────────────────────────

const capabilitySchema = z.union([
  z.object({ interfaceName: z.string().optional() }).passthrough(),
  z.string(),
])

const legacyApplianceSchema = z
  .object({
    applianceId: z.string().optional(),
    entityId: z.string().optional(),
    friendlyName: z.string().optional(),
    manufacturerName: z.string().optional(),
    capabilities: z.array(capabilitySchema).optional(),
  })
  .passthrough()

const endpointItemSchema = z
  .object({
    id: z.string().optional(),
    endpointId: z.string().optional(),
    friendlyName: z.string().optional(),
    legacyAppliance: legacyApplianceSchema.optional(),
  })
  .passthrough()

const endpointItemsSchema = z.array(endpointItemSchema)

/** Pull the Alexa interface names out of a legacy appliance's capabilities. */
function interfaceNamesOf(legacy: z.infer<typeof legacyApplianceSchema>): readonly string[] {
  const caps = legacy.capabilities ?? []
  const names: string[] = []
  for (const cap of caps) {
    if (typeof cap === 'string') {
      if (cap.length > 0) names.push(cap)
    } else if (typeof cap.interfaceName === 'string' && cap.interfaceName.length > 0) {
      names.push(cap.interfaceName)
    }
  }
  return names
}

/**
 * Decode a `getSmarthomeDevicesV2()` body into appliances. `groupName` is filled
 * later from the entities map (this endpoint carries no room). Endpoints without
 * a usable `applianceId` are skipped.
 */
export function decodeSmarthomeDevices(
  body: unknown,
  groupNameByApplianceId?: ReadonlyMap<string, string>,
): readonly AlexaAppliance[] {
  const parsed = endpointItemsSchema.safeParse(body)
  if (!parsed.success) return []

  const out: AlexaAppliance[] = []
  for (const item of parsed.data) {
    const legacy = item.legacyAppliance
    if (legacy === undefined) continue
    // The appliance's OWN stable id (Phoenix `applianceId` / `entityId`). We do
    // NOT fall back to the endpoint `id` — that is a different id namespace and
    // would mint a device with the wrong stable id.
    const applianceId = legacy.applianceId ?? legacy.entityId
    if (applianceId === undefined || applianceId.length === 0) continue

    const name = legacy.friendlyName ?? item.friendlyName ?? applianceId
    const interfaces = interfaceNamesOf(legacy)
    const groupName = groupNameByApplianceId?.get(applianceId)

    out.push({
      applianceId,
      name,
      interfaces,
      ...(legacy.manufacturerName !== undefined ? { manufacturer: legacy.manufacturerName } : {}),
      ...(groupName !== undefined ? { groupName } : {}),
    })
  }
  return out
}

// ── getSmarthomeEntities → applianceId → group/room name ──────────────────────

const behaviorEntitySchema = z
  .object({
    id: z.string().optional(),
    entityId: z.string().optional(),
    displayName: z.string().optional(),
    entityType: z.string().optional(),
    groupType: z.string().optional(),
  })
  .passthrough()

const behaviorEntitiesSchema = z.array(behaviorEntitySchema)

/**
 * Build an `applianceId → group/room display name` map from a
 * `getSmarthomeEntities()` body. Only GROUP-typed entities contribute a room
 * label; everything else is ignored. Returns an empty map on any parse failure.
 *
 * NOTE: the entities endpoint does not expose group membership directly in a
 * stable, documented field; we conservatively map an entity's own
 * `id`/`entityId` to its `displayName` when it is a group, which the device
 * decode then uses as the appliance's external location when ids line up.
 */
export function decodeEntityGroupNames(body: unknown): ReadonlyMap<string, string> {
  const parsed = behaviorEntitiesSchema.safeParse(body)
  if (!parsed.success) return new Map()
  const map = new Map<string, string>()
  for (const entity of parsed.data) {
    const id = entity.entityId ?? entity.id
    const name = entity.displayName
    if (id === undefined || name === undefined) continue
    if (entity.entityType !== 'GROUP' && entity.groupType === undefined) continue
    map.set(id, name)
  }
  return map
}

// ── querySmarthomeDevices → state values ─────────────────────────────────────

const capabilityStateSchema = z
  .object({
    namespace: z.string().optional(),
    name: z.string().optional(),
    value: z.unknown(),
    instance: z.string().optional(),
  })
  .passthrough()

const deviceStateSchema = z
  .object({
    entity: z.object({ entityId: z.string().optional() }).passthrough().optional(),
    capabilityStates: z.array(z.string()).optional(),
  })
  .passthrough()

const queryResultSchema = z
  .object({
    deviceStates: z.array(deviceStateSchema).optional(),
  })
  .passthrough()

/** Parse one JSON-encoded capability-state string into the validated shape. */
function parseCapabilityState(raw: string): z.infer<typeof capabilityStateSchema> | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = capabilityStateSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

/**
 * Decode a `querySmarthomeDevices()` body into flat state values. Each device's
 * `capabilityStates` is an array of JSON STRINGS that decode to
 * `{ namespace (= Alexa interface), name (= property), value }`. Malformed
 * entries are dropped. The `applianceId` is taken from the device's
 * `entity.entityId`.
 */
export function decodeSmarthomeStates(body: unknown): readonly AlexaStateValue[] {
  const parsed = queryResultSchema.safeParse(body)
  if (!parsed.success) return []

  const out: AlexaStateValue[] = []
  for (const device of parsed.data.deviceStates ?? []) {
    const applianceId = device.entity?.entityId
    if (applianceId === undefined || applianceId.length === 0) continue
    for (const raw of device.capabilityStates ?? []) {
      const state = parseCapabilityState(raw)
      if (state === null) continue
      const interfaceName = state.namespace
      const property = state.name
      if (interfaceName === undefined || property === undefined) continue
      out.push({ applianceId, interfaceName, property, value: state.value })
    }
  }
  return out
}
