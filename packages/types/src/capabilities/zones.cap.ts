import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Zone — pure geometry + identity. NO filtering behaviour.
 *
 * Zones describe **where** in the frame the operator wants to flag
 * something; consumer-owned {@link ZoneRule} arrays describe **how**
 * each pipeline stage uses them. Splitting the two means a single
 * polygon "Driveway" can simultaneously back a motion-exclude rule,
 * a detection-include rule on `['car']`, and an occupancy aggregate
 * — without three duplicated polygons.
 *
 * Owned by the orchestrator addon (provider) and mirrored into the
 * `zones` device-state slice on every mutation. Consumers
 * (motion-wasm, pipeline-executor, analytics, admin UI) read either
 * via `api.zones.listZones` (one-shot) or via `dev.state.zones` (live
 * mirror with `onChanged`).
 *
 * Coordinates are normalised fractions of the frame (0–1) so zones
 * survive resolution changes and stream profile switches.
 *
 * `kind` discriminates between full polygons (closed regions used
 * for intrusion / occupancy filters) and tripwires (open 2-point
 * line segments used for cross events). Onboard / firmware-reported
 * zones (Reolink, ONVIF) are out of scope for now — see the deferred
 * task list.
 */
export const ZoneKindEnum = z.enum(['polygon', 'tripwire'])
export type ZoneKind = z.infer<typeof ZoneKindEnum>

/** Polygon vertex in fraction-of-frame coordinates (0–1). */
export const PolygonPointSchema = z.object({
  x: z.number(),
  y: z.number(),
})
export type PolygonPoint = z.infer<typeof PolygonPointSchema>

/** A camera detection zone — pure geometry/identity. */
export const ZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: ZoneKindEnum.default('polygon'),
  /** Polygon vertices, fraction of frame (0–1). */
  polygon: z.array(PolygonPointSchema).readonly(),
  /** Visual color for UI rendering. */
  color: z.string().default('#3b82f6'),
})
export type Zone = z.infer<typeof ZoneSchema>

/**
 * Zones capability — per-camera CRUD over polygon detection zones.
 *
 * Provider lives in `addon-pipeline-orchestrator` (hub-only). Persists
 * to per-device settings and mirrors into the `zones` device-state
 * slice on every mutation, so downstream consumers can subscribe via
 * `dev.state.zones.onChanged`.
 *
 * The cap surface only handles geometry + identity; filtering
 * behaviour (per-class, include/exclude, threshold) lives in the
 * consumer addons' rule arrays — see `ZoneRuleSchema` exported from
 * `capabilities/schemas/zone-rule.js`.
 */
export const zonesCapability = {
  name: 'zones',
  scope: 'device',
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  methods: {
    listZones: method(z.object({ deviceId: z.number() }), z.array(ZoneSchema).readonly()),
    addZone: method(z.object({ deviceId: z.number(), zone: ZoneSchema }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    removeZone: method(z.object({ deviceId: z.number(), zoneId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    updateZone: method(z.object({ deviceId: z.number(), zone: ZoneSchema }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
  /**
   * Runtime-state slice — the live zone catalogue mirrored by the
   * orchestrator on every CRUD mutation. Consumers read via
   * `device.state.zones.value` / `.watch(...)` without round-tripping
   * the cap, and the codegen DeviceProxy auto-wires the reactive
   * handle. Slice shape is `{ zones: Zone[] }` so future extensions
   * (e.g. zone groupings) can sit alongside the polygon list.
   */
  runtimeState: z.object({
    zones: z.array(ZoneSchema).readonly(),
  }),

  /**
   * Runtime-state durability: **restored** — written only on operator mutation, so a camera that never had one has nothing to re-derive from. This is the slice `zone-mirror-hydration.ts` exists to paper over.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): none — configuration arrays.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IZonesProvider = InferProvider<typeof zonesCapability>
