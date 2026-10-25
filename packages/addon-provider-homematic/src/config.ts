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
 * Build the `HomematicOptions` the wrapped library constructor expects
 * from the validated addon config. Pure: same config in → same options
 * out. Credentials are only forwarded when both fields are non-empty so
 * the library skips the JSON-RPC hub layer cleanly when they're absent.
 */
export function toHomematicOptions(config: HomematicConfig): HomematicOptions {
  const hasCredentials = config.username.length > 0 && config.password.length > 0
  // When the operator leaves callbackHost blank, auto-infer the hub's LAN IPv4
  // on the same /24 as the CCU so the CCU can push value events back to us.
  const callbackHost =
    config.callbackHost.length > 0 ? config.callbackHost : (inferCallbackHost(config.host) ?? '')

  // Derive the XML-RPC interface list from the per-interface boolean toggles.
  // Only the four interfaces supported by nodehomematic are included.
  const interfaces: string[] = []
  if (config.enableHmipRf) interfaces.push('HmIP-RF')
  if (config.enableBidcosRf) interfaces.push('BidCos-RF')
  if (config.enableGroups) interfaces.push('VirtualDevices')
  if (config.enableBidcosWired) interfaces.push('BidCos-Wired')

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

// ---------------------------------------------------------------------------
// Multi-broker config schema
// ---------------------------------------------------------------------------

/**
 * A single registered Homematic CCU hub ("broker"). One broker entry maps
 * 1-to-1 with an operator-added integration and holds the validated CCU
 * connection settings plus an optional back-reference to the spawning
 * integration (used for cascade-delete when the integration is removed).
 */
export const HmBrokerEntrySchema = z.object({
  /** Stable opaque identifier — e.g. 'hm_001', 'hm_002'. */
  id: z.string().min(1),
  /** Human-readable label shown in the admin UI. */
  name: z.string().min(1),
  /** Validated CCU connection settings. */
  connection: homematicConfigSchema,
  /** FK to the spawning integration — auto-cleanup on integration delete. */
  integrationId: z.string().optional(),
})
export type HmBrokerEntry = z.infer<typeof HmBrokerEntrySchema>

/**
 * Top-level addon config that replaces the old single-CCU
 * `{connection: HomematicConfig|null}` shape. Holds an ordered list of
 * broker entries; the list defaults to empty so a fresh install requires
 * no explicit initialisation.
 */
export const homematicAddonConfigSchema = z.object({
  brokers: z.array(HmBrokerEntrySchema).default([]),
})
export type HomematicAddonConfigV2 = z.infer<typeof homematicAddonConfigSchema>

/**
 * Coerce a loose settings blob (e.g. from the broker `add`/`setSettings`
 * cap) through the connection schema, applying all schema defaults. Throws
 * a `ZodError` on invalid input so the caller surfaces a clear error at the
 * system boundary rather than propagating a malformed config.
 */
export function settingsToHmConfig(settings: unknown): HomematicConfig {
  return homematicConfigSchema.parse(settings ?? {})
}

// ---------------------------------------------------------------------------
// Config migration
// ---------------------------------------------------------------------------

/**
 * Narrows an `unknown` value to a plain (non-array) object record. Returns an
 * empty record when the value is not a plain object so callers can safely
 * access keys without a cast.
 */
function toRecord(v: unknown): Record<string, unknown> {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    return Object.fromEntries(Object.entries(v))
  }
  return {}
}

/**
 * One-time migration from the legacy single-CCU shape
 * `{ connection: HomematicConfig | null }` to the multi-broker shape
 * `{ brokers: HmBrokerEntry[] }`. Idempotent: an already-migrated blob (one
 * that already has a `brokers` array) is parsed through and returned as-is.
 * An absent/invalid legacy connection yields an empty brokers list (the
 * operator re-adds the CCU) rather than throwing.
 */
export function migrateLegacyConfig(raw: unknown): HomematicAddonConfigV2 {
  const obj = toRecord(raw)

  // Already in the new multi-broker shape — parse and return as-is.
  if (Array.isArray(obj['brokers'])) {
    return homematicAddonConfigSchema.parse(obj)
  }

  // Attempt to lift a legacy `connection` object into a single broker entry.
  const legacy = obj['connection']
  if (legacy !== null && legacy !== undefined) {
    const conn = homematicConfigSchema.safeParse(legacy)
    if (conn.success) {
      const label = conn.data.host.length > 0 ? conn.data.host : 'Homematic CCU'
      return { brokers: [{ id: 'hm_001', name: label, connection: conn.data }] }
    }
  }

  // No usable connection — start with an empty broker list.
  return { brokers: [] }
}

// ---------------------------------------------------------------------------

/**
 * Hand-written connection form for the broker/integration creation UI.
 * Mirrors the Home Assistant broker-settings form shape — a flat set of
 * sections the admin UI renders into the "Add Homematic hub" modal.
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
            type: 'text',
            key: 'host',
            label: 'Host / IP',
            labelKey: 'provider-homematic:connection.s_connection.host.label',
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
