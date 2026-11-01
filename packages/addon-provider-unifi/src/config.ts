import { z } from 'zod'
import { isSecretMarkerLike, type ConfigUISchema } from '@camstack/types'

/** The device-registry `system` tag every UniFi device carries. */
export const UNIFI_SYSTEM = 'unifi'

/** A secret the keychain could not serve reads as a marker object, not a string. */
function markerToEmpty(value: unknown): unknown {
  if (isSecretMarkerLike(value)) return ''
  return value === null || value === undefined ? '' : value
}

/**
 * Operator-supplied connection to ONE UniFi Network controller on the local
 * network. The addon runs in `account` mode: the CONNECTION lives on the INTEGRATION's
 * settings, not on a device. The controller is POLLED — `pollIntervalMs` drives the infra + client
 * refresh cadence. Auth is either an API key (preferred, UniFi OS ≥ 4) OR a
 * username + password local admin.
 */
export const unifiConnectionSchema = z.object({
  host: z.string().min(1).describe('Controller host name or IP address'),
  port: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(1).max(65535).default(443),
    )
    .describe('Controller HTTPS port (443 on UniFi OS, 8443 on legacy)'),
  apiKey: z
    .preprocess(markerToEmpty, z.string().default(''))
    .describe('UniFi OS API key (preferred). Leave blank to use username + password.')
    .meta({ secret: true }),
  username: z.string().default('').describe('Local admin username (when no API key)'),
  password: z
    .preprocess(markerToEmpty, z.string().default(''))
    .describe('Local admin password (when no API key)')
    .meta({ secret: true }),
  site: z.string().default('default').describe('Controller site name'),
  allowSelfSigned: z
    .preprocess((v) => (v === '' || v === null ? undefined : v), z.boolean().default(false))
    .describe('Accept the console self-signed certificate'),
  pollIntervalMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(2000).max(3_600_000).default(30_000),
    )
    .describe('Infra + client poll interval (ms)'),
})

export type UnifiConnectionConfig = z.infer<typeof unifiConnectionSchema>

// ── Feature discriminants (shared by descriptor + child config) ───────────────

/** The four child device kinds a controller fans out into. */
export const UnifiFeatureKindSchema = z.enum(['switch', 'button', 'sensor', 'presence'])
export type UnifiFeatureKind = z.infer<typeof UnifiFeatureKindSchema>

/** A switch child is either a per-port PoE toggle or the device LED. */
export const UnifiSwitchFeatureSchema = z.enum(['poe', 'led'])
export type UnifiSwitchFeature = z.infer<typeof UnifiSwitchFeatureSchema>

/** A button child is either a whole-device restart or a per-port power-cycle. */
export const UnifiButtonActionSchema = z.enum(['restart', 'power-cycle'])
export type UnifiButtonAction = z.infer<typeof UnifiButtonActionSchema>

/** The infra metrics surfaced as sensor children. */
export const UnifiSensorMetricSchema = z.enum([
  'cpu_utilization',
  'cpu_temperature',
  'clients',
  'state',
  'uptime',
])
export type UnifiSensorMetric = z.infer<typeof UnifiSensorMetricSchema>

/**
 * One feature descriptor persisted on an infra Container's `features[]`. It is
 * `integrationId` / `infraNativeId` free (those live on the Container) — those are
 * folded back in when the accessory child is spawned. Mirrors ecowitt's
 * `sensors[]` entry.
 */
export const unifiFeatureDescriptorSchema = z.object({
  kind: z.enum(['switch', 'button', 'sensor']),
  /** Present for `kind: 'switch'`. */
  switchFeature: UnifiSwitchFeatureSchema.optional(),
  /** Present for `kind: 'button'`. */
  buttonAction: UnifiButtonActionSchema.optional(),
  /** Present for per-port switch/button children (`poe` / `power-cycle`). */
  portIdx: z.number().int().nonnegative().optional(),
  /** Present for `kind: 'sensor'`. */
  metric: UnifiSensorMetricSchema.optional(),
})

export type UnifiFeatureDescriptor = z.infer<typeof unifiFeatureDescriptorSchema>

/**
 * Persisted config for one infra {@link import('@camstack/types').DeviceType.Container}
 * device (USER DIRECTIVE: each infra switch / AP / gateway is a Container that
 * exposes its features). `integrationId` selects the parent controller's live
 * client; `infraNativeId` is the controller device id; `features[]` is the
 * additively-reconciled descriptor list that fans out as accessory children.
 */
export const unifiInfraSchema = z.object({
  integrationId: z.string().min(1).describe('Owning integration'),
  infraNativeId: z.string().min(1).describe('Controller-stable infra device id'),
  model: z.string().optional(),
  features: z.array(unifiFeatureDescriptorSchema).default([]),
  system: z.literal('unifi').optional(),
  name: z.string().optional(),
})

