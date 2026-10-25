#!/usr/bin/env tsx
/**
 * D850 P4 — numeric history has one mechanism (device-history).
 *
 * Refuses:
 *   - `LtsAggregator` in runtime packages (legacy 5m SQLite tiers)
 *   - collection names matching `*stats-5m*`
 *   - `declareCollection` with a `bucketStart` column outside the device-history builtin
 *
 * Run: npx tsx scripts/check-history-single-mechanism.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const SCAN_DIRS = [
  'packages/addon-post-analysis/src',
  'packages/addon-pipeline-orchestrator/src',
  'packages/system/src/builtins/native-metrics',
  'server/backend/src',
] as const

const ALLOW_BUCKET_START = 'packages/system/src/builtins/device-history/'

function walkTsFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return []
  const out: string[] = []
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue
      out.push(...walkTsFiles(rel))
      continue
    }
    if (
      ent.name.endsWith('.ts') &&
      !ent.name.endsWith('.spec.ts') &&
      !ent.name.endsWith('.test.ts')
    ) {
      out.push(rel)
    }
  }
  return out
}

function main(): void {
  const failures: string[] = []

  for (const dir of SCAN_DIRS) {
    for (const rel of walkTsFiles(dir)) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      if (text.includes('LtsAggregator')) {
        failures.push(`${rel}: references LtsAggregator`)
      }
      if (/stats-5m/i.test(text)) {
        failures.push(`${rel}: references stats-5m collection name`)
      }
      if (!rel.startsWith(ALLOW_BUCKET_START) && /name:\s*['"]bucketStart['"]/.test(text)) {
        failures.push(`${rel}: declares a bucketStart column outside device-history`)
      }
    }
  }

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('\n\x1b[31m✘ history single-mechanism guard failed\x1b[0m')
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.error(`    - ${f}`)
    }
    // eslint-disable-next-line no-console
    console.error('')
    process.exit(1)
  }

  // eslint-disable-next-line no-console
  console.log('✔ history single-mechanism: no LtsAggregator / stats-5m / stray bucketStart')
}

main()
