#!/usr/bin/env tsx
/**
 * GUARD: a migration reaches the world only through `MigrationApiV1` (planning#447).
 *
 * The API is the one surface that never changes under an old migration, so a migration that
 * reads `ctx`, imports a server module, or binds its own ports with `defineAddonMigrations(`
 * would break after a version-jump upgrade. Rules: see `scripts/lib/migration-ports-surface.ts`.
 *
 * `scripts/migration-ports-surface-pending.json` names the catalogues still bound the old way.
 * It only shrinks: a new entry is refused by review, a converted one must be deleted.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { portsSurfaceProblems, type SourceFile } from './lib/migration-ports-surface.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const SKIP = new Set(['node_modules', 'dist', '.git', '__tests__', '__fixtures__'])

function sourcesUnder(dir: string, out: SourceFile[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourcesUnder(full, out)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push({
        path: path.relative(ROOT, full).split(path.sep).join('/'),
        text: fs.readFileSync(full, 'utf8'),
      })
    }
  }
}

function readPending(): readonly string[] {
  const raw: unknown = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'scripts/migration-ports-surface-pending.json'), 'utf8'),
  )
  if (!Array.isArray(raw)) throw new Error('migration-ports-surface-pending.json must be an array')
  return raw.filter((entry): entry is string => typeof entry === 'string')
}

function main(): number {
  const files: SourceFile[] = []
  for (const pkg of fs.readdirSync(path.join(ROOT, 'packages'))) {
    sourcesUnder(path.join(ROOT, 'packages', pkg, 'src'), files)
  }
  const problems = portsSurfaceProblems(files, readPending())
  if (problems.length === 0) {
    console.log('check-migration-ports-surface: every migration reaches the world through the API')
    return 0
  }
  console.error('check-migration-ports-surface: a migration bypasses MigrationApiV1')
  for (const problem of problems) console.error(`  ${problem}`)
  return 1
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  process.exit(main())
}
