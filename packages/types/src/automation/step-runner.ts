/**
 * The ONE step runner — shared by an internal Action and by the block an
 * automation recipe compiles to. It is pure: it knows nothing about `ctx`, the
 * hub or a clock beyond the functions it is handed.
 *
 * Contract (the one the NC runner it mirrors set): steps run in order, the
 * sequence STOPS at the first failure (continuing past a failed step executes
 * an intent the operator never expressed), and every step is traced — the ones
 * after a failure, or after an abort, are `not-run` with the reason.
 *
 * Flow control (#500) is the operator EXPRESSING that intent: a step marked
 * `continueOnError` is traced `failed-continued` and the sequence goes on; a
 * `stop` step ends the run on purpose, as a success or as a failure, and the
 * steps after it are `not-run` with its reason.
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
  type NestedStepTrace,
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
  /** End the run here, on purpose (#500): the later steps are `not-run` with this reason. */
  stop(reason: string, outcome: StepStopOutcome): void
  /** The step waited for something that did not come and the run goes on (#500): traced `timed-out`. */
  markTimedOut(reason: string): void
}

/** How a `stop` step ends the run: as a success, or as a failure. */
export type StepStopOutcome = 'ok' | 'failed'

/** The `stop` that ended a run. */
export interface StepStop {
  readonly reason: string
  readonly outcome: StepStopOutcome
  /** The step that stopped it. */
  readonly path: string
}

/** One step as the runner sees it: its meta and a closure that does the work. */
export interface RunnableStep {
  readonly meta: StepMeta
  run(scope: StepScope): Promise<void>
  /** The step's own `if` (#472): read when the step is reached. Absent = always runs. */
  readonly guard?: () => Promise<StepConditionVerdict>
  /** Run when the guard reads `false`; never when it reads `unknown`. */
  readonly otherwise?: readonly RunnableStep[]
  /** A failure of THIS step is traced `failed-continued` and the sequence goes on (#500). */
  readonly continueOnError?: boolean
  /** A `choose` step (#500): `run` is not called, the first branch that reads true is. */
  readonly choose?: RunnableChoose
  /** A `parallel` step (#500): `run` is not called, these are started together and all awaited. */
  readonly parallel?: readonly RunnableStep[]
  /** A `repeat` step (#500): `run` is not called, the steps are, once per iteration. */
  readonly repeat?: RunnableRepeat
}

/** What a loop's condition answers: go on, or end the loop and why. */
export type RepeatCheck =
  | { readonly go: true }
  | {
      readonly go: false
      readonly reason: string
      /** The condition could not be read: the loop ends and says so (D49). */
      readonly unknown?: true
    }

export interface RunnableRepeat {
  readonly steps: readonly RunnableStep[]
  /** The most iterations the loop runs, whatever its condition says. */
  readonly limit: number
  /** True when reaching `limit` means the condition never ended the loop: traced `timed-out`. */
  readonly limitIsTimeout: boolean
  /** Asked before iteration `n` (0-based): a `while`, or the next device of a list. */
  readonly before?: (iteration: number) => Promise<RepeatCheck>
  /** Asked after iteration `n`: an `until`. */
  readonly after?: (iteration: number) => Promise<RepeatCheck>
  /** A pause between two iterations, never after the last. */
  readonly between?: () => Promise<void>
}

/** One branch of a `choose`: its condition and the steps it runs. */
export interface RunnableBranch {
  readonly guard: () => Promise<StepConditionVerdict>
  readonly steps: readonly RunnableStep[]
}

export interface RunnableChoose {
  readonly branches: readonly RunnableBranch[]
  /** Run when every branch reads `false`; never when one reads `unknown`. */
  readonly otherwise?: readonly RunnableStep[]
}

/** What one branch of a `choose` read. */
interface BranchCheck {
  readonly condition: StepConditionResult
  readonly conditionReason: string
}

