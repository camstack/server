/**
 * Homematic integrations as `integration-instances` (planning#416, D985, D1007): one `connections`
 * record per CCU under its registry id. The body is the connection the live session dials (host,
 * interfaces, callback, WebUI user, TLS), the WebUI password a keychain secret declared in the
 * schema. The integrations registry owns the on/off switch (`role: devices`).
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

export const HomematicConnectionBodySchema = entryBody({
  host: z.string().nullish(),
  enableHmipRf: z.boolean().nullish(),
  enableBidcosRf: z.boolean().nullish(),
  enableGroups: z.boolean().nullish(),
  enableBidcosWired: z.boolean().nullish(),
  username: z.string().nullish(),
  password: z.string().optional().meta({ secret: true }),
  callbackHost: z.string().nullish(),
  callbackPort: z.number().int().min(1).max(65535).nullish(),
  tls: z.boolean().nullish(),
})
export type HomematicConnectionBody = z.infer<typeof HomematicConnectionBodySchema>

export const homematicConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Homematic CCUs',
  schema: HomematicConnectionBodySchema,
  writeTrigger: 'an operator adds, edits or removes a Homematic CCU',
})

/** Every kind this addon declares, keyed by its name. */
export const homematicRecordKinds = { connections: homematicConnectionsEntryKind } as const

/** The record body as the flat settings the connection schema parses: no name, no unset keys. */
export function connectionSettingsOf(body: HomematicConnectionBody): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'name' || value === null || value === undefined) continue
    out[key] = value
  }
  return out
}

/** What a reader of one integration gets: the flat settings, or "the keychain is locked" (D49). */
export interface HomematicSettingsRead {
  readonly values: Readonly<Record<string, unknown>>
  /** The keychain could not serve the record's secrets: the password is unknown, not empty. */
  readonly secretsLocked: boolean
}

export function settingsReadOf(
  resolved: ResolvedInstance<HomematicConnectionBody> | null,
): HomematicSettingsRead {
  return resolved === null
    ? { values: {}, secretsLocked: false }
    : {
        values: connectionSettingsOf(resolved.body),
        secretsLocked: resolved.secrets === 'unavailable',
      }
}

export interface HomematicInstancesDeps {
  /** Bring the live CCU sessions in line with the records after a change. */
  readonly onChanged: () => Promise<void>
}

export function buildHomematicInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: HomematicInstancesDeps,
): RecordIntegrationInstances<HomematicConnectionBody> {
  return new RecordIntegrationInstances<HomematicConnectionBody>(
    records,
    homematicConnectionsEntryKind,
    {
      description: {
        role: 'devices',
        discovery: { mode: 'lan', scopedToInstance: false },
        instanceMode: 'multiple',
        kind: 'connection',
        canTest: false,
      },
      formSchema: () => buildConnectionFormSchema(),
      initialBody: (name): HomematicConnectionBody => ({ name }),
      configured: (body) => (body.host ?? '').trim().length > 0,
      onChanged: () => deps.onChanged(),
    },
  )
}
