import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'
import type { HomematicOptions } from 'nodehomematic'
import { inferCallbackHost } from './callback-host.js'

/**
 * Operator-supplied CCU connection settings. Mirrors `HomematicOptions`
 * from the wrapped `nodehomematic` library, but with the addon's own
 * defaults + validation at the system boundary.
 *
 * The CCU exposes one or more XML-RPC interfaces; the operator selects
 * which ones to bind (HmIP-RF for HomematicIP, BidCos-RF for classic
 * Homematic, …). `callbackHost`/`callbackPort` are where the CCU calls
 * BACK into this addon's local XML-RPC server to push value events —
 * `callbackHost` must be an address the CCU can reach (usually the hub's
 * LAN IP), NOT `127.0.0.1`.
 *
 * Credentials are optional: they unlock the JSON-RPC hub layer (names,
 * rooms, system variables, programs). Without them the addon still works
 * over plain XML-RPC, just with raw addresses instead of friendly names.
 */
export const homematicConfigSchema = z.object({
  host: z.string().min(1).describe('CCU3 / RaspberryMatic host name or IP address'),
  enableHmipRf: z.boolean().default(true).describe('Enable Homematic IP (HmIP-RF)'),
  enableBidcosRf: z.boolean().default(false).describe('Enable Homematic (BidCos-RF)'),
  enableGroups: z
    .boolean()
    .default(true)
    .describe('Enable groups (heating groups / VirtualDevices)'),
  enableBidcosWired: z.boolean().default(false).describe('Enable BidCos-Wired (HM-Wired)'),
  username: z
    .string()
    .default('')
    .describe('WebUI username (optional — enables names / rooms / sysvars)'),
  password: z.string().default('').describe('WebUI password (optional)').meta({ secret: true }),
  callbackHost: z
    .string()
    .default('')
    .describe('Address the CCU calls back to for event push (this hub LAN IP)'),
  // Robust to a blank form field: the admin-ui may submit '' or null for an
  // empty number input — coerce those to undefined so the default applies
  // (a raw z.number() would THROW on '' and reject the whole connection).
  callbackPort: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(1).max(65535).default(2128),
    )
    .describe('Local XML-RPC callback server port'),
  tls: z.boolean().default(false).describe('Use TLS for the CCU transport'),
})

export type HomematicConfig = z.infer<typeof homematicConfigSchema>

/**
 * The XML-RPC interface names the operator's toggles select, in the library's
 * order. Only the four interfaces supported by nodehomematic are included.
 */
export function enabledInterfaces(
  config: Pick<
    HomematicConfig,
    'enableHmipRf' | 'enableBidcosRf' | 'enableGroups' | 'enableBidcosWired'
  >,
): string[] {
  const interfaces: string[] = []
  if (config.enableHmipRf) interfaces.push('HmIP-RF')
  if (config.enableBidcosRf) interfaces.push('BidCos-RF')
  if (config.enableGroups) interfaces.push('VirtualDevices')
  if (config.enableBidcosWired) interfaces.push('BidCos-Wired')
  return interfaces
}

/**
 * Build the `HomematicOptions` the wrapped library constructor expects
 * from the validated addon config. Pure: same config in → same options
 * out. Credentials are forwarded when a username is set (the password may be
 * empty on a CCU without WebUI authentication); without one the library skips
 * the JSON-RPC hub layer cleanly.
 */
export function toHomematicOptions(config: HomematicConfig): HomematicOptions {
  // A CCU without WebUI authentication (auto-login) has users with NO password: a
  // username alone is enough for the JSON-RPC session, so the password may be empty.
  const hasCredentials = config.username.length > 0
  // When the operator leaves callbackHost blank, auto-infer the hub's LAN IPv4
  // on the same /24 as the CCU so the CCU can push value events back to us.
  const callbackHost =
    config.callbackHost.length > 0 ? config.callbackHost : (inferCallbackHost(config.host) ?? '')

  const interfaces = enabledInterfaces(config)

  return {
    host: config.host,
    interfaces,
    callback: {
      host: callbackHost,
      port: config.callbackPort,
    },
    tls: config.tls,
    ...(hasCredentials
      ? { credentials: { username: config.username, password: config.password } }
      : {}),
  }
}

/**
 * Parse an integration's stored settings, or null while the host is missing or
 * a field is invalid. Strings are trimmed; the password arrives resolved from
 * the keychain.
 */
export function connectionFromSettings(settings: unknown): HomematicConfig | null {
  const raw = typeof settings === 'object' && settings !== null ? settings : {}
  const parsed = homematicConfigSchema.safeParse(
    Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]),
    ),
  )
  return parsed.success ? parsed.data : null
}

/**
 * Structural equality over the fields that affect the live CCU connection. Two
 * configs are "the same connection" when every field that would force a facade
 * stop+start matches. A `null` argument is never equal to anything.
 */
