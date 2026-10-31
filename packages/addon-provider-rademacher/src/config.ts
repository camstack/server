import type { ConfigUISchema } from '@camstack/types'
import { z } from 'zod'

/**
 * Operator-supplied connection to ONE Rademacher HomePilot / Start2Smart hub on
 * the local network. It is the settings of an INTEGRATION (`mode: account`):
 * the password is a schema `password` field kept in the keychain, never in env,
 * argv or logs. `@apocaliss92/noderademacher` has no push channel — the hub is
 * POLLED, so `pollIntervalMs` drives the device-state refresh cadence.
 */
export const rademacherConnectionSchema = z.object({
  host: z.string().min(1).describe('HomePilot hub host name or IP address'),
  password: z
    .string()
    .default('')
    .describe('Hub password (leave blank for an unprotected hub)')
    .meta({ secret: true }),
  basePath: z
    .string()
    .default('')
    .describe('API base path override (blank = auto-probe: v1 "" / v2 "/hp")'),
  pollIntervalMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(2000).max(3_600_000).default(30_000),
    )
    .describe('Device-state poll interval (ms)'),
})

export type RademacherConnectionConfig = z.infer<typeof rademacherConnectionSchema>

/** Parse an integration's stored settings, or null while the host is missing or a field is invalid. */
export function connectionFromSettings(settings: unknown): RademacherConnectionConfig | null {
  const raw = typeof settings === 'object' && settings !== null ? settings : {}
  const parsed = rademacherConnectionSchema.safeParse(
    Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]),
    ),
  )
  return parsed.success ? parsed.data : null
}

export function sameRademacherConnection(
  a: RademacherConnectionConfig | null,
  b: RademacherConnectionConfig | null,
): boolean {
  if (a === null || b === null) return false
  return (
    a.host === b.host &&
    a.password === b.password &&
    a.basePath === b.basePath &&
    a.pollIntervalMs === b.pollIntervalMs
  )
}

/**
 * What every Rademacher device carries so the integration's cascade and offline
 * helpers find it: the provenance marker and the integration it belongs to.
 */
const rademacherDeviceBase = z.object({
  integrationId: z.string().min(1).describe('Integration (hub session) the device belongs to'),
  system: z.literal('rademacher'),
  /** The adoption candidate id the device was adopted from. */
  nativeId: z.string().min(1),
})

/** The hub box itself ({@link import('@camstack/types').DeviceType.Gateway}). */
export const rademacherGatewayDeviceSchema = rademacherDeviceBase
export type RademacherGatewayDeviceConfig = z.infer<typeof rademacherGatewayDeviceSchema>

/**
 * Persisted config every Rademacher roller-shutter (cover) carries.
 * `did` resolves the live handle from the integration's client. `invertPosition`
 * corrects HomePilot units that report an already-HA-oriented position
 * (`inverted_cover_position`); `supportsPosition` / `supportsTilt` gate the
 * positionable / tilt cover sub-surfaces (probed from the live device on adopt).
 */
export const rademacherCoverSchema = rademacherDeviceBase.extend({
  did: z.string().min(1).describe('HomePilot device id'),
  invertPosition: z
    .boolean()
    .default(false)
    .describe('Re-invert the reported position (HomePilot units flagged inverted)'),
  supportsPosition: z.boolean().default(true).describe('Device supports SET_POSITION'),
  supportsTilt: z.boolean().default(false).describe('Device supports slat-tilt (ventilation)'),
})

export type RademacherCoverConfig = z.infer<typeof rademacherCoverSchema>

/**
 * The integration form: the host, the password and the advanced fields. The password is a `password`
 * field, so it lands in the keychain.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'HomePilot hub',
        titleKey: 'provider-rademacher:connection.s_connection.title',
        description: 'Leave the password blank for an unprotected hub.',
        descriptionKey: 'provider-rademacher:connection.s_connection.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'host',
            label: 'Hub host / IP',
            labelKey: 'provider-rademacher:connection.s_connection.host.label',
            description: 'The address of the HomePilot or Start2Smart hub on your network.',
            descriptionKey: 'provider-rademacher:connection.s_connection.host.description',
            required: true,
            placeholder: '192.168.10.50',
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password (optional)',
            labelKey: 'provider-rademacher:connection.s_connection.password.label',
            showToggle: true,
          },
          {
            type: 'number',
            key: 'pollIntervalMs',
            label: 'Poll interval (ms)',
            labelKey: 'provider-rademacher:connection.s_connection.pollIntervalMs.label',
            min: 2000,
            max: 3_600_000,
            default: 30_000,
          },
          {
            type: 'text',
            key: 'basePath',
            label: 'API base path (optional)',
            labelKey: 'provider-rademacher:connection.s_connection.basePath.label',
            placeholder: 'auto',
          },
        ],
      },
    ],
  }
}
