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
import {
  buildConnectionFormSchema,
  connectionFromSettings,
  type HomematicConfig,
} from './config.js'

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

/** The slice of the instances provider the readers need. */
export type HomematicInstancesReader = Pick<
  RecordIntegrationInstances<HomematicConnectionBody>,
  'readResolved'
>

/** What a reader of one CCU's connection learns from its record. */
export interface HomematicConnectionRead {
  /** The usable connection, or null while the record is absent or holds no usable host. */
  readonly connection: HomematicConfig | null
  /** The keychain could not serve the WebUI password: unknown, never an empty password (D49). */
  readonly secretsLocked: boolean
}

/** The ONE reader of a CCU's connection: the integration's record, never the legacy rows. */
export async function readCcuConnection(
  instances: HomematicInstancesReader,
  integrationId: string,
): Promise<HomematicConnectionRead> {
  const read = settingsReadOf(await instances.readResolved(integrationId))
  return { connection: connectionFromSettings(read.values), secretsLocked: read.secretsLocked }
}

/** The hosts of the CCUs already set up, for discovery to leave out; an unreadable one is skipped. */
export async function knownCcuHostsOf(deps: {
  readonly instances: HomematicInstancesReader
  readonly integrationIds: readonly string[]
  readonly onUnreadable: (integrationId: string, error: unknown) => void
}): Promise<readonly string[]> {
  const hosts: string[] = []
  for (const id of deps.integrationIds) {
    try {
      const { connection } = await readCcuConnection(deps.instances, id)
      if (connection !== null) hosts.push(connection.host)
    } catch (err: unknown) {
      deps.onUnreadable(id, err)
    }
  }
  return hosts
}
