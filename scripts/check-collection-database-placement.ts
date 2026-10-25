#!/usr/bin/env tsx
/**
 * D851 / LTS P5 — `declareCollection.database` must agree with `@durable database=`,
 * and operator `config` tables must stay on `settings`.
 *
 * Usage: npx tsx scripts/check-collection-database-placement.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  buildDurableCatalogue,
  collectSourceFiles,
  parseDeclarations,
  type DeclaredCollection,
} from './lib/parse-storage.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/** §7 collections that must declare `database: 'events'` when declared. */
const MUST_EVENTS = new Set<string>([
  'pipeline-analytics:tracks',
  'pipeline-analytics:track-aliases',
  'pipeline-analytics:track-purity',
  'pipeline-analytics:track-relations',
  'pipeline-analytics:tracking-tapes',
  'pipeline-analytics:object-events',
  'pipeline-analytics:motion-events',
  'pipeline-analytics:audio-events',
  'pipeline-analytics:sensor-events',
  'pipeline-analytics:media',
  'pipeline-analytics:faces',
  'pipeline-analytics:plates',
  'pipeline-analytics:vehicle-samples',
  'pipeline-analytics:identity-samples',
  'pipeline-analytics:birth-decision-ledger',
  'pipeline-analytics:debug-note-archive',
  'pipeline-analytics:ops-log',
  'pipeline-analytics:retrain-frames',
  'pipeline-analytics:retrain-annotations',
  'pipeline-analytics:retrain-collections',
  'pipeline-analytics:retrain-collection-frames',
  'pipeline-analytics:sweep-cursors',
  'pipeline-analytics:migrations',
  'notification-center:outbox',
  'notification-center:artifacts',
  'notification-center:track-groups',
  'notification-center:snooze-suppressed',
])

interface Violation {
  readonly message: string
}

function databaseOf(decl: DeclaredCollection): string {
  return decl.database ?? 'settings'
}

function main(): void {
  const durable = buildDurableCatalogue(ROOT)
  const violations: Violation[] = []

  for (const file of collectSourceFiles(ROOT, ['packages', 'server'])) {
    const source = fs.readFileSync(file, 'utf-8')
    if (!source.includes('declareCollection')) continue
    const rel = path.relative(ROOT, file)
    for (const decl of parseDeclarations(source, rel)) {
      if (!decl.resolved) continue
      const db = databaseOf(decl)
      const ann = durable.get(decl.name)

      if (MUST_EVENTS.has(decl.name) && db !== 'events') {
        violations.push({
          message: `${rel}: "${decl.name}" must declare database: 'events' (LTS §7)`,
        })
      }

      if (ann !== undefined) {
        if (ann.database !== db) {
          violations.push({
            message: `${rel}: "${decl.name}" declares database "${db}" but @durable database=${ann.database} in ${ann.file}`,
          })
        }
        if (ann.semanticClass === 'config' && db !== 'settings') {
          violations.push({
            message: `${rel}: "${decl.name}" is class=config in @durable but declares database "${db}" (config stays on settings)`,
          })
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(`check-collection-database-placement: ${violations.length} violation(s)\n`)
    for (const v of violations) console.error(`  ${v.message}`)
    process.exit(1)
  }
  console.log('check-collection-database-placement: ok')
}

main()
