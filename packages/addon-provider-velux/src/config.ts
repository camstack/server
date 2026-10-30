import type { ConfigUISchema } from '@camstack/types'
import { z } from 'zod'

/**
 * Operator-supplied connection to ONE Velux KLF-200 gateway on the local
 * network. It is the settings of an INTEGRATION (`mode: account`): the password
 * is a schema `password` field kept in the keychain, never in env, argv or logs.
 * The KLF-200 PUSHES node changes over its socket
 * (`GW_NODE_STATE_POSITION_CHANGED_NTF`), so there is no poll interval.
 */
export const veluxConnectionSchema = z.object({
  host: z.string().min(1).describe('KLF-200 host name or IP address'),
  password: z
    .string()
    .min(1)
    .describe('KLF-200 WiFi/web password (printed on the back of the unit)')
    .meta({ secret: true }),
})

export type VeluxConnectionConfig = z.infer<typeof veluxConnectionSchema>

/** Parse an integration's stored settings, or null while host or password is missing. */
export function connectionFromSettings(
  settings: Record<string, unknown>,
): VeluxConnectionConfig | null {
  const parsed = veluxConnectionSchema.safeParse(settings)
  return parsed.success ? parsed.data : null
}

export function sameVeluxConnection(
  a: VeluxConnectionConfig | null,
  b: VeluxConnectionConfig | null,
): boolean {
  if (a === null || b === null) return false
  return a.host === b.host && a.password === b.password
}

/** HA-oriented cover device class (`device_class`) of a KLF-200 actuator. */
export const VeluxCoverClassSchema = z.enum([
  'window',
  'shutter',
  'blind',
  'awning',
  'garage',
  'gate',
])
export type VeluxCoverClass = z.infer<typeof VeluxCoverClassSchema>

/**
 * What every Velux device carries so the integration's cascade and offline
 * helpers find it: the provenance marker and the integration it belongs to.
 */
const veluxDeviceBase = z.object({
  integrationId: z.string().min(1).describe('Integration (gateway session) the device belongs to'),
  system: z.literal('velux'),
})

/** The gateway box itself ({@link import('@camstack/types').DeviceType.Gateway}). */
export const veluxGatewayDeviceSchema = veluxDeviceBase.extend({
  /** The adoption candidate id (`<integration>:gateway`). */
  nativeId: z.string().min(1),
})
export type VeluxGatewayDeviceConfig = z.infer<typeof veluxGatewayDeviceSchema>

/** Identity of one actuator node: its serial is the stable key, the node id only a fallback. */
const veluxNodeFields = {
  nodeId: z.number().int().nonnegative().describe('KLF-200 actuator node id'),
  /** Hex serial of the actuator — the stable identity; '' when the gateway reported none. */
  serial: z.string().default(''),
}

/**
 * A window with an integrated rain sensor: a
 * {@link import('@camstack/types').DeviceType.Container} whose accessory children
 * are its cover and its rain sensor.
 */
export const veluxWindowSchema = veluxDeviceBase.extend({
  ...veluxNodeFields,
  nativeId: z.string().min(1),
  coverClass: VeluxCoverClassSchema.default('window'),
})
export type VeluxWindowConfig = z.infer<typeof veluxWindowSchema>

/**
 * Persisted config of a Velux cover: a plain adopted product (it then also has
 * `nativeId`) or the cover inside a window container. `nodeId`/`serial` resolve
 * the live node from the integration's session. Velux actuators are positional
 * with no tilt.
 */
export const veluxCoverSchema = veluxDeviceBase.extend({
  ...veluxNodeFields,
  nativeId: z.string().min(1).optional(),
  coverClass: VeluxCoverClassSchema.default('window'),
})
export type VeluxCoverConfig = z.infer<typeof veluxCoverSchema>

/** Persisted config of the rain-sensor child of a window container. It follows the window's node. */
export const veluxRainSensorSchema = veluxDeviceBase.extend({
  ...veluxNodeFields,
})
export type VeluxRainSensorConfig = z.infer<typeof veluxRainSensorSchema>

/**
 * The integration form: a discovered-gateway picker (filled by the LAN scan),
 * the host and the password. The password is a `password` field, so it lands in
 * the keychain.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'KLF-200 gateway',
        titleKey: 'provider-velux:connection.s_connection.title',
        description: 'The password is the WiFi/web password printed on the back of the unit.',
        descriptionKey: 'provider-velux:connection.s_connection.description',
        columns: 1,
        fields: [
          {
            type: 'addon-action-select',
            addonId: 'provider-velux',
            key: '__velux-discovered',
            writesKey: 'host',
            omitFromSettings: true,
            label: 'Gateway',
            labelKey: 'provider-velux:connection.s_connection.__velux-discovered.label',
            action: 'discoverGateway',
            mapOption: { value: 'host', label: 'name' },
            hideWhenFewerThan: 2,
            emptyResultsMessage: 'No gateway found on the network.',
          },
          {
            type: 'text',
            key: 'host',
            label: 'Gateway host / IP',
            labelKey: 'provider-velux:connection.s_connection.host.label',
            description: 'Filled when one gateway is found. Type the address if it is not.',
            descriptionKey: 'provider-velux:connection.s_connection.host.description',
            required: true,
            placeholder: '192.168.20.65',
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-velux:connection.s_connection.password.label',
            required: true,
            showToggle: true,
          },
        ],
      },
    ],
  }
}
