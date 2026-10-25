#!/usr/bin/env tsx
/**
 * Crop-derivation guard — the rectangle fed to an enrichment step is derived in
 * exactly ONE place, and only the runner cuts it.
 *
 * ## The failure this catches
 *
 * `object-clip` is a single vector index, and a cosine score is only meaningful
 * between vectors cut the same way. Two encode paths write into it: the live
 * detail plane and the embedding rebuild. They each derived their own crop —
 * `DETAIL_CROP_PADDING_RATIO = 0.15` unsquared on one side,
 * `DEFAULT_CROP_MARGIN = 0.2` squared-by-default on the other — so every
 * rebuild poured a second, incomparable feature space into the index it exists
 * to keep consistent. Nothing failed, nothing logged; search quality simply
 * became a function of which pass had run last.
 *
 * Two constants, in two packages, both reasonable in isolation. That is not a
 * thing review catches, so it gets a check.
 *
 * ## What it checks
 *
 * 1. `deriveDetailCropRect` is DECLARED in exactly one file — the owner.
 * 2. Nothing outside {@link CUTTER_FILES} imports it. Adding a caller means
 *    adding a second cutter, which is the decision that must be conscious.
 * 3. The embedding rebuild does not cut: {@link NON_CUTTER_FILES} may not
 *    import an image library or call `.extract(`.
 * 4. No file outside the owner declares a detail/CLIP crop padding constant.
 *
 * ## Why these four and not "look for suspicious maths"
 *
 * Every check is a declaration or an import — syntax that is either present or
 * absent, never a judgement call. A guard with false positives gets deleted,
 * and this one is worth keeping. It cannot see a hand-inlined `bbox.w * 0.15`
 * that never names itself; nothing conservative can. What it does guarantee is
 * that the SHARED function stays single, that the rebuild cannot silently
 * regain a cutter, and that a second named convention cannot be introduced.
 *
 * Usage: tsx scripts/check-clip-crop-single-owner.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** The one module allowed to compute a detail-crop rectangle. */
const OWNER_FILE = 'packages/types/src/pipeline/detail-crop.ts'

/** The exported derivation everything else must go through. */
const DERIVATION = 'deriveDetailCropRect'

/**
 * Files permitted to CALL the derivation — i.e. to cut a crop.
 *
 * One on the ENCODE path, and that is the point: `runDetailSubtree` is the
 * single entry for both the live detail plane (frame handle) and the embedding
 * rebuild (full key frame shipped as `frameJpeg`). A second encode-path entry
 * here means two cutters again, whatever they agree on today. The only other
 * entry writes training files and says why beside it.
 */
const CUTTER_FILES: readonly string[] = [
  'packages/addon-pipeline/src/pipeline-runner/detail-subtree.ts',
  // The retrain export's `crops` layout (D785 context, cloud-training P3). It
  // writes classifier TRAINING files, never a vector, so it cannot add a
  // feature space to an index; it must cut exactly as the runtime does, and
  // calling this one derivation is how it does. Not on any encode path.
  'packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-crop-cut.ts',
]

/**
 * Files that must NOT cut, with the reason each one is listed.
 *
 * The rebuild is here because it is where the second feature space came from:
 * it used to load the key frame, cut its own window and encode it directly.
 * It now ships the frame to the runner and receives a vector.
 *
 * The rebuild's request builder and the STATELESS step path are here for the
 * same reason one step removed. Both are new entries on the encode path, both
 * sit next to an image, and either could grow a `sharp` call that looks locally
 * reasonable — the stateless path in particular must reach the derivation
 * THROUGH `detail-subtree.ts`'s `cutFromFullFrame`, never around it.
 */
