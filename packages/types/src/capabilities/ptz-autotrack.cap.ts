import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * `ptz-autotrack` — sibling cap of `ptz` that exposes the on-camera
 * smart-tracking subsystem (subject-following). Modeled separately
 * from `ptz` because:
 *   - Not every PTZ-capable camera has autotrack (Reolink: yes;
 *     Hikvision: model-dependent), so a single combined cap would
 *     force every PTZ provider to surface `Unsupported` stubs on
 *     half the methods.
 *   - The cap's lifecycle is "registered when probed-true" — the
 *     binding system can show / hide the UI affordance cleanly via
 *     the standard `provider-registered` signal.
 *   - Autotrack on/off is a device-state toggle (status), distinct
 *     from PTZ's continuous control surface — a status-driven cap
 *     fits the existing `setStatus` / `onStatusChanged` pattern
 *     better than `ptz`'s discrete-action surface.
 *
 * Settings (cross-vendor consolidation, sourced from Reolink's
 * `setAutotrackingSettings` shape; expandable as Hikvision /
 * Dahua / others land):
 *   - `targetType`            — vendor target string (people /
 *                                vehicle / pet / `''` = camera default)
 *   - `stopDelaySeconds`      — how long to keep tracking a
 *                                stationary target before stopping
 *                                (0..300, default 30)
 *   - `disappearDelaySeconds` — how long to wait before releasing a
 *                                target that has left the frame
 *                                (0..300, default 15)
 *
 * The driver is the source of truth for which settings keys it
 * actually honours; unsupported keys silently fall back to the
 * camera's defaults. Adding a new vendor's setting (e.g. Hikvision's
 * `trackingDuration`) extends the schema below and the
 * `setSettings` payload.
 */

const AutotrackTargetTypeSchema = z
  .string()
  .describe('Vendor target string (people/vehicle/pet); empty = camera default')

export const PtzAutotrackSettingsSchema = z.object({
  targetType: AutotrackTargetTypeSchema,
  stopDelaySeconds: z.number().int().min(0).max(300).meta(readingMeta('duration')),
  disappearDelaySeconds: z.number().int().min(0).max(300).meta(readingMeta('duration')),
})

export type PtzAutotrackSettings = z.infer<typeof PtzAutotrackSettingsSchema>

/**
 * One option the camera advertises as a valid `targetType`. Drivers
 * harvest this from their probe data; the UI renders these as the
 * `targetType` select options. Empty array = the camera doesn't
 * expose a target-type selector (auto-only).
 *
 * The `value` is the canonical wire string the cap accepts in
 * `setSettings({targetType})` — drivers use it verbatim when pushing
 * to firmware. The `label` is operator-facing English (translated
 * client-side if the UI supports i18n).
 */
export const PtzAutotrackTargetOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
})

export type PtzAutotrackTargetOption = z.infer<typeof PtzAutotrackTargetOptionSchema>

export const PtzAutotrackStatusSchema = z.object({
  /** True when autotrack is currently armed on the camera. */
  enabled: z.boolean(),
  /** Ms epoch of the last on/off transition (0 if never observed). */
  lastChangedAt: z.number(),
  /** Currently-applied settings the camera reports. Drivers fill
   *  this from the firmware GET so the UI can echo what's *really*
   *  active vs the operator-typed values in the settings form. */
  currentSettings: PtzAutotrackSettingsSchema.nullable(),
  /**
   * Target types the camera advertises. Driver-supplied — Reolink
   * exposes `people` / `vehicle` / `pet`, Hikvision exposes
   * `auto` / `human` / `vehicle` when the `<smartTrackingType>` knob
   * is supported. Empty array = vendor doesn't expose a selector
   * (treat as auto-only). The UI renders these as the `targetType`
   * field options without hardcoding a vendor-specific list.
   */
  supportedTargetTypes: z.array(PtzAutotrackTargetOptionSchema),
})

export type PtzAutotrackStatus = z.infer<typeof PtzAutotrackStatusSchema>

