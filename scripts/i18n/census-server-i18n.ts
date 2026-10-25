/**
 * Census of the server-side translation migration (D863): how many settings-schema
 * texts and user-facing error literals are still English-only, per package.
 *
 *   npx tsx scripts/i18n/census-server-i18n.ts            # per package + totals
 *   npx tsx scripts/i18n/census-server-i18n.ts --json     # machine readable
 *   npx tsx scripts/i18n/census-server-i18n.ts --strict   # exit 1 while anything is untranslated
 *
 * Schema texts: every `title` / `label` / `description` literal the label codemod
 * (`add-label-keys.ts`) recognises, in files that declare settings schemas. A text
 * is "translated" when its object already carries the matching `*Key`.
 * Error literals: `new Error('...')` and `new TRPCError({ ..., message: '...' })`
 * with a literal message. "Translated" = built by `userError(` / `trpcUserError(`.
 * Counts are by regex and approximate on purpose: the point is a trend that the
 * bulk migration drives to zero, addon by addon.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { addLabelKeys } from './add-label-keys.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '__tests__',
  'generated',
  '.git',
  'coverage',
])
const SCHEMA_FILE = /ConfigUISchema|ConfigSection|ConfigField|fields:\s*\[/
const KEY_ATTR = /\b(?:labelKey|descriptionKey|titleKey):\s*'/g
const RAW_ERROR = /new Error\(\s*(?:'[^']|`[^`$]*`)/g
const RAW_TRPC = /new TRPCError\(\{[^}]*message:\s*(?:'[^']|`[^`$]*`)/g
const CODED_ERROR = /\b(?:userError|trpcUserError)\(/g

export interface PackageCensus {
  readonly pkg: string
  schemaTranslated: number
  schemaUntranslated: number
  errorsTranslated: number
  errorsUntranslated: number
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(path.join(dir, entry.name))
    } else if (entry.name.endsWith('.ts') && !/\.(spec|test|d)\.ts$/.test(entry.name)) {
      yield path.join(dir, entry.name)
    }
  }
}

function count(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length
}

export function censusFile(file: string, text: string, row: PackageCensus): void {
  if (SCHEMA_FILE.test(text)) {
    row.schemaTranslated += count(KEY_ATTR, text)
    row.schemaUntranslated += Object.keys(addLabelKeys(file, text, 'x').added).length
  }
  row.errorsTranslated += count(CODED_ERROR, text)
  row.errorsUntranslated += count(RAW_ERROR, text) + count(RAW_TRPC, text)
}

export function runCensus(): readonly PackageCensus[] {
  const roots = [
    ...fs
      .readdirSync(path.join(ROOT, 'packages'))
      .map((p) => ({ pkg: `packages/${p}`, dir: path.join(ROOT, 'packages', p, 'src') })),
    { pkg: 'server/backend', dir: path.join(ROOT, 'server/backend/src') },
  ].filter((r) => fs.existsSync(r.dir))
  const rows: PackageCensus[] = []
  for (const { pkg, dir } of roots) {
    const row: PackageCensus = {
      pkg,
      schemaTranslated: 0,
      schemaUntranslated: 0,
      errorsTranslated: 0,
      errorsUntranslated: 0,
    }
    for (const file of sourceFiles(dir)) censusFile(file, fs.readFileSync(file, 'utf8'), row)
    if (
      row.schemaTranslated +
        row.schemaUntranslated +
        row.errorsTranslated +
        row.errorsUntranslated >
      0
    ) {
      rows.push(row)
    }
  }
  return rows.sort(
    (a, b) =>
      b.schemaUntranslated + b.errorsUntranslated - (a.schemaUntranslated + a.errorsUntranslated),
  )
}

function main(): void {
  const rows = runCensus()
  const sum = (pick: (r: PackageCensus) => number): number => rows.reduce((n, r) => n + pick(r), 0)
  const totals = {
    schemaTranslated: sum((r) => r.schemaTranslated),
    schemaUntranslated: sum((r) => r.schemaUntranslated),
    errorsTranslated: sum((r) => r.errorsTranslated),
    errorsUntranslated: sum((r) => r.errorsUntranslated),
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ rows, totals }, null, 2))
  } else {
    console.log('package                                  schema(tr/untr)   errors(tr/untr)')
    for (const r of rows) {
      console.log(
        `${r.pkg.padEnd(40)} ${`${r.schemaTranslated}/${r.schemaUntranslated}`.padEnd(17)} ${r.errorsTranslated}/${r.errorsUntranslated}`,
      )
    }
    console.log(
      `TOTAL ${' '.repeat(34)} ${`${totals.schemaTranslated}/${totals.schemaUntranslated}`.padEnd(17)} ${totals.errorsTranslated}/${totals.errorsUntranslated}`,
    )
  }
  if (
    process.argv.includes('--strict') &&
    totals.schemaUntranslated + totals.errorsUntranslated > 0
  ) {
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
