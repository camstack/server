/**
 * Move an integration's legacy `integration_settings` rows into a typed record of the addon's own
 * kind (planning#416, the one store). The record is keyed by the `integrations` registry id, so
 * the integration id, the devices stamped with it and the automations that name it do not change.
 *
 * Order, so a crash or a locked keychain is safe at every point:
 *
 *  1. Phase A, read only: every row of every integration of the addon is read with its secrets
 *     resolved. One that cannot be read (a locked keychain) throws, naming the integration, before
 *     anything is written; `block-owner` then holds the addon.
 *  2. Phase B, per integration: the addon's `bodyFrom` builds the body; the record is put with
 *     `ifRev: 0` (an existing record is never overwritten). A record this pass CREATED is read back
 *     and every secret leaf must equal what the rows held, else the record is deleted and the pass
 *     throws; an EXISTING record must hold every secret the rows carry, else the rows are kept and
 *     a warning names the path. Only then are the rows (and their keychain values) cleared.
 *
 * Idempotent: an integration whose rows are gone and whose record exists is skipped, so a rerun is
 * a no-op. A default integration with no rows still gets its record (an empty body, D985).
 * Never logs or throws a secret value; messages name integration ids and secret PATHS only.
 */
import { collectSecretLeaves } from '../records/secret-paths.js'
import type { MigrationProcedureResult } from './migration.js'

/** A registry row of the addon. */
export interface RowsIntegration {
  readonly id: string
  readonly name: string
}

/** What the migration says about a decision it took; never carries a value. */
export interface RowsMigrationLog {
  warn(message: string): void
}

export interface IntegrationRowsPorts extends RowsMigrationLog {
  /** The registry rows of `addonId`. */
  listIntegrations(addonId: string): Promise<readonly RowsIntegration[]>
  /**
   * The integration's legacy rows with every secret RESOLVED, through the owner's secret door.
   * Empty once cleared. Throws when a secret cannot be read; the values are never exposed further.
   */
  readRows(integrationId: string): Promise<Readonly<Record<string, unknown>>>
  /** Put the record under `id` with `ifRev: 0`; `exists` when one is already there. */
  putRecord(id: string, body: Readonly<Record<string, unknown>>): Promise<'created' | 'exists'>
  /** The record under `id`, secrets resolved; null when absent. Throws when it cannot be read. */
  readRecord(id: string): Promise<Readonly<Record<string, unknown>> | null>
  /** Remove a record this pass created and could not verify. */
  deleteRecord(id: string): Promise<void>
  /** Delete the integration's legacy rows AND their keychain values. */
  clearRows(integrationId: string): Promise<void>
}

export interface RowsToRecordSpec<TBody extends Readonly<Record<string, unknown>>> {
  readonly addonId: string
  /** The record body for one integration, from its resolved legacy rows. */
  bodyFrom(
    values: Readonly<Record<string, unknown>>,
    log: RowsMigrationLog,
    integration: RowsIntegration,
  ): TBody
  /** The kind's secret paths (`kind.declaration.secretPaths`): what is verified before the clear. */
  readonly secretPaths: readonly string[]
  readonly secretArrayKeys?: Readonly<Record<string, string>>
}

function secretLeavesOf(
  body: Readonly<Record<string, unknown>>,
  spec: Pick<
    RowsToRecordSpec<Readonly<Record<string, unknown>>>,
    'secretPaths' | 'secretArrayKeys'
  >,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const leaf of collectSecretLeaves(body, spec.secretPaths, spec.secretArrayKeys ?? {})) {
    if (typeof leaf.value === 'string' && leaf.value.length > 0) out.set(leaf.concrete, leaf.value)
  }
  return out
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function moveIntegrationRowsToRecords<TBody extends Readonly<Record<string, unknown>>>(
  ports: IntegrationRowsPorts,
  spec: RowsToRecordSpec<TBody>,
): Promise<MigrationProcedureResult> {
  const integrations = await ports.listIntegrations(spec.addonId)
  if (integrations.length === 0) return { outcome: 'already-done', summary: { integrations: 0 } }

  // Phase A: nothing is written until every row has been read, secrets included.
  const rowsOf = new Map<string, Readonly<Record<string, unknown>>>()
  for (const integration of integrations) {
    try {
      rowsOf.set(integration.id, await ports.readRows(integration.id))
    } catch (err) {
      throw new Error(
        `integration '${integration.id}': the legacy settings cannot be read with their secrets (${why(err)}) - nothing moved`,
        { cause: err },
      )
    }
  }

  let created = 0
  let cleared = 0
  let kept = 0
  for (const integration of integrations) {
    const values = rowsOf.get(integration.id) ?? {}
    const hasRows = Object.keys(values).length > 0
    const body = spec.bodyFrom(values, ports, integration)
    const put = await ports.putRecord(integration.id, body)
    if (put === 'created') created += 1
    if (!hasRows) continue

    const wanted = secretLeavesOf(body, spec)
    const back = await ports.readRecord(integration.id)
    if (back === null) {
      throw new Error(`integration '${integration.id}': the record is gone after it was put`)
    }
    const held = secretLeavesOf(back, spec)
    if (put === 'created') {
      const wrong = [...wanted].filter(([path, value]) => held.get(path) !== value).map(([p]) => p)
      if (wrong.length > 0) {
        await ports.deleteRecord(integration.id)
        throw new Error(
          `integration '${integration.id}': ${wrong.join(', ')} did not read back from the record - the record was removed and the legacy settings are kept`,
        )
      }
    } else {
      const missing = [...wanted].filter(([path]) => !held.has(path)).map(([p]) => p)
      if (missing.length > 0) {
        ports.warn(
          `integration '${integration.id}': the existing record holds no ${missing.join(', ')}; the legacy settings are kept, not cleared`,
        )
        kept += 1
        continue
      }
    }
    await ports.clearRows(integration.id)
    cleared += 1
  }
  return created === 0 && cleared === 0
    ? { outcome: 'already-done', summary: { integrations: integrations.length, kept } }
    : { outcome: 'done', summary: { integrations: integrations.length, created, cleared, kept } }
}
