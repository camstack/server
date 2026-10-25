#!/usr/bin/env tsx
/**
 * Retention-settings guard — **an operator-visible retention value has exactly
 * one consumer, and a retired one does not come back.**
 *
 * ## The failure this catches
 *
 * D61 collapsed retention into one age sweep over tracks. It did not touch the
 * settings form, so four per-family day windows kept rendering, kept saving,
 * and stopped deciding anything: object events, faces, plates, crops and CLIP
 * vectors had become track-owned and left through the cascade. An operator
 * could set object retention to 30 days, watch the form accept it, and lose the
 * events at 7. D62 deleted them and made the surviving surface two keys.
 *
 * This is the third knob-decoupled-from-its-reader defect found in this repo in
 * one day — `zoneMembershipMinOverlap` and `rescueCentroidFactor` both wrote a
 * store nobody read. The pattern is always the same: the READER moves or dies,
 * the WRITER and the form stay, and nothing connects them, so the drift is
 * invisible to review and to the test suite alike. A settings test that reads
 * back what it wrote passes perfectly the whole time.
 *
 * ## What it checks
 *
 * 1. **The form is the declaration.** Every `key` in the `retention` section of
 *    `settings-schema.ts` must appear in `RETENTION_SETTING_KEYS`, and every
 *    key in that list must appear in the form. Neither can grow alone.
 * 2. **The declaration is consumed.** Every key in `RETENTION_SETTING_KEYS`
 *    must appear inside the body of `resolveRetentionCutoffs` — the one
 *    function that turns settings into the instant rows are deleted before. A
 *    key that reaches the store but not that body decides nothing.
 * 3. **Every cutoff it produces is applied.** Every field of
 *    `DeviceRetentionCutoffs` must be read outside `retention-policy.ts`. A
 *    resolver that computes a cutoff no sweep passes to a store is the same
 *    defect one layer down.
 * 4. **Retired names stay retired.** The keys in `RETIRED_DEVICE_SETTING_KEYS`
 *    may not appear in analytics source outside the file that declares them.
 *    Re-adding `retentionObjectDays` "because the form should expose it" is
 *    exactly how this returns.
 *
 * ## The false-positive argument
 *
 * Every check compares two DECLARATIONS that already exist in the source — a
 * form key list, an exported const array, an interface's fields — and asks
 * whether a name appears in a named function body. There is no heuristic and no
 * judgement about intent, so there is nothing for it to be wrong about: if the
 * two lists agree, it is silent. It is scoped to four files plus one directory
 * tree, skips tests, and comment text is stripped before check 4 scans, so
 * documenting what was removed (which every file that lost a field here does)
 * cannot trip it. The comment stripper is deliberately naive in the direction
 * of stripping too much: over-stripping makes the guard quieter, which is the
 * correct bias for something that must never be wrong.
 *
 * ## What it CANNOT catch — stated plainly
 *
 * **It is a surface-size guard, not a semantic one.** It proves a setting
 * reaches the cutoff resolver and that the cutoff reaches a sweep. It cannot
 * prove the cutoff a key produces is applied to the entity the key is NAMED
 * after. D61's own hole would have survived it: `retentionObjectDays` did reach
 * `resolveRetentionCutoffs`, and the `objectCutoffMs` it produced WAS read by
 * the sweep — it had simply been quietly repurposed to sweep sensor events
 * while object events had moved to the cascade. Every check here would have
 * been green.
 *
 * That gap is behavioural and only a behavioural test closes it:
 * `retention/__tests__/one-window-governs.spec.ts` changes one operator value
 * at a time and asserts the set of DELETED rows moves, and
 * `__tests__/retired-retention-settings-wiring.spec.ts` asserts the migration
 * fires from the real addon. The guard stops a knob from being ADDED without a
 * reader; the tests stop a reader from reading the wrong thing.
 *
 * It also sees only this addon's per-device settings. A retention value stored
 * by another addon, or read across the settings-store cap from a different
 * process, is invisible to it — as is a form field built dynamically rather
 * than written as a literal.
 *
 * Usage: tsx scripts/check-retention-settings-consumed.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const ANALYTICS_ROOT = 'packages/addon-post-analysis/src/pipeline-analytics'
const POLICY_FILE = `${ANALYTICS_ROOT}/retention-policy.ts`
const FORM_FILE = `${ANALYTICS_ROOT}/settings-schema.ts`
const RETIRED_FILE = `${ANALYTICS_ROOT}/retention/retired-device-settings.ts`

/** The settings-form section whose fields are retention policy. */
const RETENTION_SECTION_ID = 'retention'