const NON_CUTTER_FILES: ReadonlyArray<{ readonly file: string; readonly why: string }> = [
  {
    file: 'packages/addon-post-analysis/src/pipeline-analytics/embedding-rebuild.ts',
    why: 'the rebuild must ship the key frame to the runner and let it cut — cutting here is exactly how the index acquired two feature spaces',
  },
  {
    file: 'packages/addon-post-analysis/src/pipeline-analytics/rebuild-detail-request.ts',
    why: 'the rebuild request carries a FULL frame and a normalised box; reading or cutting the image here would put a second rectangle one hop from the one the runner derives',
  },
  {
    file: 'packages/addon-pipeline/src/pipeline-runner/stateless-step.ts',
    why: "the stateless step path must cut through `detail-subtree.ts`'s `cutFromFullFrame` (the single permitted caller of the derivation), never with its own image call",
  },
]

/**
 * Image libraries whose presence in a non-cutter file means it is cutting.
 *
 * `lazy-sharp` is in here because it is how this repo ACTUALLY reaches sharp:
 * `import { getSharp } from '../shared/lazy-sharp.js'`. A check that looked only
 * for `from 'sharp'` would have waved through every real cutter in
 * `packages/addon-pipeline` — the guard would have been green and blind.
 */
const IMAGE_LIBS: readonly string[] = ['sharp', 'jimp', 'canvas', 'lazy-sharp']

/**
 * Names that denote a detail/CLIP crop convention.
 *
 * Narrow on purpose. Media/display crops legitimately have their own padding
 * (thumbnails, best-shot strips, the `captureCrop` retry tile) and are not part
 * of the model-input feature space, so a blanket "any constant with PADDING in
 * its name" would fire on unrelated, correct code and get this file deleted.
 */
const CONVENTION_NAME = /\b(?:DETAIL|CLIP)_CROP_(?:PADDING|MARGIN)\w*|\bDEFAULT_CROP_MARGIN\b/

interface Problem {
  readonly where: string
  readonly what: string
  readonly fix: string
}

function sourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      sourceFiles(full, out)
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
}

