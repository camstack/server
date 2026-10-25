import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { CamProfileSchema } from './schemas/streaming-shared.js'

/**
 * device-ops — device-scoped cap that unifies the per-IDevice operations
 * previously routed through the `.device-ops` Moleculer bridge service.
 *
 * Each worker that hosts live `IDevice` instances auto-registers a native
 * provider for this cap (per device) backed by its local
 * `DeviceRegistry`. Hub-side callers reach it transparently through
 * `ctx.fetchDevice(id).deviceOps.*` — the DeviceProxy injects
 * `deviceId` + `nodeId` and dispatches through the standard cap-router,
 * so there's no parallel bridge path anymore.
 *
 * The surface is intentionally small — every method corresponds to a
 * single action on the live `IDevice` (or `ICameraDevice` for
 * `getStreamSources`). Richer orchestration (enable/disable with
 * integration plumbing, bulk updates) stays in the `device-manager` cap;
 * `device-ops` is the per-device primitive the device-manager routes to.
 */
const StreamSourceEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  protocol: z.enum(['rtsp', 'rtmp', 'annexb', 'http-mjpeg', 'webrtc', 'custom']),
  url: z.string().optional(),
  resolution: z.object({ width: z.number(), height: z.number() }).optional(),
  fps: z.number().optional(),
  bitrate: z.number().optional(),
  codec: z.string().optional(),
  profileHint: CamProfileSchema.optional(),
  sdp: z.string().optional(),
})

const ConfigEntrySchema = z.object({
  key: z.string(),
  value: z.unknown(),
})

export const RawStateResultSchema = z.object({
  /** Originating provider id, e.g. 'homeassistant' | 'reolink' | 'hikvision'. */
  source: z.string(),
  /** Opaque, DISPLAY-SAFE upstream blob (no secrets/PII). */
  data: z.record(z.string(), z.unknown()),
})
export type RawStateResult = z.infer<typeof RawStateResultSchema>

export const deviceOpsCapability = {
  name: 'device-ops',
  scope: 'device',
  // Device-native: a provider is auto-registered PER DEVICE in the worker
  // that hosts the live `IDevice` (see `buildDeviceOpsProvider`). The mount
  // MUST use `requireDeviceScoped` (→ `getNativeProvider(cap, deviceId)`) so
  // calls route to the owning runner; without this flag codegen falls back to
  // `getSingleton('device-ops')`, which returns null for a per-device cap and
  // makes every device-ops method unroutable for forked devices.
  deviceNative: true,
  mode: 'singleton',
  methods: {
    /**
     * Return stream sources for camera-like devices. Non-camera devices
     * return an empty array (the bridge did the same; preserved for compat).
     */
    getStreamSources: method(z.object({ deviceId: z.number() }), z.array(StreamSourceEntrySchema)),

    /**
     * Return the device's config entries (key + current value). Used by
     * the device-manager aggregator when reading the driver's schema+values.
     */
    getConfigEntries: method(z.object({ deviceId: z.number() }), z.array(ConfigEntrySchema)),

    /**
     * Bulk-apply a config patch via `IDevice.config.setAll`. Covers the
     * updateConfig / setStreamProfileMap / enable-as-config paths from
     * the old bridge.
     */
    setConfig: method(
      z.object({
        deviceId: z.number(),
        values: z.record(z.string(), z.unknown()),
      }),
      z.void(),
      // Admin (D634 r3): this rewrites the CONNECTION config — host, port,
      // password. An operator could point a camera's stored credentials at a
      // host of their own. The device manager calls it through the provider
      // registry, never through this router.
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Invoke a device custom action on a forked/remote device (the
     * cross-process transport for `IDevice.runDeviceAction`). Mirrors
     * `setConfig` — the device-manager calls this when the device is not
     * hub-local.
     */
    runAction: method(
      z.object({
        deviceId: z.number(),
        action: z.string().min(1),
        input: z.unknown(),
      }),
      z.unknown(),
      { kind: 'mutation' },
    ),

    /**
     * Invoke `IDevice.removeDevice()` so the driver can release resources
     * (close sockets, stop background tasks, …). The device-manager still
     * performs its own persistence cleanup before/after this call.
     */
    // Admin (D634 r3): the driver-cleanup half of a deletion. The public path
    // is `deviceManager.removeDevice`, which runs persistence cleanup too.
    removeDevice: method(z.object({ deviceId: z.number() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /**
     * Build the ConfigUISchema (FormBuilder input shape) from the device's
     * Zod config schema. Runs on the worker that owns the IDevice so the
     * Zod types stay local (they're function references, not
     * serializable). Returns a fully JSON-serializable schema with
     * sections/fields the admin UI renders directly.
     *
     * Needed because the hub-side `device-manager.getSettingsSchema`
     * couldn't reach forked-worker devices — it had no registry entry
     * and no cross-process lookup, so the UI silently rendered an empty
     * settings panel for every worker-owned device.
     *
     * Returns `null` when the device isn't found on this worker.
     */
    getSettingsSchema: method(z.object({ deviceId: z.number() }), z.unknown().nullable()),

    /**
     * Opt-in: return the device's RAW upstream state (the provider's
     * cached values) as a display-safe `{ source, data }` blob. Returns
     * `null` when the device exposes no raw state — the State panel hides
     * its Raw toggle in that case. One-shot (read the provider's existing
     * cache; no upstream round-trip).
     */
    getRawState: method(z.object({ deviceId: z.number() }), RawStateResultSchema.nullable(), {
      auth: 'protected',
    }),
  },
} as const satisfies CapabilityDefinition

export type IDeviceOpsProvider = InferProvider<typeof deviceOpsCapability>