interface Problem {
  readonly where: string
  readonly what: string
  readonly fix: string
}

const read = (relative: string): string | null => {
  const full = path.join(ROOT, relative)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : null
}

const isTest = (relative: string): boolean =>
  relative.includes('__tests__/') || relative.endsWith('.spec.ts') || relative.endsWith('.test.ts')

/**
 * Remove block and line comments. Naive on purpose: a `//` inside a string
 * literal costs us the rest of that line, which can only make the guard see
 * LESS and therefore report less. Under-reporting is the correct failure mode.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/** Slice from `openIndex` (which must sit on `{`) to its matching brace. */
function braceSlice(source: string, openIndex: number): string | null {
  if (source[openIndex] !== '{') return null
  let depth = 0
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openIndex, i + 1)
    }
  }
  return null
}

/** The source of the object literal that declares `id: '<sectionId>'`. */
function sectionSource(source: string, sectionId: string): string | null {
  const marker = source.indexOf(`id: '${sectionId}',`)
  if (marker === -1) return null
  // Walk back to the `{` that opens this object literal.
  for (let i = marker; i >= 0; i--) {
    if (source[i] === '{') return braceSlice(source, i)
  }
  return null
}

/** The body of a named top-level function. */
function functionBody(source: string, name: string): string | null {
  const marker = source.indexOf(`export function ${name}(`)
  if (marker === -1) return null
  const open = source.indexOf('{', source.indexOf(')', marker))
  return open === -1 ? null : braceSlice(source, open)
}

/** Quoted strings inside `export const <name>: ... = [ ... ]`. */
function constStringArray(source: string, name: string): readonly string[] {
  const marker = source.indexOf(`export const ${name}`)
  if (marker === -1) return []
  // Skip past the type annotation — `readonly (keyof X)[]` contains a `[` of
  // its own, so the array literal is the first `[` AFTER the `=`.
  const assign = source.indexOf('=', marker)
  if (assign === -1) return []
  const open = source.indexOf('[', assign)
  if (open === -1) return []
  const close = source.indexOf(']', open)
  if (close === -1) return []
  return [...source.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '')
}

/** `readonly <name>:` fields of a named interface. */
function interfaceFields(source: string, name: string): readonly string[] {
  const marker = source.indexOf(`export interface ${name} {`)
  if (marker === -1) return []
  const body = braceSlice(source, source.indexOf('{', marker))
  if (body === null) return []
  return [...body.matchAll(/readonly\s+([A-Za-z_$][\w$]*)\s*[?]?\s*:/g)].map((m) => m[1] ?? '')
}

function analyticsSources(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      analyticsSources(full, out)
      continue
    }
    if (entry.name.endsWith('.ts')) out.push(full)
  }
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

// ── Check 1 + 2: the form, the declaration and the resolver agree ────────

function checkSurfaceIsDeclaredAndConsumed(problems: Problem[]): void {
  const policy = read(POLICY_FILE)
  const form = read(FORM_FILE)
  if (policy === null || form === null) {
    problems.push({
      where: policy === null ? POLICY_FILE : FORM_FILE,
      what: 'is missing — this guard cannot check a surface it cannot find',
      fix: 'restore the file, or retire this guard deliberately rather than by deletion',
    })
    return
  }

  const declared = constStringArray(policy, 'RETENTION_SETTING_KEYS')
  if (declared.length === 0) {
    problems.push({
      where: POLICY_FILE,
      what: 'declares no RETENTION_SETTING_KEYS',
      fix: 'the operator-visible retention surface must be enumerated in one place, or nothing can check that each key has a reader.',
    })
    return
  }

  const section = sectionSource(form, RETENTION_SECTION_ID)
  if (section === null) {
    problems.push({
      where: FORM_FILE,
      what: `has no \`${RETENTION_SECTION_ID}\` settings section`,
      fix: 'the section id is how this guard finds the operator-visible retention fields. Renaming it silently disables check 1 — update the guard in the same commit.',
    })
    return
  }
  const formKeys = [...section.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1] ?? '')

  for (const key of formKeys) {
    if (declared.includes(key)) continue
    problems.push({
      where: `${FORM_FILE} → section '${RETENTION_SECTION_ID}' → ${key}`,
      what: 'is offered to the operator but is not in RETENTION_SETTING_KEYS',
      fix: `add it to RETENTION_SETTING_KEYS in ${POLICY_FILE} and read it in resolveRetentionCutoffs — or do not render it. A field the form saves and the sweep never reads is a decision the operator did not actually make.`,
    })
  }

  for (const key of declared) {
    if (formKeys.includes(key)) continue
    problems.push({
      where: `${POLICY_FILE} → RETENTION_SETTING_KEYS → ${key}`,
      what: 'is declared as operator-visible but the retention form does not render it',
      fix: `add the field to the '${RETENTION_SECTION_ID}' section of ${FORM_FILE}, or drop it from RETENTION_SETTING_KEYS.`,
    })
  }

  const resolver = functionBody(policy, 'resolveRetentionCutoffs')
  if (resolver === null) {
    problems.push({
      where: POLICY_FILE,
      what: 'has no exported resolveRetentionCutoffs — the one function that turns settings into a cutoff',
      fix: 'if it was renamed, rename it here too in the same commit; this check is what proves each setting reaches the arithmetic that decides what is deleted.',
    })
    return
  }
  for (const key of declared) {
    if (resolver.includes(key)) continue
    problems.push({
      where: `${POLICY_FILE} → ${key}`,
      what: 'never appears in resolveRetentionCutoffs — it cannot affect what is deleted',
      fix: 'read it there, or delete the setting. This is the exact state retentionObjectDays was left in by D61: stored, rendered, and inert.',
    })
  }
}

