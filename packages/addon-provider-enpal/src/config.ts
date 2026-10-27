import { z } from 'zod'
import { isSecretMarkerLike, type ConfigUISchema } from '@camstack/types'

/**
 * Operator-supplied connection for ONE Enpal box. The addon runs in `standalone`
 * mode (the VeSync / Ecowitt / Velux pattern): the CONNECTION lives on the box
 * DEVICE config, there is no broker registry.
 *
 * Two sources behind `source`:
 *   - `influx`: the box's InfluxDB 2.x (port 8086, org `enpal`, bucket `solar`).
 *     Needs the access token Enpal support issues; it is a keychain secret.
 *   - `page`: the box's local device page (`/deviceMessages`). No token; fewer
 *     boxes and firmware versions still serve it.
 *   - `auto` (default): InfluxDB when a token is set, the page otherwise or when
 *     InfluxDB cannot be read.
 */

/** Strip a pasted scheme and path: `http://192.0.2.10/deviceMessages` -> `192.0.2.10`. */
function cleanHost(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    ?.trim()
}

/** A token the keychain could not serve reads as a marker object, not a string. */
function markerToEmpty(value: unknown): unknown {
  if (isSecretMarkerLike(value)) return ''
  return value === null || value === undefined ? '' : value
}

const blankToUndefined = (v: unknown): unknown => (v === '' || v === null ? undefined : v)

/** Names that are interpolated into a Flux string: no quote, no space, no operator. */
const FLUX_NAME = /^[A-Za-z0-9_.-]+$/

export const ENPAL_SOURCES = ['auto', 'influx', 'page'] as const
export type EnpalSource = (typeof ENPAL_SOURCES)[number]

export const enpalConnectionSchema = z.object({
  host: z.preprocess(
    cleanHost,
    z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+$/, 'host name or IP address only')
      .describe('Enpal box host name or IP address'),
  ),
  source: z.enum(ENPAL_SOURCES).default('auto').describe('Where the readings come from'),
  influxPort: z
    .preprocess(blankToUndefined, z.number().int().min(1).max(65535).default(8086))
    .describe('InfluxDB port'),
  org: z.string().trim().min(1).default('enpal').describe('InfluxDB organisation'),
  bucket: z
    .string()
    .trim()
    .regex(FLUX_NAME, 'letters, digits, dot, dash and underscore only')
    .default('solar')
    .describe('InfluxDB bucket'),
  token: z
    .preprocess(markerToEmpty, z.string().default(''))
    .describe('InfluxDB access token (issued by Enpal support)')
    .meta({ secret: true }),
  pagePort: z
    .preprocess(blankToUndefined, z.number().int().min(1).max(65535).default(80))
    .describe('Device page HTTP port'),
  pollIntervalMs: z
    .preprocess(blankToUndefined, z.number().int().min(10_000).max(3_600_000).default(30_000))
    .describe('Poll interval (ms)'),
  invertBatteryPower: z
    .boolean()
    .default(false)
    .describe('Report battery power positive while DIScharging instead of while charging'),
})

export type EnpalConnection = z.infer<typeof enpalConnectionSchema>

/** A connection plus whether its token is stored but unreadable right now. */
export interface EnpalConnectionRead {
  readonly connection: EnpalConnection
  readonly tokenLocked: boolean
}

/** Narrow an `unknown` to a shallow-cloned plain record (cast-free boundary). */
function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value))
  }
  return {}
}

/** Coerce a loose settings blob through the connection schema, applying defaults. */
export function settingsToConnection(settings: unknown): EnpalConnection {
  return enpalConnectionSchema.parse(toRecord(settings))
}

/** Same, but also reports a token the keychain could not serve (a marker, not a string). */
export function readConnection(settings: unknown): EnpalConnectionRead {
  const raw = toRecord(settings)
  return {
    connection: enpalConnectionSchema.parse(raw),
    tokenLocked: isSecretMarkerLike(raw['token']),
  }
}

/** Persisted config for the Enpal box {@link import('@camstack/types').DeviceType.Hub} device. */
export const enpalBoxSchema = z.object({
  connection: enpalConnectionSchema,
  /** Provenance marker used to scope offline / cascade helpers. */
  system: z.literal('enpal-box').optional(),
})

