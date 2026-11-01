/**
 * What a migration IS, as data (D987): its identity, its place in the order, the
 * edits a `plan` body returns, and what the ledger records about it. The code a
 * migration runs lives with its owner; this file is the part every process and the
 * guard share, so a catalogue is refused the same way everywhere.
 */
import { z } from 'zod'
import { DataStoreDatabaseSchema } from '../capabilities/settings-store.cap.js'

/** `<owner>/<date>-<slug>`, lower case, never reused once released. */
export const MIGRATION_ID_PATTERN = /^[a-z0-9-]+\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/

export const MigrationIdSchema = z
  .string()
  .regex(MIGRATION_ID_PATTERN, 'a migration id is "<owner>/<yyyy-mm-dd>-<slug>"')

export const MigrationLevelSchema = z.enum([
  'hub-store',
  'addon-state',
  'node-config',
  'viewer',
  'addon-internal',
])
export type MigrationLevel = z.infer<typeof MigrationLevelSchema>

export const MigrationStoreSchema = z.enum([
  'settings',
  'events',
  'history',
  'node-local',
  'addon-files',
])
export type MigrationStore = z.infer<typeof MigrationStoreSchema>

export const MigrationScopeSchema = z.enum(['cluster', 'per-node'])

/** What depends on a migration while it is pending: `block-owner` is the default. */
export const MigrationOnFailureSchema = z.enum(['block-owner', 'tolerate'])

/**
 * `sql` is a hub-only body over the owner's connection. `plan` returns edits the
 * engine applies inside the migration's own transaction (hub-owned: computed in
 * that transaction; addon-owned: computed by the owner and shipped to the engine).
 * `procedure` is addon-owned work that is not SQL (keychain, integration registry,
 * device tombstones); the ledger records its outcome and it must be idempotent.
 */
export const MigrationBodyKindSchema = z.enum(['sql', 'plan', 'procedure'])
export type MigrationBodyKind = z.infer<typeof MigrationBodyKindSchema>

export const MigrationMetaSchema = z
  .object({
    id: MigrationIdSchema,
    /** `hub`, an addon id, `node` or `viewer`. */
    owner: z.string().regex(/^[a-z0-9-]+$/),
    level: MigrationLevelSchema,
    /** Strictly increasing per owner: the order within an owner. */
    seq: z.number().int().positive(),
    /** Ids of any owner: the order across owners. */
    dependsOn: z.array(MigrationIdSchema),
    store: MigrationStoreSchema,
    scope: MigrationScopeSchema,
    onFailure: MigrationOnFailureSchema,
    bodyKind: MigrationBodyKindSchema,
    description: z.string().min(1),
    /** The marked field the migration's spec must assert survived. */
    fixtureMark: z.string().min(1),
  })
  .refine((m) => m.id.startsWith(`${m.owner}/`), {
    message: 'the id must start with "<owner>/"',
    path: ['id'],
  })
export type MigrationMeta = z.infer<typeof MigrationMetaSchema>

/** The shape `orderMigrations` needs: nothing else of a migration matters to the order. */
export interface MigrationOrderKey {
  readonly id: string
  readonly owner: string
  readonly seq: number
  readonly dependsOn: readonly string[]
}

/** A cycle in the dependency graph, named by the ids on it. */
export class MigrationCycleError extends Error {
  constructor(readonly ids: readonly string[]) {
    super(`migration dependsOn cycle: ${ids.join(' -> ')}`)
    this.name = 'MigrationCycleError'
  }
}

/**
 * Topological order over `dependsOn` plus the implicit edge "a lower `seq` of an
 * owner runs first". Ties are broken by `(owner, seq)`. Throws
 * {@link MigrationCycleError} on a cycle. A `dependsOn` id that is not in the list
 * is ignored here — the catalogue schema is what refuses it.
 */
