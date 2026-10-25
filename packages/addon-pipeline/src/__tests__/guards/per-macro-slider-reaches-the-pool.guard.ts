/**
 * A per-macro confidence slider must be able to LOWER the detector.
 *
 * Lived in `scripts/check-per-macro-slider-reaches-the-pool.ts` until
 * 2026-09-20; it reads two files of this package, so it runs as this package's
 * test (D548).
 *
 * ## The failure this catches
 *
 * The Python pool receives a per-step confidence FLOOR and drops every box
 * below it before TypeScript sees anything. For most steps that floor is the
 * step's own `defaultConfidence`, which is correct: those steps have no
 * operator-facing threshold, so nothing downstream can disagree with it.
 *
 * A step that DOES expose a `minConfidence<Macro>` slider is different. The
 * executor's `macroFilterVerdict` re-filters that step's detections against the
 * slider — but only over boxes that survived the pool. So while the pool floor
 * stays at `defaultConfidence`, every slider position BELOW the default is a
 * silent no-op. This shipped once for `object-detection` and again on
 * 2026-08-07 for `package-detection`, whose brand-new `minConfidencePackage`
 * slider was born half dead — every position under 0.5 unreachable.
 *
 * The two halves live in different files (`registry/step-definitions.ts`
 * declares the slider, `engine/engine-factory.ts` decides the floor) and each is
 * self-consistent. That is not a thing review catches, so it gets a check.
 *
 * ## What it checks
 *
 * Every step whose `getConfigSchema()` declares a key matching
 * `minConfidence<Macro>` must appear in `engine-factory.ts`'s
 * `PER_MACRO_REFILTERED_STEP_IDS`. The reverse is deliberately NOT checked.
 * Bare `minConfidence` (the classifier convention) is not a per-macro slider.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const STEP_DEFINITIONS = 'src/detection-pipeline/registry/step-definitions.ts'
export const ENGINE_FACTORY = 'src/detection-pipeline/engine/engine-factory.ts'
export const FLOOR_SET_NAME = 'PER_MACRO_REFILTERED_STEP_IDS'

/** `minConfidencePerson`, `minConfidencePackage`, … — never bare `minConfidence`. */
const PER_MACRO_KEY = /^minConfidence[A-Z]\w*$/

export interface SliderProblem {
  readonly stepId: string
  readonly key: string
}

/**
 * Ids inside the floor set literal. Read as text rather than imported: the
 * guard must not depend on the module's runtime graph (sharp, the python
 * paths), and a `Set([...])` literal is unambiguous.
 */
export function floorSetIds(factorySource: string): ReadonlySet<string> {
  const match = new RegExp(`${FLOOR_SET_NAME}[^=]*=\\s*new Set\\(\\[([^\\]]*)\\]`, 's').exec(
    factorySource,
  )
  if (!match) {
    throw new Error(
      `could not find \`${FLOOR_SET_NAME} = new Set([...])\` in ${ENGINE_FACTORY} — ` +
        'the guard reads that literal; if it was renamed, update this guard.',
    )
  }
  return new Set([...(match[1] ?? '').matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1] ?? ''))
}

/**
 * Map every per-macro slider key to the step id(s) that get it. The file has
 * two shapes and BOTH must be handled: a class with an inline `definition =
 * { id: 'x', … }` and its own `getConfigSchema()`, and a class carrying only
 * `getConfigSchema()`, instantiated as `new ThatClass({ id: 'x', … })` —
 * possibly more than once. So: keys per CLASS, then each class to its ids.
 */
export function slidersByStep(stepsSource: string): ReadonlyMap<string, readonly string[]> {
  const lines = stepsSource.split('\n')
  const keysByClass = new Map<string, string[]>()
  const inlineIdByClass = new Map<string, string>()
  let currentClass: string | null = null
  for (const line of lines) {
    const classMatch = /^class\s+(\w+)/.exec(line)
    if (classMatch) {
      currentClass = classMatch[1] ?? null
      continue
    }
    if (/^(?:const|function|export)\s/.test(line)) {
      currentClass = null
      continue
    }
    if (currentClass === null) continue
    const idMatch = /^\s{4}id:\s*['"]([\w-]+)['"]/.exec(line)
    if (idMatch?.[1] !== undefined && !inlineIdByClass.has(currentClass)) {
      inlineIdByClass.set(currentClass, idMatch[1])
      continue
    }
    const key = /^\s*key:\s*['"](\w+)['"]/.exec(line)?.[1]
    if (key === undefined || !PER_MACRO_KEY.test(key)) continue
    const list = keysByClass.get(currentClass) ?? []
    if (!list.includes(key)) list.push(key)
    keysByClass.set(currentClass, list)
  }
  const idsByClass = new Map<string, string[]>()
  for (let i = 0; i < lines.length; i++) {
    const ctor = /=\s*new\s+(\w+)\(\{/.exec(lines[i] ?? '')?.[1]
    if (ctor === undefined) continue
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const id = /^\s*id:\s*['"]([\w-]+)['"]/.exec(lines[j] ?? '')?.[1]
      if (id === undefined) continue
      const list = idsByClass.get(ctor) ?? []
      list.push(id)
      idsByClass.set(ctor, list)
      break
    }
  }
  const out = new Map<string, string[]>()
  for (const [className, keys] of keysByClass) {
    const inline = inlineIdByClass.get(className)
    const ids = [...(inline === undefined ? [] : [inline]), ...(idsByClass.get(className) ?? [])]
    if (ids.length === 0) {
      throw new Error(
        `class ${className} declares a per-macro slider but resolves to no step id — ` +
          'the guard could not attribute it; if the file shape changed, update this guard.',
      )
    }
    for (const id of ids) {
      const merged = out.get(id) ?? []
      for (const k of keys) if (!merged.includes(k)) merged.push(k)
      out.set(id, merged)
    }
  }
  return out
}

/** The pure judgement: every slider the pool floor pre-empts. */
export function sliderProblems(
  stepsSource: string,
  factorySource: string,
): readonly SliderProblem[] {
  const refiltered = floorSetIds(factorySource)
  const problems: SliderProblem[] = []
  for (const [stepId, keys] of slidersByStep(stepsSource)) {
    if (refiltered.has(stepId)) continue
    for (const key of keys) problems.push({ stepId, key })
  }
  return problems
}

/** Judge THIS package as checked out, as sentences. */
export function evaluatePerMacroSliderGuard(packageRoot: string): readonly string[] {
  const read = (rel: string): string => fs.readFileSync(path.join(packageRoot, rel), 'utf-8')
  return sliderProblems(read(STEP_DEFINITIONS), read(ENGINE_FACTORY)).map(
    (p) =>
      `${p.stepId} declares \`${p.key}\` but is not in ${FLOOR_SET_NAME} — add '${p.stepId}' to ` +
      `${FLOOR_SET_NAME} in ${ENGINE_FACTORY}, or the slider does nothing below the step's defaultConfidence`,
  )
}
