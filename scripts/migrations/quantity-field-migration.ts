/**
 * The orchestration of the quantity-field migration: locate the files, refuse
 * when the hub looks live, plan, back up, apply each file in ONE transaction,
 * and verify. The entry point (`2026-10-27-quantity-field-names.ts`) only parses
 * arguments; everything testable lives here.
 *
 * Exit codes: 0 done (or nothing to do), 1 verification failed (the backup is
 * left in place), 2 refused or unusable arguments (nothing was touched).
 */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import {
  type LivenessOptions,
  judgeLiveness,
  systemProcessProbe,
  companionsOf,
} from './hub-liveness.ts'
import { isNewFieldName, renamedField } from './quantity-field-renames.ts'
import {
  type Db,
  type FilePlan,
  type StorePlan,
  planHistoryDb,
  planSettingsDb,
} from './quantity-field-stores.ts'
import { isRecord, type Tally } from './quantity-field-rewrite.ts'

export const EXIT_OK = 0
export const EXIT_VERIFY_FAILED = 1
export const EXIT_REFUSED = 2

export type Mode = 'dry-run' | 'apply'

export interface MigrationOptions {
  readonly mode: Mode
  readonly settingsDb: string | null
  readonly historyDb: string | null
  readonly backupDir: string | null
  readonly assumeStopped: boolean
  readonly minIdleSeconds: number
  readonly out: (line: string) => void
  /** Injected in tests; defaults to the operating-system probe. */
  readonly liveness?: Partial<LivenessOptions>
}

export interface MigrationResult {
  readonly exitCode: number
  readonly problems: readonly string[]
  readonly backupDir: string | null
  readonly plans: readonly {
    readonly file: string
    readonly stores: readonly StorePlan[]
  }[]
}

interface FileSpec {
  readonly file: string
  readonly plan: (db: Db) => FilePlan
}

export const SETTINGS_DB_NAME = 'camstack.db'
export const HISTORY_DB_NAME = 'history.db'
export const SQLITE_SETTINGS_SUBDIR = path.join('addons-data', 'sqlite-settings')

/** Where the sqlite-settings engine keeps its files under a data dir. */
export function filesUnderDataDir(dataDir: string): {
  settingsDb: string
  historyDb: string
} {
  const dir = path.join(dataDir, SQLITE_SETTINGS_SUBDIR)
  return {
    settingsDb: path.join(dir, SETTINGS_DB_NAME),
    historyDb: path.join(dir, HISTORY_DB_NAME),
  }
}

function fileSpecs(opts: MigrationOptions): readonly FileSpec[] {
  const specs: FileSpec[] = []
  if (opts.settingsDb !== null) specs.push({ file: opts.settingsDb, plan: planSettingsDb })
  if (opts.historyDb !== null) specs.push({ file: opts.historyDb, plan: planHistoryDb })
  return specs
}

// ── printing ──────────────────────────────────────────────────────────────────

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function describeRef(ref: string): string {
  const dot = ref.indexOf('.')
  const cap = ref.slice(0, dot)
  const field = ref.slice(dot + 1)
  const to = renamedField(cap, field)
  if (to !== null) return `-> ${to}`
  if (isNewFieldName(cap, field)) return '(new name)'
  return '(dropped by the code; left as is)'
}

function printStore(store: StorePlan, out: (line: string) => void): void {
  const refs = [...store.seen.keys()].toSorted()
  const advisories = [...store.advisories.keys()].toSorted()
  if (refs.length === 0 && advisories.length === 0) return
  out(
    `  ${store.store}  (${String(store.rowsScanned)} rows scanned, ${String(store.rowsToChange)} to change)`,
  )
  for (const ref of refs) {
    const merged = store.merged.get(ref) ?? 0
    const mergedText = merged > 0 ? `  merged into an existing entry: ${String(merged)}` : ''
    out(
      `    ${pad(ref, 42)} ${pad(String(store.seen.get(ref) ?? 0), 8)} ${describeRef(ref)}${mergedText}`,
    )
  }
  for (const key of advisories) {
    out(`    ADVISORY ${key}: ${String(store.advisories.get(key) ?? 0)} (rewrite by hand)`)
  }
}

