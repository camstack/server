import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Alarm-panel cap. Models HA `alarm_control_panel.*` on
 * `DeviceType.AlarmPanel`. State follows HA's canonical lifecycle
 * across disarmed / armed_(home|away|night|vacation|custom_bypass) /
 * arming / pending / triggered / disarming.
 *
 * Many panels require a PIN code on arm / disarm — the optional
 * `code` field on the methods passes it through to the upstream
 * service; it's NEVER persisted in the runtime slice or any event
 * payload. The presence of a required code is signalled by
 * `DeviceFeature.AlarmPinRequired` so the UI gates a code-entry
 * field without a slice fetch.
 *
 * `availableModes` mirrors HA's `supported_features`-derived arm
 * mode list — the UI renders only the buttons the panel accepts.
 */

export const AlarmStateSchema = z.enum([
  'disarmed',
  'armed_home',
  'armed_away',
  'armed_night',
  'armed_vacation',
  'armed_custom_bypass',
  'arming',
  'disarming',
  'pending',
  'triggered',
])
export type AlarmState = z.infer<typeof AlarmStateSchema>

export const AlarmArmModeSchema = z.enum(['home', 'away', 'night', 'vacation', 'custom_bypass'])
export type AlarmArmMode = z.infer<typeof AlarmArmModeSchema>

export const AlarmPanelStatusSchema = z.object({
  /** Current lifecycle state. */
  state: AlarmStateSchema,
  /**
   * The arm mode the machine belongs to under transitional words
   * (`arming` / `pending` / `triggered` / `disarming`). `null` when
   * disarmed or when a provider cannot name one. Exporters MUST prefer
   * this over an in-process memo — a HomeKit accessory that missed the
   * settled `armed_*` slice used to map `pending` to DISARMED and hide
   * an entry delay.
   */
  // `.optional()` so a restored pre-field slice still parses; exporters treat
  // absent the same as `null` (no remembered mode).
  targetMode: AlarmArmModeSchema.nullable().optional(),
  /** Subset of arm modes the panel accepts. UI renders one button per
   *  mode in this list. */
  availableModes: z.array(AlarmArmModeSchema),
  /** Whether the panel requires a PIN on arm / disarm. Mirrors
   *  `DeviceFeature.AlarmPinRequired` for slice consumers. */
  requiresCode: z.boolean(),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type AlarmPanelStatus = z.infer<typeof AlarmPanelStatusSchema>

export const alarmPanelCapability = {
  name: 'alarm-panel',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.AlarmPanel],
  methods: {
    arm: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        mode: AlarmArmModeSchema,
        /** Optional PIN code. Required when `requiresCode === true`.
         *  Passed through to the upstream service; never persisted. */
        code: z.string().min(1).optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    disarm: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        code: z.string().min(1).optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    /**
     * Force the panel into the `triggered` state — used by HA
     * automations to surface external sensor events through the panel
     * (e.g. a Reolink camera intrusion event firing the security
     * system). Provider rejects when the panel hardware doesn't
     * support a software-initiated trigger.
     */
    trigger: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
  },
  status: {
    schema: AlarmPanelStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI panel reads the
   * full slice; renders an arm button per `availableModes` entry and
   * a PIN field iff `requiresCode === true`.
   */
  runtimeState: AlarmPanelStatusSchema,

  /**
   * Runtime-state durability: **restored** — armed state is the one thing a panel must not lose across a restart.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): the panel's lifecycle state as an `enum` series —
   * change-only, no floor, so an `arming -> pending -> triggered` sequence of a
   * few seconds keeps every step. Who armed it stays in the events ledger.
   */
  history: { fields: { state: { kind: 'enum' } } },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
} as const satisfies CapabilityDefinition

export type IAlarmPanelProvider = InferProvider<typeof alarmPanelCapability>
