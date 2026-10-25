/**
 * The guard that keeps a live SQLite file reachable only through its owner's
 * connection (D679). Each rule is proved red on the exact shape that caused
 * the 2026-09-12 → 2026-09-29 SIGBUS. The real tree is not walked here: the CI
 * repository-guards step runs the guard over it, and a 4 000-file walk under
 * vitest's 10 s timeout was flaky (D679 review H1).
 */
import { describe, expect, it } from 'vitest'
import {
  findSqliteFileViolations,
  SQLITE_CONNECTION_FILES,
  type SqliteGuardAllowance,
} from '../check-sqlite-files-not-opened-by-fs.js'
import { stripComments } from '../lib/walk-sources.js'

const OWNER_FILE = 'packages/system/src/builtins/sqlite-storage/wal-checkpoint-worker.ts'
const ELSEWHERE = 'packages/system/src/builtins/system-backup/system-backup.service.ts'
/** Same directory as the owner, but exported from `@camstack/system` and loaded by hub-main. */
const OWNER_DIR_NOT_OWNER = 'packages/system/src/builtins/sqlite-storage/config-store.ts'

const rules = (src: string, rel = OWNER_FILE, allowlist?: readonly SqliteGuardAllowance[]) =>
  findSqliteFileViolations(stripComments(src), rel, allowlist).map((v) => v.rule)

describe('rule fs-on-sqlite-file', () => {
  it('refuses the retired worker’s -shm read: open, read, CLOSE', () => {
    const src = [
      "import { closeSync, openSync, readSync } from 'node:fs'",
      'function readWalIndex(shmPath: string) {',
      "  const fd = openSync(shmPath, 'r')",
      '  readSync(fd, buf, 0, 100, 0)',
      '  closeSync(fd)',
      '}',
    ].join('\n')
    expect(rules(src)).toEqual(['fs-on-sqlite-file'])
  })

  it('refuses a literal sidecar or database name, wrapped over lines as prettier writes it', () => {
    expect(rules('fs.readFileSync(`${dbPath}-wal`)\n')).toEqual(['fs-on-sqlite-file'])
    expect(rules("await fsp.open(\n  path.join(dir, 'camstack.db'),\n  'r',\n)\n")).toEqual([
      'fs-on-sqlite-file',
    ])
    expect(rules("fs.rmSync(dbFile + '-shm', { force: true })\n")).toEqual(['fs-on-sqlite-file'])
  })

  it('matches the exact suffix: a .db.json or .dbx is not a database', () => {
    expect(rules("fs.readFileSync('settings.db.json')\nfs.writeFileSync('x.dbx', b)\n")).toEqual([])
    expect(rules("fs.readFileSync('camstack.sqlite3')\n")).toEqual(['fs-on-sqlite-file'])
  })

  it('a named allowlist entry exempts that file for that rule only', () => {
    const allow: readonly SqliteGuardAllowance[] = [
      { file: ELSEWHERE, rule: 'fs-on-sqlite-file', reason: 'restore: no runner has it open' },
    ]
    expect(rules('fs.rmSync(`${dbPath}-wal`)\n', ELSEWHERE, allow)).toEqual([])
    expect(rules('fs.rmSync(`${dbPath}-wal`)\n', OWNER_FILE, allow)).toEqual(['fs-on-sqlite-file'])
    expect(rules("import D from 'better-sqlite3'\n", ELSEWHERE, allow)).toEqual([
      'sqlite-connection-outside-owner',
    ])
  })

  it('allows a path lookup — stat and existsSync take no descriptor', () => {
    expect(rules('fs.statSync(`${dbPath}-wal`)\nfs.existsSync(dbPath)\n')).toEqual([])
  })

  it('a method on something that is not fs is not a filesystem call', () => {
    expect(rules('db.close()\nthis.backend.open(dbPath)\nstream.read()\n')).toEqual([])
  })

  it('a docblock describing the bug is not the bug', () => {
    expect(rules('/** the worker did closeSync(fd) on the -shm */\nconst x = 1\n')).toEqual([])
  })
})

describe('rule sqlite-connection-outside-owner', () => {
  it('refuses the backup’s second connection from hub-main', () => {
    const src = "Database = (await import('better-sqlite3')).default\nconst db = new Database(p)\n"
    expect(rules(src, ELSEWHERE)).toEqual(['sqlite-connection-outside-owner'])
    expect(rules("import Database from 'better-sqlite3'\n", ELSEWHERE)).toEqual([
      'sqlite-connection-outside-owner',
    ])
    expect(rules("const D = require('better-sqlite3')\n", ELSEWHERE)).toEqual([
      'sqlite-connection-outside-owner',
    ])
  })

  it('refuses the built-in node:sqlite driver the same way', () => {
    expect(rules("import { DatabaseSync } from 'node:sqlite'\n", ELSEWHERE)).toEqual([
      'sqlite-connection-outside-owner',
    ])
    expect(rules("const s = await import('node:sqlite')\n", ELSEWHERE)).toEqual([
      'sqlite-connection-outside-owner',
    ])
  })

  it('the owner DIRECTORY is not the owner: a sibling module hub-main loads is refused', () => {
    expect(rules("import Database from 'better-sqlite3'\n", OWNER_DIR_NOT_OWNER)).toEqual([
      'sqlite-connection-outside-owner',
    ])
  })

  it('covers the owned files of D851: events.db and history.db, and their new serving thread', () => {
    // The worker that serves them reaches the driver THROUGH the backend; it is
    // not a connection file, so a direct driver import there is refused.
    const FILE_HOST = 'packages/system/src/builtins/sqlite-storage/file-host-worker.ts'
    expect(rules("import Database from 'better-sqlite3'\n", FILE_HOST)).toEqual([
      'sqlite-connection-outside-owner',
    ])
    expect(rules("fs.openSync(path.join(dir, 'events.db'), 'r')\n", FILE_HOST)).toEqual([
      'fs-on-sqlite-file',
    ])
    expect(rules('fs.readFileSync(historyDbPath)\n', ELSEWHERE)).toEqual(['fs-on-sqlite-file'])
    expect(rules("fs.copyFileSync(src, 'history.db-wal')\n", ELSEWHERE)).toEqual([
      'fs-on-sqlite-file',
    ])
  })

  it('allows the connection files, and allows a type import anywhere', () => {
    for (const file of SQLITE_CONNECTION_FILES) {
      expect(rules("import Database from 'better-sqlite3'\n", file)).toEqual([])
    }
    expect(rules("import type Database from 'better-sqlite3'\n", ELSEWHERE)).toEqual([])
    expect(rules("let D: typeof import('better-sqlite3')\n", ELSEWHERE)).toEqual([])
  })
})
