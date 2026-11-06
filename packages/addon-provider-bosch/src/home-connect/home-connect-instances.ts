/**
 * Home Connect integrations as `integration-instances` (planning#416, D985, D1007): one
 * `connections` record per account under the `integrations` registry id. The body IS the account
 * (the access and refresh tokens and the appliance pairing keys in the keychain; the appliance
 * rows, each with its device description, and the signed-in label in the open), so the form the
 * instances page edits is the stored shape and the addon reads nothing else.
 */
import {
  type AddonMigration,
  defineEntryKind,
  entryBody,
  type IConnectionProbe,
  type IntegrationRowsApi,
  type RowsRecordsDoor,
  type IntegrationRowsPorts,
  RecordIntegrationInstances,
  type RecordKindHandle,
  type RecordsAccess,
  type SecretsAccess,
  type RowsMigrationLog,
} from '@camstack/types'
import { z } from 'zod'
import {
  boschRowsMigration,
  boschRowsPorts,
  keepBodyKeys,
  testBoschInstance,
} from '../shared/bosch-instances.js'
import {
  APPLIANCE_SECRETS_KEY,
  buildHomeConnectFormSchema,
  connectionFromSettings,
  type HomeConnectConfig,
  homeConnectApplianceRowSchema,
  homeConnectSettingsForPersist,
} from './config.js'

/** The device descriptions ride on the appliance rows, so a body outgrows the 64 KiB default. */
const HOME_CONNECT_MAX_BODY_BYTES = 1024 * 1024

export const homeConnectConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Home Connect accounts',
  schema: entryBody({
    token: z.string().optional().meta({ secret: true }),
    refresh: z.string().optional().meta({ secret: true }),
    /** JSON of `haId -> { psk, iv64? }`: one string in the keychain. */
    applianceSecrets: z.string().optional().meta({ secret: true }),
    appliances: z.array(homeConnectApplianceRowSchema).optional(),
    accountLabel: z.string().optional(),
  }),
  writeTrigger:
    'an operator signs in, edits or removes a Home Connect account, or a connection stores what it learned',
  maxDataBytes: HOME_CONNECT_MAX_BODY_BYTES,
})
export type HomeConnectConnectionBody = z.infer<typeof homeConnectConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const homeConnectRecordKinds = { connections: homeConnectConnectionsEntryKind } as const

const LEGACY_KEYS: readonly string[] = [
  'token',
  'refresh',
  APPLIANCE_SECRETS_KEY,
  'appliances',
  'accountLabel',
  // The sign-in's own working keys: never settings, dropped without a word.
  'accountEmail',
  'accountPassword',
  'authorizeUrl',
  'verifier',
  'callback',
  'state',
]
const SECRET_KEYS: readonly string[] = ['token', 'refresh', APPLIANCE_SECRETS_KEY]

/** The `appliances` row value as an array: a JSON string is parsed, anything else is as stored. */
function parseStoredRows(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The record body of one account, from its legacy rows (secrets resolved). A pairing key still
 * sitting on an appliance row (the shape before the keychain move) is carried into
 * `applianceSecrets` here, once, and never again.
 */
export function homeConnectBodyFromRows(
  values: Readonly<Record<string, unknown>>,
  log: RowsMigrationLog,
  integration: { readonly id: string; readonly name: string },
): HomeConnectConnectionBody {
  const dropped = Object.keys(values).filter((key) => !LEGACY_KEYS.includes(key))
  if (dropped.length > 0) {
    log.warn(
      `integration '${integration.id}': legacy settings nothing reads any more are dropped: ${dropped.join(', ')}`,
    )
  }
  const normalized = homeConnectSettingsForPersist({ ...values })
  // Judged on the rows as stored: the inline-key move above already leaves an unreadable one out.
  const storedRows: unknown = parseStoredRows(values['appliances'])
  if (Array.isArray(storedRows)) {
    for (const row of storedRows) {
      const parsed = homeConnectApplianceRowSchema.safeParse(row)
      if (parsed.success) continue
      // The appliance id is not a secret; the failing paths name the field, never its value.
      const haId =
        typeof row === 'object' && row !== null && typeof Reflect.get(row, 'haId') === 'string'
          ? String(Reflect.get(row, 'haId'))
          : '(no haId)'
      const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '(row)').join(', ')
      log.warn(
        `integration '${integration.id}': appliance row '${haId}' could not be read and is dropped (invalid: ${paths})`,
      )
    }
  }
  const appliances: z.infer<typeof homeConnectApplianceRowSchema>[] = []
  const keptRows: unknown = normalized['appliances']
  if (Array.isArray(keptRows)) {
    for (const row of keptRows) {
      const parsed = homeConnectApplianceRowSchema.safeParse(row)
      if (parsed.success) appliances.push(parsed.data)
    }
  }
  const token = text(normalized['token'])
  const refresh = text(normalized['refresh'])
  const applianceSecrets = text(normalized[APPLIANCE_SECRETS_KEY])
  const accountLabel = text(normalized['accountLabel'])
  return {
    name: integration.name,
    ...(token !== undefined ? { token } : {}),
    ...(refresh !== undefined ? { refresh } : {}),
    ...(applianceSecrets !== undefined ? { applianceSecrets } : {}),
    ...(appliances.length > 0 ? { appliances } : {}),
    ...(accountLabel !== undefined ? { accountLabel } : {}),
  }
}

