import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import {
  method,
  type CapabilityDefinition,
  type InferNativeProvider,
  type InferProvider,
} from './capability-definition.js'

/**
 * camera-grid-layout — the geometry of a COMPOSITE camera, on the camera's own
 * page.
 *
 * ## Why this is a capability and not an addon settings schema
 *
 * It was one, and it did not render. The addon declared the editor as a
 * `type: 'widget'` field inside its own `deviceSettingsSchema()`; the hub
 * returned that section correctly and `ConfigFormField` renders `type:'widget'`
 * perfectly well — and nothing ever asked camera-grid for it. The Cluster →
 * Pipeline → Device Overrides page interrogates a HAND-WRITTEN list of four
 * addons (`PIPELINE_CLUSTER_DEVICE_ADDONS`), whose own comment says an addon
 * not on it "falls off silently".
 *
 * Adding a fifth name to that list would have been the wrong fix twice over:
 * that page is per-camera DETECTION tuning, and a grid's geometry belongs
 * beside PTZ and motion zones on the camera itself. The device page is
 * BINDING-driven (D12), so the way in is a capability bound to the device —
 * and this cap carries its section the way `recording` does, by RETURNING it
 * from `getDeviceSettingsContribution`.
 *
 * Seven other widgets are still declared the other way, through a
 * `deviceConfig.ui` block the framework derives a section from. That route
 * gives the addon no say in where its own panel lands and no way to decline
 * for a device the panel does not suit, which is why this one does not use it.
 *
 * ## Why one addon may implement it
 *
 * It is a device-scoped NATIVE cap, registered by the grid camera device
 * itself. Nothing else declares a composite camera, so nothing else has a
 * layout — and the device-scoped route means the widget asks THE camera, not
 * "the camera-grid addon", which is what let the old custom-action pair be
 * reached only by a caller that already knew the addon id.
 *
 * ## The tab
 *
 * `streaming`, not a top-tab of its own. A grid's geometry IS what its stream
 * is, so the Streaming tab is where it belongs; a `grid` top-tab would need an
 * entry in `WELL_KNOWN_TAB_MAP` or the device page renders the raw id as the
 * label (measured on the robot camera, 2026-09-06 — a tab called "navigation"
 * next to "PTZ").
 */

/** A rectangle in normalized [0,1] coordinates of whatever contains it. */
const GridNormalizedRectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
})

/**
 * One source camera, the part of its picture taken, and where that part lands.
 *
 * Both rectangles are NORMALIZED (D519): a source camera can change resolution
 * — a profile switch, a firmware update, a substream that comes back different
 * — and a stored PIXEL rectangle would quietly start cutting the wrong region,
 * which is the class of bug nobody files.
 */
const GridLayoutCellSchema = z.object({
  deviceId: z.number().int().positive(),
  /** The part of the SOURCE taken, normalized against the source. */
  source: GridNormalizedRectSchema,
  /** Where it lands, normalized against the CANVAS. */
  cell: GridNormalizedRectSchema,
})

/**
 * Which profiles this grid can actually compose, and why not.
 *
 * A grid's `high` composes its sources' `high` and its `low` their `low`, so a
 * profile is on offer only when EVERY source can serve it. The refusal NAMES
 * the sources, because "this grid has no low" is not a finding — "101 has no
 * low" is, and it is the one an operator can act on.
 */
const GridProfileOfferSchema = z.object({
  profile: z.enum(['high', 'mid', 'low']),
  offered: z.boolean(),
  /** Sources that cannot serve it. Empty when it is offered, or when there are no cells. */
  missingSources: z.array(z.number().int().positive()),
  /**
   * The canvas this profile composes onto, `WxH`, or empty when it is not
   * offered. DERIVED from the cells and the sources' own size at this profile —
   * it is reported because nothing else in the system would ever say what the
   * grid came out as, and because it is the number an operator would otherwise
   * expect to type.
   */
  canvas: z.string(),
  /**
   * Whether this profile is PUBLISHED, of the ones the grid could serve.
   *
   * A grid's `high` is composed of its sources' `high`, so on a 4K fleet it is
   * a 4K canvas built from 4K decodes — something to opt into, not something a
   * viewer's adaptive should be handed by climbing to the top rung it can see.
   * Default is `mid` + `low`.
   */
  published: z.boolean(),
})