export function orderMigrations<T extends MigrationOrderKey>(items: readonly T[]): readonly T[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const deps = new Map<string, Set<string>>()
  const ownerSorted = new Map<string, T[]>()
  for (const item of items) {
    const list = ownerSorted.get(item.owner) ?? []
    list.push(item)
    ownerSorted.set(item.owner, list)
  }
  for (const item of items) {
    deps.set(item.id, new Set(item.dependsOn.filter((id) => byId.has(id))))
  }
  for (const list of ownerSorted.values()) {
    list.sort((a, b) => a.seq - b.seq)
    for (let i = 1; i < list.length; i++) {
      const previous = list[i - 1]
      const current = list[i]
      if (previous !== undefined && current !== undefined) deps.get(current.id)?.add(previous.id)
    }
  }
  const tie = (a: T, b: T): number =>
    a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : a.seq - b.seq
  const done = new Set<string>()
  const ordered: T[] = []
  let remaining = [...items]
  while (remaining.length > 0) {
    const ready = remaining.filter((item) =>
      [...(deps.get(item.id) ?? [])].every((dep) => done.has(dep)),
    )
    if (ready.length === 0) throw new MigrationCycleError(remaining.map((item) => item.id).sort())
    ready.sort(tie)
    const next = ready[0]
    if (next === undefined) break
    ordered.push(next)
    done.add(next.id)
    remaining = remaining.filter((item) => item.id !== next.id)
  }
  return ordered
}

/** A problem with a catalogue as a whole. */
export interface MigrationCatalogueIssue {
  readonly code: 'duplicate-id' | 'duplicate-seq' | 'seq-order' | 'unknown-dependency' | 'cycle'
  readonly ids: readonly string[]
  readonly message: string
}

/** Every way a list of migrations (in declaration order) is not a catalogue. */
export function catalogueIssues(
  items: readonly MigrationOrderKey[],
): readonly MigrationCatalogueIssue[] {
  const issues: MigrationCatalogueIssue[] = []
  const seen = new Set<string>()
  const known = new Set(items.map((item) => item.id))
  const lastSeq = new Map<string, number>()
  const seqUsed = new Map<string, Set<number>>()
  for (const item of items) {
    if (seen.has(item.id)) {
      issues.push({ code: 'duplicate-id', ids: [item.id], message: `duplicate id ${item.id}` })
    }
    seen.add(item.id)
    const used = seqUsed.get(item.owner) ?? new Set<number>()
    if (used.has(item.seq)) {
      issues.push({
        code: 'duplicate-seq',
        ids: [item.id],
        message: `owner ${item.owner} has two migrations with seq ${item.seq}`,
      })
    } else if (item.seq < (lastSeq.get(item.owner) ?? 0)) {
      issues.push({
        code: 'seq-order',
        ids: [item.id],
        message: `seq ${item.seq} of ${item.id} does not increase in declaration order (owner ${item.owner})`,
      })
    }
    used.add(item.seq)
    seqUsed.set(item.owner, used)
    lastSeq.set(item.owner, Math.max(item.seq, lastSeq.get(item.owner) ?? 0))
    for (const dep of item.dependsOn) {
      if (!known.has(dep)) {
        issues.push({
          code: 'unknown-dependency',
          ids: [item.id, dep],
          message: `${item.id} dependsOn unknown id ${dep}`,
        })
      }
    }
  }
  try {
    orderMigrations(items)
  } catch (err) {
    if (err instanceof MigrationCycleError) {
      issues.push({ code: 'cycle', ids: err.ids, message: err.message })
    } else {
      throw err
    }
  }
  return issues
}

export const MigrationCatalogueSchema = z.array(MigrationMetaSchema).superRefine((items, ctx) => {
  for (const issue of catalogueIssues(items)) {
    ctx.addIssue({ code: 'custom', message: `${issue.code}: ${issue.message}` })
  }
})

// ── Plan edits (the `plan` body, applied by the framework) ───────────────

/**
 * The canonical JSON (`preconditionOf`) of the value a plan read; the apply step
 * re-reads, and a plan whose read no longer matches is refused (the migration is
 * `failed`, nothing it edited is kept).
 */
const PreconditionSchema = z.string().min(1).optional()

export const MigrationEditSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('setKeys'),
    scope: z.string().min(1),
    values: z.record(z.string(), z.unknown()),
    precondition: PreconditionSchema,
  }),
  z.object({
    op: z.literal('deleteKeys'),
    scope: z.string().min(1),
    keys: z.array(z.string().min(1)).min(1),
    precondition: PreconditionSchema,
  }),
  z.object({
    op: z.literal('putRow'),
    table: z.string().min(1),
    key: z.record(z.string(), z.unknown()),
    row: z.record(z.string(), z.unknown()),
    precondition: PreconditionSchema,
  }),
  z.object({
    op: z.literal('deleteRow'),
    table: z.string().min(1),
    key: z.record(z.string(), z.unknown()),
    precondition: PreconditionSchema,
  }),
  z.object({
    op: z.literal('upsertRecord'),
    kind: z.string().min(1),
    recordKey: z.string().min(1),
    value: z.unknown(),
    precondition: PreconditionSchema,
  }),
  z.object({
    op: z.literal('deleteRecord'),
    kind: z.string().min(1),
    recordKey: z.string().min(1),
    precondition: PreconditionSchema,
  }),
])
export type MigrationEdit = z.infer<typeof MigrationEditSchema>