/** Every non-generated source file under `packages/` and `server/`. */
function allSources(): readonly string[] {
  const files: string[] = []
  for (const root of ['packages', 'server']) {
    sourceFiles(path.join(ROOT, root), files)
  }
  return files.filter((f) => !f.includes(`${path.sep}generated${path.sep}`))
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

/** Is this a test file? Tests may import the derivation to assert on it. */
const isTest = (relative: string): boolean =>
  relative.includes('__tests__/') || relative.endsWith('.spec.ts') || relative.endsWith('.test.ts')

function checkSingleDeclaration(files: readonly string[], problems: Problem[]): void {
  const declaring = files.filter((file) => {
    const relative = rel(file)
    if (isTest(relative)) return false
    return new RegExp(`export\\s+function\\s+${DERIVATION}\\b`).test(fs.readFileSync(file, 'utf-8'))
  })

  if (declaring.length === 1 && rel(declaring[0]!) === OWNER_FILE) return
  if (declaring.length === 0) {
    problems.push({
      where: OWNER_FILE,
      what: `\`${DERIVATION}\` is not declared anywhere`,
      fix: 'this guard is checking a function that no longer exists — restore it, or retire the guard deliberately rather than by deletion',
    })
    return
  }
  for (const file of declaring) {
    if (rel(file) === OWNER_FILE) continue
    problems.push({
      where: rel(file),
      what: `a SECOND \`${DERIVATION}\` is declared here`,
      fix: `there is exactly one crop derivation, in ${OWNER_FILE} — import it instead of redeclaring it`,
    })
  }
}

/**
 * Blank out block and line comments, preserving offsets is unnecessary — only
 * the import test reads this. Deliberately naive: a `//` inside a string
 * literal would truncate that line, which can only DROP a match, never invent
 * one, and an import statement never carries such a literal.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

function checkOnlyCuttersImport(files: readonly string[], problems: Problem[]): void {
  const allowed = new Set(CUTTER_FILES)
  for (const file of files) {
    const relative = rel(file)
    if (relative === OWNER_FILE || allowed.has(relative) || isTest(relative)) continue
    // Only an IMPORT counts. A mention in a comment (this guard, an ADR, a
    // docblock explaining the design) must never fail the build — and until
    // 2026-08-13 it did: this repo writes no semicolons, so `import[^;]*…from`
    // with the `s` flag spans the WHOLE head of a file. Any docblock naming the
    // derivation above the first `import … from` matched, and the intent stated
    // one line above was false in exactly the case it names. Comments are
    // stripped first, which can only make the test stricter.
    const source = stripComments(fs.readFileSync(file, 'utf-8'))
    if (!new RegExp(`import[^;]*\\b${DERIVATION}\\b[^;]*from`, 's').test(source)) continue
    problems.push({
      where: relative,
      what: `imports \`${DERIVATION}\` — this file would become a second place that cuts a model-input crop`,
      fix: `route the work through \`pipelineRunner.runDetailSubtree\` (send a full frame as \`frameJpeg\` and let the runner cut), or add this file to CUTTER_FILES in ${rel(path.join(ROOT, 'scripts/check-clip-crop-single-owner.ts'))} with a reason`,
    })
  }
}

function checkNonCuttersDoNotCut(problems: Problem[]): void {
  for (const entry of NON_CUTTER_FILES) {
    const full = path.join(ROOT, entry.file)
    if (!fs.existsSync(full)) continue
    const source = fs.readFileSync(full, 'utf-8')
    for (const lib of IMAGE_LIBS) {
      // Matches both a bare specifier (`from 'sharp'`) and a relative helper
      // module ending in the name (`from '../shared/lazy-sharp.js'`).
      if (!new RegExp(`from\\s+['"][^'"]*\\b${lib}(?:\\.js)?['"]`).test(source)) continue
      problems.push({
        where: entry.file,
        what: `imports \`${lib}\` — this file must not touch pixels`,
        fix: entry.why,
      })
    }
    if (/\.extract\s*\(/.test(source)) {
      problems.push({
        where: entry.file,
        what: 'calls `.extract(` — that is cutting a crop',
        fix: entry.why,
      })
    }
  }
}

function checkNoSecondConvention(files: readonly string[], problems: Problem[]): void {
  for (const file of files) {
    const relative = rel(file)
    if (relative === OWNER_FILE || isTest(relative)) continue
    const source = fs.readFileSync(file, 'utf-8')
    for (const line of source.split('\n')) {
      // A DECLARATION only. A reference in prose, or an import of the owner's
      // own constant, is fine — restating a name is not defining a rival value.
      const match = /(?:const|let|var|enum|readonly)\s+([A-Z][A-Z0-9_]*)\s*[:=]/.exec(line)
      const name = match?.[1]
      if (name === undefined || !CONVENTION_NAME.test(name)) continue
      problems.push({
        where: relative,
        what: `declares \`${name}\` — a second detail-crop convention`,
        fix: `the convention is ONE cluster-wide \`pipeline-orchestrator\` setting, defaulting to DEFAULT_DETAIL_CROP_CONVENTION in ${OWNER_FILE}. Read it, do not redeclare it.`,
      })
    }
  }
}

function main(): void {
  const files = allSources()
  if (files.length === 0) {
    console.error('\x1b[31m✘ no source files found — check the repo layout\x1b[0m')
    process.exit(1)
  }

  const problems: Problem[] = []
  checkSingleDeclaration(files, problems)
  checkOnlyCuttersImport(files, problems)
  checkNonCuttersDoNotCut(problems)
  checkNoSecondConvention(files, problems)

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} CLIP-crop ownership violation(s)\x1b[0m:`)
    for (const p of problems) {
      console.error(`    ${p.where}: ${p.what}`)
      console.error(`      → ${p.fix}`)
    }
    console.error(
      '    Why this matters: two crop derivations put two incomparable feature spaces in one vector index.',
    )
    process.exit(1)
  }
  console.log('  ✔ the detail/CLIP crop rectangle has exactly one owner')
}

main()