function printPlan(file: string, stores: readonly StorePlan[], out: (line: string) => void): void {
  out(`${file}`)
  if (stores.length === 0) out('  (no store of this file exists)')
  for (const store of stores) printStore(store, out)
}

// ── verification ──────────────────────────────────────────────────────────────

function countOf(tally: Tally, key: string): number {
  return tally.get(key) ?? 0
}

function refParts(ref: string): { cap: string; field: string } {
  const dot = ref.indexOf('.')
  return { cap: ref.slice(0, dot), field: ref.slice(dot + 1) }
}

/** After[old] = 0 and after[new] = before[new] + before[old] - merged[new], per store. */
export function verifyStore(before: StorePlan, after: StorePlan | undefined): readonly string[] {
  const problems: string[] = []
  const afterSeen: Tally = after?.seen ?? new Map()
  for (const [ref, count] of before.seen) {
    const { cap, field } = refParts(ref)
    const to = renamedField(cap, field)
    if (to === null) {
      if (!isNewFieldName(cap, field) && countOf(afterSeen, ref) !== count) {
        problems.push(
          `${before.store} ${ref}: untouched count changed ${String(count)} -> ${String(countOf(afterSeen, ref))}`,
        )
      }
      continue
    }
    if (countOf(afterSeen, ref) !== 0) {
      problems.push(
        `${before.store} ${ref}: ${String(countOf(afterSeen, ref))} old-name references remain`,
      )
    }
    const newRef = `${cap}.${to}`
    const expected = countOf(before.seen, newRef) + count - countOf(before.merged, newRef)
    if (countOf(afterSeen, newRef) !== expected) {
      problems.push(
        `${before.store} ${newRef}: expected ${String(expected)}, found ${String(countOf(afterSeen, newRef))}`,
      )
    }
  }
  return problems
}

export function verifyFile(
  before: readonly StorePlan[],
  after: readonly StorePlan[],
): readonly string[] {
  const byStore = new Map(after.map((store) => [store.store, store]))
  return before.flatMap((store) => verifyStore(store, byStore.get(store.store)))
}

function integrityProblems(db: Db, file: string): readonly string[] {
  const rows: unknown = db.pragma('integrity_check')
  const messages = (Array.isArray(rows) ? rows : []).map((row: unknown) =>
    isRecord(row) ? String(row['integrity_check']) : String(row),
  )
  return messages.length === 1 && messages[0] === 'ok'
    ? []
    : messages.map((message) => `${file}: integrity_check: ${message}`)
}

// ── backup ────────────────────────────────────────────────────────────────────

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

interface ManifestEntry {
  readonly original: string
  readonly copy: string
  readonly sha256: string
  readonly bytes: number
}