export const MigrationPlanSchema = z.object({ edits: z.array(MigrationEditSchema) })
export type MigrationPlan = z.infer<typeof MigrationPlanSchema>

/** `JSON.stringify` with object keys sorted, so equal values spell the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const body = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    return `{${body.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** The precondition string for a value a plan read (`null` when it read nothing). */
export function preconditionOf(value: unknown): string {
  return canonicalJson(value ?? null)
}

// ── Procedure outcome and the owner protocol (M3) ────────────────────────

/**
 * What a `procedure` body reports. `already-done` means the rerun observed the
 * work finished (a crash between the work and the ledger row, or a manual fix)
 * and did none of it again; the ledger records `applied` either way.
 */
export const MigrationProcedureResultSchema = z.object({
  outcome: z.enum(['done', 'already-done']),
  summary: z.record(z.string(), z.unknown()),
})
export type MigrationProcedureResult = z.infer<typeof MigrationProcedureResultSchema>

/** What an owner hands the engine when one of its migrations ran. */
export const MigrationOwnerResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), plan: MigrationPlanSchema }),
  z.object({ kind: z.literal('procedure'), result: MigrationProcedureResultSchema }),
  z.object({ kind: z.literal('failed'), error: z.string().min(1) }),
])
export type MigrationOwnerResult = z.infer<typeof MigrationOwnerResultSchema>

// ── The ledger ───────────────────────────────────────────────────────────

/**
 * `held`: a restore of a pre-migration snapshot undid this id; it does not rerun
 * until the operator retries or a new code version ships.
 * `skipped-newer`: the database knows an id this code does not.
 */
export const MigrationStatusSchema = z.enum([
  'applied',
  'failed',
  'blocked',
  'running',
  'held',
  'skipped-newer',
])
export type MigrationStatus = z.infer<typeof MigrationStatusSchema>

export const MigrationLedgerEntrySchema = z.object({
  id: z.string(),
  database: DataStoreDatabaseSchema,
  owner: z.string(),
  level: MigrationLevelSchema,
  seq: z.number().int().nonnegative(),
  status: MigrationStatusSchema,
  attempts: z.number().int().nonnegative(),
  appliedAt: z.number().nullable(),
  codeVersion: z.string().nullable(),
  /** What the apply changed: rows per table, as the engine counted them. */
  planSummary: z.record(z.string(), z.unknown()).nullable(),
  progress: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  /** Why it is `blocked` or `held` (`dependency-failed`, `snapshot-refused`, …). */
  reason: z.string().nullable(),
  nodeId: z.string().nullable(),
  bootId: z.string().nullable(),
  /**
   * The catalogued meta of this id (description, body kind, store, `dependsOn`…),
   * joined by the engine from the catalogues it knows this boot. Absent when no
   * catalogue lists the id (a newer database).
   */
  meta: MigrationMetaSchema.optional(),
})
export type MigrationLedgerEntry = z.infer<typeof MigrationLedgerEntrySchema>

/** A catalogued migration that is not applied, with where it stands. */
export const MigrationPendingEntrySchema = z.object({
  meta: MigrationMetaSchema,
  database: DataStoreDatabaseSchema,
  state: z.enum(['pending', 'failed', 'blocked', 'held']),
  reason: z.string().nullable(),
})
export type MigrationPendingEntry = z.infer<typeof MigrationPendingEntrySchema>

/** Rows per table before and after a dry run, and what it would have changed. */
export const MigrationDryRunResultSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
  rowsChanged: z.number().int().nonnegative(),
  tables: z.array(
    z.object({
      table: z.string(),
      before: z.number().int().nonnegative(),
      after: z.number().int().nonnegative(),
    }),
  ),
})
export type MigrationDryRunResult = z.infer<typeof MigrationDryRunResultSchema>

/** One of an owner's migrations, as the engine tells the owner to treat it this boot. */
export const MigrationOwnerStepSchema = z.object({
  id: MigrationIdSchema,
  action: z.enum(['run', 'skip']),
  /** The ledger state the engine found: `pending` has no row yet. */
  state: z.union([z.literal('pending'), MigrationStatusSchema]),
})
export type MigrationOwnerStep = z.infer<typeof MigrationOwnerStepSchema>
