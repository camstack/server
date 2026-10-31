/**
 * The boot-time migration engine of the `sqlite-settings` owner (D986).
 *
 * It runs from each owned file's `afterOpen` — BEFORE the engine returns a
 * single provider, so nothing can read a file whose shape is half moved — and
 * drives, per file: read what is pending, take the pre-migration snapshot, apply
 * each migration in its own transaction. The per-file work is
 * `migration-pass.ts`, executed where the connection lives (here for
 * `camstack.db`, in the file-host worker for `events.db` and `history.db`); this
 * class holds what is NOT per file: the boot id, the hold, the snapshotter, the
 * statuses that order one file's migrations after another's, and the log lines.
 *
 * The hub always finishes booting: a pass that cannot run is logged and leaves
 * the file as it was.
 */
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  type DatabaseSnapshotResult,
  type DataStoreDatabase,
  errMsg,
  type IScopedLogger,
  type MigrationLedgerEntry,
  type MigrationMeta,
  orderMigrations,
} from '@camstack/types'
import { PRE_MIGRATION_DIR_SUFFIX } from '../sqlite-snapshotter.js'
import { clearHold, readHold, releaseFromHold, writeHold } from './migration-hold.js'
import type {
  AppliedPass,
  HubMigration,
  MigrateInput,
  MigrateOp,
  MigrateOutput,
  PassOutcome,
  PassStatus,
  PassStatuses,
} from './migration-types.js'

/** One owned file as the engine sees it: a path and the ops its connection answers. */
export interface MigrationFileAccess {
  readonly databaseId: DataStoreDatabase
  readonly livePath: string
  call<K extends MigrateOp>(op: K, input: MigrateInput<K>): Promise<MigrateOutput<K>>
}

export interface PreMigrationSnapshotter {
  writePreMigration(bootId: string, firstId: string): Promise<DatabaseSnapshotResult>
}

/** What a restore asks the launcher to do at the next start. */
export interface PreMigrationRestoreRequest {
  readonly livePath: string
  readonly snapshotPath: string
}

export interface MigrationEngineOptions {
  readonly logger: IScopedLogger
  readonly catalogue: readonly HubMigration[]
  readonly codeVersion: string
  readonly snapshotterFor: (livePath: string) => PreMigrationSnapshotter
  /** A hint to the Alert Center that the ledger changed; the ledger stays the authority (D11). */
  readonly announce?: (kind: 'failed' | 'applied', ids: readonly string[]) => void
  /** Writes the pending-restore marker the launcher promotes at the next start. */
  readonly scheduleRestore?: (request: PreMigrationRestoreRequest) => Promise<void>
  readonly bootId?: string
}

/** The order the files are opened in at boot, and so the order a retry re-runs them. */
const FILE_ORDER: readonly DataStoreDatabase[] = ['settings', 'events', 'history']

export class MigrationEngine {
  readonly bootId: string
  private readonly files = new Map<DataStoreDatabase, MigrationFileAccess>()
  private readonly statuses = new Map<string, PassStatus>()
  /** One pass at a time: a retry must not interleave with a boot pass. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: MigrationEngineOptions) {
    this.bootId = options.bootId ?? randomUUID().slice(0, 8)
  }

  /** The hook for one file's `afterOpen`. Never throws. */
  runFile(access: MigrationFileAccess): Promise<void> {
    this.files.set(access.databaseId, access)
    return this.serialised(() => this.pass(access))
  }

  /** Every registered file again, in boot order — what a retry does after it cleared rows. */
  runAll(): Promise<void> {
    return this.serialised(async () => {
      this.statuses.clear()
      for (const databaseId of FILE_ORDER) {
        const access = this.files.get(databaseId)
        if (access !== undefined) await this.pass(access)
      }
    })
  }

  private serialised(work: () => Promise<void>): Promise<void> {
    const run = this.tail.catch(() => undefined).then(work)
    this.tail = run
    return run
  }

  private external(): PassStatuses {
    return Object.fromEntries(this.statuses)
  }

