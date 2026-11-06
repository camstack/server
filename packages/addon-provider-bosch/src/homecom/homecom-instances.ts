/**
 * HomeCom integrations as `integration-instances` (planning#416, D985, D1007): one `connections`
 * record per account under the `integrations` registry id. The body IS the account (the account
 * email and the OAuth tokens in the keychain; brand, region, the chosen gateway and the
 * signed-in label in the open), so the form the instances page edits is the stored shape.
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
  buildHomeComFormSchema,
  connectionFromSettings,
  type HomeComConfig,
  HomeComBrandSchema,
  HomeComRegionSchema,
} from './config.js'

export const homeComConnectionsEntryKind = defineEntryKind('connections', {
  title: 'HomeCom accounts',
  schema: entryBody({
    username: z.string().optional().meta({ secret: true }),
    token: z.string().optional().meta({ secret: true }),
    refresh: z.string().optional().meta({ secret: true }),
    brand: HomeComBrandSchema.optional(),
    region: HomeComRegionSchema.optional(),
    gatewayId: z.string().optional(),
    accountLabel: z.string().optional(),
    gatewayCount: z.number().optional(),
  }),
  writeTrigger:
    'an operator signs in, edits or removes a HomeCom account, or a connection stores a rotated token or its gateway',
})
export type HomeComConnectionBody = z.infer<typeof homeComConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const homeComRecordKinds = { connections: homeComConnectionsEntryKind } as const

const LEGACY_KEYS: readonly string[] = [
  'username',
  'token',
  'refresh',
  'brand',
  'region',
  'gatewayId',
  'accountLabel',
  'gatewayCount',
]
const SECRET_KEYS: readonly string[] = ['username', 'token', 'refresh']

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The record body of one account, from its legacy rows (secrets resolved). */
export function homeComBodyFromRows(
  values: Readonly<Record<string, unknown>>,
  log: RowsMigrationLog,
  integration: { readonly id: string; readonly name: string },
): HomeComConnectionBody {
  const dropped = Object.keys(values).filter((key) => !LEGACY_KEYS.includes(key))
  if (dropped.length > 0) {
    log.warn(
      `integration '${integration.id}': legacy settings nothing reads any more are dropped: ${dropped.join(', ')}`,
    )
  }
  const username = text(values['username'])
  const token = text(values['token'])
  const refresh = text(values['refresh'])
  const brand = HomeComBrandSchema.safeParse(values['brand'])
  const region = HomeComRegionSchema.safeParse(values['region'])
  const gatewayId = text(values['gatewayId'])?.trim()
  const accountLabel = text(values['accountLabel'])
  const count = values['gatewayCount']
  return {
    name: integration.name,
    ...(username !== undefined ? { username } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(refresh !== undefined ? { refresh } : {}),
    ...(brand.success ? { brand: brand.data } : {}),
    ...(region.success ? { region: region.data } : {}),
    ...(gatewayId !== undefined && gatewayId.length > 0 ? { gatewayId } : {}),
    ...(accountLabel !== undefined ? { accountLabel } : {}),
    ...(typeof count === 'number' && Number.isFinite(count) ? { gatewayCount: count } : {}),
  }
}

export const HOMECOM_ROWS_TO_RECORD_ID = 'bosch-homecom/2026-11-05-integration-rows-to-record'

/** The whole `bosch-homecom` catalogue (D987): offered to the engine at `onInitialize`. */
export const HOMECOM_MIGRATIONS: readonly AddonMigration<IntegrationRowsPorts>[] = [
  boschRowsMigration({
    addonId: 'bosch-homecom',
    id: HOMECOM_ROWS_TO_RECORD_ID,
    description:
      'Move every HomeCom account into a typed instance record keyed by its registry id, then clear the legacy integration settings rows and their keychain values',
    fixtureMark: 'a legacy setting key the migration does not know',
    kind: homeComConnectionsEntryKind,
    bodyFrom: homeComBodyFromRows,
  }),
]

export function homeComRowsPorts(deps: {
  readonly api: IntegrationRowsApi
  readonly records: RowsRecordsDoor
  readonly warn: (message: string) => void
  readonly secrets?: Pick<SecretsAccess, 'resolve' | 'delete'> | null
}): IntegrationRowsPorts {
  return boschRowsPorts({ ...deps, kind: homeComConnectionsEntryKind })
}

/** A record read for the runtime: the body, and whether its secrets could not be read. */
export interface HomeComStored {
  readonly settings: Record<string, unknown>
  readonly locked: boolean
}

export async function homeComStoredOf(
  instances: Pick<RecordIntegrationInstances<HomeComConnectionBody>, 'readResolved'>,
  id: string,
): Promise<HomeComStored | null> {
  const read = await instances.readResolved(id)
  if (read === null) return null
  return { settings: { ...read.body }, locked: read.secrets === 'unavailable' }
}

/**
 * The live account of one integration, read from its record. null while it is not signed in; a
 * locked keychain throws so the caller keeps the client it has instead of reconfiguring it
 * without its tokens (D49).
 */
export async function homeComConnectionOf(
  instances: Pick<RecordIntegrationInstances<HomeComConnectionBody>, 'readResolved'>,
  id: string,
): Promise<HomeComConfig | null> {
  const stored = await homeComStoredOf(instances, id)
  if (stored === null) return null
  if (stored.locked) {
    throw new Error('the keychain is locked, the saved HomeCom tokens cannot be read')
  }
  return connectionFromSettings(stored.settings)
}

export interface HomeComInstancesDeps {
  readonly onChanged: () => Promise<void>
  readonly tester: IConnectionProbe
}

export interface HomeComInstances {
  readonly instances: RecordIntegrationInstances<HomeComConnectionBody>
  readonly provider: ReturnType<RecordIntegrationInstances<HomeComConnectionBody>['toProvider']>
  /** The kind's handle: the addon patches a rotated token or a chosen gateway here. */
  readonly handle: Pick<RecordKindHandle<HomeComConnectionBody>, 'patch'>
}

export function buildHomeComInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: HomeComInstancesDeps,
): HomeComInstances {
  const handle = records.kind(homeComConnectionsEntryKind)
  const instances = new RecordIntegrationInstances<HomeComConnectionBody>(
    records,
    homeComConnectionsEntryKind,
    {
      description: { role: 'devices', instanceMode: 'multiple', kind: 'account', canTest: true },
      formSchema: () => buildHomeComFormSchema(),
      initialBody: (name): HomeComConnectionBody => ({ name }),
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
      new Set(Object.keys(homeComConnectionsEntryKind.schema.shape)),
    ),
  }
}
