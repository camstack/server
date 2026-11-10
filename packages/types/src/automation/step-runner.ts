/**
 * The ONE step runner — shared by an internal Action and by the block an
 * automation recipe compiles to. It is pure: it knows nothing about `ctx`, the
 * hub or a clock beyond the functions it is handed.
 *
 * Contract (the one the NC runner it mirrors set): steps run in order, the
 * sequence STOPS at the first failure (continuing past a failed step executes
 * an intent the operator never expressed), and every step is traced — the ones
 * after a failure, or after an abort, are `not-run` with the reason.
 */

import type { CommandOriginClaim } from '../audit/device-transition.js'
import type { DeviceTemplateRender } from '../expression/device-template.js'
import type { ActionTarget, ResolvedTarget, ResolveOrigin } from './action-target.js'
import { type ActionStep, normalizeCapStep } from './recipe.js'
import type {
  EvaluateStepCondition,
  StepConditionResult,
  StepConditionVerdict,
} from './step-condition.js'
import {
  type AutomationStepTrace,
  buildStepArgsTrace,
  MAX_STEP_DEVICE_OUTCOMES,
  MAX_STEP_TEMPLATE_NOTES,
  type StepDeviceTrace,
} from './trace.js'

/** Static facts about a step, known before it runs. */
export interface StepMeta {
  readonly kind: string
  readonly cap?: string
  readonly method?: string
  /** The vocabulary action id the step performs, when it names one. */
  readonly actionId?: string
  readonly deviceId?: number
}

/** What a running step can tell the runner (the device a fan-out is on right now). */
export interface StepScope {
  setDeviceId(deviceId: number): void
  /** One device of a multi-device step finished — traced per device. */
  recordDevice(outcome: StepDeviceTrace): void
  /** The step's target resolved to no device: traced as `empty`, with the reason. */
  markEmpty(reason: string): void
  /** The parameters the step is sending NOW (substituted), for its trace. */
  setArgs(args: Readonly<Record<string, unknown>>): void
  /** The device values the step's templates printed as `—`, with the reason (D1021). */
  setTemplateNotes(notes: readonly string[]): void
}

/** One step as the runner sees it: its meta and a closure that does the work. */
export interface RunnableStep {
  readonly meta: StepMeta
  run(scope: StepScope): Promise<void>
  /** The step's own `if` (#472): read when the step is reached. Absent = always runs. */
  readonly guard?: () => Promise<StepConditionVerdict>
  /** Run when the guard reads `false`; never when it reads `unknown`. */
  readonly otherwise?: readonly RunnableStep[]
}

export interface StepFailure {
  readonly index: number
  readonly path: string
  readonly message: string
  readonly deviceId: number | undefined
}

/** A guarded step that was skipped because its condition could not be read (D49). */
export interface StepGuardUnknown {
  readonly index: number
  readonly path: string
  readonly reason: string
  readonly deviceId: number | undefined
}

export interface RunStepsOptions {
  /** `actions` for an automation, `steps` for an Action run. */
  readonly pathPrefix: string
  /** True once the run was cut short (a restart, a stop). Checked between steps. */
  readonly isAborted: () => boolean
  readonly abortReason: string
  readonly now: () => number
  /** Called once, for the step that failed. */
  readonly onFailure: (failure: StepFailure) => void
  /** Called for a step skipped because its `if` read unknown: a branch that drops work says so (#472). */
  readonly onGuardUnknown?: (skipped: StepGuardUnknown) => void
}

