/**
 * Where the shared client credentials and ACL come from while the copy migration has not been
 * recorded `applied`. The records are the instances; until the copy is recorded the legacy
 * settings lists are still the authority for any entry the records do not have yet, so a copy
 * that failed never boots a broker that has lost its users.
 */
import { aclRecordId, type LegacyClientsAcl } from './migrations/clients-acl-to-records.js'
import type { EmbeddedAclEntry, EmbeddedClientEntry } from './mqtt-embedded-instances.js'

export interface EmbeddedEntries {
  readonly clients: readonly EmbeddedClientEntry[]
  readonly acl: readonly EmbeddedAclEntry[]
}

/** The report of `runMigrations`, as far as this decision reads it. */
export interface MigrationReportView {
  readonly declared: boolean
  readonly applied: readonly string[]
  readonly failed: readonly string[]
}

/**
 * The copy is known to have landed only when THIS boot applied it. A step the engine skipped is
 * "already applied" or "held" by a restore, and the report cannot tell them apart, so a skipped
 * copy keeps merging the legacy lists: once the keys are gone that adds nothing.
 */
export function copyIsRecorded(report: MigrationReportView, id: string): boolean {
  return report.declared && report.applied.includes(id) && !report.failed.includes(id)
}

/** A minimal view of a record handle: enough to page through every id. */
export interface RecordIdSource {
  query(q: { readonly limit?: number; readonly cursor?: string }): Promise<{
    readonly records: readonly { readonly id: string }[]
    readonly nextCursor: string | null
  }>
}

const PAGE = 500

/** Every record id of a kind, page after page until the cursor is exhausted. */
export async function allRecordIds(handle: RecordIdSource): Promise<ReadonlySet<string>> {
  const ids = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await handle.query({ limit: PAGE, ...(cursor !== undefined ? { cursor } : {}) })
    for (const r of page.records) ids.add(r.id)
    if (page.nextCursor === null || page.records.length === 0) return ids
    cursor = page.nextCursor
  }
}

/** Every record id of the two kinds, switched off ones included: an off record stays off. */
export interface ExistingRecordIds {
  readonly clients: ReadonlySet<string>
  readonly acl: ReadonlySet<string>
}

/**
 * The records win; a legacy entry whose username (client) or username + pattern (rule) has no
 * record at all, on or off, is added, so the lists keep serving whatever the copy has not landed yet.
 */
export function withLegacyEntries(
  records: EmbeddedEntries,
  legacy: LegacyClientsAcl,
  have: ExistingRecordIds,
): EmbeddedEntries {
  const haveClient = have.clients
  const haveAcl = have.acl
  return {
    clients: [...records.clients, ...legacy.clients.filter((c) => !haveClient.has(c.username))],
    acl: [...records.acl, ...legacy.acl.filter((r) => !haveAcl.has(aclRecordId(r)))],
  }
}

export interface EmbeddedEntriesDeps {
  /** True when this boot applied the copy: the records alone are then the answer. */
  readonly copyRecorded: boolean
  readonly fromRecords: EmbeddedEntries
  readonly readLegacy: () => Promise<LegacyClientsAcl>
  readonly readRecordIds: () => Promise<ExistingRecordIds>
}

export type EmbeddedEntriesResolution =
  | {
      readonly kind: 'ready'
      readonly entries: EmbeddedEntries
      readonly rejected: LegacyClientsAcl['rejected']
    }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Fail closed: when the copy is not known to have landed and the legacy lists cannot be read,
 * the answer is `unavailable` (the caller opens no broker), never an empty user list.
 */
export async function resolveEmbeddedEntries(
  deps: EmbeddedEntriesDeps,
): Promise<EmbeddedEntriesResolution> {
  if (deps.copyRecorded) return { kind: 'ready', entries: deps.fromRecords, rejected: [] }
  try {
    const legacy = await deps.readLegacy()
    const entries = withLegacyEntries(deps.fromRecords, legacy, await deps.readRecordIds())
    return { kind: 'ready', entries, rejected: legacy.rejected }
  } catch (err) {
    return { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) }
  }
}
