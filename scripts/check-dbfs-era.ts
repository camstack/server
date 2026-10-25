#!/usr/bin/env tsx
/**
 * Every absolute-dBFS constant states which amplitude era it was calibrated in
 * (D460).
 *
 * ## What this prevents
 *
 * D459 fixed a G.711 decoder that had, for months, reported levels 12.04 dB
 * (PCMU) / 18.06 dB (PCMA) below their true ITU-T value on 19 of this hub's 25
 * cameras. The defect survived that long for one reason: **a number in a
 * source file carries no record of the meter it was read off.** `-55` written
 * as a threshold is completely indistinguishable from `-55, as measured
 * through a decoder that was 12 dB low` — and exactly one constant in the repo
 * happened to record its provenance in prose (`NC_AUDIO_DB_OFFERED`'s "real
 * crying sits between -55 and -26 dBFS"). That one sentence is what let D459
 * be diagnosed at all.
 *
 * D459 closed by naming this as unenforced: *"nothing stops a new
 * absolute-dBFS constant being added without a note about which era it was
 * calibrated in. A guard would need to know which numbers are levels, and it
 * does not."*
 *
 * It does not need to. **This guard does not classify the numbers — it makes
 * the author classify them**, and only checks that a classification is present
 * and is one the vocabulary knows. The undecidable half ("is -25 a level or a
 * step?") is the half a human answers for free while writing the line, and
 * never answers again afterwards.
 *
 * ## The vocabulary, and why it has exactly these five words
 *
 * A dB number in this repo is one of five things, and they behave differently
 * under a scale change:
 *
 *  - `itu` — **a statement about the scale.** "-55 dBFS is near silence."
 *    True before the epoch and after it. The defect was never in such a
 *    number; it was that 19 cameras did not obey it. Converting one takes
 *    something correct and makes it wrong to preserve a bug.
 *  - `pre-itu-pcmu` / `pre-itu-pcma` — **a measurement taken through the old
 *    decoder.** It describes a sound that was really 12.04 / 18.06 dB louder,
 *    and must be restated with `ituDbfsFromPreEpoch` rather than by hand.
 *  - `relative` — **a difference, step, deviation, or correction.** D459
 *    proved these immune: a uniform offset cancels, so `levelDeviationDb` and
 *    friends were never affected and must never be "corrected".
 *  - `scale-bound` — **a structural bound of dBFS itself**, not a calibration:
 *    `0` is full scale and `-96` is the 16-bit floor, on any decoder.
 *
 * The vocabulary is CLOSED on purpose. An unrecognised tag is a refusal, not a
 * pass: a typo that silently satisfies the guard reads as a classification
 * that was checked when it was not — the same failure shape as D459's "the two
 * implementations agree" test, which went green whenever both sides were
 * wrong the same way.
 *
 * ## What it checks
 *
 * A declaration is IN SCOPE when its identifier has `db` or `dbfs` as a
 * whole token (camelCase and SCREAMING_SNAKE both split) **and** it binds a
 * numeric value — a literal, a negated literal, or a call that computes one.
 * An alias to another identifier is out of scope: the annotation belongs on
 * whatever it points at, and demanding it twice invites the two to disagree.
 *
 * Both shapes a calibration hides in are covered:
 *   - `const SOME_THING_DBFS = -55`
 *   - `someThingDbfs: z.number().default(-25)`  ← where `audioMarkerMinDbfs`
 *     lives, and the easier of the two to miss
 *
 * Text-based on purpose, like the other guards here: it must run on a bare CI
 * checkout with nothing built.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/** The annotation an in-scope declaration must carry. */
export const DBFS_ERA_TAG = '@dbfs-era'

/** The closed vocabulary. An unrecognised word is a refusal, never a pass. */
export const DBFS_ERAS: readonly string[] = [
  'itu',
  'pre-itu-pcmu',
  'pre-itu-pcma',
  'relative',
  'scale-bound',
]

/** Roots scanned. Sources only — a built `dist` has no comments left to read. */
const SCAN_ROOTS: readonly string[] = ['packages', 'server']

/** One declaration that binds a dB number without saying which era it is from. */
export interface DbfsEraViolation {
  readonly file: string
  readonly line: number
  readonly identifier: string
}

/**
 * Does this identifier name a dB quantity?
 *
 * Two rules, and the second exists because **`db` means both "decibel" and
 * "database"** — this repo is full of the second kind, and a guard that fires
 * on `dbConnections` gets switched off within a week.
 *
 * What separates them is POSITION, reliably in both conventions:
 *
 *  - a **database** identifier uses `db` as a leading namespace qualifier —
 *    `dbPath`, `dbConnections`, `DB_URL`;
 *  - a **decibel** identifier uses it as a unit, and a unit is never the thing
 *    it qualifies — `levelDeviationDb`, `MIN_MAD_DB`, `NC_AUDIO_DB_OFFERED`.
 *
 * So `db` counts only when something precedes it. `dbfs` counts anywhere: no
 * database is called "dbfs", so the ambiguity does not arise and a legitimate
 * `DBFS_FLOOR` must not be let through on a technicality.
 *
 * Whole-token match after splitting camelCase and underscores, never a
 * substring — `debounce` contains neither token and must stay out.
 */