function backupFiles(files: readonly string[], dir: string): readonly ManifestEntry[] {
  fs.mkdirSync(dir, { recursive: true })
  const entries: ManifestEntry[] = []
  for (const [index, dbFile] of files.entries()) {
    for (const original of companionsOf(dbFile)) {
      const copy = path.join(dir, `${String(index)}-${path.basename(original)}`)
      fs.copyFileSync(original, copy)
      const digest = sha256(original)
      if (sha256(copy) !== digest)
        throw new Error(`backup of ${original} does not match its source`)
      entries.push({
        original,
        copy,
        sha256: digest,
        bytes: fs.statSync(copy).size,
      })
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ entries }, null, 2)}\n`)
  return entries
}

function defaultBackupDir(opts: MigrationOptions, anchor: string): string {
  if (opts.backupDir !== null) return opts.backupDir
  const stamp = new Date().toISOString().replaceAll(':', '-')
  return path.join(path.dirname(anchor), 'migration-backups', `quantity-field-names-${stamp}`)
}

// ── run ───────────────────────────────────────────────────────────────────────

function refuse(opts: MigrationOptions, problems: readonly string[]): MigrationResult {
  for (const problem of problems) opts.out(`REFUSED: ${problem}`)
  return { exitCode: EXIT_REFUSED, problems, backupDir: null, plans: [] }
}

function planFromReadonly(spec: FileSpec): FilePlan {
  const db = new Database(spec.file, { readonly: true, fileMustExist: true })
  try {
    return spec.plan(db)
  } finally {
    db.close()
  }
}

function applyFile(spec: FileSpec, out: (line: string) => void): readonly string[] {
  const db = new Database(spec.file, { fileMustExist: true })
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const plan = spec.plan(db)
      plan.apply()
      const after = spec.plan(db)
      const problems = [
        ...verifyFile(plan.stores, after.stores),
        ...integrityProblems(db, spec.file),
      ]
      if (after.hasWork) problems.push(`${spec.file}: a second planning pass still finds work`)
      if (problems.length > 0) {
        db.exec('ROLLBACK')
        return problems
      }
      db.exec('COMMIT')
      out(`applied ${spec.file}`)
      return []
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK')
      return [`${spec.file}: ${error instanceof Error ? error.message : String(error)}`]
    }
  } finally {
    db.close()
  }
}

export function runMigration(opts: MigrationOptions): MigrationResult {
  const specs = fileSpecs(opts)
  const missing = specs
    .filter((spec) => !fs.existsSync(spec.file))
    .map((spec) => `no such file: ${spec.file}`)
  if (specs.length === 0)
    return refuse(opts, ['no database file given: pass --data-dir, --settings-db or --history-db'])
  if (missing.length > 0) return refuse(opts, missing)

  const verdict = judgeLiveness(
    specs.map((spec) => spec.file),
    {
      minIdleSeconds: opts.minIdleSeconds,
      assumeStopped: opts.assumeStopped,
      probe: systemProcessProbe,
      now: Date.now,
      selfPid: process.pid,
      ...opts.liveness,
    },
  )
  if (verdict.live) {
    return refuse(opts, [...verdict.reasons, 'stop the hub, wait for it to exit, then run again'])
  }
  for (const note of verdict.notes) opts.out(`note: ${note}`)

  const planned = specs.map((spec) => ({ spec, plan: planFromReadonly(spec) }))
  for (const { spec, plan } of planned) printPlan(spec.file, plan.stores, opts.out)
  const plans = planned.map(({ spec, plan }) => ({
    file: spec.file,
    stores: plan.stores,
  }))
  const work = planned.filter(({ plan }) => plan.hasWork)

  if (opts.mode === 'dry-run') {
    opts.out(
      work.length === 0
        ? 'dry run: nothing to change'
        : 'dry run: nothing written. Run again with --apply to migrate.',
    )
    return { exitCode: EXIT_OK, problems: [], backupDir: null, plans }
  }
  if (work.length === 0) {
    opts.out('nothing to change')
    return { exitCode: EXIT_OK, problems: [], backupDir: null, plans }
  }

  const first = work[0]
  const backupDir = defaultBackupDir(opts, first === undefined ? '' : first.spec.file)
  backupFiles(
    work.map(({ spec }) => spec.file),
    backupDir,
  )
  opts.out(`backup written to ${backupDir}`)

  const problems = work.flatMap(({ spec }) => applyFile(spec, opts.out))
  if (problems.length > 0) {
    for (const problem of problems) opts.out(`FAILED: ${problem}`)
    opts.out(`the backup is left in ${backupDir}`)
    return { exitCode: EXIT_VERIFY_FAILED, problems, backupDir, plans }
  }
  opts.out('done. Start the hub again.')
  return { exitCode: EXIT_OK, problems: [], backupDir, plans }
}