export type UnifiInfraConfig = z.infer<typeof unifiInfraSchema>

/**
 * Persisted config every generic child device carries. A single class
 * ({@link import('./devices/unifi-feature-device.js').UnifiFeatureDevice})
 * services all four `kind`s — the discriminant selects which cap it registers:
 *   - `switch`   → `switch` cap (per-port PoE toggle OR device LED)
 *   - `button`   → `button` cap (device restart OR per-port power-cycle)
 *   - `sensor`   → a typed sensor cap chosen from `metric`
 *   - `presence` → `presence` cap (a network client tracker)
 *
 * `integrationId` resolves the live client. `infraNativeId` selects the owning
 * infra device (switch/button/sensor); `mac` selects the client (presence).
 */
export const unifiFeatureSchema = z.object({
  kind: UnifiFeatureKindSchema,
  integrationId: z.string().min(1).describe('Owning integration'),
  /** Owning infra device id — set for switch / button / sensor children. */
  infraNativeId: z.string().optional(),
  /** Switch discriminant (`poe` / `led`). */
  switchFeature: UnifiSwitchFeatureSchema.optional(),
  /** Button discriminant (`restart` / `power-cycle`). */
  buttonAction: UnifiButtonActionSchema.optional(),
  /** Per-port index for `poe` switch / `power-cycle` button children. */
  portIdx: z.number().int().nonnegative().optional(),
  /** Sensor discriminant. */
  metric: UnifiSensorMetricSchema.optional(),
  /** Client MAC — set for `kind: 'presence'`. */
  mac: z.string().optional(),
  system: z.literal('unifi').optional(),
})

export type UnifiFeatureConfig = z.infer<typeof unifiFeatureSchema>

/**
 * Narrow an `unknown` value to a shallow-cloned plain object record, or an empty
 * record when it is not a plain object. Mirrors the Velux / Ecowitt `toRecord`
 * helper — a cast-free boundary narrowing.
 */
function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value))
  }
  return {}
}

/** Coerce a loose settings blob through the connection schema, applying defaults. */
export function settingsToConnection(settings: unknown): UnifiConnectionConfig {
  return unifiConnectionSchema.parse(toRecord(settings))
}

/** A connection plus whether a credential is stored but unreadable right now. */
export interface UnifiConnectionRead {
  readonly connection: UnifiConnectionConfig
  readonly credentialsLocked: boolean
}

/** Parse an integration's settings into a connection, or null while its host is missing. */
export function connectionFromSettings(settings: unknown): UnifiConnectionRead | null {
  const raw = toRecord(settings)
  const parsed = unifiConnectionSchema.safeParse(raw)
  if (!parsed.success) return null
  return {
    connection: parsed.data,
    credentialsLocked: isSecretMarkerLike(raw['apiKey']) || isSecretMarkerLike(raw['password']),
  }
}

/** True when two connections would poll the controller the same way. */
export function sameConnection(a: UnifiConnectionConfig, b: UnifiConnectionConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The integration's settings form (`globalSettingsSchema`); the integration carries the
 * name. The credentials are `password` fields, keychain secrets.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'Connection',
        titleKey: 'provider-unifi:controller.s_connection.title',
        description:
          'Authenticate with a UniFi OS API key (preferred) or a local admin username and password.',
        descriptionKey: 'provider-unifi:controller.s_connection.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'host',
            label: 'Controller host / IP',
            labelKey: 'provider-unifi:controller.s_connection.host.label',
            required: true,
            placeholder: '192.168.10.1',
          },
          {
            type: 'number',
            key: 'port',
            label: 'HTTPS port',
            labelKey: 'provider-unifi:controller.s_connection.port.label',
            min: 1,
            max: 65535,
            default: 443,
          },
          {
            type: 'password',
            key: 'apiKey',
            label: 'API key',
            labelKey: 'provider-unifi:controller.s_connection.apiKey.label',
            showToggle: true,
          },
          {
            type: 'text',
            key: 'username',
            label: 'Username',
            labelKey: 'provider-unifi:controller.s_connection.username.label',
            placeholder: 'admin',
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-unifi:controller.s_connection.password.label',
            showToggle: true,
          },
          {
            type: 'text',
            key: 'site',
            label: 'Site',
            labelKey: 'provider-unifi:controller.s_connection.site.label',
            placeholder: 'default',
          },
          {
            type: 'boolean',
            key: 'allowSelfSigned',
            label: 'Accept self-signed certificate',
            labelKey: 'provider-unifi:controller.s_connection.allowSelfSigned.label',
            default: false,
          },
          {
            type: 'number',
            key: 'pollIntervalMs',
            label: 'Poll interval (ms)',
            labelKey: 'provider-unifi:controller.s_connection.pollIntervalMs.label',
            min: 2000,
            max: 3_600_000,
            default: 30_000,
          },
        ],
      },
    ],
  }
}