function namesADbQuantity(identifier: string): boolean {
  const tokens = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split('_')
    .map((t) => t.toLowerCase())
  if (tokens.includes('dbfs')) return true
  return tokens.indexOf('db') > 0
}

/**
 * A value that is a NUMBER — a literal, a negated literal, or a call that
 * computes one (`ituDbfsFromPreEpoch(…)`, `Math.round(…)`).
 *
 * The dotted form matters more than it looks: without it the guard would have
 * waved through `NC_AUDIO_DB_OFFERED = Math.round(ituDbfsFromPreEpoch(…))`,
 * the one constant in the repo whose provenance is the entire point. A derived
 * calibration is MORE of a calibration than a literal, not less.
 */
const NUMERIC_RHS = /^\s*(?:-?\s*\d|[A-Za-z_$][\w$.]*\s*\()/

/**
 * A `const` at MODULE SCOPE — no leading whitespace, optionally exported.
 *
 * The indentation is the whole test, and it is the right one: a calibration is
 * a number somebody CHOSE, and those live at module scope. An indented
 * `const dbfs = readNumber(level, 'dbfs')` is reading a value, not choosing
 * one. Demanding an era note there would mean tagging every place a level is
 * passed through a function, which is noise — and noise trains the reader to
 * add the tag without thinking, which is worse than having no guard at all.
 */
const CONST_DECL = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/
const ZOD_FIELD = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*z\s*\.[\s\S]*?\.default\(\s*(-?\d)/

/**
 * Is there a valid era tag in the comment block immediately above `index`?
 *
 * "Immediately above" means the unbroken run of comment lines directly
 * preceding the declaration. Stopping at the first non-comment line is what
 * keeps a note on one constant from silently covering the next one — the
 * failure that would make the guard look satisfied across a whole file.
 */
function hasEraTagAbove(lines: readonly string[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (trimmed === '') continue
    const isComment =
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*') ||
      trimmed.endsWith('*/')
    if (!isComment) return false
    const tagged = new RegExp(`${DBFS_ERA_TAG}\\s+([a-z-]+)`).exec(trimmed)
    if (tagged) return DBFS_ERAS.includes(tagged[1] ?? '')
  }
  return false
}

/**
 * Every in-scope declaration in `source` that carries no valid era tag.
 *
 * Exported so the behaviour is asserted on fixtures rather than on whatever
 * the repo happens to contain today — a guard tested only against the live
 * tree goes green the moment it stops matching anything at all.
 */
export function findUnannotatedDbfsConstants(
  source: string,
  file: string,
): readonly DbfsEraViolation[] {
  const lines = source.split('\n')
  const violations: DbfsEraViolation[] = []

  lines.forEach((line, index) => {
    const constMatch = CONST_DECL.exec(line)
    const zodMatch = ZOD_FIELD.exec(line)

    let identifier: string | undefined
    if (constMatch && NUMERIC_RHS.test(constMatch[2] ?? '')) identifier = constMatch[1]
    else if (zodMatch) identifier = zodMatch[1]

    if (identifier === undefined) return
    if (!namesADbQuantity(identifier)) return
    if (hasEraTagAbove(lines, index)) return

    violations.push({ file, line: index + 1, identifier })
  })

  return violations
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') {
        continue
      }
      walk(full, out)
    } else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.spec\.|\.d\.ts$/.test(entry.name)) {
      out.push(full)
    }
  }
}

function main(): void {
  const files: string[] = []
  for (const root of SCAN_ROOTS) {
    for (const pkg of fs.existsSync(path.join(ROOT, root))
      ? fs.readdirSync(path.join(ROOT, root))
      : []) {
      walk(path.join(ROOT, root, pkg, 'src'), files)
    }
  }

  const violations = files.flatMap((file) =>
    findUnannotatedDbfsConstants(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file)),
  )

  if (violations.length === 0) {
    console.log(`✓ every dB constant declares its calibration era (${files.length} files)`)
    return
  }

  console.error(
    `\n✗ ${violations.length} dB constant(s) do not say which amplitude era they were calibrated in.\n`,
  )
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.identifier}`)
  }
  console.error(
    [
      '',
      `Add a ${DBFS_ERA_TAG} line to the comment directly above each, using one of:`,
      '',
      '  itu           a statement about the ITU-T dBFS scale ("-55 is near silence").',
      '                True before the D459 epoch and after. Do NOT convert it.',
      '  pre-itu-pcmu  measured through the old mu-law decoder, which read 12.04 dB low.',
      '  pre-itu-pcma  measured through the old A-law decoder, which read 18.06 dB low.',
      '                Both: restate with ituDbfsFromPreEpoch(), never by hand.',
      '  relative      a difference, step, deviation or correction. Scale-invariant —',
      '                D459 proved these immune, so they must never be "corrected".',
      '  scale-bound   a structural bound of dBFS itself (0 = full scale, -96 = floor).',
      '',
      'Why: D459 cost months because a number in a source file carries no record of',
      'the meter it was read off. See docs/decisions/adr-0460-*.md.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
