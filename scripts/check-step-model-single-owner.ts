#!/usr/bin/env tsx
/**
 * Step-model resolution guard — a step's model OPTIONS and its EFFECTIVE value
 * are derived in exactly ONE place, and every admin-ui surface reads that place.
 *
 * ## The failure this catches
 *
 * Three surfaces answer the same two questions about a pipeline step:
 *
 *   - the cluster matrix   (`NodeDeviceStepsMatrix`, per-(node,device) base),
 *   - the per-camera matrix (`DeviceStepOverrideTab`, per-camera override),
 *   - the drawer picker     (`AgentStepEditor`, what you may choose).
 *
 * Each had its own copy. On 2026-08-08 `rfdetr-package` became the package
 * step's default; the cluster matrix was fixed to gate the device's ELECTED
 * object-detection model on catalog membership, the per-camera tab kept
 * applying it slot-wide — and `package-detection` shares the `detector` slot
 * with the root step. So the same camera, the same accelerator, the same
 * moment: one page said `rfdetr-package`, the other said `yolov9m-320-int8`.
 * Worse, that alien id then seeded the picker, whose flat `<select>` paints its
 * FIRST option when the value matches none — so the control read "YOLOv8 Nano —
 * Package selected" and the operator reported rfdetr as missing entirely.
 *
 * Nothing failed. Two suites were green, one of them because its mock supplied
 * the resolver production had stopped calling. That is not a thing review
 * catches twice, so it gets a check.
 *
 * ## What it checks
 *
 * 1. The primitive is declared in exactly one file — the owner.
 * 2. No surface re-implements the ELECTION rule: a file outside the owner may
 *    not test `slot === 'detector'` (the gate that must be membership, not slot).
 * 3. No surface re-implements the OPTIONS rule: a file outside the owner may not
 *    filter a model list on `.formats[<something>]`.
 *
 * Checks 2 and 3 look for syntax that is present or absent, never a judgement
 * call — a guard with false positives gets deleted. What they cannot see is a
 * resolution hand-inlined under different names; what they do guarantee is that
 * the two rules whose divergence caused this cannot be restated.
 *
 * Usage: tsx scripts/check-step-model-single-owner.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** The one module allowed to resolve a step's models. */
const OWNER_FILE = 'packages/ui-library/src/composites/resolve-step-default-model.ts'

/** Exports the owner must keep — the guard fails loudly if it is checking ghosts. */
const OWNED_EXPORTS: readonly string[] = [
  'resolveStepDefaultModel',
  'resolveEffectiveDefaultModel',
  'resolveEffectiveStepModel',
  'stepModelOptions',
  'stepHasModelForFormat',
]

/**
 * Where a step-model decision may be made at all. Scoping the scan to the two
 * UI packages keeps it away from the RUNNER's own resolver
 * (`addon-pipeline/registry/step-definitions.ts`), which this file MIRRORS by
 * design and must not be forced to import a React package.
 */
const SCAN_ROOTS: readonly string[] = ['packages/ui-library/src', 'packages/addon-admin-ui/src']

/**
 * The election gate: applying the device's elected object-detection model
 * because the step sits in the `detector` slot. That is the rule that was
 * wrong — the gate is catalog MEMBERSHIP, and it lives in the owner.
 */
