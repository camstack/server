import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Generic on/off switch cap for accessory children (siren, floodlight,
 * spotlight, PIR toggle, chime silencer, autotrack enable, …). The cap
 * owns ONLY the boolean state — driver-specific settings (brightness,
 * sensitivity, schedule, duration) live on the device's own
 * `getSettingsUISchema()` surface.
 */
export const SwitchStatusSchema = z.object({
  on: z.boolean().meta({ label: 'On' }),
  /** Ms epoch of the last state change. Useful for UI "X minutes ago". */
  lastChangedAt: z.number(),
})

export type SwitchStatus = z.infer<typeof SwitchStatusSchema>

export const switchCapability = {
  name: 'switch',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Switch, DeviceType.Siren, DeviceType.Light],
  methods: {
    setState: method(z.object({ deviceId: z.number(), on: z.boolean() }), z.void(), {
      kind: 'mutation',
      // ACTUATION, not administration: governed by the caller's device
      // grant (`selector` + `includeLinked`), never by `isAdmin`. See D403.
      auth: 'protected',
    }),
  },
  events: {
    onStateChanged: {
      data: z.object({
        deviceId: z.number(),
        on: z.boolean(),
        lastChangedAt: z.number(),
      }),
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
} as const satisfies CapabilityDefinition

export type ISwitchProvider = InferProvider<typeof switchCapability>
