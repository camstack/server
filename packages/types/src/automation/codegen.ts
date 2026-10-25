/**
 * Recipe → TypeScript. The half that makes "a visual automation compiles to a
 * block; it does not get an engine" true rather than aspirational
 * (design decision 4, `docs/design/2026-08-08-automation-scripts-custom-devices.md`).
 *
 * **The generated source is derived, never authoritative.** It is regenerated on
 * every compile and shown read-only; the RECIPE is what the operator edited.
 * That resolves the open question §8.2 left to this phase ("is the generated
 * code stored for audit, or regenerated?"): storing it creates a second copy
 * that can disagree with the recipe, and a second copy that can disagree is the
 * failure this whole chapter exists to avoid.
 *
 * The recipe travels INSIDE the generated file as `AUTOMATION_RECIPE`, a frozen
 * JSON literal. That is deliberate and it is not a second store: there is still
 * exactly one row in `core_blocks`, and the recipe is part of the one artefact
 * that row holds. It is what lets the editor re-open a visually-authored
 * automation without `CoreBlock.source` having shipped yet — and when the
 * `source` union does ship, this literal becomes redundant and is dropped in the
 * same change that starts persisting the recipe properly.
 *
 * Nothing here evaluates anything. The generated code is compiled by esbuild
 * inside the block pipeline exactly like hand-written code — no `eval`, no
 * `new Function`, no `vm`, which `scripts/check-no-dynamic-eval.ts` enforces
 * repo-wide.
 */

import type {
  AutomationAction,
  AutomationCondition,
  AutomationRecipe,
  AutomationTrigger,
} from './recipe.js'
import { validateRecipeBounds } from './recipe.js'

export interface GenerateAutomationBlockInput {
  /** The block's name — the ONE name for the artefact (§2.1). */
  readonly name: string
  readonly recipe: AutomationRecipe
}

/** How often the state mirror is re-read as the backstop for a dropped event
 *  (D8: an event WAKES the evaluation, the reconcile guarantees it). */
const RECONCILE_MS = 15_000

function j(value: unknown): string {
  return JSON.stringify(value)
}

/** Emit the boolean tree as calls into the generated combinators. */
function emitCondition(cond: AutomationCondition, indent: string): string {
  switch (cond.kind) {
    case 'all':
      return `allOf([\n${cond.children
        .map((c) => `${indent}  () => ${emitCondition(c, `${indent}  `)}`)
        .join(',\n')}\n${indent}])`
    case 'any':
      return `anyOf([\n${cond.children
        .map((c) => `${indent}  () => ${emitCondition(c, `${indent}  `)}`)
        .join(',\n')}\n${indent}])`
    case 'not':
      return `notOf(() => ${emitCondition(cond.child, indent)})`
    case 'condition':
      return `leaf(${j(cond.deviceId)}, ${j(cond.cap)}, ${j(cond.fieldPath)}, ${j(
        cond.operator,
      )}, ${j(cond.value)})`
    case 'expression':
      return `exprLeaf(${j(cond.expr)}, ${j(cond.bindings)})`
  }
}

