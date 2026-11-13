import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType, DeviceRole } from '../device/device-type.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Generic on/off switch cap for accessory children (siren, floodlight,
 * spotlight, PIR toggle, chime silencer, autotrack enable, …). The cap
 * owns ONLY the boolean state — driver-specific settings (brightness,
 * sensitivity, schedule, duration) live on the device's own
 * `getSettingsUISchema()` surface.
 */
export const SwitchStatusSchema = z.object({
  /**
   * `null` = the device has never reported its state (a measurement that
   * has not happened is unknown, never `false`).
   */
  on: z.boolean().nullable().meta({ label: 'On' }),
  /** Ms epoch of the last state change. Useful for UI "X minutes ago". */
  lastChangedAt: z.number(),
})

export type SwitchStatus = z.infer<typeof SwitchStatusSchema>

export const switchCapability = {
  name: 'switch',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Switch, DeviceType.Siren, DeviceType.Light, DeviceType.Fan],
  methods: {
    setState: method(z.object({ deviceId: z.number(), on: z.boolean() }), z.void(), {
      kind: 'mutation',
      // ACTUATION, not administration: governed by the caller's device
      // grant (`selector` + `includeLinked`), never by `isAdmin`. See D403.
      auth: 'protected',
      actions: [
        {
          id: 'switch.on',
          label: t('Turn on', 'Accendi'),
          phrase: t('Turn on {device}', 'Accendi {device}'),
          icon: 'power',
          effect: { field: 'on', value: true },
          args: { on: true },
        },
        {
          id: 'switch.off',
          label: t('Turn off', 'Spegni'),
          phrase: t('Turn off {device}', 'Spegni {device}'),
          icon: 'power-off',
          effect: { field: 'on', value: false },
          args: { on: false },
        },
      ],
    }),
  },
  events: {
    onStateChanged: {
      data: z.object({
        deviceId: z.number(),
        on: z.boolean().nullable(),
        lastChangedAt: z.number(),
      }),
      notOperatorFacing: 'the `on` state trigger phrases both edges of this change',
    },
  },
  status: {
    schema: SwitchStatusSchema,
    kind: 'command-driven',
  },
  /**
   * Runtime-state slice — the last applied on/off state, mirrored by
   * the kernel. Read via `device.state.switch.value`; UI toggles do
   * not need to re-query the provider after a setState mutation.
   */
  runtimeState: SwitchStatusSchema,

  /**
   * Runtime-state durability: **restored** — device state an operator reads as authoritative; 55 devices, transition-driven.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): recorded series.
   */
  history: {
    fields: {
      on: { kind: 'boolean' },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
  settings: {
    bindings: [
      {
        kind: 'scalar',
        statusPath: 'on',
        method: 'setState',
        valueArg: 'on',
        field: { label: 'On', kind: 'boolean' },
      },
    ],
  },
  vocabulary: {
    noun: t('Switch', 'Interruttore'),
    order: 1000,
    state: [
      {
        kind: 'boolean',
        field: 'on',
        label: t('On', 'Acceso'),
        whenTrue: t('When {device} turns on', 'Quando {device} si accende'),
        whenFalse: t('When {device} turns off', 'Quando {device} si spegne'),
        icon: 'power',
      },
    ],
    overrides: {
      byType: {
        [DeviceType.Siren]: {
          actions: {
            'switch.on': {
              label: t('Sound', 'Fai suonare'),
              phrase: t('Sound {device}', 'Fai suonare {device}'),
              icon: 'siren',
            },
            'switch.off': {
              label: t('Silence', 'Zittisci'),
              phrase: t('Silence {device}', 'Zittisci {device}'),
              icon: 'volume-x',
            },
          },
          state: {
            on: {
              label: t('Sounding', 'In funzione'),
              whenTrue: t('When {device} starts sounding', 'Quando {device} inizia a suonare'),
              whenFalse: t('When {device} falls silent', 'Quando {device} smette di suonare'),
              icon: 'siren',
            },
          },
        },
        [DeviceType.Light]: {
          actions: {
            'switch.on': { icon: 'lightbulb' },
            'switch.off': { icon: 'lightbulb-off' },
          },
          state: { on: { icon: 'lightbulb' } },
        },
      },
      byRole: {
        [DeviceRole.Siren]: {
          actions: {
            'switch.on': {
              label: t('Sound', 'Fai suonare'),
              phrase: t('Sound {device}', 'Fai suonare {device}'),
              icon: 'siren',
            },
            'switch.off': {
              label: t('Silence', 'Zittisci'),
              phrase: t('Silence {device}', 'Zittisci {device}'),
              icon: 'volume-x',
            },
          },
          state: {
            on: {
              label: t('Sounding', 'In funzione'),
              whenTrue: t('When {device} starts sounding', 'Quando {device} inizia a suonare'),
              whenFalse: t('When {device} falls silent', 'Quando {device} smette di suonare'),
              icon: 'siren',
            },
          },
        },
        [DeviceRole.Floodlight]: {
          actions: {
            'switch.on': { icon: 'lightbulb' },
            'switch.off': { icon: 'lightbulb-off' },
          },
          state: { on: { icon: 'lightbulb' } },
        },
        [DeviceRole.Spotlight]: {
          actions: {
            'switch.on': { icon: 'lightbulb' },
            'switch.off': { icon: 'lightbulb-off' },
          },
          state: { on: { icon: 'lightbulb' } },
        },
        [DeviceRole.SwitchLight]: {
          actions: {
            'switch.on': { icon: 'lightbulb' },
            'switch.off': { icon: 'lightbulb-off' },
          },
          state: { on: { icon: 'lightbulb' } },
        },
        [DeviceRole.Chime]: {
          actions: {
            'switch.on': {
              label: t('Enable chime', 'Attiva il campanello'),
              phrase: t('Enable the chime {device}', 'Attiva il campanello {device}'),
              icon: 'bell',
            },
            'switch.off': {
              label: t('Mute chime', 'Silenzia il campanello'),
              phrase: t('Mute the chime {device}', 'Silenzia il campanello {device}'),
              icon: 'bell-off',
            },
          },
        },
        [DeviceRole.PirSensor]: {
          actions: {
            'switch.on': {
              label: t('Arm PIR', 'Attiva il PIR'),
              phrase: t('Arm the PIR sensor {device}', 'Attiva il sensore PIR {device}'),
              icon: 'radar',
            },
            'switch.off': {
              label: t('Disarm PIR', 'Disattiva il PIR'),
              phrase: t('Disarm the PIR sensor {device}', 'Disattiva il sensore PIR {device}'),
              icon: 'radar',
            },
          },
        },
        [DeviceRole.Nightvision]: {
          actions: {
            'switch.on': {
              label: t('Night vision on', 'Visione notturna attiva'),
              phrase: t(
                'Turn on night vision on {device}',
                'Attiva la visione notturna di {device}',
              ),
              icon: 'moon',
            },
            'switch.off': {
              label: t('Night vision off', 'Visione notturna spenta'),
              phrase: t(
                'Turn off night vision on {device}',
                'Disattiva la visione notturna di {device}',
              ),
              icon: 'sun',
            },
          },
        },
        [DeviceRole.PrivacyMask]: {
          actions: {
            'switch.on': {
              label: t('Privacy on', 'Privacy attiva'),
              phrase: t('Turn on privacy on {device}', 'Attiva la privacy su {device}'),
              icon: 'eye-off',
            },
            'switch.off': {
              label: t('Privacy off', 'Privacy disattiva'),
              phrase: t('Turn off privacy on {device}', 'Disattiva la privacy su {device}'),
              icon: 'eye',
            },
          },
        },
        [DeviceRole.Autotrack]: {
          actions: {
            'switch.on': {
              label: t('Autotrack on', 'Inseguimento attivo'),
              phrase: t('Start autotracking on {device}', 'Attiva l’inseguimento su {device}'),
              icon: 'crosshair',
            },
            'switch.off': {
              label: t('Autotrack off', 'Inseguimento spento'),
              phrase: t('Stop autotracking on {device}', 'Disattiva l’inseguimento su {device}'),
              icon: 'crosshair',
            },
          },
        },
        [DeviceRole.Outlet]: {
          actions: {
            'switch.on': { icon: 'plug-zap' },
            'switch.off': { icon: 'plug' },
          },
          state: { on: { icon: 'plug-zap' } },
        },
      },
    },
  },
} as const satisfies CapabilityDefinition

export type ISwitchProvider = InferProvider<typeof switchCapability>