export interface RunStepsResult {
  readonly steps: readonly AutomationStepTrace[]
  readonly failed: boolean
  readonly aborted: boolean
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A guard that throws is an unknown, never a crash of the run. */
async function readGuard(
  guard: () => Promise<StepConditionVerdict>,
): Promise<StepConditionVerdict> {
  try {
    return await guard()
  } catch (err: unknown) {
    return { result: 'unknown', reason: `the condition could not be read: ${errorMessage(err)}` }
  }
}

/** The else level of a trace is one level deep: a nested trace carries no `else` of its own. */
function withoutElse(trace: AutomationStepTrace): Omit<AutomationStepTrace, 'else'> {
  const { else: _else, ...rest } = trace
  return rest
}

export async function runSteps(
  steps: readonly RunnableStep[],
  options: RunStepsOptions,
): Promise<RunStepsResult> {
  const traces: AutomationStepTrace[] = []
  let failed = false
  let aborted = false
  for (const [index, step] of steps.entries()) {
    const path = `${options.pathPrefix}.${index}`
    if (failed || aborted || options.isAborted()) {
      if (!failed) aborted = true
      traces.push({
        ...step.meta,
        path,
        outcome: 'not-run',
        message: failed ? 'an earlier step failed' : options.abortReason,
      })
      continue
    }
    const startedAt = options.now()
    let guardTrace: { condition?: StepConditionResult; conditionReason?: string } = {}
    if (step.guard !== undefined) {
      const verdict = await readGuard(step.guard)
      guardTrace = { condition: verdict.result, conditionReason: verdict.reason }
      if (verdict.result === 'unknown') {
        options.onGuardUnknown?.({
          index,
          path,
          reason: verdict.reason,
          deviceId: step.meta.deviceId,
        })
      }
      if (verdict.result !== 'true') {
        const branch = verdict.result === 'false' ? (step.otherwise ?? []) : []
        if (branch.length === 0) {
          traces.push({
            ...step.meta,
            ...guardTrace,
            path,
            startedAt,
            endedAt: options.now(),
            outcome: 'skipped',
            message:
              verdict.result === 'unknown'
                ? `not run: ${verdict.reason}`
                : `not run: the condition is false (${verdict.reason})`,
          })
          continue
        }
        const sub = await runSteps(branch, { ...options, pathPrefix: `${path}.else` })
        if (sub.failed) failed = true
        else if (sub.aborted) aborted = true
        traces.push({
          ...step.meta,
          ...guardTrace,
          path,
          startedAt,
          endedAt: options.now(),
          outcome: sub.failed ? 'error' : 'ok',
          ...(sub.failed ? { message: 'an else step failed' } : {}),
          else: sub.steps.map(withoutElse),
        })
        continue
      }
    }
    let deviceId: number | undefined = step.meta.deviceId
    let sent: Readonly<Record<string, unknown>> | undefined
    const perDevice: StepDeviceTrace[] = []
    let emptyReason: string | undefined
    let templateNotes: readonly string[] = []
    const scope: StepScope = {
      setDeviceId: (id) => {
        deviceId = id
      },
      recordDevice: (outcome) => {
        perDevice.push(outcome)
      },
      markEmpty: (reason) => {
        emptyReason = reason
      },
      setArgs: (args) => {
        sent = args
      },
      setTemplateNotes: (notes) => {
        templateNotes = notes.slice(0, MAX_STEP_TEMPLATE_NOTES)
      },
    }
    const templatesTrace = (): { templates?: string[] } =>
      templateNotes.length === 0 ? {} : { templates: [...templateNotes] }
    const argsTrace = (): { args?: ReturnType<typeof buildStepArgsTrace> } =>
      sent === undefined ? {} : { args: buildStepArgsTrace(sent) }
    const devicesTrace = (): { devices?: StepDeviceTrace[] } =>
      perDevice.length === 0 ? {} : { devices: perDevice.slice(0, MAX_STEP_DEVICE_OUTCOMES) }
    try {
      await step.run(scope)
      traces.push({
        ...step.meta,
        ...(deviceId === undefined || perDevice.length > 1 ? {} : { deviceId }),
        ...argsTrace(),
        ...templatesTrace(),
        ...devicesTrace(),
        ...guardTrace,
        path,
        startedAt,
        endedAt: options.now(),
        outcome: emptyReason === undefined ? 'ok' : 'empty',
        ...(emptyReason === undefined ? {} : { message: emptyReason }),
      })
    } catch (err: unknown) {
      failed = true
      const message = errorMessage(err)
      options.onFailure({ index, path, message, deviceId })
      traces.push({
        ...step.meta,
        ...(deviceId === undefined || perDevice.length > 1 ? {} : { deviceId }),
        ...argsTrace(),
        ...templatesTrace(),
        ...devicesTrace(),
        ...guardTrace,
        path,
        startedAt,
        endedAt: options.now(),
        outcome: 'error',
        message,
      })
    }
  }
  return { steps: traces, failed, aborted: aborted && !failed }
}

/** The bag of values `{ $var }` and `{{vars.x}}` read from. */
export type StepVars = Readonly<Record<string, unknown>>

function isVarRef(value: unknown): value is { readonly $var: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === '$var' && typeof Reflect.get(value, '$var') === 'string'
}

const TEMPLATE_RE = /\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/**
 * Substitute a step's args from the run's variables. SUBSTITUTION only, never
 * evaluation:
 *  - a value that is exactly `{ $var: 'name' }` becomes the variable's value,
 *    keeping its type (a number stays a number);
 *  - `{{vars.name}}` inside a string becomes its text.
 * A variable that is not set THROWS — a step must not run with a hole where
 * the operator meant a value. (`{{vars.x}}` keeps the automation behaviour:
 * the hole is reported through `onMissing` and rendered empty.)
 */
export function resolveStepArgs(
  value: unknown,
  vars: StepVars,
  onMissing: (name: string) => void,
): unknown {
  if (isVarRef(value)) {
    const found = vars[value.$var]
    if (found === undefined) throw new Error(`variable "${value.$var}" is not set`)
    return found
  }
  if (typeof value === 'string') {
    return value.replace(TEMPLATE_RE, (_m, key: string) => {
      const v = vars[key]
      if (v === undefined) {
        onMissing(key)
        return ''
      }
      return String(v)
    })
  }
  if (Array.isArray(value)) return value.map((v) => resolveStepArgs(v, vars, onMissing))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveStepArgs(v, vars, onMissing)]),
    )
  }
  return value
}