export function sameConnection(a: HomematicConfig | null, b: HomematicConfig | null): boolean {
  if (a === null || b === null) return false
  return (
    a.host === b.host &&
    a.enableHmipRf === b.enableHmipRf &&
    a.enableBidcosRf === b.enableBidcosRf &&
    a.enableGroups === b.enableGroups &&
    a.enableBidcosWired === b.enableBidcosWired &&
    a.callbackHost === b.callbackHost &&
    a.callbackPort === b.callbackPort &&
    a.username === b.username &&
    a.password === b.password &&
    a.tls === b.tls
  )
}

/**
 * What every Homematic device carries so the integration's cascade and offline
 * helpers find it: the provenance marker and the integration (CCU session) it
 * belongs to.
 */
export const homematicGatewayDeviceSchema = z.object({
  integrationId: z.string().min(1).describe('Integration (CCU session) the device belongs to'),
  system: z.literal('homematic'),
  /** The adoption candidate id the device was adopted from. */
  nativeId: z.string().min(1),
})

/** The CCU box itself ({@link import('@camstack/types').DeviceType.Gateway}). */
export type HomematicGatewayDeviceConfig = z.infer<typeof homematicGatewayDeviceSchema>

// ---------------------------------------------------------------------------

/**
 * The integration form: a discovered-CCU picker (filled by the LAN scan), the
 * host, the interfaces, the event callback, the WebUI credentials (the password
 * is a `password` field, so it lands in the keychain) and TLS.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'CCU connection',
        titleKey: 'provider-homematic:connection.s_connection.title',
        columns: 1,
        fields: [
          {
            type: 'addon-action-select',
            addonId: 'provider-homematic',
            key: '__homematic-discovered',
            writesKey: 'host',
            omitFromSettings: true,
            label: 'CCU',
            labelKey: 'provider-homematic:connection.s_connection.__homematic-discovered.label',
            action: 'discoverCcu',
            mapOption: { value: 'host', label: 'name' },
            hideWhenFewerThan: 2,
            emptyResultsMessage: 'No CCU found on the network.',
          },
          {
            type: 'text',
            key: 'host',
            label: 'Host / IP',
            labelKey: 'provider-homematic:connection.s_connection.host.label',
            description: 'Filled when one CCU is found. Type the address if it is not.',
            descriptionKey: 'provider-homematic:connection.s_connection.host.description',
            required: true,
            placeholder: '192.168.10.50',
          },
        ],
      },
      {
        id: 'interfaces',
        title: 'Interfaces',
        titleKey: 'provider-homematic:connection.s_interfaces.title',
        description: 'CCU-Jack and CUxD are not supported.',
        descriptionKey: 'provider-homematic:connection.s_interfaces.description',
        columns: 1,
        fields: [
          {
            type: 'boolean',
            key: 'enableHmipRf',
            label: 'Enable Homematic IP',
            labelKey: 'provider-homematic:connection.s_interfaces.enableHmipRf.label',
            default: true,
          },
          {
            type: 'boolean',
            key: 'enableBidcosRf',
            label: 'Enable Homematic (BidCos-RF)',
            labelKey: 'provider-homematic:connection.s_interfaces.enableBidcosRf.label',
            default: false,
          },
          {
            type: 'boolean',
            key: 'enableGroups',
            label: 'Enable groups (heating groups)',
            labelKey: 'provider-homematic:connection.s_interfaces.enableGroups.label',
            default: true,
          },
          {
            type: 'boolean',
            key: 'enableBidcosWired',
            label: 'Enable BidCos-Wired (HM-Wired)',
            labelKey: 'provider-homematic:connection.s_interfaces.enableBidcosWired.label',
            default: false,
          },
        ],
      },
      {
        id: 'callback',
        title: 'Event callback',
        titleKey: 'provider-homematic:connection.s_callback.title',
        description:
          'Optional; must be reachable from the CCU (not 127.0.0.1). Blank auto-infers the hub LAN address.',
        descriptionKey: 'provider-homematic:connection.s_callback.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'callbackHost',
            label: 'Callback host (optional — auto-inferred when blank)',
            labelKey: 'provider-homematic:connection.s_callback.callbackHost.label',
            placeholder: 'auto (this hub LAN IP)',
          },
          {
            type: 'number',
            key: 'callbackPort',
            label: 'Callback port',
            labelKey: 'provider-homematic:connection.s_callback.callbackPort.label',
            min: 1,
            max: 65535,
            default: 2128,
          },
        ],
      },
      {
        id: 'credentials',
        title: 'WebUI credentials',
        titleKey: 'provider-homematic:connection.s_credentials.title',
        description: 'Optional. Unlocks friendly names, rooms, system variables and programs.',
        descriptionKey: 'provider-homematic:connection.s_credentials.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'username',
            label: 'Username',
            labelKey: 'provider-homematic:connection.s_credentials.username.label',
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-homematic:connection.s_credentials.password.label',
            showToggle: true,
          },
        ],
      },
      {
        id: 'advanced',
        title: 'Advanced',
        titleKey: 'provider-homematic:connection.s_advanced.title',
        columns: 1,
        fields: [
          {
            type: 'boolean',
            key: 'tls',
            label: 'Use TLS',
            labelKey: 'provider-homematic:connection.s_advanced.tls.label',
          },
        ],
      },
    ],
  }
}
