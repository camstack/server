/**
 * An addon-owned migration catalogue and the driver that runs it (D987, M3).
 *
 * ## How an addon declares and runs its migrations
 *
 * The catalogue is a module export of the addon, `ADDON_MIGRATIONS` in
 * `src/migrations/index.ts`: each entry is its `meta` (identity, order, body kind)
 * plus the body, a `plan` or a `procedure` that takes the addon's ports. At the
 * point of its own boot where its data must already have the new shape (`onInitialize`,
 * or `onRestoreDevices` for a migration that needs the restored devices), the addon
 * binds the catalogue to its ports (`defineAddonMigrations`) and runs it
 * (`BaseAddon.runMigrations`).
 *
 * ## Why the owner drives
 *
 * `sqlite-settings` boots first and cannot see an addon, let alone call into it, so
 * the hub never waits for an owner: an addon's migrations stay `pending` in the
 * ledger until the owner process boots and offers its catalogue. The engine then
 * gates each step on the ledger (`startMigration`), the owner does the work, and the
 * engine records the outcome (`finishMigration`): a `plan` is applied by the engine in
 * ONE transaction with the `applied` row (same snapshot, same rollback as a hub
 * migration), a `procedure` outcome is recorded as reported. The hub always finishes
 * booting; an owner that never boots simply leaves its rows pending.
 */
import type { IMigrationsProvider } from '../capabilities/migrations.cap.js'
import type { IScopedLogger } from '../interfaces/logging.js'
import { errMsg } from '../utils/err-msg.js'
import type {
  MigrationMeta,
  MigrationOwnerResult,
  MigrationPlan,
  MigrationProcedureResult,
  MigrationStatus,
} from './migration.js'

/** A `plan` body: reads through the owner's ports, returns edits the engine applies. */
export interface AddonPlanMigration<TPorts> {
  readonly meta: MigrationMeta
  plan(ports: TPorts): Promise<MigrationPlan>
}

/**
 * A `procedure` body: work that is not SQL, done through the owner's ports. It MUST be
 * idempotent — a rerun observes the work done and reports `already-done` without
 * redoing it (a crash between the work and the ledger row is the case it covers).
 */
export interface AddonProcedureMigration<TPorts> {
  readonly meta: MigrationMeta
  procedure(ports: TPorts): Promise<MigrationProcedureResult>
}

export type AddonMigration<TPorts> = AddonPlanMigration<TPorts> | AddonProcedureMigration<TPorts>

/** A migration with its ports bound: all the owner driver needs. */
export interface BoundAddonMigration {
  readonly meta: MigrationMeta
  execute(): Promise<MigrationOwnerResult>
}

/** Why a catalogue entry is not a runnable body of its declared kind. */
export class AddonMigrationDefinitionError extends Error {
  constructor(
    readonly id: string,
    message: string,
  ) {
    super(`${id}: ${message}`)
    this.name = 'AddonMigrationDefinitionError'
  }
}

/**
 * Bind a catalogue to the addon's ports. Throws {@link AddonMigrationDefinitionError} when
 * an entry's `bodyKind` does not match the body it carries, or is `sql` (a hub-only
 * body). A throwing body never escapes `execute`: it is reported as a failed result.
 */
export function defineAddonMigrations<TPorts>(
  catalogue: readonly AddonMigration<TPorts>[],
  ports: TPorts,
): readonly BoundAddonMigration[] {
  return catalogue.map((entry): BoundAddonMigration => {
    const { meta } = entry
    if ('plan' in entry) {
      if (meta.bodyKind !== 'plan') {
        throw new AddonMigrationDefinitionError(
          meta.id,
          `carries a plan body but declares "${meta.bodyKind}"`,
        )
      }
      return {
        meta,
        execute: () =>
          guarded(async () => ({ kind: 'plan', plan: await entry.plan(ports) }) as const),
      }
    }
    if (meta.bodyKind !== 'procedure') {
      throw new AddonMigrationDefinitionError(
        meta.id,
        `carries a procedure body but declares "${meta.bodyKind}"`,
      )
    }
    return {
      meta,
      execute: () =>
        guarded(async () => ({ kind: 'procedure', result: await entry.procedure(ports) }) as const),
    }
  })
}

async function guarded(work: () => Promise<MigrationOwnerResult>): Promise<MigrationOwnerResult> {
  try {
    return await work()
  } catch (err) {
    return { kind: 'failed', error: errMsg(err) }
  }
}

/** The three cap methods the owner driver needs. */
export type AddonMigrationHost = Pick<
  IMigrationsProvider,
  'declareOwner' | 'startMigration' | 'finishMigration'
>

export interface AddonMigrationRunReport {
  /** False when the engine could not be reached or refused the catalogue: nothing ran. */
  readonly declared: boolean
  readonly snapshot: 'none' | 'written' | 'refused' | null
  readonly applied: readonly string[]
  readonly failed: readonly string[]
  readonly blocked: readonly string[]
  readonly skipped: readonly string[]
  /** Failed or blocked migrations whose `onFailure` is `block-owner`: the owner must not serve. */
  readonly blockOwner: readonly string[]
}