export const HOME_CONNECT_ROWS_TO_RECORD_ID =
  'bosch-home-connect/2026-11-05-integration-rows-to-record'

/** The whole `bosch-home-connect` catalogue (D987): offered to the engine at `onInitialize`. */
export const HOME_CONNECT_MIGRATIONS: readonly AddonMigration<IntegrationRowsPorts>[] = [
  boschRowsMigration({
    addonId: 'bosch-home-connect',
    id: HOME_CONNECT_ROWS_TO_RECORD_ID,
    description:
      'Move every Home Connect account into a typed instance record keyed by its registry id (pairing keys still on an appliance row go to the appliance secrets), then clear the legacy integration settings rows and their keychain values',
    fixtureMark: 'a legacy setting key the migration does not know',
    kind: homeConnectConnectionsEntryKind,
    bodyFrom: homeConnectBodyFromRows,
  }),
]

export function homeConnectRowsPorts(deps: {
  readonly api: IntegrationRowsApi
  readonly records: RowsRecordsDoor
  readonly warn: (message: string) => void
  readonly secrets?: Pick<SecretsAccess, 'resolve' | 'delete'> | null
}): IntegrationRowsPorts {
  return boschRowsPorts({ ...deps, kind: homeConnectConnectionsEntryKind })
}

/** A record read for the connection code: the body as the settings map it parses, or null. */
export interface HomeConnectStored {
  readonly settings: Record<string, unknown>
  /** The keychain is locked: the secrets are absent from `settings`, stored but unreadable. */
  readonly locked: boolean
}

export async function homeConnectStoredOf(
  instances: Pick<RecordIntegrationInstances<HomeConnectConnectionBody>, 'readResolved'>,
  id: string,
): Promise<HomeConnectStored | null> {
  const read = await instances.readResolved(id)
  if (read === null) return null
  return { settings: { ...read.body }, locked: read.secrets === 'unavailable' }
}

/**
 * The live account of one integration, read from its record. null while the account is not
 * signed in; a locked keychain throws so the caller keeps the client it has instead of
 * reconfiguring it without its tokens (D49).
 */
export async function homeConnectConnectionOf(
  instances: Pick<RecordIntegrationInstances<HomeConnectConnectionBody>, 'readResolved'>,
  id: string,
): Promise<HomeConnectConfig | null> {
  const stored = await homeConnectStoredOf(instances, id)
  if (stored === null) return null
  if (stored.locked) {
    throw new Error('the keychain is locked, the saved Home Connect tokens cannot be read')
  }
  return connectionFromSettings(stored.settings)
}

export interface HomeConnectInstancesDeps {
  readonly onChanged: () => Promise<void>
  readonly tester: IConnectionProbe
}

export interface HomeConnectInstances {
  readonly instances: RecordIntegrationInstances<HomeConnectConnectionBody>
  readonly provider: ReturnType<RecordIntegrationInstances<HomeConnectConnectionBody>['toProvider']>
  /** The kind's handle: the addon patches what a connection learned (tokens, descriptions) here. */
  readonly handle: Pick<RecordKindHandle<HomeConnectConnectionBody>, 'patch'>
}

export function buildHomeConnectInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: HomeConnectInstancesDeps,
): HomeConnectInstances {
  const handle = records.kind(homeConnectConnectionsEntryKind)
  const instances = new RecordIntegrationInstances<HomeConnectConnectionBody>(
    records,
    homeConnectConnectionsEntryKind,
    {
      description: { role: 'devices', instanceMode: 'multiple', kind: 'account', canTest: true },
      formSchema: () => buildHomeConnectFormSchema(),
      initialBody: (name): HomeConnectConnectionBody => ({ name }),
      configured: (body) => connectionFromSettings(body) !== null,
      onChanged: async (_id, change) => {
        if (change !== 'deleted') await deps.onChanged()
      },
      test: (input) =>
        testBoschInstance({ ...input, tester: deps.tester, handle, secretKeys: SECRET_KEYS }),
    },
  )
  return {
    instances,
    handle,
    provider: keepBodyKeys(
      instances.toProvider(),
      new Set(Object.keys(homeConnectConnectionsEntryKind.schema.shape)),
    ),
  }
}