/**
 * Renders device templates (D1021) — the hub's `device-manager` does the work;
 * a consumer reaches it through `ctx.api`. One call carries every template of a
 * step, and the answer is index-aligned with the question.
 */
export type RenderStepTemplates = (
  templates: readonly string[],
) => Promise<readonly DeviceTemplateRender[]>

/** A device template that did not render: the step fails with this, never throws past `runSteps`. */
export class StepTemplateError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(`device template [${reason}]: ${message}`)
    this.name = 'StepTemplateError'
  }
}

/**
 * A `{{vars.x}}` slot, set aside while a template renders. The slot carries a
 * nonce drawn per call, so a device value that happens to contain the sentinel
 * characters can never name a held variable.
 */
const VAR_SLOT_OPEN = '\uE000'
const VAR_SLOT_CLOSE = '\uE001'
const TEMPLATE_MARKUP_RE = /\{\{|\{%/

function newSlotNonce(): string {
  return Math.random().toString(36).slice(2, 12)
}

function slotPattern(nonce: string): RegExp {
  return new RegExp(`${VAR_SLOT_OPEN}${nonce}:([A-Za-z_][A-Za-z0-9_]*)${VAR_SLOT_CLOSE}`, 'g')
}

/** `text` with every `{{vars.x}}` slot (the only slot the run-time holds) replaced by `replacement`. */
export function holdVarSlots(text: string, replacement: string): string {
  return text.replace(TEMPLATE_RE, () => replacement)
}

/** True when a string, once its `{{vars.x}}` slots are set aside, still carries template markup. */
export function carriesDeviceTemplate(text: string): boolean {
  return TEMPLATE_MARKUP_RE.test(text.replace(TEMPLATE_RE, ''))
}

/** Every string in `value` that is a device template (D1021), de-duplicated, in walk order. */
export function collectDeviceTemplates(value: unknown): string[] {
  const found = new Set<string>()
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (carriesDeviceTemplate(node)) found.add(node)
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item)
    } else if (node !== null && typeof node === 'object') {
      for (const item of Object.values(node)) walk(item)
    }
  }
  walk(value)
  return [...found]
}

function protectVarSlots(text: string, nonce: string): string {
  return text.replace(
    TEMPLATE_RE,
    (_m, key: string) => `${VAR_SLOT_OPEN}${nonce}:${key}${VAR_SLOT_CLOSE}`,
  )
}

function restoreVarSlots(
  text: string,
  nonce: string,
  vars: StepVars,
  onMissing: (name: string) => void,
): string {
  return text.replace(slotPattern(nonce), (_m, key: string) => {
    const v = vars[key]
    if (v === undefined) {
      onMissing(key)
      return ''
    }
    return String(v)
  })
}

