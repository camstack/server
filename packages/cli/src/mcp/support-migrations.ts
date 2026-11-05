/**
 * `migrations_status`: the boot-time migration ledger of this hub, per owner,
 * in one read-only answer — applied / failed / blocked / held / pending counts,
 * the error text of every failed migration, what each failed one blocks (the
 * dependency chain, from the catalogue's `dependsOn`), and which addon runners
 * are parked `refused` because of it (`addons.list` `process.state`, D877).
 *
 * Every read is independent: one that fails leaves `null` and a reason in
 * `unavailable`, never an empty list that reads as "nothing wrong" (D393). The
 * applied rows are counted, not listed, so the answer stays small on a hub with
 * hundreds of them; the problems are capped and the cut is reported.
 */
import { MigrationLedgerEntrySchema, MigrationPendingEntrySchema } from '@camstack/types'
import { z } from 'zod'
import type { McpContext } from './context.js'
import { createRedactor } from './report-scrub.js'
import { readQuery, withHub, type NoSessionResult, type RefusedResult } from './ops-hub.js'
import { adminRefusal } from './setup-assist-common.js'

export const PROBLEM_LIMIT = 40
export const CHAIN_LIMIT = 20
const ERROR_CHARS = 400

export interface OwnerCounts {
  readonly owner: string
  readonly applied: number
  readonly failed: number
  readonly blocked: number
  readonly held: number
  readonly running: number
  readonly pending: number
}

export interface MigrationProblem {
  readonly id: string
  readonly owner: string
  readonly state: 'failed' | 'blocked' | 'held' | 'running'
  readonly attempts: number
  readonly error: string | null
  readonly reason: string | null
  /** For `blocked`: the direct dependencies that are not applied. */
  readonly blockedBy: readonly string[]
  /** For `failed`: every migration that cannot run until this one does (transitive). */
  readonly blocks: readonly string[]
  readonly blocksTruncated: number
}

export interface RefusedRunner {
  readonly addonId: string
  readonly reason: string | null
}

export interface MigrationsStatusResult {
  readonly status: 'ok'
  readonly counts: {
    readonly applied: number
    readonly failed: number
    readonly blocked: number
    readonly held: number
    readonly running: number
    readonly pending: number
  } | null
  readonly owners: readonly OwnerCounts[] | null
  readonly problems: readonly MigrationProblem[] | null
  readonly problemsTruncated: number
  /** `null`: the addon list could not be read - unknown, not "none refused". */
  readonly refusedRunners: readonly RefusedRunner[] | null
  readonly unavailable: { readonly [part: string]: string }
  readonly notes: readonly string[]
}

const LedgerSchema = z.object({ entries: z.array(MigrationLedgerEntrySchema) })
const PendingSchema = z.object({ pending: z.array(MigrationPendingEntrySchema) })
const AddonRowsSchema = z.array(
  z.looseObject({
    manifest: z.looseObject({ id: z.string() }),
    process: z.looseObject({ state: z.string(), reason: z.string().optional() }).optional(),
  }),
)

type Ledger = z.infer<typeof LedgerSchema>['entries']
type Pending = z.infer<typeof PendingSchema>['pending']

const cut = (text: string | null): string | null =>
  text === null ? null : text.length > ERROR_CHARS ? `${text.slice(0, ERROR_CHARS)}…` : text

