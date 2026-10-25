#!/usr/bin/env tsx
/**
 * GUARD: a live SQLite file is reached only through its OWNER's connection
 * (D679).
 *
 * ## What this prevents
 *
 * `hub/sqlite-settings` died with SIGBUS after every 03:00 backup for 17 days
 * (2026-09-12 → 2026-09-29), and D468 filed it under the wrong cause. Two
 * lines of code made it, in two different processes:
 *
 *  1. **In the owner**, the checkpoint worker read the `-shm` header with
 *     `openSync` / `readSync` / `closeSync`, once a second. On POSIX, closing
 *     ANY descriptor of a file drops EVERY fcntl lock the process holds on it
 *     — including the shared lock on `-shm` byte 128 that SQLite keeps for a
 *     connection's whole life and that tells other processes the wal-index is
 *     live. (sqlite.org/howtocorrupt.html §2.2.)
 *  2. **Outside the owner**, the backup opened a second connection to the live
 *     database from hub-main. Finding no lock, it believed it was first and
 *     truncated the `-shm` under the runner's mappings; the runner's next
 *     write past a region boundary was a SIGBUS.
 *
 * Neither line looked dangerous. The first read 100 bytes; the second ran a
 * PASSIVE checkpoint, the "safe" one. So this guard does not judge intent — it
 * refuses both SHAPES:
 *
 *  - **Rule `fs-on-sqlite-file`**: a filesystem call that opens, reads,
 *    writes, closes, truncates, copies, renames or deletes a path that names
 *    a SQLite file — a `.db` / `.sqlite` / `.sqlite3` / `-wal` / `-shm`
 *    ending (the exact suffix: `settings.db.json` is not one), or a
 *    `dbPath` / `walPath` / `shmPath` / `dbFile` identifier — in production
 *    code. `stat` and `existsSync` are allowed: a path lookup takes no
 *    descriptor and drops no lock.
 *  - **Rule `sqlite-connection-outside-owner`**: a VALUE import of
 *    `better-sqlite3` or `node:sqlite` (static, dynamic or `require`) in any
 *    file but the two that construct the owner's connections
 *    ({@link SQLITE_CONNECTION_FILES}). Not the whole `sqlite-storage/`
 *    directory: `@camstack/system`'s index exports modules from it, and
 *    hub-main loads them. `import type` is fine: a type opens nothing.
 *
 * Code that legitimately handles a NON-live database (a restore that drops a
 * stale `-wal` before any runner starts, say) is exempted by name in
 * {@link SQLITE_GUARD_ALLOWLIST}, with its reason — never by renaming a
 * variable until the pattern stops matching.
 *
 * Tests are exempt: the reproduction of the bug has to do exactly the thing
 * this guard forbids. Text-based, over comment-stripped code, like the other
 * guards; `scripts/__tests__/check-sqlite-files-not-opened-by-fs.spec.ts`
 * proves each rule red on a fixture. The real tree is checked by the CI
 * repository-guards step that runs this file.
 *
 * Usage: tsx scripts/check-sqlite-files-not-opened-by-fs.ts
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkSources } from './lib/walk-sources.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_ROOTS: readonly string[] = ['packages', 'server']

/**
 * The only files allowed a SQLite driver value import: they construct the
 * connections of the process that owns the database (the settings backend on
 * the runner's main thread, the checkpoint worker thread beside it, and the
 * snapshot worker thread that writes the owner's backup copy — D693).
 */
export const SQLITE_CONNECTION_FILES: readonly string[] = [
  'packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts',
  'packages/system/src/builtins/sqlite-storage/wal-checkpoint-worker.ts',
  'packages/system/src/builtins/sqlite-storage/sqlite-snapshot-worker.ts',
]

export type SqliteGuardRule = 'fs-on-sqlite-file' | 'sqlite-connection-outside-owner'

/** A named exemption: one file, one rule, and why that file may. */
export interface SqliteGuardAllowance {
  readonly file: string
  readonly rule: SqliteGuardRule
  readonly reason: string
}

/**
 * An entry is a claim that the file handles a SQLite file nobody has open —
 * say it in `reason`, and a reviewer can check it.
 */
export const SQLITE_GUARD_ALLOWLIST: readonly SqliteGuardAllowance[] = [
  {
    file: 'server/backend/src/sqlite-restore.ts',
    rule: 'fs-on-sqlite-file',
    reason:
      'the boot-time restore (D693): runs in the launcher before any runner starts, so no process has the database open; it deletes the stale -wal/-shm/-journal of the database being replaced and renames the owner snapshot over it',
  },
  {
    file: 'packages/system/src/builtins/sqlite-storage/records/records-probe.ts',
    rule: 'sqlite-connection-outside-owner',
    reason:
      'the index-served proof (D881, D447): opens a private `:memory:` database it builds itself to EXPLAIN the statements a record kind prepares; no file, no other process. Imported only by scripts/check-records-index-served.ts and its spec, never by a runner',
  },
]