  private async pass(access: MigrationFileAccess): Promise<void> {
    const log = this.options.logger.withTags({ database: access.databaseId })
    try {
      const { held, unreadable } = await this.heldIds(access, log)
      const prepared = await access.call('prepare', { external: this.external(), held })
      for (const [id, status] of Object.entries(prepared.statuses)) this.statuses.set(id, status)
      for (const id of prepared.newer) {
        log.warn(
          'migration ledger names an id this code does not know — skipped-newer, nothing written for it',
          { tags: { migrationId: id, database: access.databaseId } },
        )
      }
      const heldNow = unreadable ? prepared.runnable : held
      const runnable = unreadable ? [] : prepared.runnable
      const heldPending = heldNow.filter((id) => {
        const status = prepared.statuses[id]
        return status !== undefined && status !== 'applied' && status !== 'held'
      })
      if (runnable.length === 0 && heldPending.length === 0) return

      let refusal: 'snapshot-refused' | null = null
      let refusalDetail: string | null = null
      const first = runnable[0]
      if (first !== undefined) {
        try {
          const snapshot = await this.options
            .snapshotterFor(access.livePath)
            .writePreMigration(this.bootId, first)
          log.info('pre-migration snapshot written', {
            meta: { snapshotPath: snapshot.snapshotPath, sizeBytes: snapshot.sizeBytes, first },
          })
        } catch (err) {
          refusal = 'snapshot-refused'
          refusalDetail = errMsg(err)
          log.error(
            'pre-migration snapshot refused — no migration runs on this file, it keeps its old shape',
            { meta: { error: refusalDetail, pending: runnable } },
          )
        }
      }
      const applied = await access.call('apply', {
        bootId: this.bootId,
        codeVersion: this.options.codeVersion,
        external: this.external(),
        held: heldNow,
        refusal,
        refusalDetail,
      })
      this.record(applied, log)
    } catch (err) {
      log.error('migration pass could not run on this file — nothing was changed by it', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /** The ids a restore holds for THIS code version; another version drops the hold. */
  private async heldIds(
    access: MigrationFileAccess,
    log: IScopedLogger,
  ): Promise<{ held: readonly string[]; unreadable: boolean }> {
    const read = await readHold(access.livePath)
    if (read.kind === 'absent') return { held: [], unreadable: false }
    if (read.kind === 'unreadable') {
      log.warn('migration hold file is unreadable — every pending migration of this file is held', {
        meta: { error: read.error },
      })
      return { held: [], unreadable: true }
    }
    if (read.hold.codeVersion !== this.options.codeVersion) {
      log.info('migration hold dropped — it was written for another code version', {
        meta: { heldFor: read.hold.codeVersion, running: this.options.codeVersion },
      })
      await clearHold(access.livePath)
      return { held: [], unreadable: false }
    }
    return { held: read.hold.ids, unreadable: false }
  }

  private record(applied: AppliedPass, log: IScopedLogger): void {
    for (const [id, status] of Object.entries(applied.statuses)) this.statuses.set(id, status)
    const failed: string[] = []
    const changed: string[] = []
    for (const outcome of applied.outcomes) {
      this.logOutcome(outcome, log)
      if (outcome.outcome === 'failed' || outcome.reason === 'snapshot-refused')
        failed.push(outcome.id)
      if (outcome.outcome === 'applied') changed.push(outcome.id)
    }
    if (failed.length > 0) this.options.announce?.('failed', failed)
    else if (changed.length > 0) this.options.announce?.('applied', changed)
  }

  private logOutcome(outcome: PassOutcome, log: IScopedLogger): void {
    const tags = { migrationId: outcome.id, owner: outcome.owner }
    if (outcome.outcome === 'applied') {
      log.info('migration applied', { tags, meta: { rowsChanged: outcome.rowsChanged } })
    } else if (outcome.outcome === 'failed') {
      log.error('migration failed', { tags, meta: { error: outcome.error } })
    } else {
      log.warn(`migration ${outcome.outcome}`, { tags, meta: { reason: outcome.reason } })
    }
  }

  // ── What the `migrations` capability serves ──────────────────────────

  private accessOf(database: DataStoreDatabase): MigrationFileAccess {
    const access = this.files.get(database)
    if (access === undefined) throw new Error(`database "${database}" is not open`)
    return access
  }

  async listLedger(): Promise<readonly MigrationLedgerEntry[]> {
    const entries: MigrationLedgerEntry[] = []
    for (const databaseId of FILE_ORDER) {
      const access = this.files.get(databaseId)
      if (access !== undefined) entries.push(...(await access.call('ledger', {})))
    }
    return entries
  }

  async markFailed(id: string, error: string): Promise<MigrationLedgerEntry> {
    for (const access of this.files.values()) {
      const entry = await access.call('markFailed', { id, error, bootId: this.bootId })
      if (entry !== null) {
        this.options.announce?.('failed', [id])
        return entry
      }
    }
    throw new Error(`migration ${id} is not a hub-store migration`)
  }

  /** `id` and everything that depends on it, directly or through its owner's order. */
  dependentsOf(id: string): readonly string[] {
    const metas: readonly MigrationMeta[] = this.options.catalogue.map((m) => m.meta)
    const ordered = orderMigrations(metas)
    const out = new Set<string>([id])
    for (const meta of ordered) {
      const previousInOwner = ordered
        .filter((candidate) => candidate.owner === meta.owner && candidate.seq < meta.seq)
        .at(-1)
      const deps = [
        ...meta.dependsOn,
        ...(previousInOwner === undefined ? [] : [previousInOwner.id]),
      ]
      if (deps.some((dep) => out.has(dep))) out.add(meta.id)
    }
    return [...out]
  }

  async retry(id: string): Promise<readonly MigrationLedgerEntry[]> {
    if (!this.options.catalogue.some((m) => m.meta.id === id)) {
      throw new Error(`migration ${id} is not a hub-store migration`)
    }
    const ids = this.dependentsOf(id)
    for (const access of this.files.values()) {
      await access.call('reset', { ids })
      await releaseFromHold(access.livePath, ids)
    }
    await this.runAll()
    return (await this.listLedger()).filter((entry) => ids.includes(entry.id))
  }

  /**
   * Schedule the restore of a pre-migration snapshot and hold what it undoes.
   * The ids held are the ledger rows written under the snapshot's boot id: the
   * snapshot was taken at the start of that pass, so everything the pass wrote
   * is what the restore reverts.
   */
  async restorePreMigration(
    database: DataStoreDatabase,
    snapshotId: string,
  ): Promise<{ held: readonly string[] }> {
    if (!/^[A-Za-z0-9_-]+$/.test(snapshotId))
      throw new Error(`"${snapshotId}" is not a snapshot id`)
    const access = this.accessOf(database)
    const snapshotPath = path.join(
      path.resolve(access.livePath) + PRE_MIGRATION_DIR_SUFFIX,
      `${snapshotId}.db`,
    )
    await fsp.stat(snapshotPath)
    const bootId = snapshotId.split('-')[0]
    const held = (await access.call('ledger', {}))
      .filter(
        (entry) =>
          entry.bootId === bootId &&
          (entry.status === 'applied' || entry.status === 'failed' || entry.status === 'blocked'),
      )
      .map((entry) => entry.id)
    if (this.options.scheduleRestore === undefined) {
      throw new Error('restoring a pre-migration snapshot is not available here')
    }
    await writeHold(access.livePath, {
      codeVersion: this.options.codeVersion,
      ids: held,
      snapshotId,
    })
    try {
      await this.options.scheduleRestore({ livePath: path.resolve(access.livePath), snapshotPath })
    } catch (err) {
      await clearHold(access.livePath)
      throw err
    }
    this.options.logger.warn('restore of a pre-migration snapshot scheduled for the next restart', {
      meta: { database, snapshotId, held },
    })
    return { held }
  }

  async dryRun(id: string): Promise<MigrateOutput<'dryRun'>> {
    const own = this.options.catalogue.find((m) => m.meta.id === id)
    if (own === undefined) throw new Error(`migration ${id} is not a hub-store migration`)
    const database = own.meta.store
    if (database !== 'settings' && database !== 'events' && database !== 'history') {
      throw new Error(`migration ${id} does not run on a database file`)
    }
    return this.accessOf(database).call('dryRun', { id })
  }

  /** The catalogued migrations that are not applied, with the state the ledger holds. */
  async listPending(owner?: string): Promise<
    readonly {
      readonly meta: MigrationMeta
      readonly database: DataStoreDatabase
      readonly state: 'pending' | 'failed' | 'blocked' | 'held'
      readonly reason: string | null
    }[]
  > {
    const ledger = new Map((await this.listLedger()).map((entry) => [entry.id, entry]))
    const out = []
    for (const { meta } of this.options.catalogue) {
      if (owner !== undefined && meta.owner !== owner) continue
      const database = meta.store
      if (database !== 'settings' && database !== 'events' && database !== 'history') continue
      const row = ledger.get(meta.id)
      if (row?.status === 'applied') continue
      const state =
        row === undefined
          ? 'pending'
          : row.status === 'failed' || row.status === 'blocked' || row.status === 'held'
            ? row.status
            : 'pending'
      out.push({ meta, database, state, reason: row?.reason ?? null } as const)
    }
    return out
  }
}
