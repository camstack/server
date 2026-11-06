#!/usr/bin/env tsx
/**
 * A record kind has ONE store (planning#440 step 5, D1013).
 *
 * Once a family of configured things lives in `ctx.records` (a record kind), the old storage it came
 * from must not stay alive beside it: two stores for one thing drift, and the old one is the one that
 * a half-finished migration keeps reading. Three rules, over non-test source:
 *
 * 1. `declareCollection`: a file that registers a record kind (`records.kind(`, `defineRecordKinds(`,
 *    `defineEntryKind(`) does not also declare a collection (`declareCollection(`) or read one
 *    (`store.query({ collection`). That is the parallel settings-store path.
 * 2. `replaceAll-config`: `replaceAll(this.config.` / `replaceAll(this.parseConfig` seeds a store from
 *    the addon's settings on every boot, so the settings win over what the operator edited.
 * 3. `legacy-identifier`: an identifier that names the old storage (`*_LEGACY`, `*_LEGACY_COLLECTION`,
 *    `LEGACY_*COLLECTION`, `Legacy*Schema`) or a `*_COLLECTION` constant whose doc comment calls it a legacy / settings-store
 *    collection. A `migrations/` directory may name the old shape; nothing else may.
 *
 * Every site that exists today is in `scripts/no-settings-fallback-baseline.json`, in the family whose
 * packet deletes it, with its reason. The baseline only shrinks; a listed site that is gone is an
 * error too. Key: `<repo path>:<rule>` (`:<identifier>` for rule 3).
 *
 * Textual: the source is read, not run. Specs, `__tests__`, `dist` and generated code are skipped.
 *
 * Usage: npx tsx scripts/check-no-settings-fallback-for-kinds.ts
 */
import path from 'node:path'
import {
  compareToBaseline,
  type FamilyBaseline,
  type Finding,
  isMain,
  isProductSource,
  loadBaseline,
  ROOT,
  readSources,
  report,
  type SourceFile,
  type Violation,
  walk,
} from './lib/family-baseline.js'

export const BASELINE_PATH = 'scripts/no-settings-fallback-baseline.json'

const KIND_REGISTRATION_RE = /\brecords\.kind\(|\bdefineRecordKinds\(|\bdefineEntryKind\(/
const DECLARE_COLLECTION_RE = /\bdeclareCollection\(|\bstore\.query\(\s*\{\s*collection\b/
const REPLACE_ALL_CONFIG_RE = /replaceAll\(\s*this\.(?:config\.|parseConfig)/
const LEGACY_IDENTIFIER_RE =
  /\b[A-Z0-9_]+_LEGACY(?:_COLLECTIONS?)?\b|\bLEGACY_\w*COLLECTION\w*\b|\bLegacy\w+Schema\b/g
const LEGACY_COLLECTION_DOC_RE = /\b(?:legacy|settings-store)\s+collections?\b/i
const COLLECTION_CONST_RE = /^export const (\w*COLLECTION\w*)\s*=/
/** The automation recipe reader: a different domain with a legacy shape of its own (not an instance family). */
const OTHER_DOMAIN_IDENTIFIER_RE =
  /^Legacy(?:Automation|Condition|Trigger|Step|Stationary|Expression)/

function isMigration(file: string): boolean {
  return file.includes('/migrations/')
}

/** The comment lines directly above a declaration (a run of collection constants shares one; stops at the first line that is not a comment). */
function docCommentAbove(lines: readonly string[], index: number): string {
  const doc: string[] = []
  let start = index - 1
  // One doc comment covers a run of collection constants under it.
  while (start >= 0 && COLLECTION_CONST_RE.test(lines[start] ?? '')) start--
  for (let i = start; i >= 0 && start - i <= 6; i--) {
    const line = (lines[i] ?? '').trim()
    if (!/^(?:\/\*|\*|\/\/)/.test(line)) break
    doc.push(line)
  }
  return doc.join('\n')
}

/** The legacy-storage identifiers one file names, de-duplicated, in order. */
export function legacyIdentifiersOf(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(LEGACY_IDENTIFIER_RE)) {
    if (!OTHER_DOMAIN_IDENTIFIER_RE.test(m[0])) found.add(m[0])
  }
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const m = COLLECTION_CONST_RE.exec(line)
    if (m?.[1] === undefined) return
    if (LEGACY_COLLECTION_DOC_RE.test(docCommentAbove(lines, index))) found.add(m[1])
  })
  return [...found]
}

export function findViolations(
  sources: readonly SourceFile[],
  baseline: FamilyBaseline,
): Violation[] {
  const findings: Finding[] = []
  for (const source of sources) {
    if (isMigration(source.path)) continue
    if (KIND_REGISTRATION_RE.test(source.text) && DECLARE_COLLECTION_RE.test(source.text)) {
      findings.push({
        key: `${source.path}:declareCollection`,
        where: source.path,
        message:
          'registers a record kind AND declares / reads a settings-store collection: one store per kind. Delete the collection path (the migration reads the old rows once, under **/migrations/**)',
      })
    }
    if (REPLACE_ALL_CONFIG_RE.test(source.text)) {
      findings.push({
        key: `${source.path}:replaceAll-config`,
        where: source.path,
        message:
          'seeds a store from this.config on boot (replaceAll(this.config...)): the settings then overwrite what the operator edited. Move the rows once, in a migration',
      })
    }
    for (const identifier of legacyIdentifiersOf(source.text)) {
      findings.push({
        key: `${source.path}:${identifier}`,
        where: source.path,
        message: `${identifier} names the old storage of a kind that moved to records: delete it, and read the old shape only from a migration (**/migrations/**)`,
      })
    }
  }
  return compareToBaseline(findings, baseline, BASELINE_PATH)
}

function main(): number {
  const files = [
    ...walk(path.join(ROOT, 'packages'), isProductSource),
    ...walk(path.join(ROOT, 'server'), isProductSource),
  ]
  const violations = findViolations(readSources(files), loadBaseline(BASELINE_PATH))
  return report('check-no-settings-fallback-for-kinds', violations)
}

if (isMain(import.meta.url)) process.exit(main())
