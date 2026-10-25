import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/**
 * Operator-supplied connection to ONE Rademacher HomePilot / Start2Smart hub on
 * the local network. The addon runs in `standalone` mode (the Reolink / Ecowitt
 * pattern): the CONNECTION lives on the hub DEVICE config, not a broker
 * registry. `@apocaliss92/noderademacher` has no push channel — the hub is
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

/**
 * Persisted config for a Rademacher hub {@link import('@camstack/types').DeviceType.Hub}
 * device. The hub owns exactly one live `@apocaliss92/noderademacher` client
 * keyed on its own `stableId`; adopted cover children reference it via their
 * `hubId` config field.
 */
export const rademacherHubSchema = z.object({
  connection: rademacherConnectionSchema,
  /** Provenance marker used to scope offline / cascade helpers. */
  system: z.literal('rademacher-hub').optional(),
})

export type RademacherHubConfig = z.infer<typeof rademacherHubSchema>

/**
 * Persisted config every Rademacher roller-shutter (cover) child carries.
 * `did` resolves the live handle from the hub's client; `hubId` selects the
 * parent hub (its Hub `stableId`). `invertPosition` corrects HomePilot units
 * that report an already-HA-oriented position (`inverted_cover_position`);
 * `supportsPosition` / `supportsTilt` gate the positionable / tilt cover
 * sub-surfaces (probed from the live device on adopt).
 */
export const rademacherCoverSchema = z.object({
  did: z.string().min(1).describe('HomePilot device id'),
  hubId: z.string().min(1).describe('Parent hub stableId'),
  invertPosition: z
    .boolean()
    .default(false)
    .describe('Re-invert the reported position (HomePilot units flagged inverted)'),
  supportsPosition: z.boolean().default(true).describe('Device supports SET_POSITION'),
  supportsTilt: z.boolean().default(false).describe('Device supports slat-tilt (ventilation)'),
  system: z.literal('rademacher').optional(),
})

export type RademacherCoverConfig = z.infer<typeof rademacherCoverSchema>

/**
 * Narrow an `unknown` value to a shallow-cloned plain object record, or an empty
 * record when it is not a plain object. Mirrors the Ecowitt / Homematic
 * `toRecord` helper — a cast-free boundary narrowing.
 */
function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value))
  }
  return {}
}

/** Coerce a loose settings blob through the connection schema, applying defaults. */
export function settingsToConnection(settings: unknown): RademacherConnectionConfig {
  return rademacherConnectionSchema.parse(toRecord(settings))
}

/**
 * Slugify a host into a readable, stable row-key fragment. Exported so the
 * discovery candidate's `stableId` matches exactly what `generateStableId`
 * derives on adopt (else a re-scan of an already-added hub would not be detected
 * as onboarded).
 */
export function slugifyHost(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Hand-written connection form for the hub device-creation UI (standalone
 * mode — Reolink / Ecowitt pattern). The connection lives on the hub DEVICE
 * config, not in a broker registry. A `name` field lets the operator name the
 * hub at creation time.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'identity',
        title: 'Hub',
        titleKey: 'provider-rademacher:connection.s_identity.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-rademacher:connection.s_identity.name.label',
            required: true,
            placeholder: 'HomePilot',
          },
        ],
      },
      {
        id: 'connection',
        title: 'Connection',
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