const ELECTION_RULE = /\bslot\s*===\s*['"]detector['"]/

/**
 * The options rule: filtering a model list by "does it have a build for this
 * engine format". Written a dozen ways (`Boolean(m.formats[fmt])`,
 * `m.formats[format] !== undefined`, `!!m.formats[f]`), all of which reduce to
 * a `filter`/`some`/`every`/`find` that indexes `.formats[` with a VARIABLE.
 *
 * Matched as a same-line conjunction rather than one bracket-counting regex —
 * arrow parameters (`.some((m) => …)`) defeat any `[^)]*` span, and a guard
 * that silently matches nothing is worse than no guard. Reading build METADATA
 * (`model.formats[format].sizeMB`, `?.downloaded`) is a different question and
 * is deliberately not matched: only the predicate form is.
 */
const OPTIONS_ITERATOR = /\.(?:filter|some|every|find)\s*\(/
const OPTIONS_INDEX = /\.formats\s*\[\s*[A-Za-z_$]/
const optionsRuleRestated = (code: string): boolean =>
  OPTIONS_ITERATOR.test(code) && OPTIONS_INDEX.test(code)

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

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

/** Tests may restate a rule to assert on it — they are documentation, not a second owner. */
const isTest = (relative: string): boolean =>
  relative.includes('__tests__/') || relative.endsWith('.spec.ts') || relative.endsWith('.test.ts')

function scanned(): readonly string[] {
  const files: string[] = []
  for (const root of SCAN_ROOTS) sourceFiles(path.join(ROOT, root), files)
  return files.filter((f) => !f.includes(`${path.sep}generated${path.sep}`))
}

function checkOwnerIntact(problems: Problem[]): void {
  const full = path.join(ROOT, OWNER_FILE)
  if (!fs.existsSync(full)) {
    problems.push({
      where: OWNER_FILE,
      what: 'the step-model primitive no longer exists',
      fix: 'restore it, or retire this guard deliberately rather than by deletion',
    })
    return
  }
  const source = fs.readFileSync(full, 'utf-8')
  for (const name of OWNED_EXPORTS) {
    if (new RegExp(`export\\s+function\\s+${name}\\b`).test(source)) continue
    problems.push({
      where: OWNER_FILE,
      what: `\`${name}\` is not exported from the owner`,
      fix: 'the surfaces import this by name — renaming it silently sends them back to local copies',
    })
  }
}

/** A single declaration site — a second one is a fork, whatever it agrees on today. */
function checkSingleDeclaration(files: readonly string[], problems: Problem[]): void {
  for (const file of files) {
    const relative = rel(file)
    if (relative === OWNER_FILE || isTest(relative)) continue
    const source = fs.readFileSync(file, 'utf-8')
    for (const name of OWNED_EXPORTS) {
      if (!new RegExp(`export\\s+function\\s+${name}\\b`).test(source)) continue
      problems.push({
        where: relative,
        what: `declares a SECOND \`${name}\``,
        fix: `there is one step-model primitive, in ${OWNER_FILE} — import it`,
      })
    }
  }
}

function checkNoRestatedRules(files: readonly string[], problems: Problem[]): void {
  for (const file of files) {
    const relative = rel(file)
    if (relative === OWNER_FILE || isTest(relative)) continue
    const source = fs.readFileSync(file, 'utf-8')
    for (const [index, line] of source.split('\n').entries()) {
      // A comment restating the rule in prose is fine — it is code we are after.
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (ELECTION_RULE.test(code)) {
        problems.push({
          where: `${relative}:${index + 1}`,
          what: "branches on `slot === 'detector'` — that is the election rule, restated",
          fix: "the device's elected model applies where the step's CATALOG contains it, not slot-wide (package-detection shares the detector slot with the root step). Call `resolveEffectiveStepModel` / `resolveEffectiveDefaultModel`.",
        })
      }
      if (optionsRuleRestated(code)) {
        problems.push({
          where: `${relative}:${index + 1}`,
          what: 'filters models by engine-format build — that is the options rule, restated',
          fix: 'call `stepModelOptions(models, format)` (or `stepHasModelForFormat`) so the picker and the matrix cell can never disagree about what a device can run',
        })
      }
    }
  }
}

function main(): void {
  const files = scanned()
  if (files.length === 0) {
    console.error('\x1b[31m✘ no source files found — check SCAN_ROOTS\x1b[0m')
    process.exit(1)
  }

  const problems: Problem[] = []
  checkOwnerIntact(problems)
  checkSingleDeclaration(files, problems)
  checkNoRestatedRules(files, problems)

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} step-model ownership violation(s)\x1b[0m:`)
    for (const p of problems) {
      console.error(`    ${p.where}: ${p.what}`)
      console.error(`      → ${p.fix}`)
    }
    console.error(
      '    Why this matters: two answers to "which model does this step run" is what showed the operator yolo on the package step while the cluster board showed rfdetr.',
    )
    process.exit(1)
  }
  console.log('  ✔ step-model options and resolution have exactly one owner')
}

main()
