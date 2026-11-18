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
  type IntegrationTestConnectionResult,
  type RecordsAccess,
  RecordIntegrationInstances,
  REDACTED_SECRET,
  type ResolvedInstance,
} from '@camstack/types'
import { z } from 'zod'
import { buildConnectionFormSchema, ecowittConfigSchema } from './config.js'
import { type EcowittProbeFactory, testEcowittConnection } from './ecowitt-connection-test.js'

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
  model: z.string().nullish(),
  /** The gateway's MAC as the LAN scan or the connect probe read it, and the host it was read at. */
  mac: z.string().nullish(),
  macHost: z.string().nullish(),
})
export type EcowittConnectionBody = z.infer<typeof EcowittConnectionBodySchema>

export const ecowittConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Ecowitt gateways',
  schema: EcowittConnectionBodySchema,
  writeTrigger: 'an operator adds, edits or removes an Ecowitt gateway',
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
  /** The local client the connection test reads the gateway with. */
  readonly makeProbe: EcowittProbeFactory
}

/**
 * The connection test: the stored gateway under the edited form. A saved password is never
 * retyped (the form hands back its redacted view), so the keychain value stands in.
 */
async function testEcowittInstance(
  records: Pick<RecordsAccess, 'kind'>,
  deps: Pick<EcowittInstancesDeps, 'makeProbe'>,
  input: { readonly id: string | null; readonly values: Readonly<Record<string, unknown>> },
): Promise<IntegrationTestConnectionResult> {
  const handle = records.kind(ecowittConnectionsEntryKind)
  const stored = input.id === null ? null : ((await handle.getResolved(input.id))?.data ?? null)
  const typed = input.values['password']
  const password =
    typeof typed === 'string' && typed !== '' && typed !== REDACTED_SECRET
      ? typed
      : (stored?.password ?? '')
  if (typeof password !== 'string') {
    return {
      success: false,
      status: 'inconclusive',
      error: 'ecowitt: the stored password cannot be read right now (keychain unavailable)',
    }
  }
  const merged: Record<string, unknown> = {}
  for (const [key, value] of Object.entries({ ...stored, ...input.values, password })) {
    if (key === 'name' || value === null || value === undefined) continue
    merged[key] = value
  }
  if (merged['transport'] === 'listener') {
    return {
      success: false,
      status: 'inconclusive',
      error:
        'ecowitt: a push gateway has nothing to dial — it shows up with its first upload to the listener port',
    }
  }
  const parsed = ecowittConfigSchema.safeParse({ ...merged, transport: 'local' })
  if (!parsed.success || parsed.data.transport !== 'local') {
    return { success: false, status: 'rejected', error: 'ecowitt: enter the gateway host' }
  }
  return testEcowittConnection(parsed.data, deps.makeProbe)
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
        canTest: true,
        kinds: [
          { id: 'connection', label: 'Ecowitt', functionCap: 'device-provider', role: 'devices' },
        ],
      },
      formSchema: () => buildConnectionFormSchema(),
      initialBody: (name): EcowittConnectionBody => ({ name }),
      configured: (body) =>
        body.transport === 'listener' ? true : (body.host ?? '').trim().length > 0,
      onChanged: () => deps.onChanged(),
      test: (input) => testEcowittInstance(records, deps, input),
    },
  )
}
