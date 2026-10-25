/**
 * Label-tier guard — a step that produces a LABEL declares which tier it fills.
 *
 * Lived in `scripts/check-label-tier-declared.ts` until 2026-09-20; it reads
 * only this package's step definitions, so it runs as this package's test
 * (D548).
 *
 * ## The failure this catches
 *
 * A track carries two label slots (roadmap 4g): tier 1 is the sub-class
 * (`dog`, `van`), tier 2 is the instance (`Turdus migratorius`, `Alice`, a
 * plate read). Which slot a step's answer occupies is DECLARED on
 * `StepDefinition.labelTier` and travels on the wire; the persistence write
 * rule refuses a candidate that arrives without one.
 *
 * That refusal is correct and it is also silent to the person adding a step.
 * A new classifier ships, its answers are dropped for every track on every
 * camera, and the only trace is an `undeclared-tier` line in a log nobody is
 * reading yet. The declaration is one line and it is the kind of line that is
 * forgotten, so it gets a check rather than a paragraph.
 *
 * ## What it checks
 *
 * Every step definition whose `outputClasses` contains a LABEL-BEARING class —
 * one that is not a macro class and not an opaque artifact (`embedding`,
 * `mask`) — declares `labelTier`. Macro classes and artifacts are enumerated,
 * and ANYTHING ELSE is assumed to be a label: a new artifact class must be
 * added to {@link ARTIFACT_CLASSES} to pass, a conscious decision made by the
 * person who knows the answer.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const STEP_DEFINITIONS = 'src/detection-pipeline/registry/step-definitions.ts'

/** Classes that ARE the macro taxonomy: a step whose output is one of these fills `className`. */
const MACRO_CLASSES: ReadonlySet<string> = new Set([
  'person',
  'vehicle',
  'animal',
  'package',
  'face',
  'plate',
  'audio',
])

/** OPAQUE artifacts — a vector, a bitmap — never shown to a human as a name. */
const ARTIFACT_CLASSES: ReadonlySet<string> = new Set(['embedding', 'mask'])

export interface StepBlock {
  readonly id: string
  readonly outputClasses: readonly string[]
  readonly hasLabelTier: boolean
}

/**
 * Parse the step definitions by BLOCK — from one `id:` to the next. The file is
 * a list of literal objects, so the block between two ids holds exactly one
 * step's fields, and this needs no TypeScript AST to be exact about it.
 */
export function parseSteps(source: string): readonly StepBlock[] {
  const idRe = /^\s*id: '([a-z0-9-]+)',$/gm
  const marks: { id: string; at: number }[] = []
  for (const m of source.matchAll(idRe)) {
    if (m[1] !== undefined && m.index !== undefined) marks.push({ id: m[1], at: m.index })
  }
  const steps: StepBlock[] = []
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]
    if (mark === undefined) continue
    const end = marks[i + 1]?.at ?? source.length
    const block = source.slice(mark.at, end)
    const out = /outputClasses: \[([^\]]*)\]/.exec(block)
    const outputClasses =
      out === null ? [] : [...(out[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '')
    steps.push({
      id: mark.id,
      outputClasses,
      hasLabelTier: /^\s*labelTier: [12],$/m.test(block),
    })
  }
  return steps
}

/** The pure judgement over the step-definitions source. */
export function labelTierFailures(source: string): readonly string[] {
  const steps = parseSteps(source)
  if (steps.length === 0) {
    return [
      `parsed ZERO steps from ${STEP_DEFINITIONS}. The file shape changed and this guard is now ` +
        'blind — fix the parser, do not delete the check.',
    ]
  }
  const failures: string[] = []
  for (const step of steps) {
    const labelBearing = step.outputClasses.filter(
      (c) => !MACRO_CLASSES.has(c) && !ARTIFACT_CLASSES.has(c),
    )
    if (labelBearing.length === 0) continue
    if (step.hasLabelTier) continue
    failures.push(
      `${step.id}: outputs ${labelBearing.map((c) => `'${c}'`).join(', ')} but declares no labelTier`,
    )
  }
  // The root detector is label-bearing through its RAW class rather than its
  // outputClasses (which are macro), so it is checked by name.
  const root = steps.find((s) => s.id === 'object-detection')
  if (root !== undefined && !root.hasLabelTier) {
    failures.push(
      'object-detection: declares no labelTier — its RAW class (`dog` under `animal`) is a tier-1 label',
    )
  }
  return failures
}

/** Judge THIS package as checked out. */
export function evaluateLabelTierGuard(packageRoot: string): readonly string[] {
  return labelTierFailures(fs.readFileSync(path.join(packageRoot, STEP_DEFINITIONS), 'utf8'))
}
