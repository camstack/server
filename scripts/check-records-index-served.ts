#!/usr/bin/env tsx
/**
 * Every operation a record kind promises is served by an index (D881, D447).
 *
 * ## The failure this catches
 *
 * D447: a scheduled aggregate that finds its range through an index and then
 * fetches the row behind every entry held the synchronous settings thread for
 * 4-7 s every five minutes, and every configuration read in the cluster queued
 * behind it. Records put JSON in a shared table, where that failure is one
 * mismatched expression away: SQLite uses an expression index only on an exact
 * textual match, and `EXPLAIN QUERY PLAN` prints `USING INDEX` even when the
 * table row is still read behind the index entry.
 *
 * ## What it checks
 *
 * Every kind declared in the repo (a `defineRecordKinds(...)` /
 * `defineEntryKind(...)` call in a non-test file, loaded the way an addon loads
 * it) is declared on an in-memory engine and every operation its declaration
 * promises is run with a spy on `prepare`: by device and time, by id, by each
 * declared index at each prefix, the counts, the histogram, the aggregates over
 * indexed fields, the bounded deletes. Each statement the engine REALLY
 * prepared is then judged (`records-probe.ts`): no table scan, no sort, `kind_id`
 * a literal, and a count or aggregate that never reads the table row - checked
 * on the opcodes, not on the plan text.
 *
 * The probe itself is armed by its spec (`records-probe.spec.ts`), which plants
 * a scanning, a sorting and a row-reading statement and watches each fail.
 *
 * Usage: npx tsx scripts/check-records-index-served.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DefinedRecordKind } from '../packages/types/src/records/record-kind.js'
import { probeKind } from '../packages/system/src/builtins/sqlite-storage/records/records-probe.js'
import { collectSourceFiles } from './lib/parse-storage.js'
import { scanKindSpecs } from './lib/parse-records.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

function isDefinedKind(value: unknown): value is DefinedRecordKind {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'name') === 'string' &&
    typeof Reflect.get(value, 'declaration') === 'object' &&
    Reflect.get(value, 'schema') !== undefined
  )
}

/** The kinds an imported module exports: directly, or as a map of them. */
export function kindsOfModule(
  exported: Readonly<Record<string, unknown>>,
): readonly DefinedRecordKind[] {
  const out: DefinedRecordKind[] = []
  for (const value of Object.values(exported)) {
    if (isDefinedKind(value)) {
      out.push(value)
    } else if (typeof value === 'object' && value !== null) {
      for (const inner of Object.values(value)) if (isDefinedKind(inner)) out.push(inner)
    }
  }
  return out
}

async function main(): Promise<void> {
  const files = collectSourceFiles(ROOT, ['packages', 'server'])
    .map((abs) => path.relative(ROOT, abs))
    .filter(
      (rel) =>
        rel.endsWith('.ts') &&
        !/(^|\/)(__tests__|dist|assets)\//.test(rel) &&
        !/\.(spec|test)\.ts$/.test(rel),
    )
    .filter((rel) => scanKindSpecs(rel, fs.readFileSync(path.join(ROOT, rel), 'utf-8')).length > 0)

  const problems: string[] = []
  let kinds = 0
  for (const rel of files) {
    const loaded = (await import(pathToFileURL(path.join(ROOT, rel)).href)) as Record<
      string,
      unknown
    >
    for (const kind of kindsOfModule(loaded)) {
      kinds += 1
      for (const p of await probeKind(kind)) {
        problems.push(`${rel}  kind "${p.kind}"  ${p.op}: ${p.problem}`)
      }
    }
  }
  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} records plan violation(s)\x1b[0m:`)
    for (const p of problems) console.error(`    ${p}`)
    process.exit(1)
  }
  console.log(
    `  ✔ records: ${kinds} declared kind(s) in ${files.length} file(s), every promised statement is served by an index`,
  )
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')
) {
  void main()
}