// ── Check 3: every cutoff the resolver produces is applied ───────────────

function checkEveryCutoffIsApplied(problems: Problem[], sources: readonly string[]): void {
  const policy = read(POLICY_FILE)
  if (policy === null) return
  const fields = interfaceFields(policy, 'DeviceRetentionCutoffs')
  if (fields.length === 0) return

  const consumers = sources.filter((f) => rel(f) !== POLICY_FILE && !isTest(rel(f)))
  const haystack = consumers.map((f) => fs.readFileSync(f, 'utf-8')).join('\n')
  for (const field of fields) {
    if (haystack.includes(field)) continue
    problems.push({
      where: `${POLICY_FILE} → DeviceRetentionCutoffs.${field}`,
      what: 'is computed but never read by any sweep',
      fix: 'a cutoff nobody passes to a store deletes nothing. Apply it, or remove the field — a resolver that answers a question no one asks reads as coverage that is not there.',
    })
  }
}

// ── Check 4: retired names stay retired ──────────────────────────────────

function checkRetiredNamesStayRetired(problems: Problem[], sources: readonly string[]): void {
  const retiredSource = read(RETIRED_FILE)
  if (retiredSource === null) {
    problems.push({
      where: RETIRED_FILE,
      what: 'is missing — the retired-settings declaration is also the migration operators are told about',
      fix: 'restore it, or retire this guard deliberately rather than by deletion',
    })
    return
  }
  const retired = [...retiredSource.matchAll(/^\s{4}key:\s*'([^']+)',$/gm)].map((m) => m[1] ?? '')
  if (retired.length === 0) return

  for (const file of sources) {
    const relative = rel(file)
    if (relative === RETIRED_FILE || isTest(relative)) continue
    const code = stripComments(fs.readFileSync(file, 'utf-8'))
    for (const key of retired) {
      if (!code.includes(key)) continue
      problems.push({
        where: `${relative} → ${key}`,
        what: 'is a RETIRED retention setting and it is back in the source',
        fix: `it was removed because nothing consumed it (see ${RETIRED_FILE} for which sweep stopped reading it and why). If it genuinely needs to decide something again, delete it from RETIRED_DEVICE_SETTINGS in the same commit that gives it a reader — and write the migration back the other way.`,
      })
    }
  }
}

function main(): void {
  const files: string[] = []
  analyticsSources(path.join(ROOT, ANALYTICS_ROOT), files)

  const problems: Problem[] = []
  checkSurfaceIsDeclaredAndConsumed(problems)
  checkEveryCutoffIsApplied(problems, files)
  checkRetiredNamesStayRetired(problems, files)

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} retention-settings violation(s)\x1b[0m:`)
    for (const p of problems) {
      console.error(`    ${p.where}: ${p.what}`)
      console.error(`      → ${p.fix}`)
    }
    console.error(
      '    Why this matters: a knob that decides nothing is worse than a missing one — it reads as a decision that was made. Three of these were found in this repo in one day.',
    )
    process.exit(1)
  }
  console.log('  ✔ every operator-visible retention setting has exactly one reader')
}

main()