/**
 * Runtime-state slice owned by this cap. Persists the last-known
 * camera-derived snapshot across restarts, so cold-start callers
 * have a meaningful baseline even before the first refresh round-trip.
 *
 * Adds `lastFetchedAt` on top of the status shape so the framework
 * (or the provider) can stale-check before deciding whether to
 * round-trip the camera again.
 */
export const PtzAutotrackRuntimeStateSchema = PtzAutotrackStatusSchema.extend({
  /** Ms epoch of the last successful camera fetch (0 = never). */
  lastFetchedAt: z.number(),
})

export type PtzAutotrackRuntimeState = z.infer<typeof PtzAutotrackRuntimeStateSchema>

export const ptzAutotrackCapability = {
  name: 'ptz-autotrack',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  /**
   * Two kinds of provider behind one name, the same shape `snapshot` uses:
   *
   *  - **Native**: the camera's own firmware autotrack, registered per device by
   *    the driver when the probe says it exists (Reolink: yes; Hikvision:
   *    model-dependent).
   *  - **Wrapper**: the emulated implementation (`@camstack/system`'s `autotrack` builtin),
   *    which follows a subject with `ptz.move` pulses driven by the detection
   *    pipeline. `defaultActive: false` — the operator binds it per camera in
   *    the bindings UI.
   *
   * The binding chooses WHICH implementation answers; `setEnabled` stays the
   * one switch for the function either way. A camera never has both driving its
   * head, which is the whole reason this is not a second cap with a second
   * toggle (D62, D520).
   */
  kind: 'wrapper',
  defaultActive: false,
  deviceTypes: [DeviceType.Camera],
  deviceConfig: {
    ui: {
      kind: 'widget',
      widgetId: 'host/ptz-autotrack',
      tab: 'ptz',
      topTab: true,
      label: 'Auto-Tracking',
      order: 5,
    },
  },
  methods: {
    /**
     * Read the current on/off state + last-applied settings.
     * Drivers may serve from a cache + refresh on a schedule —
     * callers should NOT poll faster than ~5s.
     */
    getStatus: method(z.object({ deviceId: z.number() }), PtzAutotrackStatusSchema),
    /**
     * Arm or disarm autotrack. Resolves once the camera has
     * acknowledged the transition; the `onStatusChanged` event
     * fires shortly after with the live state.
     */
    setEnabled: method(z.object({ deviceId: z.number(), enabled: z.boolean() }), z.void(), {
      kind: 'mutation',
    }),
    /**
     * Read settings (target type + delays). Mirrors the
     * `getStatus().currentSettings` payload but exposes it as a
     * standalone read for callers that want settings without the
     * status surface around them. `null` until the driver has
     * harvested the firmware state at least once.
     */
    getSettings: method(z.object({ deviceId: z.number() }), PtzAutotrackSettingsSchema.nullable()),
    /**
     * Update one or more settings. Partial — keys that aren't
     * supplied keep their last persisted value. The driver is
     * responsible for clamping vendor-specific ranges if narrower
     * than the cross-vendor max declared on the schema.
     */
    setSettings: method(
      z.object({
        deviceId: z.number(),
        settings: PtzAutotrackSettingsSchema.partial(),
      }),
      z.void(),
      // Configuration, not operation: admin for a viewer (D921).
      { role: 'admin', kind: 'mutation' },
    ),
  },
  events: {
    onStatusChanged: {
      data: z.object({
        deviceId: z.number(),
        status: PtzAutotrackStatusSchema,
      }),
    },
  },
  status: {
    schema: PtzAutotrackStatusSchema,
    kind: 'command-driven',
  },
  /**
   * Persistent slice mirrored across restarts. The provider writes
   * here on every successful firmware fetch / settings push;
   * `getStatus` and `getSettings` then read this snapshot synchronously
   * with a stale-driven async refresh in the background. Keeps the
   * fetch / cache / fallback logic out of the four cap methods —
   * they become trampolines over `runtimeState`.
   */
  runtimeState: PtzAutotrackRuntimeStateSchema,

  /**
   * Runtime-state durability: **session** — mirrors the camera's own autotrack config, re-read on connect.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — configuration and capability.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IPtzAutotrackProvider = InferProvider<typeof ptzAutotrackCapability>