export type EnpalBoxConfig = z.infer<typeof enpalBoxSchema>

/**
 * Persisted config every adopted Enpal device carries. `specId` selects the entry of the
 * device catalog (PV, battery, grid import, ...); `boxId` selects the parent box (its Hub
 * `stableId`) in the in-process resolver.
 */
export const enpalSensorSchema = z.object({
  specId: z.string().min(1).describe('Device catalog entry id'),
  boxId: z.string().min(1).describe('Parent box stableId'),
  system: z.literal('enpal').optional(),
})

export type EnpalSensorConfig = z.infer<typeof enpalSensorSchema>

/** Slugify a host into a readable, stable row-key fragment. */
export function slugifyHost(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Hand-written connection form for the box device-creation UI. The connection lives on the box
 * DEVICE config; a `name` field lets the operator name it at creation time.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'identity',
        title: 'Box',
        titleKey: 'provider-enpal:connection.s_identity.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-enpal:connection.s_identity.name.label',
            required: true,
            placeholder: 'Enpal',
          },
          {
            type: 'text',
            key: 'host',
            label: 'Box host / IP',
            labelKey: 'provider-enpal:connection.s_identity.host.label',
            required: true,
            placeholder: '192.168.10.60',
          },
        ],
      },
      {
        id: 'source',
        title: 'Data source',
        titleKey: 'provider-enpal:connection.s_source.title',
        description:
          'InfluxDB needs the access token Enpal support issues (ask in the Enpal app chat). Without it the box device page is used.',
        descriptionKey: 'provider-enpal:connection.s_source.description',
        columns: 2,
        fields: [
          {
            type: 'select',
            key: 'source',
            label: 'Source',
            labelKey: 'provider-enpal:connection.s_source.source.label',
            default: 'auto',
            options: [
              {
                value: 'auto',
                label: 'Automatic (InfluxDB, then device page)',
                labelKey: 'provider-enpal:connection.s_source.source.o_auto.label',
              },
              {
                value: 'influx',
                label: 'InfluxDB only',
                labelKey: 'provider-enpal:connection.s_source.source.o_influx.label',
              },
              {
                value: 'page',
                label: 'Device page only',
                labelKey: 'provider-enpal:connection.s_source.source.o_page.label',
              },
            ],
          },
          {
            type: 'password',
            key: 'token',
            label: 'InfluxDB token',
            labelKey: 'provider-enpal:connection.s_source.token.label',
            showToggle: true,
          },
          {
            type: 'text',
            key: 'org',
            label: 'InfluxDB organisation',
            labelKey: 'provider-enpal:connection.s_source.org.label',
            default: 'enpal',
          },
          {
            type: 'text',
            key: 'bucket',
            label: 'InfluxDB bucket',
            labelKey: 'provider-enpal:connection.s_source.bucket.label',
            default: 'solar',
          },
          {
            type: 'number',
            key: 'influxPort',
            label: 'InfluxDB port',
            labelKey: 'provider-enpal:connection.s_source.influxPort.label',
            min: 1,
            max: 65535,
            default: 8086,
          },
          {
            type: 'number',
            key: 'pagePort',
            label: 'Device page port',
            labelKey: 'provider-enpal:connection.s_source.pagePort.label',
            min: 1,
            max: 65535,
            default: 80,
          },
        ],
      },
      {
        id: 'polling',
        title: 'Polling',
        titleKey: 'provider-enpal:connection.s_polling.title',
        columns: 2,
        fields: [
          {
            type: 'number',
            key: 'pollIntervalMs',
            label: 'Poll interval (ms)',
            labelKey: 'provider-enpal:connection.s_polling.pollIntervalMs.label',
            min: 10_000,
            max: 3_600_000,
            default: 30_000,
          },
          {
            type: 'boolean',
            key: 'invertBatteryPower',
            label: 'Battery power is positive while discharging',
            labelKey: 'provider-enpal:connection.s_polling.invertBatteryPower.label',
            default: false,
          },
        ],
      },
    ],
  }
}
