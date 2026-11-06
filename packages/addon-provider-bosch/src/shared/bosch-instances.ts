/**
 * What the three Bosch addons (Smart Home Controller, Home Connect, HomeCom) share about keeping
 * their integrations as `integration-instances` records (planning#416, D985, D1007): the rows to
 * record migration, its ports over the hub and the records facade, and the connection probe that
 * reads a saved secret from the record when the form hands back its view.
 */
import {
  type AddonMigration,
  type DefinedRecordKind,
  type IConnectionProbe,
  type IIntegrationInstancesProvider,
  type IntegrationRowsApi,
  type RowsRecordsDoor,
  type SecretsAccess,
  type IntegrationRowsPorts,
  type IntegrationTestConnectionResult,
  type RowsIntegration,
  type RowsMigrationLog,
  integrationRowsPortsOverApi,
  moveIntegrationRowsToRecords,
  REDACTED_SECRET,
  type RecordKindHandle,
} from '@camstack/types'
import { z } from 'zod'

/** The kind a Bosch entry declares: only what the migration and the instances read from it. */
export type BoschEntryKind = Pick<DefinedRecordKind<z.ZodType>, 'name' | 'declaration'>

export interface BoschRowsMigrationSpec {
  readonly addonId: string
  readonly id: string
  readonly description: string
  readonly fixtureMark: string
  readonly kind: BoschEntryKind
  bodyFrom(
    values: Readonly<Record<string, unknown>>,
    log: RowsMigrationLog,
    integration: RowsIntegration,
  ): Readonly<Record<string, unknown>>
}

/** The `<addonId>/2026-11-05-integration-rows-to-record` migration of one Bosch entry (block-owner). */
export function boschRowsMigration(
  spec: BoschRowsMigrationSpec,
): AddonMigration<IntegrationRowsPorts> {
  return {
    meta: {
      id: spec.id,
      owner: spec.addonId,
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description: spec.description,
      fixtureMark: spec.fixtureMark,
    },
    procedure: (ports) =>
      moveIntegrationRowsToRecords(ports, {
        addonId: spec.addonId,
        secretPaths: spec.kind.declaration.secretPaths,
        bodyFrom: spec.bodyFrom,
      }),
  }
}

/** The hub side and the records side of the move, over `ctx.api` and `ctx.records`. */
export function boschRowsPorts(deps: {
  readonly api: IntegrationRowsApi
  readonly records: RowsRecordsDoor
  readonly kind: BoschEntryKind
  readonly warn: (message: string) => void
  readonly secrets?: Pick<SecretsAccess, 'resolve' | 'delete'> | null
}): IntegrationRowsPorts {
  return integrationRowsPortsOverApi({
    api: deps.api,
    ...(deps.secrets !== undefined ? { secrets: deps.secrets } : {}),
    records: deps.records.kind({
      name: deps.kind.name,
      // The declaration is the kind's own; the move reads and writes untyped bodies.
      declaration: deps.kind.declaration,
      schema: z.record(z.string(), z.unknown()),
    }),
    log: { warn: deps.warn },
  })
}

function typedSecret(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value !== REDACTED_SECRET ? value : undefined
}

/**
 * Probe with the (possibly unsaved) form values. A secret the operator did not retype comes back
 * as its view, so it is read from the saved record; one that cannot be read is simply absent.
 */
export async function testBoschInstance(input: {
  readonly tester: IConnectionProbe
  readonly handle: Pick<RecordKindHandle<Record<string, unknown>>, 'getResolved'>
  readonly secretKeys: readonly string[]
  readonly id: string | null
  readonly values: Readonly<Record<string, unknown>>
}): Promise<IntegrationTestConnectionResult> {
  const stored = await storedBody(input.handle, input.id)
  const settings: Record<string, unknown> = { ...input.values }
  for (const key of input.secretKeys) {
    const typed = typedSecret(input.values[key])
    const saved = typedSecret(stored[key])
    if (typed !== undefined) settings[key] = typed
    else if (saved !== undefined) settings[key] = saved
    else delete settings[key]
  }
  const outcome = await input.tester.testSettings({ settings })
  if (outcome.outcome === 'validated') {
    return {
      success: true,
      status: 'validated',
      ...(outcome.latencyMs !== undefined ? { latencyMs: outcome.latencyMs } : {}),
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    }
  }
  return { success: false, status: outcome.outcome, error: outcome.error }
}

async function storedBody(
  handle: Pick<RecordKindHandle<Record<string, unknown>>, 'getResolved'>,
  id: string | null,
): Promise<Readonly<Record<string, unknown>>> {
  if (id === null) return {}
  try {
    return (await handle.getResolved(id))?.data ?? {}
  } catch {
    // A locked keychain: nothing saved can be offered to the probe.
    return {}
  }
}

/**
 * The provider with `updateInstance` limited to the keys the kind's body has. A form carries
 * values that only an in-form action uses (a pairing password, a sign-in code); none of them may
 * reach the record, least of all as a plain key beside the secrets.
 */
export function keepBodyKeys(
  provider: IIntegrationInstancesProvider,
  keys: ReadonlySet<string>,
): IIntegrationInstancesProvider {
  return {
    ...provider,
    updateInstance: (input) =>
      provider.updateInstance({
        ...input,
        values: Object.fromEntries(Object.entries(input.values).filter(([key]) => keys.has(key))),
      }),
  }
}