/** Pure: the view of one ledger + pending answer. */
export function buildMigrationsView(
  ledger: Ledger,
  pending: Pending,
): Pick<MigrationsStatusResult, 'counts' | 'owners' | 'problems' | 'problemsTruncated'> {
  const dependsOn = new Map<string, readonly string[]>()
  for (const e of ledger) if (e.meta) dependsOn.set(e.id, e.meta.dependsOn)
  for (const p of pending) dependsOn.set(p.meta.id, p.meta.dependsOn)

  const applied = new Set(ledger.filter((e) => e.status === 'applied').map((e) => e.id))
  const notApplied = new Set<string>([
    ...ledger.filter((e) => e.status !== 'applied').map((e) => e.id),
    ...pending.map((p) => p.meta.id),
  ])

  const owners = new Map<string, { -readonly [K in keyof OwnerCounts]: OwnerCounts[K] }>()
  const bump = (owner: string, key: Exclude<keyof OwnerCounts, 'owner'>): void => {
    const row = owners.get(owner) ?? {
      owner,
      applied: 0,
      failed: 0,
      blocked: 0,
      held: 0,
      running: 0,
      pending: 0,
    }
    row[key] += 1
    owners.set(owner, row)
  }
  const inLedger = new Set(ledger.map((e) => e.id))
  for (const e of ledger) {
    if (e.status === 'applied') bump(e.owner, 'applied')
    else if (e.status === 'failed') bump(e.owner, 'failed')
    else if (e.status === 'blocked') bump(e.owner, 'blocked')
    else if (e.status === 'held') bump(e.owner, 'held')
    else if (e.status === 'running') bump(e.owner, 'running')
  }
  for (const p of pending) {
    if (inLedger.has(p.meta.id)) continue
    if (p.state === 'pending') bump(p.meta.owner, 'pending')
    else if (p.state === 'failed') bump(p.meta.owner, 'failed')
    else if (p.state === 'blocked') bump(p.meta.owner, 'blocked')
    else bump(p.meta.owner, 'held')
  }

  const dependentsOf = (root: string): string[] => {
    const out: string[] = []
    const seen = new Set<string>([root])
    const queue = [root]
    while (queue.length > 0) {
      const at = queue.shift()
      if (at === undefined) break
      for (const [id, deps] of dependsOn) {
        if (seen.has(id) || !deps.includes(at) || !notApplied.has(id)) continue
        seen.add(id)
        out.push(id)
        queue.push(id)
      }
    }
    return out
  }

  const ownerOf = (id: string): string => id.split('/')[0] ?? id
  const problems: MigrationProblem[] = []
  const seenProblem = new Set<string>()
  const add = (
    id: string,
    state: MigrationProblem['state'],
    row: { attempts: number; error: string | null; reason: string | null },
  ): void => {
    if (seenProblem.has(id)) return
    seenProblem.add(id)
    const blocks = state === 'failed' ? dependentsOf(id) : []
    problems.push({
      id,
      owner: ownerOf(id),
      state,
      attempts: row.attempts,
      error: cut(row.error),
      reason: row.reason,
      blockedBy: (dependsOn.get(id) ?? []).filter((d) => !applied.has(d)),
      blocks: blocks.slice(0, CHAIN_LIMIT),
      blocksTruncated: Math.max(0, blocks.length - CHAIN_LIMIT),
    })
  }
  for (const e of ledger) {
    if (
      e.status === 'failed' ||
      e.status === 'blocked' ||
      e.status === 'held' ||
      e.status === 'running'
    ) {
      add(e.id, e.status, { attempts: e.attempts, error: e.error, reason: e.reason })
    }
  }
  for (const p of pending) {
    if (p.state !== 'pending')
      add(p.meta.id, p.state, { attempts: 0, error: null, reason: p.reason })
  }
  // Failed first, then blocked: the cause before its consequences.
  const rank = { failed: 0, blocked: 1, held: 2, running: 3 } as const
  problems.sort((a, b) => rank[a.state] - rank[b.state] || a.id.localeCompare(b.id))

  const rows = [...owners.values()].toSorted((a, b) => a.owner.localeCompare(b.owner))
  const sum = (key: Exclude<keyof OwnerCounts, 'owner'>): number =>
    rows.reduce((n, r) => n + r[key], 0)
  return {
    counts: {
      applied: sum('applied'),
      failed: sum('failed'),
      blocked: sum('blocked'),
      held: sum('held'),
      running: sum('running'),
      pending: sum('pending'),
    },
    owners: rows,
    problems: problems.slice(0, PROBLEM_LIMIT),
    problemsTruncated: Math.max(0, problems.length - PROBLEM_LIMIT),
  }
}

export async function migrationsStatus(
  ctx: McpContext,
): Promise<MigrationsStatusResult | NoSessionResult | RefusedResult> {
  return withHub(ctx, async (connection): Promise<MigrationsStatusResult | RefusedResult> => {
    const refused = adminRefusal(connection, 'migrations_status (the migration ledger)')
    if (refused) return refused
    const client = connection.client
    const unavailable: { [part: string]: string } = {}
    const [ledger, pending, addons] = await Promise.all([
      readQuery(client, 'migrations.listLedger', {}, LedgerSchema),
      readQuery(client, 'migrations.listPending', {}, PendingSchema),
      readQuery(client, 'addons.list', {}, AddonRowsSchema),
    ])
    if (!ledger.ok) unavailable['ledger'] = ledger.reason
    if (!pending.ok) unavailable['pending'] = pending.reason
    if (!addons.ok) unavailable['addons'] = addons.reason
    // A migration error or a runner reason is free text from the hub: it can carry
    // a path, a host or a credential, so it is masked here, not only by report_issue.
    const { scrub } = createRedactor()
    const built =
      ledger.ok && pending.ok
        ? buildMigrationsView(ledger.value.entries, pending.value.pending)
        : { counts: null, owners: null, problems: null, problemsTruncated: 0 }
    const view = {
      ...built,
      problems:
        built.problems?.map((p) => ({
          ...p,
          error: p.error === null ? null : scrub(p.error),
          reason: p.reason === null ? null : scrub(p.reason),
        })) ?? null,
    }
    const refusedRunners: RefusedRunner[] | null = addons.ok
      ? addons.value
          .filter((a) => a.process?.state === 'refused')
          .map((a) => ({
            addonId: a.manifest.id,
            reason: a.process?.reason === undefined ? null : scrub(a.process.reason),
          }))
      : null
    const notes: string[] = [
      'Hub runners only: an agent node keeps its own runner states (see ops_status).',
      'A runner is parked "refused" with "no addon of this runner could start" when every addon in it is blocked by a migration that did not apply; fix or retry the failed migration, then restart the addon.',
    ]
    return {
      status: 'ok',
      ...view,
      refusedRunners,
      unavailable,
      notes,
    }
  })
}
