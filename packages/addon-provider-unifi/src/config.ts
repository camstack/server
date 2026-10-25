import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/**
 * Operator-supplied connection to ONE UniFi Network controller on the local
 * network. The addon runs in `standalone` mode (the Reolink / Ecowitt / Velux
 * pattern): the CONNECTION lives on the controller DEVICE config, not a broker
 * registry. The controller is POLLED — `pollIntervalMs` drives the infra + client
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
    .string()
    .default('')
    .describe('UniFi OS API key (preferred). Leave blank to use username + password.')
    .meta({ secret: true }),
  username: z.string().default('').describe('Local admin username (when no API key)'),
  password: z
    .string()
    .default('')
    .describe('Local admin password (when no API key)')
    .meta({ secret: true }),
  site: z.string().default('default').describe('Controller site name'),
  pollIntervalMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(2000).max(3_600_000).default(30_000),
    )
    .describe('Infra + client poll interval (ms)'),
})

export type UnifiConnectionConfig = z.infer<typeof unifiConnectionSchema>

/**
 * Persisted config for a UniFi controller {@link import('@camstack/types').DeviceType.Hub}
 * device. The controller owns exactly one live client keyed on its own
 * `stableId`; adopted infra Containers + client Presence devices reference it via
 * their `controllerId` config field.
 */
export const unifiControllerSchema = z.object({
  connection: unifiConnectionSchema,
  /** Provenance marker used to scope offline / cascade helpers. */
  system: z.literal('unifi-controller').optional(),
})

export type UnifiControllerConfig = z.infer<typeof unifiControllerSchema>

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
 * `controllerId` / `infraNativeId` free (those live on the Container) — those are
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
 * exposes its features). `controllerId` selects the parent controller's live
 * client; `infraNativeId` is the controller device id; `features[]` is the
 * additively-reconciled descriptor list that fans out as accessory children.
 */
export const unifiInfraSchema = z.object({
  controllerId: z.string().min(1).describe('Parent controller Hub stableId'),
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
 * `controllerId` resolves the live client. `infraNativeId` selects the owning
 * infra device (switch/button/sensor); `mac` selects the client (presence).
 */
export const unifiFeatureSchema = z.object({
  kind: UnifiFeatureKindSchema,
  controllerId: z.string().min(1).describe('Parent controller Hub stableId'),
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

/**
 * Slugify a host into a readable, stable row-key fragment. Exported so the
 * discovery candidate's `stableId` matches exactly what `generateStableId`
 * derives on adopt.
 */
export function slugifyHost(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Hand-written connection form for the controller device-creation UI (standalone
 * mode — Reolink / Velux pattern). The connection lives on the controller DEVICE
 * config, not in a broker registry.
 */
export function buildControllerFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'identity',
        title: 'Controller',
        titleKey: 'provider-unifi:controller.s_identity.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-unifi:controller.s_identity.name.label',
            required: true,
            placeholder: 'UniFi Network',
          },
        ],
      },
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