export interface TemplatedArgs {
  readonly value: unknown
  /** `ref: reason` per value that printed `—`, in render order, de-duplicated. */
  readonly notes: readonly string[]
}

/**
 * {@link resolveStepArgs} plus the device templates of a step (D1021). A string
 * that carries `{{ … }}` / `{% … %}` beyond a `{{vars.x}}` slot is rendered by
 * `render` BEFORE the variables are put in, so a variable's value is data and
 * never template source (an action variable can come from a non-admin caller).
 * A refused render, or no renderer, throws {@link StepTemplateError}: the step
 * fails with the typed reason and nothing is dispatched.
 */
export async function resolveStepArgsWithTemplates(
  value: unknown,
  vars: StepVars,
  onMissing: (name: string) => void,
  render: RenderStepTemplates | undefined,
): Promise<TemplatedArgs> {
  const nonce = newSlotNonce()
  const sources: string[] = []
  const indexOf = new Map<string, number>()
  const hold = (text: string): number => {
    const known = indexOf.get(text)
    if (known !== undefined) return known
    sources.push(text)
    indexOf.set(text, sources.length - 1)
    return sources.length - 1
  }
  class Pending {
    constructor(readonly index: number) {}
  }
  const collect = (node: unknown): unknown => {
    if (isVarRef(node)) return resolveStepArgs(node, vars, onMissing)
    if (typeof node === 'string') {
      return carriesDeviceTemplate(node)
        ? new Pending(hold(protectVarSlots(node, nonce)))
        : resolveStepArgs(node, vars, onMissing)
    }
    if (Array.isArray(node)) return node.map(collect)
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, collect(v)]))
    }
    return node
  }
  const skeleton = collect(value)
  if (sources.length === 0) return { value: skeleton, notes: [] }
  if (render === undefined) {
    throw new StepTemplateError('unavailable', 'this node has no device template renderer')
  }
  let answers: readonly DeviceTemplateRender[]
  try {
    answers = await render(sources)
  } catch (err: unknown) {
    throw new StepTemplateError('unavailable', errorMessage(err))
  }
  const texts: string[] = []
  const notes: string[] = []
  for (const index of sources.keys()) {
    const answer = answers[index]
    if (answer === undefined) {
      throw new StepTemplateError('unavailable', `no answer for template ${index + 1}`)
    }
    if (!answer.ok) throw new StepTemplateError(answer.refusal.reason, answer.refusal.message)
    texts.push(restoreVarSlots(answer.text, nonce, vars, onMissing))
    for (const entry of answer.trace) {
      const note = `${entry.ref}: ${entry.reason}`
      if (!notes.includes(note)) notes.push(note)
    }
  }
  const fill = (node: unknown): unknown => {
    if (node instanceof Pending) return texts[node.index] ?? ''
    if (Array.isArray(node)) return node.map(fill)
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v)]))
    }
    return node
  }
  return { value: fill(skeleton), notes }
}

/** A `{ $var }` device target, resolved from the bag BEFORE dispatch. */
export function resolveDeviceTarget(vars: StepVars, name: string): number {
  const raw = vars[name]
  if (typeof raw === 'number') return raw
  throw new Error(`action target var "${name}" is not a device id`)
}

export interface CapCall {
  readonly deviceId: number
  readonly cap: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  /** Why the call is made (an action run, a scheduler); recorded in the device transition audit (D1022). */
  readonly origin?: CommandOriginClaim
}

/** How many devices of one step are driven at once. */
export const STEP_DEVICE_CONCURRENCY = 4

export interface ActionStepDeps {
  invokeCap(call: CapCall): Promise<void>
  sleep(ms: number): Promise<void>
  onMissingVar(name: string): void
  /** Renders the device templates of a step's args (D1021); absent on a node that has none. */
  readonly renderTemplates?: RenderStepTemplates
  /** Reads a step's `if` (#472) on the state mirror; absent = a guarded step reads `unknown`. */
  readonly evaluateCondition?: EvaluateStepCondition
  /** Turn a step's target into device ids (an empty answer is logged by the resolver). */
  resolveTarget(
    target: ActionTarget,
    actionId: string | undefined,
    vars: StepVars,
    origin: ResolveOrigin,
  ): Promise<ResolvedTarget>
  /** The action / automation the steps belong to, for the log line of an empty target. */
  readonly owner?: string
}