export interface SqliteGuardViolation {
  readonly file: string
  readonly line: number
  readonly rule: SqliteGuardRule
  readonly excerpt: string
}

/**
 * Filesystem calls that take a descriptor or change the file. Called bare
 * (`openSync(`, destructured from `node:fs`) or on an `fs`-ish namespace
 * (`fs.`, `fsp.`, `promises.`, `fsPromises.`). A method on anything else —
 * `db.close()`, `stream.read()` — is not a filesystem call.
 */
const FS_CALL =
  /(?:(?<![\w$.])|\b(?:fs|fsp|promises|fsPromises)\.)(openSync|open|readSync|read|readvSync|closeSync|close|readFileSync|readFile|writeFileSync|writeFile|writeSync|write|appendFileSync|appendFile|createReadStream|createWriteStream|truncateSync|truncate|ftruncateSync|ftruncate|copyFileSync|copyFile|cpSync|cp|renameSync|rename|unlinkSync|unlink|rmSync|rm)\s*\(/g

/** An argument text that names a SQLite file. */
const SQLITE_FILE_ARG =
  /(?:-shm|-wal|\.db|\.sqlite3?)(?![\w.-])|\b\w*(?:db|wal|shm)(?:Path|File)\b/i

const VALUE_IMPORT =
  /(?:^|[\s;])import\s+(?!type\b)[^'"]*?from\s*['"](?:better-sqlite3|node:sqlite)['"]|(?<!\btypeof\s+)\bimport\s*\(\s*['"](?:better-sqlite3|node:sqlite)['"]\s*\)|\brequire\w*\s*\(\s*['"](?:better-sqlite3|node:sqlite)['"]\s*\)/g

/** The text between the `(` at `open` and its matching `)`, or to the end. */
function argumentsFrom(code: string, open: number): string {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const ch = code[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return code.slice(open + 1, i)
    }
  }
  return code.slice(open + 1)
}

function lineOf(code: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (code[i] === '\n') line++
  return line
}

function excerptAt(code: string, index: number): string {
  const start = code.lastIndexOf('\n', index) + 1
  const end = code.indexOf('\n', index)
  return code.slice(start, end === -1 ? undefined : end).trim()
}

function allowed(
  rel: string,
  rule: SqliteGuardRule,
  allowlist: readonly SqliteGuardAllowance[],
): boolean {
  return allowlist.some((a) => a.file === rel && a.rule === rule)
}

/** Every violation in one file's comment-stripped code. */
export function findSqliteFileViolations(
  code: string,
  rel: string,
  allowlist: readonly SqliteGuardAllowance[] = SQLITE_GUARD_ALLOWLIST,
): SqliteGuardViolation[] {
  const out: SqliteGuardViolation[] = []
  for (const m of code.matchAll(FS_CALL)) {
    const at = m.index ?? 0
    const args = argumentsFrom(code, at + m[0].length - 1)
    if (!SQLITE_FILE_ARG.test(args)) continue
    if (allowed(rel, 'fs-on-sqlite-file', allowlist)) continue
    out.push({
      file: rel,
      line: lineOf(code, at),
      rule: 'fs-on-sqlite-file',
      excerpt: excerptAt(code, at),
    })
  }
  if (
    !SQLITE_CONNECTION_FILES.includes(rel) &&
    !allowed(rel, 'sqlite-connection-outside-owner', allowlist)
  ) {
    for (const m of code.matchAll(VALUE_IMPORT)) {
      const at = m.index ?? 0
      out.push({
        file: rel,
        line: lineOf(code, at),
        rule: 'sqlite-connection-outside-owner',
        excerpt: excerptAt(code, at),
      })
    }
  }
  return out
}

function main(): void {
  const files = walkSources(ROOT, SCAN_ROOTS)
  const violations = files.flatMap((f) => findSqliteFileViolations(f.code, f.rel))
  if (violations.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `check-sqlite-files-not-opened-by-fs: OK — ${files.length} source files; no fs call on a SQLite file, no connection outside the owner`,
    )
    return
  }
  // eslint-disable-next-line no-console
  console.error('check-sqlite-files-not-opened-by-fs: FAILED\n')
  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.error(`  - ${v.file}:${v.line} [${v.rule}] ${v.excerpt}`)
  }
  // eslint-disable-next-line no-console
  console.error(
    [
      '',
      'A live SQLite file is reached only through its owner’s connection (D679):',
      '  fs-on-sqlite-file               closing ANY descriptor of the file drops every fcntl lock the',
      '                                  process holds on it — SQLite’s -shm DMS lock included. Use the',
      '                                  connection (a pragma), or `stat`, which takes no descriptor.',
      '  sqlite-connection-outside-owner a second connection from another process rebuilds the wal-index',
      '                                  of an owner that lost its lock. Only these open it:',
      ...SQLITE_CONNECTION_FILES.map((f) => `                                    ${f}`),
      '                                  Ask the owner through a capability instead.',
      '',
      'A file that handles a database nobody has open goes in SQLITE_GUARD_ALLOWLIST, with its reason.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