export interface AddonMigrationRunOptions {
  /**
   * The ids this call runs. The WHOLE catalogue is still declared every time (the engine
   * replaces an owner's catalogue on a declare, so a partial offer would make the engine
   * judge an applied id the owner "no longer declares"); ids outside this set are left
   * untouched, neither started nor reported — a later call runs them.
   */
  readonly only?: readonly string[]
  /**
   * Ids this owner deliberately REMOVED from its catalogue. They are never run; an applied
   * ledger row of one is reported `applied`, not `skipped-newer`, and raises no alert.
   */
  readonly retired?: readonly string[]
}

const NOT_RUN: AddonMigrationRunReport = {
  declared: false,
  snapshot: null,
  applied: [],
  failed: [],
  blocked: [],
  skipped: [],
  blockOwner: [],
}

/**
 * Offer `migrations` to the engine and run what it says to run, in its order. Never
 * throws: an unreachable or refusing engine is logged and reported `declared: false`,
 * because the hub (and this addon's boot) must not hang on a migration.
 */
export async function runAddonMigrations(
  host: AddonMigrationHost,
  migrations: readonly BoundAddonMigration[],
  logger: IScopedLogger,
  options: AddonMigrationRunOptions = {},
): Promise<AddonMigrationRunReport> {
  const first = migrations[0]
  if (first === undefined) return NOT_RUN
  const owner = first.meta.owner
  const log = logger.withTags({ migrationOwner: owner })
  const byId = new Map(migrations.map((m) => [m.meta.id, m]))
  let declaration: Awaited<ReturnType<AddonMigrationHost['declareOwner']>>
  try {
    declaration = await host.declareOwner({
      owner,
      metas: migrations.map((m) => m.meta),
      ...(options.retired === undefined ? {} : { retired: [...options.retired] }),
    })
  } catch (err) {
    log.error('the migration engine refused or could not take this addon catalogue — none ran', {
      meta: { error: errMsg(err) },
    })
    // Not evaluated is not applied: a catalogue the engine never judged blocks its owner
    // exactly as a failed migration does.
    return {
      ...NOT_RUN,
      blockOwner: migrations
        .filter((m) => m.meta.onFailure === 'block-owner')
        .map((m) => m.meta.id),
    }
  }
  const applied: string[] = []
  const failed: string[] = []
  const blocked: string[] = []
  const skipped: string[] = []
  const settle = (id: string, status: MigrationStatus): void => {
    if (status === 'applied') applied.push(id)
    else if (status === 'failed') failed.push(id)
    else if (status === 'blocked') blocked.push(id)
    else skipped.push(id)
  }
  const selected = options.only === undefined ? null : new Set(options.only)
  // A phased owner (`only`) runs part of its catalogue now and the rest in a later phase of
  // the same boot (e.g. a hub migration that needs the restored devices). A step whose unmet
  // predecessor belongs to another phase — or was itself deferred here — is DEFERRED, not
  // blocked: the predecessor's own phase carries the verdict. Blocking here deadlocked the
  // owner, because the later phase never runs once the addon is refused.
  const deferred = new Set<string>()
  const deferredBy = (reason: string | null): string | null => {
    if (selected === null || reason === null) return null
    const match = /^dependency-(?:pending|blocked):(.+)$/.exec(reason)
    const dep = match?.[1]
    if (dep === undefined || !byId.has(dep)) return null
    return !selected.has(dep) || deferred.has(dep) ? dep : null
  }
  for (const step of declaration.steps) {
    if (selected !== null && !selected.has(step.id)) continue
    const bound = byId.get(step.id)
    if (bound === undefined || step.action === 'skip') {
      skipped.push(step.id)
      continue
    }
    const tags = { migrationId: step.id }
    try {
      const gate = await host.startMigration({ id: step.id })
      if (!gate.proceed) {
        const waitsFor = deferredBy(gate.reason)
        if (waitsFor !== null) {
          log.info('migration deferred: its predecessor runs in another phase of this owner', {
            tags,
            meta: { waitsFor, reason: gate.reason },
          })
          deferred.add(step.id)
          skipped.push(step.id)
          continue
        }
        log.warn('migration not run', { tags, meta: { state: gate.state, reason: gate.reason } })
        settle(step.id, gate.state === 'pending' ? 'blocked' : gate.state)
        continue
      }
      const result = await bound.execute()
      const outcome = await host.finishMigration({ id: step.id, result })
      if (outcome.status === 'applied') {
        log.info('migration applied', { tags, meta: { rowsChanged: outcome.rowsChanged } })
      } else {
        log.error('migration failed', { tags, meta: { error: outcome.error } })
      }
      settle(step.id, outcome.status)
    } catch (err) {
      log.error('migration could not be completed with the engine', {
        tags,
        meta: { error: errMsg(err) },
      })
      failed.push(step.id)
    }
  }
  const blockOwner = [...failed, ...blocked].filter(
    (id) => byId.get(id)?.meta.onFailure === 'block-owner',
  )
  return {
    declared: true,
    snapshot: declaration.snapshot,
    applied,
    failed,
    blocked,
    skipped,
    blockOwner,
  }
}
