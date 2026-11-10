#!/usr/bin/env tsx
/**
 * A record kind has ONE store (planning#440 step 5, D1013).
 *
 * Once a family of configured things lives in `ctx.records` (a record kind), the old storage it came
 * from must not stay alive beside it: two stores for one thing drift, and the old one is the one that
 * a half-finished migration keeps reading. Three rules, over non-test source:
 *
 * 1. `declareCollection`: a package that registers a record kind (`records.kind(`, `defineRecordKinds(`,
 *    `defineEntryKind(`) in ANY of its files does not also declare a collection (`declareCollection(`)
 *    or read one (`store.query({ collection`) in any non-migration file. That is the parallel
 *    settings-store path; the finding is keyed on the file holding the collection.
 * 1b. `legacy-served`: a package that registers a kind does not serve the old rows beside it
 *    (`legacyServed`, `withUnmigrated*`): until the migration lands the records are the only store.
 * 2. `replaceAll-config`: `replaceAll(this.config.` / `replaceAll(this.parseConfig` seeds a store from
 *    the addon's settings on every boot, so the settings win over what the operator edited.
 * 3. `legacy-identifier`: an identifier that names the old storage (`*_LEGACY`, `*_LEGACY_COLLECTION`,
 *    `LEGACY_*COLLECTION`, `Legacy*Schema`) or a `*_COLLECTION` constant whose doc comment calls it a legacy / settings-store
 *    collection. A `migrations/` directory may name the old shape; nothing else may.
 * 4. `credential-state`: a package that registers a kind does not keep a CREDENTIAL in durable state
 *    (`this.state('<key>'` whose `<key>` roots one of the file's `secretStatePaths`) outside a
 *    migration. An account's token belongs on its record (a secret field): the state blob is the
 *    second store the Google accounts kept beside their `brokers` records (planning#480). Key:
 *    `<path>:credential-state:<key>`.
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
const LEGACY_SERVED_RE = /\blegacyServed\b|\bwithUnmigrated\w*/
const REPLACE_ALL_CONFIG_RE = /replaceAll\(\s*this\.(?:config\.|parseConfig)/
const LEGACY_IDENTIFIER_RE =
  /\b[A-Z0-9_]+_LEGACY(?:_COLLECTIONS?)?\b|\bLEGACY_\w*COLLECTION\w*\b|\bLegacy\w+Schema\b/g
const LEGACY_COLLECTION_DOC_RE = /\b(?:legacy|settings-store)\s+collections?\b/i
const COLLECTION_CONST_RE = /^export const (\w*COLLECTION\w*)\s*=/
const SECRET_STATE_PATHS_RE = /secretStatePaths\s*=\s*\[([\s\S]*?)\]\s*$/m
const STRING_LITERAL_RE = /['"`]([^'"`]+)['"`]/g
const STATE_CALL_RE = /\bthis\.state\(\s*['"`]([\w-]+)['"`]/g
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

/** The roots (`a` of `a.b[id].c`) of the `secretStatePaths` a file declares inline. */
function secretStateRootsOf(text: string): Set<string> {
  const roots = new Set<string>()
  const list = SECRET_STATE_PATHS_RE.exec(text)?.[1]
  if (list === undefined) return roots
  // A comment inside the list (`// … the record's …`) is not a path, and its quotes would pair.
  const entries = list.replace(/\/\/[^\n]*/g, '')
  for (const m of entries.matchAll(STRING_LITERAL_RE)) {
    const root = m[1]?.split(/[.[]/)[0]
    if (root !== undefined && root.length > 0) roots.add(root)
  }
  return roots
}

/** The durable-state keys of one file that hold a declared secret, de-duplicated, in order. */
export function credentialStateKeysOf(text: string): string[] {
  const roots = secretStateRootsOf(text)
  const found = new Set<string>()
  for (const m of text.matchAll(STATE_CALL_RE)) {
    if (m[1] !== undefined && roots.has(m[1])) found.add(m[1])
  }
  return [...found]
}

/** `packages/<addon>` (or `server/<x>`) the file belongs to: the unit that owns one kind's store. */
function packageDirOf(file: string): string {
  const parts = file.split('/')
  return parts.slice(0, 2).join('/')
}

/** Only an addon package owns ONE kind's store; the kernel (`system`, `types`) holds many unrelated stores. */
function isAddonPackage(dir: string): boolean {
  return dir.startsWith('packages/addon-')
}

/** The package directories with at least one non-migration file that registers a record kind. */
function kindPackages(sources: readonly SourceFile[]): Set<string> {
  const dirs = new Set<string>()
  for (const source of sources) {
    if (
      !isMigration(source.path) &&
      isAddonPackage(packageDirOf(source.path)) &&
      KIND_REGISTRATION_RE.test(source.text)
    ) {
      dirs.add(packageDirOf(source.path))
    }
  }
  return dirs
}

export function findViolations(
  sources: readonly SourceFile[],
  baseline: FamilyBaseline,
): Violation[] {
  const findings: Finding[] = []
  const withKinds = kindPackages(sources)
  for (const source of sources) {
    if (isMigration(source.path)) continue
    const inKindPackage = withKinds.has(packageDirOf(source.path))
    if (inKindPackage && LEGACY_SERVED_RE.test(source.text)) {
      findings.push({
        key: `${source.path}:legacy-served`,
        where: source.path,
        message:
          'serves the old rows beside a record kind (legacyServed / withUnmigrated*): the records are the only store; the migration copies the old rows once (**/migrations/**)',
      })
    }
    const ownKind = KIND_REGISTRATION_RE.test(source.text)
    if (
      DECLARE_COLLECTION_RE.test(source.text) &&
      (inKindPackage || (ownKind && !isAddonPackage(packageDirOf(source.path))))
    ) {
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
    if (inKindPackage) {
      for (const key of credentialStateKeysOf(source.text)) {
        findings.push({
          key: `${source.path}:credential-state:${key}`,
          where: source.path,
          message: `keeps a credential in durable state ('${key}') beside a record kind: put it on the record as a secret field, and read the old state only from a migration (**/migrations/**)`,
        })
      }
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
