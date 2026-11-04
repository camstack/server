/**
 * Ecowitt integrations as `integration-instances` (planning#416, D985, D1007): one `connections`
 * record per gateway under its registry id. The body is the connection the live client dials
 * (transport, host/port + optional password for a local poll, the listener port for a push), the
 * password a keychain secret declared in the schema. The integrations registry owns the on/off
 * switch (`role: devices`).
 */
import {
  defineEntryKind,
  entryBody,
  type RecordsAccess,
  RecordIntegrationInstances,
  type ResolvedInstance,
} from '@camstack/types'
import { z } from 'zod'
import { buildConnectionFormSchema } from './config.js'

export const EcowittConnectionBodySchema = entryBody({
  transport: z.enum(['local', 'listener']).nullish(),
  host: z.string().nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  password: z.string().optional().meta({ secret: true }),
  pollIntervalMs: z.number().int().min(1000).max(3_600_000).nullish(),
  mappingIntervalMs: z.number().int().min(10_000).max(86_400_000).nullish(),
  listenPort: z.number().int().min(1).max(65535).nullish(),
  listenHost: z.string().nullish(),
  stationId: z.string().nullish(),
})
export type EcowittConnectionBody = z.infer<typeof EcowittConnectionBodySchema>

export const ecowittConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Ecowitt gateways',
  schema: EcowittConnectionBodySchema,
  writeTrigger:
    'an operator adds, edits or removes an Ecowitt gateway, or a Hub device is migrated into one',
})

/** Every kind this addon declares, keyed by its name. */
export const ecowittRecordKinds = { connections: ecowittConnectionsEntryKind } as const

/** The record body as the flat settings the connection schema parses: no name, no unset keys. */
export function connectionSettingsOf(body: EcowittConnectionBody): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'name' || value === null || value === undefined) continue
    out[key] = value
  }
  return out
}

/** What the reconciler reads of one integration. */
export interface EcowittSettingsRead {
  readonly values: Readonly<Record<string, unknown>>
  /** The keychain could not serve the record's secrets: the password is unknown, not empty (D49). */
  readonly secretsLocked: boolean
}

export function settingsReadOf(
  resolved: ResolvedInstance<EcowittConnectionBody> | null,
): EcowittSettingsRead {
  return resolved === null
    ? { values: {}, secretsLocked: false }
    : {
        values: connectionSettingsOf(resolved.body),
        secretsLocked: resolved.secrets === 'unavailable',
      }
}

export interface EcowittInstancesDeps {
  /** Bring the live clients in line with the records after a change. */
  readonly onChanged: () => Promise<void>
}

export function buildEcowittInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: EcowittInstancesDeps,
): RecordIntegrationInstances<EcowittConnectionBody> {
  return new RecordIntegrationInstances<EcowittConnectionBody>(
    records,
    ecowittConnectionsEntryKind,
    {
      description: {
        role: 'devices',
        discovery: { mode: 'lan', scopedToInstance: false },
        instanceMode: 'multiple',
        kind: 'connection',
        canTest: false,
      },
      formSchema: () => buildConnectionFormSchema(),
      initialBody: (name): EcowittConnectionBody => ({ name }),
      configured: (body) =>
        body.transport === 'listener' ? true : (body.host ?? '').trim().length > 0,
      onChanged: () => deps.onChanged(),
    },
  )
}
