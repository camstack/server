import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { t } from '../device/cap-vocabulary/l10n.js'

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
      actions: [
        {
          id: 'alarm.trigger',
          label: t('Trigger alarm', 'Fai scattare l’allarme'),
          phrase: t('Trigger the alarm on {device}', 'Fai scattare l’allarme su {device}'),
          icon: 'siren',
        },
      ],
    }),
    disarm: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        code: z.string().min(1).optional(),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'alarm.disarm',
            label: t('Disarm', 'Disinserisci'),
            phrase: t('Disarm {device}', 'Disinserisci {device}'),
            icon: 'shield-off',
            effect: { field: 'state', value: 'disarmed' },
            openArgs: [
              {
                key: 'code',
                label: t('PIN code', 'Codice PIN'),
                offer: { kind: 'text', secret: true },
                optional: true,
              },
            ],
          },
        ],
      },
    ),
    arm: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        mode: AlarmArmModeSchema,
        /** Optional PIN code. Required when `requiresCode === true`.
         *  Passed through to the upstream service; never persisted. */
        code: z.string().min(1).optional(),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'alarm.arm.home',
            label: t('Arm home', 'Inserisci in casa'),
            phrase: t('Arm {device} for home', 'Inserisci {device} in modalità casa'),
            icon: 'house',
            effect: { field: 'state', value: 'armed_home' },
            args: { mode: 'home' },
            openArgs: [
              {
                key: 'code',
                label: t('PIN code', 'Codice PIN'),
                offer: { kind: 'text', secret: true },
                optional: true,
              },
            ],
          },
          {
            id: 'alarm.arm.away',
            label: t('Arm away', 'Inserisci fuori casa'),
            phrase: t('Arm {device} for away', 'Inserisci {device} in modalità fuori casa'),
            icon: 'shield-check',
            effect: { field: 'state', value: 'armed_away' },
            args: { mode: 'away' },
            openArgs: [
              {
                key: 'code',
                label: t('PIN code', 'Codice PIN'),
                offer: { kind: 'text', secret: true },
                optional: true,
              },
            ],
          },
          {
            id: 'alarm.arm.night',
            label: t('Arm night', 'Inserisci notte'),
            phrase: t('Arm {device} for the night', 'Inserisci {device} in modalità notte'),
            icon: 'moon',
            effect: { field: 'state', value: 'armed_night' },
            args: { mode: 'night' },
            openArgs: [
              {
                key: 'code',
                label: t('PIN code', 'Codice PIN'),
                offer: { kind: 'text', secret: true },
                optional: true,
              },
            ],
          },
          {
            id: 'alarm.arm.vacation',
            label: t('Arm vacation', 'Inserisci vacanza'),
            phrase: t('Arm {device} for vacation', 'Inserisci {device} in modalità vacanza'),
            icon: 'plane',
            effect: { field: 'state', value: 'armed_vacation' },
            args: { mode: 'vacation' },
            openArgs: [
              {
                key: 'code',
                label: t('PIN code', 'Codice PIN'),
                offer: { kind: 'text', secret: true },
                optional: true,
              },
            ],
          },
          {
            id: 'alarm.arm.custom_bypass',
            label: t('Arm custom bypass', 'Inserisci con esclusioni'),
            phrase: t(
              'Arm {device} with its custom bypass',
              'Inserisci {device} con le zone escluse',
            ),
            icon: 'shield-half',
            effect: { field: 'state', value: 'armed_custom_bypass' },
            args: { mode: 'custom_bypass' },
            openArgs: [
              {
                key: 'code',
                label: t('PIN code', 'Codice PIN'),
                offer: { kind: 'text', secret: true },
                optional: true,
              },
            ],
          },
        ],
      },
    ),
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
  vocabulary: {
    noun: t('Alarm panel', 'Centrale d’allarme'),
    order: 1120,
    state: [
      {
        kind: 'enum',
        field: 'state',
        label: t('Alarm state', 'Stato dell’allarme'),
        values: [
          {
            value: 'disarmed',
            label: t('Disarmed', 'Disinserito'),
            phrase: t('When {device} is disarmed', 'Quando {device} viene disinserito'),
          },
          {
            value: 'armed_home',
            label: t('Armed home', 'Inserito in casa'),
            phrase: t(
              'When {device} is armed for home',
              'Quando {device} viene inserito in modalità casa',
            ),
          },
          {
            value: 'armed_away',
            label: t('Armed away', 'Inserito fuori casa'),
            phrase: t(
              'When {device} is armed for away',
              'Quando {device} viene inserito in modalità fuori casa',
            ),
          },
          {
            value: 'armed_night',
            label: t('Armed night', 'Inserito notte'),
            phrase: t(
              'When {device} is armed for the night',
              'Quando {device} viene inserito in modalità notte',
            ),
          },
          {
            value: 'armed_vacation',
            label: t('Armed vacation', 'Inserito vacanza'),
          },
          {
            value: 'armed_custom_bypass',
            label: t('Armed with bypass', 'Inserito con esclusioni'),
          },
          { value: 'arming', label: t('Arming', 'In inserimento') },
          { value: 'disarming', label: t('Disarming', 'In disinserimento') },
          { value: 'pending', label: t('Entry delay', 'Ritardo d’ingresso') },
          {
            value: 'triggered',
            label: t('Triggered', 'In allarme'),
            phrase: t('When {device} goes off', 'Quando {device} scatta'),
          },
        ],
        icon: 'shield',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IAlarmPanelProvider = InferProvider<typeof alarmPanelCapability>
