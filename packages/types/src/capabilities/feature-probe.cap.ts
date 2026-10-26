import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Per-device feature/identity probe slice. Holds the runtime-resolved
 * truth about what a device CAN do — which the kernel uses to:
 *   1. Reconcile accessory children (hub-children spawn siren/floodlight/PIR
 *      based on what the firmware actually advertises).
 *   2. Compute the public `features: DeviceFeature[]` array surfaced via
 *      `device-manager.listAll`.
 *   3. Decide which optional caps (PTZ, intercom, doorbell, battery, …)
 *      to register on the device's capability surface.
 *
 * Auto-registered by `BaseDevice` for every device. Drivers populate the
 * slice from `onProbe()` (kernel calls it once after register, before
 * accessory reconciliation). Consumers read via:
 *   `runtimeState.getCapState<FeatureProbeStatus>('feature-probe')`
 *
 * `flags` is an open record so each driver carries its own keys without
 * a centralized schema bottleneck — Reolink writes `hasPtz/hasIntercom`,
 * Hikvision writes `hasSupplementalLight/hasAlarmIo`, etc.
 *
 * Replaces the older driver-local `deviceCache.has*` blob: the per-device
 * config is for operator-edited overrides + UI snapshots; runtime probe
 * results belong in runtime-state where the kernel handles persistence,
 * cross-process mirroring, and reactive updates.
 */
export const FeatureProbeStatusSchema = z.object({
  /**
   * Driver-specific flag bag. Each driver picks its own key names — the
   * cap deliberately does NOT enforce a closed enum here. Reolink keys:
   * `hasPtz`, `hasIntercom`, `hasDoorbell`, `hasFloodlight`, `hasSiren`,
   * `hasPirSensor`, `hasAutotrack`, `hasBattery`. Hikvision keys:
   * `hasSupplementalLight`, `lightHasWhiteLight`, `hasAlarmIo`, `hasPtz`.
   */
  flags: z.record(z.string(), z.unknown()),
  /**
   * Coarse driver-classification — lets cross-process consumers tell apart
   * cameras / battery-cams / NVRs without re-running the probe. `null`
   * before the first probe completes.
   */
  deviceType: z.string().nullable(),
  /** Camera/firmware model string. `null` when the firmware doesn't expose it. */
  model: z.string().nullable(),
  /** Channel count for NVR/Hub devices; `1` for standalone cameras; `null` pre-probe. */
  channelCount: z.number().nullable().meta(readingMeta('count')),
  /**
   * Ms epoch of the last SUCCESSFUL probe. `0` before the first probe
   * completes — drivers' `getAccessoryChildren()` should treat zero as
   * "probe not done yet, return empty" so accessories aren't spawned
   * before the firmware is queried.
   */
  lastProbedAt: z.number(),
  /**
   * Framework convention: every runtime-state slice carries this for the
   * createRuntimeStateBridge stale-check helper. We keep it in sync with
   * `lastProbedAt` on every write.
   */
  lastFetchedAt: z.number(),
})

export type FeatureProbeStatus = z.infer<typeof FeatureProbeStatusSchema>

export const featureProbeCapability = {
  name: 'feature-probe',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  methods: {},
  events: {
    /** Fires whenever a fresh probe completes (kernel-driven `reprobe()`
     *  or driver-initiated re-detect after a state change). */
    onProbeChanged: {
      data: z.object({
        deviceId: z.number(),
        status: FeatureProbeStatusSchema,
      }),
    },
  },
  status: {
    schema: FeatureProbeStatusSchema,
    kind: 'push',
  },
  runtimeState: FeatureProbeStatusSchema,

  /**
   * Runtime-state durability: **session** — per-session by definition — `lastProbedAt` means "this worker completed a probe THIS session", which is why the mirror seed already blanks it. Persisting it only creates something to blank.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — static identity and capability probe.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IFeatureProbeProvider = InferProvider<typeof featureProbeCapability>