function emitTrigger(trigger: AutomationTrigger, index: number): string {
  switch (trigger.kind) {
    case 'schedule':
      return `  // trigger ${index}: schedule — armed to the next minute boundary and
  // RE-ARMED from the wall clock every tick, so it cannot drift the way a
  // setInterval(24h) does. No cron library: a block cannot resolve one.
  {
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      timer = setTimeout(() => {
        if (cronMatches(${j(trigger.cron)}, new Date())) {
          void run({ kind: 'schedule', at: Date.now() })
        }
        arm()
      }, nextMinuteBoundary())
    }
    arm()
    disposers.push(() => { if (timer !== undefined) clearTimeout(timer) })
  }`
    case 'device-event':
      return `  // trigger ${index}: device event
  disposers.push(
    ctx.eventBus.subscribe(
      { category: ${j(trigger.category)}${
        trigger.deviceId === undefined ? '' : `, deviceId: ${j(trigger.deviceId)}`
      } },
      (event) => {
        void run({
          kind: 'device-event',
          at: Date.now(),
          deviceId: event.deviceId,
          category: ${j(trigger.category)},
        })
      },
    ),
  )`
    case 'device-state': {
      const becomes = trigger.becomes === undefined ? 'undefined' : j(trigger.becomes)
      return `  // trigger ${index}: device state — the mirror is the authority, the
  // event only WAKES the evaluation, so a dropped event delays and never loses.
  {
    let previous: unknown = undefined
    let debounce: ReturnType<typeof setTimeout> | undefined
    let heldSince: number | undefined
    const check = async (): Promise<void> => {
      const value = await readField(${j(trigger.deviceId)}, ${j(trigger.cap)}, ${j(
        trigger.fieldPath,
      )})
      const want = ${becomes}
      const matches = want === undefined ? value !== previous : value === want
      const changed = value !== previous
      previous = value
      if (!matches) { heldSince = undefined; return }
      if (${trigger.edge === true ? 'true' : 'false'} && !changed) return
      const forMs = ${j(trigger.forMs ?? 0)}
      if (forMs > 0) {
        if (heldSince === undefined) { heldSince = Date.now(); return }
        if (Date.now() - heldSince < forMs) return
      }
      heldSince = undefined
      void run({
        kind: 'device-state',
        at: Date.now(),
        deviceId: ${j(trigger.deviceId)},
        cap: ${j(trigger.cap)},
        field: ${j(trigger.fieldPath)},
        to: value,
      })
    }
    const wake = (): void => {
      if (debounce !== undefined) clearTimeout(debounce)
      debounce = setTimeout(() => { void check() }, ${j(trigger.debounceMs ?? 0)})
    }
    disposers.push(
      ctx.eventBus.subscribe({ category: 'device.state-changed', deviceId: ${j(
        trigger.deviceId,
      )} }, wake),
    )
    const reconcile = setInterval(() => { void check() }, RECONCILE_MS)
    disposers.push(() => clearInterval(reconcile))
  }`
    }
    case 'manual':
      return `  // trigger ${index}: manual — fired by automation-control.trigger
  // ("Run actions"), which runs the THEN half with an EMPTY vars bag.`
  }
}

function emitAction(action: AutomationAction, index: number): string {
  switch (action.kind) {
    case 'wait':
      return `      case ${index}: await sleep(${j(action.seconds * 1000)}); break`
    case 'cap': {
      if (Array.isArray(action.deviceId)) {
        return `      case ${index}: {
        for (const deviceId of ${j(action.deviceId)}) {
          await actuate(deviceId, ${j(action.cap)}, ${j(action.method)}, ${j(
            action.args ?? {},
          )}, vars)
        }
        break
      }`
      }
      const target =
        typeof action.deviceId === 'number'
          ? j(action.deviceId)
          : `resolveTarget(vars, ${j(action.deviceId.$var)})`
      return `      case ${index}: {
        const deviceId = ${target}
        await actuate(deviceId, ${j(action.cap)}, ${j(action.method)}, ${j(
          action.args ?? {},
        )}, vars)
        break
      }`
    }
    case 'code':
      return `      case ${index}: {
        // inline code action — a fragment of THIS block, bundled by esbuild
        await (async () => {
${action.code
  .split('\n')
  .map((line) => `          ${line}`)
  .join('\n')}
        })()
        break
      }`
  }
}

/**
 * Compile a recipe to the TypeScript of a core block.
 *
 * Throws when the recipe is out of bounds — generation is not the place to
 * discover that, but it is the last place it can still be caught before code
 * that the operator did not author starts running.
 */