function stepMetaOfAction(step: ActionStep): StepMeta {
  if (step.kind === 'wait') return { kind: 'wait' }
  const { target, actionId } = normalizeCapStep(step)
  return {
    kind: 'cap',
    cap: step.cap,
    method: step.method,
    ...(actionId === undefined ? {} : { actionId }),
    ...(target.kind === 'devices' && target.ids.length === 1 ? { deviceId: target.ids[0] } : {}),
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Run `work` for every device, `concurrency` at a time. EVERY device is tried
 * (one refusing device must not leave the others undone); each outcome goes to
 * the step's trace, in device order, and the step fails afterwards if any did.
 */
export async function runForDevices(
  deviceIds: readonly number[],
  scope: StepScope,
  work: (deviceId: number) => Promise<void>,
  concurrency: number = STEP_DEVICE_CONCURRENCY,
): Promise<void> {
  const outcomes: StepDeviceTrace[] = new Array(deviceIds.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const deviceId = deviceIds[index]
      if (deviceId === undefined) return
      try {
        await work(deviceId)
        outcomes[index] = { deviceId, outcome: 'ok' }
      } catch (err: unknown) {
        outcomes[index] = { deviceId, outcome: 'error', message: errorMessage(err) }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, deviceIds.length)) }, () => worker()),
  )
  for (const outcome of outcomes) scope.recordDevice(outcome)
  const failed = outcomes.filter((o) => o.outcome === 'error')
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} of ${outcomes.length} devices failed: ` +
        failed
          .slice(0, 3)
          .map((f) => `${f.deviceId}: ${f.message ?? 'failed'}`)
          .join('; '),
    )
  }
}

/**
 * The runnable form of an internal Action's steps, bound to one run's
 * variables. Variables are substituted per step, at the moment it runs, so a
 * missing one fails THAT step (traced) and leaves the later ones not-run.
 */
/** The guard and the else list of a step, bound to the run (#472); `{}` for an unguarded step. */
function guardOf(
  step: ActionStep,
  vars: StepVars,
  deps: ActionStepDeps,
): Pick<RunnableStep, 'guard' | 'otherwise'> {
  const when = step.if
  if (when === undefined) return {}
  const evaluate = deps.evaluateCondition
  return {
    guard: async () =>
      evaluate === undefined
        ? { result: 'unknown', reason: 'this consumer has no condition evaluator' }
        : evaluate(when),
    ...(step.else === undefined ? {} : { otherwise: buildActionSteps(step.else, vars, deps) }),
  }
}

export function buildActionSteps(
  steps: readonly ActionStep[],
  vars: StepVars,
  deps: ActionStepDeps,
): RunnableStep[] {
  return steps.map((step): RunnableStep => {
    const guarded = guardOf(step, vars, deps)
    const meta = stepMetaOfAction(step)
    if (step.kind === 'wait') {
      return { meta, ...guarded, run: () => deps.sleep(step.seconds * 1000) }
    }
    const normalized = normalizeCapStep(step)
    return {
      meta,
      ...guarded,
      run: async (scope) => {
        const templated = await resolveStepArgsWithTemplates(
          step.args ?? {},
          vars,
          deps.onMissingVar,
          deps.renderTemplates,
        )
        if (templated.notes.length > 0) scope.setTemplateNotes(templated.notes)
        const args = isPlainRecord(templated.value) ? templated.value : {}
        const target = await deps.resolveTarget(normalized.target, normalized.actionId, vars, {
          actionId: normalized.actionId,
          owner: deps.owner,
        })
        if (target.deviceIds.length === 0) {
          scope.markEmpty(target.emptyReason ?? 'the target matched no device')
          return
        }
        scope.setArgs(args)
        const [only] = target.deviceIds
        if (target.deviceIds.length === 1 && only !== undefined) {
          scope.setDeviceId(only)
          await deps.invokeCap({ deviceId: only, cap: step.cap, method: step.method, args })
          return
        }
        await runForDevices(target.deviceIds, scope, (deviceId) =>
          deps.invokeCap({ deviceId, cap: step.cap, method: step.method, args }),
        )
      },
    }
  })
}
