import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Motion-trigger toggle for accessory devices.
 *
 * "Motion trigger" means: when the parent camera detects motion, the
 * accessory activates automatically. The cap exposes a single boolean
 * — `enabled` — that drivers map to the vendor-specific firmware
 * action (Reolink: `setSirenOnMotion`, `setFloodlightOnMotion`; ONVIF
 * relay: schedule binding; …).
 *
 * The accessory still has its own `switch` cap for direct on/off; this
 * cap is independent. Toggling motion-trigger on does NOT necessarily
 * toggle the switch on — it just instructs the firmware to flip the
 * switch when motion fires.
 *
 * Driver-specific knobs (motion duration window, brightness while
 * triggered, schedule windows) live in the device's
 * `getSettingsUISchema()` instead of bloating this cap — same
 * principle as `switch` and `brightness` keeping their surface
 * minimal.
 */
export const MotionTriggerStatusSchema = z.object({
  enabled: z.boolean(),
  /** Ms epoch of the last operator-driven change. */
  lastChangedAt: z.number(),
})

export type MotionTriggerStatus = z.infer<typeof MotionTriggerStatusSchema>

/**
 * Persistent slice mirrored across restarts. The provider writes here
 * on every successful firmware fetch / setMotionTrigger push; the cap
 * router and admin-ui hero read straight from this snapshot via
 * `device.state.motionTrigger.value` instead of re-issuing a firmware
 * round-trip on every UI mount. `lastFetchedAt` lets the framework
 * helper (`createRuntimeStateBridge`) stale-check before deciding
 * whether to refresh from the camera.
 */
export const MotionTriggerRuntimeStateSchema = MotionTriggerStatusSchema.extend({
  /** Ms epoch of the last successful camera fetch (0 = never). */
  lastFetchedAt: z.number(),
})

export type MotionTriggerRuntimeState = z.infer<typeof MotionTriggerRuntimeStateSchema>

export const motionTriggerCapability = {
  name: 'motion-trigger',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Light, DeviceType.Siren, DeviceType.Switch],
  methods: {
    setMotionTrigger: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        enabled: z.boolean(),
      }),
      z.void(),
      // OPERATE, not configure: the same authority as `switch.setState` on
      // the same siren / light child — governed by the caller's device grant
      // (a grant on the parent camera reaches it through `includeLinked`),
      // never by `isAdmin`. Was `admin`, which refused a camera's operator
      // before the grant was read. See D403, D918.
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'motionTrigger.on',
            label: t('Motion trigger on', 'Attivazione al movimento attiva'),
            phrase: t('Let motion trigger {device}', 'Fai attivare {device} dal movimento'),
            icon: 'activity',
            effect: { field: 'enabled', value: true },
            args: { enabled: true },
          },
          {
            id: 'motionTrigger.off',
            label: t('Motion trigger off', 'Attivazione al movimento spenta'),
            phrase: t(
              'Stop motion triggering {device}',
              'Non far più attivare {device} dal movimento',
            ),
            icon: 'activity',
            effect: { field: 'enabled', value: false },
            args: { enabled: false },
          },
        ],
      },
    ),
  },
  events: {
    onMotionTriggerChanged: {
      data: z.object({
        deviceId: z.number(),
        enabled: z.boolean(),
        lastChangedAt: z.number(),
      }),
      notOperatorFacing: 'the `enabled` state trigger phrases both edges of this change',
    },
  },
  status: {
    schema: MotionTriggerStatusSchema,
    kind: 'command-driven',
  },
  runtimeState: MotionTriggerRuntimeStateSchema,

  /**
   * Runtime-state durability: **session** — the authority for motion-trigger enablement is the provider's own config; the slice is a mirror of it, re-published on connect.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — configuration switch.
   */
  history: 'none',
  vocabulary: {
    noun: t('Motion trigger', 'Attivazione al movimento'),
    order: 1160,
    state: [
      {
        kind: 'boolean',
        field: 'enabled',
        label: t('Motion trigger', 'Attivazione al movimento'),
        whenTrue: t(
          'When motion triggering is turned on for {device}',
          'Quando si attiva l’attivazione al movimento di {device}',
        ),
        whenFalse: t(
          'When motion triggering is turned off for {device}',
          'Quando si disattiva l’attivazione al movimento di {device}',
        ),
        icon: 'activity',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IMotionTriggerProvider = InferProvider<typeof motionTriggerCapability>
