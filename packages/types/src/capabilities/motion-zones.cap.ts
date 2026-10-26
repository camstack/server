import { z } from 'zod'
import {
  method,
  type CapabilityDefinition,
  type InferNativeProvider,
} from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { MaskGridShapeSchema, MaskShapeKindSchema, MaskGridDimsSchema } from './mask-shape.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Motion-zones share the same MaskShape vocabulary as privacy-mask — the
 * on-camera motion-detection mask is a single `grid` region (a row-major
 * boolean cell lattice the camera's onboard VMD evaluates). Composing it as
 * a region keeps one drawing-plane model across all geometry caps.
 */

/** A motion-zone region — exactly one boolean cell grid today. */
export const MotionZoneRegionSchema = z.object({
  id: z.number(),
  enabled: z.boolean(),
  shape: MaskGridShapeSchema,
})

/** Current on-camera motion-detection state — master enable + sensitivity +
 *  the grid region(s). */
export const MotionZoneStatusSchema = z.object({
  enabled: z.boolean(),
  sensitivity: z.number().meta(readingMeta('none')),
  /** Grid region(s). Today exactly one `grid` shape. */
  regions: z.array(MotionZoneRegionSchema),
  lastFetchedAt: z.number(),
})

/** Per-camera availability — grid dims are fixed per camera model; the UI
 *  sizes its editor from `grid`. */
export const MotionZoneOptionsSchema = z.object({
  maxRegions: z.number(),
  supportedShapes: z.array(MaskShapeKindSchema),
  grid: MaskGridDimsSchema,
  sensitivity: z.object({ min: z.number(), max: z.number(), step: z.number() }),
})

/** Partial change — every field optional. */
export const MotionZonePatchSchema = z.object({
  enabled: z.boolean().optional(),
  sensitivity: z.number().optional(),
  regions: z.array(MotionZoneRegionSchema).optional(),
})

export type MotionZoneRegion = z.infer<typeof MotionZoneRegionSchema>
export type MotionZoneStatus = z.infer<typeof MotionZoneStatusSchema>
export type MotionZoneOptions = z.infer<typeof MotionZoneOptionsSchema>
export type MotionZonePatch = z.infer<typeof MotionZonePatchSchema>

export const motionZonesCapability = {
  name: 'motion-zones',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  deviceConfig: {
    ui: {
      kind: 'widget',
      widgetId: 'host/motion-zones-grid',
      tab: 'motion',
      label: 'Motion Zones',
    },
  },
  methods: {
    getOptions: method(z.object({ deviceId: z.number() }), MotionZoneOptionsSchema),
    setZone: method(z.object({ deviceId: z.number(), patch: MotionZonePatchSchema }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
  status: { schema: MotionZoneStatusSchema, kind: 'poll' },
  runtimeState: MotionZoneStatusSchema,

  /**
   * Runtime-state durability: **restored** — the 14 KB polygon list is the single largest slice on the fleet and has not changed since the operator drew it. Highest value per byte in the table.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): none — configuration.
   */
  history: 'none',
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IMotionZonesProvider = InferNativeProvider<typeof motionZonesCapability>