export const GridLayoutViewSchema = z.object({
  /** The persisted grid row this camera was declared from. */
  instanceId: z.string(),
  deviceId: z.number().int().nonnegative(),
  name: z.string(),
  /**
   * NO canvas size. A grid's resolution is not authored: each profile derives
   * its own from the cells and its sources' dimensions. The two numbers that
   * used to be here were a text field that silently decided both how much the
   * composite cost and how sharp it was — see `profiles[].canvas` for what it
   * came out as.
   */
  fps: z.number().int(),
  cells: z.array(GridLayoutCellSchema),
  /** What the catalog will publish, and what it refuses to. Read-only. */
  profiles: z.array(GridProfileOfferSchema),
})

export type GridNormalizedRect = z.infer<typeof GridNormalizedRectSchema>
export type GridLayoutCell = z.infer<typeof GridLayoutCellSchema>
export type GridProfileOffer = z.infer<typeof GridProfileOfferSchema>
export type GridLayoutView = z.infer<typeof GridLayoutViewSchema>

export const GridLayoutPatchSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  name: z.string().min(1).max(160).optional(),
  fps: z.number().int().min(1).max(60).optional(),
  /** Which profiles to publish. See `GridProfileOffer.published`. */
  publishedProfiles: z
    .array(z.enum(['high', 'mid', 'low']))
    .max(3)
    .optional(),
  /**
   * The whole cell list at once. A per-cell patch would need an ordering the
   * editor does not have, and a half-applied layout is a picture nobody asked
   * for.
   */
  cells: z.array(GridLayoutCellSchema).max(16),
})

export type GridLayoutPatch = z.infer<typeof GridLayoutPatchSchema>

export const cameraGridLayoutCapability = {
  name: 'camera-grid-layout',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  /**
   * The section is built by the ADDON and returned from
   * `getDeviceSettingsContribution`, not derived by the framework from a
   * `deviceConfig.ui` block.
   *
   * Both mechanisms render the same widget. This one hands the addon two
   * things the framework-derived route cannot give it:
   *
   *  - it chooses its own section, `tab`, `location` and `order`, the way any
   *    other setting does, instead of receiving them from a cap declaration;
   *  - it can DECLINE per device. A camera that is not a grid gets no section
   *    at all, rather than a widget that renders its own "not a grid" state.
   *
   * `recording` is the precedent (`recorder/recording-device-settings.ts`): it
   * returns `null` for anything that is not a camera, so the Recording tab
   * never appears there.
   */
  exposesDeviceSettings: true,
  methods: {
    /**
     * The grid behind this device.
     *
     * `null` means ANSWERED and this camera is not a grid — not "not yet
     * known". The widget renders its "this is not a grid camera" state only
     * from this answer, never from an unresolved query (D315).
     */
    getLayout: method(
      z.object({ deviceId: z.number().int().nonnegative() }),
      GridLayoutViewSchema.nullable(),
      { auth: 'admin' },
    ),
    /** Write the geometry back. Returns the grid as it now stands, profiles included. */
    saveLayout: method(GridLayoutPatchSchema, GridLayoutViewSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

/**
 * The DEVICE's provider: the data methods only.
 *
 * `InferNativeProvider` deliberately omits the device-settings contribution —
 * the framework expects a native provider to hold the data and a WRAPPER to
 * describe the UI, which is why `getProviderByAddon` (not
 * `getProviderForDevice`) is what the aggregation resolves with.
 */
export type ICameraGridLayoutProvider = InferNativeProvider<typeof cameraGridLayoutCapability>

/**
 * The ADDON's provider: the same methods plus the contribution surface that
 * `exposesDeviceSettings` adds. This is the one that carries the section, and
 * the one that can decline for a device that is not a grid.
 *
 * Two types for two roles, the same split `doorbell` and `snapshot` use.
 */
export type ICameraGridLayoutSettingsProvider = InferProvider<typeof cameraGridLayoutCapability>
