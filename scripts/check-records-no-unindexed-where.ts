#!/usr/bin/env tsx
/**
 * A `where` on a record kind names a DECLARED index field - and nothing reaches
 * the `records` table around the engine (D881, D447).
 *
 * ## The failure this catches
 *
 * A JSON field filter that no expression index matches character for character
 * is silently a full scan; `share_view_tokens` was one, and nobody saw it until
 * the latency cliff. The engine refuses such a filter at RUN time
 * (`records/unindexed-filter`); this is the same rule at REVIEW time, so the
 * refusal is found in the diff rather than by a request in production.
 *
 * ## What it checks
 *
 *  1. **Where keys.** In every package that declares kinds, each key of a
 *     literal `where: { … }` passed to `.query / .count / .aggregate /
 *     .deleteWhere` must be a field of some index that package declares. The
 *     match is per package (a call is not traced back to its kind handle), so
 *     it can under-report, never over-report: the engine refuses the rest.
 *  2. **Literal indexes.** A kind's `indexes` must be an array literal of
 *     `{ name, fields: ['…'] }`, so rule 1 can read it.
 *  3. **No side door.** Outside the engine (`sqlite-storage/records/`), no source
 *     writes SQL against `records`, `_record_kinds` or `_record_sequences`. A
 *     second writer is how a statement ends up without `kind_id`.
 *
 * Usage: npx tsx scripts/check-records-no-unindexed-where.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { collectSourceFiles } from './lib/parse-storage.js'
import { scanKindSpecs, scanWhereUses } from './lib/parse-records.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const ENGINE_DIR = 'packages/system/src/builtins/sqlite-storage/records/'

/** SQL that touches the records engine's tables. */
const SIDE_DOOR =
  /\b(?:FROM|INTO|UPDATE|JOIN)\s+["`']?(?:records|_record_kinds|_record_sequences)\b/i

export interface Violation {
  readonly where: string
  readonly message: string
}

function isTestFile(file: string): boolean {
  return /(^|\/)(__tests__|test|tests)\//.test(file) || /\.(spec|test)\.[tj]sx?$/.test(file)
}

/** The package directory (`packages/<name>` or `server/<name>`) of a repo-relative file. */
function packageOf(file: string): string {
  const parts = file.split('/')
  return parts.slice(0, 2).join('/')
}

/** Pure: the violations of a set of `[repo-relative path, source]` files. */
export function findViolations(
  files: readonly (readonly [string, string])[],
): readonly Violation[] {
  const out: Violation[] = []
  const fieldsByPackage = new Map<string, Set<string>>()
  const hasKinds = new Set<string>()

  for (const [file, source] of files) {
    if (isTestFile(file)) continue
    for (const spec of scanKindSpecs(file, source)) {
      const pkg = packageOf(file)
      hasKinds.add(pkg)
      const set = fieldsByPackage.get(pkg) ?? new Set<string>()
      if (spec.indexFields === null) {
        out.push({
          where: `${file}:${spec.line}`,
          message: `kind "${spec.kind}": \`indexes\` must be an array literal of { name, fields: ['…'] } so the guards can read it`,
        })
      } else {
        for (const fields of spec.indexFields) for (const f of fields) set.add(f)
      }
      fieldsByPackage.set(pkg, set)
    }
  }

  for (const [file, source] of files) {
    if (isTestFile(file)) continue
    const pkg = packageOf(file)
    if (hasKinds.has(pkg)) {
      const allowed = fieldsByPackage.get(pkg) ?? new Set<string>()
      for (const use of scanWhereUses(file, source)) {
        for (const key of use.keys) {
          if (!allowed.has(key)) {
            out.push({
              where: `${file}:${use.line}`,
              message: `.${use.method}({ where: { ${key} } }): "${key}" is not a field of any index this package declares - an unindexed filter does not compile (declare an index on it)`,
            })
          }
        }
      }
    }
    if (!file.startsWith(ENGINE_DIR)) {
      source.split('\n').forEach((text, i) => {
        if (SIDE_DOOR.test(text) && !/^\s*(\*|\/\/)/.test(text)) {
          out.push({
            where: `${file}:${i + 1}`,
            message: 'SQL against the records tables outside the engine - go through ctx.records',
          })
        }
      })
    }
  }
  return out
}

function main(): void {
  const rels = collectSourceFiles(ROOT, ['packages', 'server']).map((abs) =>
    path.relative(ROOT, abs),
  )
  const files = rels
    .filter(
      (rel) => /\.(ts|tsx)$/.test(rel) && !rel.includes('/dist/') && !rel.includes('/assets/'),
    )
    .map((rel) => [rel, fs.readFileSync(path.join(ROOT, rel), 'utf-8')] as const)
  const violations = findViolations(files)
  if (violations.length > 0) {
    console.error(`\x1b[31m✘ ${violations.length} records query violation(s)\x1b[0m:`)
    for (const v of violations) console.error(`    ${v.where}  ${v.message}`)
    process.exit(1)
  }
  console.log(
    `  ✔ records: every literal where names an indexed field, no side door (${files.length} files)`,
  )
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')
) {
  main()
}