export function generateAutomationBlock(input: GenerateAutomationBlockInput): string {
  const boundsError = validateRecipeBounds(input.recipe)
  if (boundsError !== null) {
    throw new Error(`cannot generate an automation from an invalid recipe: ${boundsError}`)
  }
  const { name, recipe } = input
  const conditionExpr =
    recipe.conditions === undefined ? 'true' : `await ${emitCondition(recipe.conditions, '    ')}`

  return `import type { AddonContext } from '@camstack/types'
import { evaluateExpressionSource, toExpressionValue } from '@camstack/types'

/**
 * ${name}
 *
 * GENERATED FROM A RECIPE — do not edit by hand. Editing this file makes it a
 * script: the visual editor reads AUTOMATION_RECIPE below, and hand edits are
 * lost the next time the recipe is saved. Use "Eject to code" to take ownership
 * of it permanently (one way).
 */

const AUTOMATION_RECIPE = ${JSON.stringify(recipe, null, 2)} as const

const RECONCILE_MS = ${RECONCILE_MS}

/** A cap is named \`alarm-panel\`; \`ctx.api\` is keyed by the ROUTER name,
 *  \`alarmPanel\`. Indexing ctx.api with the cap name yields undefined and every
 *  action throws, so the conversion is not cosmetic. */
function capToRouterKey(cap: string): string {
  return cap.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

/** Ms until the top of the next minute. Recomputed every tick so a long-lived
 *  schedule cannot accumulate drift. */
function nextMinuteBoundary(): number {
  const now = Date.now()
  return 60_000 - (now % 60_000)
}

/** Does \`when\` satisfy a 5-field cron expression (min hour dom mon dow)?
 *  Supports wildcards, step syntax, ranges, comma lists and plain numbers —
 *  the subset an operator can author, and nothing that needs a library. */
function cronMatches(expr: string, when: Date): boolean {
  const fields = expr.trim().split(/\\s+/)
  if (fields.length !== 5) return false
  const actual = [
    when.getMinutes(),
    when.getHours(),
    when.getDate(),
    when.getMonth() + 1,
    when.getDay(),
  ]
  return fields.every((field, i) => matchField(field, actual[i]!))
}

function matchField(field: string, value: number): boolean {
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw === undefined ? 1 : Number.parseInt(stepRaw, 10)
    if (!Number.isFinite(step) || step < 1) continue
    if (range === '*') {
      if (value % step === 0) return true
      continue
    }
    const bounds = range!.split('-')
    const lo = Number.parseInt(bounds[0]!, 10)
    const hi = bounds[1] === undefined ? lo : Number.parseInt(bounds[1], 10)
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true
  }
  return false
}

export default function block(ctx: AddonContext) {
  const disposers: Array<() => void> = []
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** Read one cap field off the state mirror. Returns undefined when the device,
   *  the cap or the field cannot be resolved — the caller decides what that
   *  means, and it always logs. */
  async function readField(
    deviceId: number,
    cap: string,
    fieldPath: string,
  ): Promise<unknown> {
    try {
      const slice = await ctx.api.deviceState.getCapSlice.query({ deviceId, capName: cap })
      let cursor: unknown = slice
      for (const part of fieldPath.split('.')) {
        if (cursor === null || typeof cursor !== 'object') return undefined
        cursor = (cursor as Record<string, unknown>)[part]
      }
      return cursor
    } catch {
      return undefined
    }
  }

  function compare(actual: unknown, operator: string, expected: unknown): boolean {
    switch (operator) {
      case 'eq': return actual === expected
      case 'ne': return actual !== expected
      case 'gt': return typeof actual === 'number' && typeof expected === 'number' && actual > expected
      case 'gte': return typeof actual === 'number' && typeof expected === 'number' && actual >= expected
      case 'lt': return typeof actual === 'number' && typeof expected === 'number' && actual < expected
      case 'lte': return typeof actual === 'number' && typeof expected === 'number' && actual <= expected
      case 'contains': return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)
      case 'in': return Array.isArray(expected) && expected.some((v) => v === actual)
      default: return false
    }
  }

  /** A leaf whose device or cap is currently unresolvable is FALSE and logs.
   *  It never throws the pass away, and it never counts as true. */
  async function leaf(
    deviceId: number,
    cap: string,
    fieldPath: string,
    operator: string,
    expected: unknown,
  ): Promise<boolean> {
    const actual = await readField(deviceId, cap, fieldPath)
    if (actual === undefined) {
      ctx.logger.warn('condition leaf unresolvable — treated as false', {
        tags: { deviceId },
        cap,
        fieldPath,
      })
      return false
    }
    return compare(actual, operator, expected)
  }

  /** The expression leaf goes through the bounded engine — parsed AST, no
   *  member access, no loops, hard step/node limits. Never inline JS. */
  async function exprLeaf(
    expr: string,
    bindings: Record<string, { kind?: string; cap?: string; fieldPath?: string; value?: unknown; sourceStableId?: string }>,
  ): Promise<boolean> {
    const values: Record<string, string | number | boolean | null> = {}
    for (const [alias, binding] of Object.entries(bindings)) {
      if (binding.kind === 'literal') {
        values[alias] = toExpressionValue(binding.value) ?? null
        continue
      }
      const deviceId = await stableIdToDeviceId(binding.sourceStableId)
      if (deviceId === undefined) {
        ctx.logger.warn('condition leaf unresolvable — treated as false', {
          tags: { deviceId: -1 },
          binding: alias,
        })
        return false
      }
      const raw = await readField(deviceId, binding.cap ?? '', binding.fieldPath ?? '')
      values[alias] = toExpressionValue(raw) ?? null
    }
    const result = evaluateExpressionSource(expr, values, Date.now())
    if (!result.ok) {
      ctx.logger.warn('expression leaf failed — treated as false', { expr, error: result.error })
      return false
    }
    return result.value === true
  }

  async function stableIdToDeviceId(stableId: string | undefined): Promise<number | undefined> {
    if (stableId === undefined) return undefined
    try {
      const all = await ctx.api.deviceManager.listAll.query({})
      const hit = all.devices.find((d: { stableId?: string; id: number }) => d.stableId === stableId)
      return hit?.id
    } catch {
      return undefined
    }
  }

  async function allOf(children: Array<() => Promise<boolean>>): Promise<boolean> {
    for (const c of children) { if (!(await c())) return false }
    return true
  }
  async function anyOf(children: Array<() => Promise<boolean>>): Promise<boolean> {
    for (const c of children) { if (await c()) return true }
    return false
  }
  async function notOf(child: () => Promise<boolean>): Promise<boolean> {
    return !(await child())
  }

  /** A {$var} action target, resolved from the run's bag BEFORE dispatch — the
   *  action runner only ever sees a number. */
  function resolveTarget(vars: Record<string, unknown>, name: string): number {
    const raw = vars[name]
    if (typeof raw === 'number') return raw
    throw new Error('action target var "' + name + '" is not a device id')
  }

  /** Substitute {{vars.x}} slots. Substitution only — never evaluation. */
  function substitute(value: unknown, vars: Record<string, unknown>): unknown {
    if (typeof value !== 'string') return value
    return value.replace(/\\{\\{\\s*vars\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\}\\}/g, (_m, key: string) => {
      const v = vars[key]
      if (v === undefined) {
        ctx.logger.warn('template referenced a var that was never set', { var: key })
        return ''
      }
      return String(v)
    })
  }

  async function actuate(
    deviceId: number,
    cap: string,
    method: string,
    args: Record<string, unknown>,
    vars: Record<string, unknown>,
  ): Promise<void> {
    const resolved: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) resolved[k] = substitute(v, vars)
    // Forked-addon ctx.api namespaces are tRPC Proxies over a noop function
    // (typeof === 'function'), not plain objects — reject only null/undefined.
    const client: unknown = Reflect.get(ctx.api, capToRouterKey(cap))
    const proc: unknown =
      client !== null && client !== undefined ? Reflect.get(client as object, method) : undefined
    const mutate: unknown =
      proc !== null && proc !== undefined ? Reflect.get(proc as object, 'mutate') : undefined
    if (typeof mutate !== 'function') {
      throw new Error('no such device method: ' + cap + '.' + method)
    }
    await mutate({ ...resolved, deviceId })
  }

  async function evaluateConditions(): Promise<boolean> {
    return ${conditionExpr}
  }

  /** The THEN half. Stops at the first failure — continuing past a failed step
   *  executes an intent the operator never expressed. */
  async function runActions(vars: Record<string, unknown>): Promise<void> {
    for (let step = 0; step < ${recipe.actions.length}; step += 1) {
      try {
        switch (step) {
${recipe.actions.map((a, i) => emitAction(a, i)).join('\n')}
        }
      } catch (err: unknown) {
        ctx.logger.warn('action failed — stopping the sequence', {
          step,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
    }
  }

  async function run(trigger: Record<string, unknown>): Promise<void> {
    const vars: Record<string, unknown> = { ...trigger }
    const passed = await evaluateConditions()
    if (!passed) {
      ctx.logger.debug('automation did not run — conditions were false', { trigger })
      return
    }
    ctx.logger.info('automation running', { trigger })
    await runActions(vars)
  }

${recipe.triggers.map((t, i) => emitTrigger(t, i)).join('\n\n')}

  return () => {
    for (const dispose of disposers) dispose()
  }
}
`
}
