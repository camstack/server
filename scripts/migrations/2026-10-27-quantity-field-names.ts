#!/usr/bin/env tsx
/**
 * OFFLINE migration for planning issue #260: device value fields are named after
 * their quantity, not their unit (`power-meter.watts` -> `power`, ...). It
 * rewrites every stored `(cap, field)` reference in the hub's SQLite files.
 *
 * Run it BY HAND with the hub STOPPED. There is no boot migration.
 *
 *   npx tsx scripts/migrations/2026-10-27-quantity-field-names.ts --data-dir /data
 *   npx tsx scripts/migrations/2026-10-27-quantity-field-names.ts --data-dir /data --apply --backup-dir /backups/q
 *
 * Arguments:
 *   --data-dir <dir>      the hub data dir (files under addons-data/sqlite-settings/)
 *   --settings-db <file>  the settings file (camstack.db), instead of --data-dir
 *   --history-db <file>   the history file (history.db), instead of --data-dir
 *   --dry-run             print the per-store table and write nothing (the default)
 *   --apply               back up, rewrite each file in one transaction, verify
 *   --backup-dir <dir>    where the backup goes (default: next to the files)
 *   --assume-stopped      you stopped the hub and this machine cannot list open files
 *   --min-idle-seconds N  refuse when a file changed within N seconds (default 30)
 *
 * Exit codes: 0 ok, 1 verification failed (backup left in place), 2 refused.
 * Runbook: docs/architecture/storage-files.md, "Offline migrations".
 */
import * as fs from 'node:fs'
import { parseArgs } from 'node:util'
import {
  EXIT_REFUSED,
  filesUnderDataDir,
  type Mode,
  runMigration,
} from './quantity-field-migration.ts'

const DEFAULT_MIN_IDLE_SECONDS = 30

function usage(message: string): never {
  process.stderr.write(
    `${message}\nsee the header of scripts/migrations/2026-10-27-quantity-field-names.ts\n`,
  )
  process.exit(EXIT_REFUSED)
}

function main(): number {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      'settings-db': { type: 'string' },
      'history-db': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      'backup-dir': { type: 'string' },
      'assume-stopped': { type: 'boolean', default: false },
      'min-idle-seconds': { type: 'string' },
    },
    strict: true,
  })
  if (values['apply'] && values['dry-run']) usage('--apply and --dry-run exclude each other')
  const mode: Mode = values['apply'] ? 'apply' : 'dry-run'
  const dataDir = values['data-dir']
  const underDir = dataDir === undefined ? null : filesUnderDataDir(dataDir)
  const ifPresent = (file: string | undefined): string | null =>
    file !== undefined && fs.existsSync(file) ? file : null
  const idle = values['min-idle-seconds']
  const minIdleSeconds = idle === undefined ? DEFAULT_MIN_IDLE_SECONDS : Number.parseInt(idle, 10)
  if (!Number.isInteger(minIdleSeconds) || minIdleSeconds < 0)
    usage('--min-idle-seconds must be a number of seconds')
  const result = runMigration({
    mode,
    settingsDb: values['settings-db'] ?? ifPresent(underDir?.settingsDb),
    historyDb: values['history-db'] ?? ifPresent(underDir?.historyDb),
    backupDir: values['backup-dir'] ?? null,
    assumeStopped: values['assume-stopped'],
    minIdleSeconds,
    out: (line) => void process.stdout.write(`${line}\n`),
  })
  return result.exitCode
}

process.exitCode = main()