/** Which list of a `choose` runs, after reading its branches in order. */
type ChooseDecision =
  | { readonly kind: 'run'; readonly branch: string; readonly steps: readonly RunnableStep[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown'; readonly index: number; readonly reason: string }

interface ChooseReading {
  readonly checks: readonly BranchCheck[]
  readonly decision: ChooseDecision
}

/**
 * Read the branches in order and stop at the first that decides: `true` runs
 * it, `unknown` ends the choice with nothing run (D49). All `false` runs the
 * else list, when there is one.
 */
async function readChoose(choose: RunnableChoose): Promise<ChooseReading> {
  const checks: BranchCheck[] = []
  for (const [index, branch] of choose.branches.entries()) {
    const verdict = await readGuard(branch.guard)
    checks.push({ condition: verdict.result, conditionReason: verdict.reason })
    if (verdict.result === 'true') {
      return {
        checks,
        decision: { kind: 'run', branch: `branches.${index}`, steps: branch.steps },
      }
    }
    if (verdict.result === 'unknown') {
      return { checks, decision: { kind: 'unknown', index, reason: verdict.reason } }
    }
  }
  const otherwise = choose.otherwise ?? []
  return {
    checks,
    decision:
      otherwise.length === 0 ? { kind: 'none' } : { kind: 'run', branch: 'else', steps: otherwise },
  }
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
  /** Called for a step that failed and was passed over (`continueOnError`): work that was dropped says so. */
  readonly onContinuedFailure?: (failure: StepFailure) => void
  /** The index the first step of this list is traced at (a member of a `parallel` runs as a list of one). */
  readonly indexOffset?: number
}

export interface RunStepsResult {
  readonly steps: readonly AutomationStepTrace[]
  readonly failed: boolean
  readonly aborted: boolean
  /** Set when a `stop` step ended the run. */
  readonly stopped?: StepStop
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

/**
 * What a loop's condition says about going on. A `while` goes on while it
 * reads true, an `until` goes on while it reads false; `unknown` ends either,
 * with the reason (D49): a loop never runs on a value it could not read.
 */
export function repeatCheck(by: 'while' | 'until', verdict: StepConditionVerdict): RepeatCheck {
  if (verdict.result === 'unknown') {
    return {
      go: false,
      reason: `the condition could not be read: ${verdict.reason}`,
      unknown: true,
    }
  }
  if (by === 'while') {
    return verdict.result === 'true'
      ? { go: true }
      : { go: false, reason: 'the condition is no longer true' }
  }
  return verdict.result === 'true' ? { go: false, reason: 'the condition is true' } : { go: true }
}

/** A loop condition that throws ends the loop as unreadable, never a crash of the run. */
async function readRepeatCheck(
  check: ((iteration: number) => Promise<RepeatCheck>) | undefined,
  iteration: number,
): Promise<RepeatCheck> {
  if (check === undefined) return { go: true }
  try {
    return await check(iteration)
  } catch (err: unknown) {
    return {
      go: false,
      reason: `the condition could not be read: ${errorMessage(err)}`,
      unknown: true,
    }
  }
}

/** How a loop ended, before it is written on its trace row. */
interface RepeatRun {
  readonly iterations: number
  readonly last: RunStepsResult | undefined
  /** Why the loop ended on its own; absent when a failure, a stop or an abort ended it. */
  readonly ended?: string
  readonly timedOut: boolean
  readonly unknown?: string
}

/** Run a loop's steps until its count, its condition, its bound, a failure, a stop or an abort ends it. */
async function runRepeat(
  repeat: RunnableRepeat,
  options: RunStepsOptions,
  path: string,
): Promise<RepeatRun> {
  let iterations = 0
  let last: RunStepsResult | undefined
  for (;;) {
    if (options.isAborted()) return { iterations, last, timedOut: false }
    const before = await readRepeatCheck(repeat.before, iterations)
    if (!before.go) {
      return {
        iterations,
        last,
        ended: before.reason,
        timedOut: false,
        ...(before.unknown === true ? { unknown: before.reason } : {}),
      }
    }
    if (iterations >= repeat.limit) {
      return repeat.limitIsTimeout
        ? { iterations, last, ended: `stopped at ${repeat.limit} iterations`, timedOut: true }
        : { iterations, last, ended: '', timedOut: false }
    }
    last = await runSteps(repeat.steps, {
      ...options,
      pathPrefix: `${path}.steps`,
      indexOffset: 0,
    })
    iterations += 1
    if (last.failed || last.aborted || last.stopped !== undefined) {
      return { iterations, last, timedOut: false }
    }
    const after = await readRepeatCheck(repeat.after, iterations - 1)
    if (!after.go) {
      return {
        iterations,
        last,
        ended: after.reason,
        timedOut: false,
        ...(after.unknown === true ? { unknown: after.reason } : {}),
      }
    }
    if (repeat.between !== undefined && iterations < repeat.limit) await repeat.between()
  }
}

/** The else level of a trace is one level deep: a nested trace carries no `else` of its own. */
function withoutElse(trace: AutomationStepTrace): Omit<AutomationStepTrace, 'else'> {
  const { else: _else, ...rest } = trace
  return rest
}

/** A plain row: the last level of a trace carries no list of its own. */
function plainRow(trace: AutomationStepTrace): Omit<NestedStepTrace, 'steps'> {
  const { else: _else, steps: _steps, ...rest } = trace
  return rest
}

/** A row one level down: it keeps its own steps as plain rows, and no `else`. */
function withoutNested(trace: AutomationStepTrace): NestedStepTrace {
  const { else: _else, steps, ...rest } = trace
  return steps === undefined ? rest : { ...rest, steps: steps.map(plainRow) }
}

export async function runSteps(
  steps: readonly RunnableStep[],
  options: RunStepsOptions,
): Promise<RunStepsResult> {
  const traces: AutomationStepTrace[] = []
  let failed = false
  let aborted = false
  let stopped: StepStop | undefined
  for (const [position, step] of steps.entries()) {
    const index = position + (options.indexOffset ?? 0)
    const path = `${options.pathPrefix}.${index}`
    if (stopped !== undefined) {
      traces.push({
        ...step.meta,
        path,
        outcome: 'not-run',
        message: `stopped at ${stopped.path}: ${stopped.reason}`,
      })
      continue
    }
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
    if (step.parallel !== undefined) {
      const members = await Promise.all(
        step.parallel.map((member, at) =>
          runSteps([member], { ...options, pathPrefix: `${path}.steps`, indexOffset: at }),
        ),
      )
      const anyFailed = members.some((m) => m.failed)
      if (anyFailed) failed = true
      else if (members.some((m) => m.aborted)) aborted = true
      traces.push({
        ...step.meta,
        path,
        startedAt,
        endedAt: options.now(),
        outcome: anyFailed ? 'error' : 'ok',
        ...(anyFailed ? { message: 'a parallel step failed' } : {}),
        steps: members.flatMap((m) => m.steps.map(withoutNested)),
      })
      continue
    }
    if (step.repeat !== undefined) {
      const loop = await runRepeat(step.repeat, options, path)
      const sub = loop.last
      if (loop.unknown !== undefined) {
        options.onGuardUnknown?.({
          index,
          path: `${path}.loop.when`,
          reason: loop.unknown,
          deviceId: step.meta.deviceId,
        })
      }
      const bodyFailed = loop.ended === undefined && sub?.failed === true
      if (bodyFailed) failed = true
      else if (loop.ended === undefined && sub?.stopped !== undefined) stopped = sub.stopped
      else if (loop.ended === undefined) aborted = true
      const times = `ran ${loop.iterations} times`
      const message = bodyFailed
        ? `a step failed in iteration ${loop.iterations}`
        : loop.ended === undefined
          ? times
          : loop.timedOut
            ? loop.ended
            : loop.ended === ''
              ? times
              : `${times}: ${loop.ended}`
      traces.push({
        ...step.meta,
        path,
        startedAt,
        endedAt: options.now(),
        outcome: bodyFailed ? 'error' : loop.timedOut ? 'timed-out' : 'ok',
        message,
        iterations: loop.iterations,
        ...(sub === undefined ? {} : { steps: sub.steps.map(withoutNested) }),
      })
      continue
    }
    if (step.choose !== undefined) {
      const reading = await readChoose(step.choose)
      const base = { ...step.meta, path, startedAt, branchChecks: [...reading.checks] }
      const { decision } = reading
      if (decision.kind !== 'run') {
        if (decision.kind === 'unknown') {
          options.onGuardUnknown?.({
            index,
            path: `${path}.branches.${decision.index}.if`,
            reason: decision.reason,
            deviceId: step.meta.deviceId,
          })
        }
        traces.push({
          ...base,
          endedAt: options.now(),
          outcome: 'skipped',
          message:
            decision.kind === 'unknown'
              ? `not run: branch ${decision.index + 1} could not be read (${decision.reason})`
              : 'not run: no branch is true',
        })
        continue
      }
      const listPath =
        decision.branch === 'else' ? `${path}.else` : `${path}.${decision.branch}.steps`
      const sub = await runSteps(decision.steps, {
        ...options,
        pathPrefix: listPath,
        indexOffset: 0,
      })
      if (sub.failed) failed = true
      else if (sub.aborted) aborted = true
      if (sub.stopped !== undefined) stopped = sub.stopped
      traces.push({
        ...base,
        endedAt: options.now(),
        outcome: sub.failed ? 'error' : 'ok',
        ...(sub.failed ? { message: 'a step of the branch failed' } : {}),
        branch: decision.branch,
        steps: sub.steps.map(withoutNested),
      })
      continue
    }
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
        const sub = await runSteps(branch, {
          ...options,
          pathPrefix: `${path}.else`,
          indexOffset: 0,
        })
        if (sub.failed) failed = true
        else if (sub.aborted) aborted = true
        if (sub.stopped !== undefined) stopped = sub.stopped
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
    let timedOutReason: string | undefined
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
      stop: (reason, outcome) => {
        stopped = { reason, outcome, path }
      },
      markTimedOut: (reason) => {
        timedOutReason = reason
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
      // a closure wrote it: read it back through a call so the narrowing above does not hide it
      const stop = ((): StepStop | undefined => stopped)()
      if (stop !== undefined) {
        const message = `stopped: ${stop.reason}`
        if (stop.outcome === 'failed') {
          failed = true
          options.onFailure({ index, path, message, deviceId })
        }
        traces.push({
          ...step.meta,
          ...guardTrace,
          path,
          startedAt,
          endedAt: options.now(),
          outcome: stop.outcome === 'failed' ? 'error' : 'ok',
          message,
        })
        continue
      }
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
        outcome:
          timedOutReason !== undefined ? 'timed-out' : emptyReason === undefined ? 'ok' : 'empty',
        ...(timedOutReason !== undefined
          ? { message: timedOutReason }
          : emptyReason === undefined
            ? {}
            : { message: emptyReason }),
      })
    } catch (err: unknown) {
      const message = errorMessage(err)
      const continued = step.continueOnError === true
      if (continued) {
        options.onContinuedFailure?.({ index, path, message, deviceId })
      } else {
        failed = true
        options.onFailure({ index, path, message, deviceId })
      }
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
        outcome: continued ? 'failed-continued' : 'error',
        message,
      })
    }
  }
  return {
    steps: traces,
    failed,
    aborted: aborted && !failed,
    ...(stopped === undefined ? {} : { stopped }),
  }
}

/** The bag of values `{ $var }` and `{{vars.x}}` read from. */
export type StepVars = Readonly<Record<string, unknown>>

function isVarRef(value: unknown): value is { readonly $var: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === '$var' && typeof Reflect.get(value, '$var') === 'string'
}

/** `{{vars.name}}`, or a dotted name (`{{vars.data.channel}}`): the bag is flat, the dots are part of the key. */
const TEMPLATE_RE = /\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g

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
  return new RegExp(`${VAR_SLOT_OPEN}${nonce}:([A-Za-z_][A-Za-z0-9_.]*)${VAR_SLOT_CLOSE}`, 'g')
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
