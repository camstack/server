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

import type { ActionTarget, ResolvedTarget, ResolveOrigin } from './action-target.js'
import { type ActionStep, normalizeCapStep } from './recipe.js'
import {
  type AutomationStepTrace,
  buildStepArgsTrace,
  MAX_STEP_DEVICE_OUTCOMES,
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
}

/** One step as the runner sees it: its meta and a closure that does the work. */
export interface RunnableStep {
  readonly meta: StepMeta
  run(scope: StepScope): Promise<void>
}

export interface StepFailure {
  readonly index: number
  readonly path: string
  readonly message: string
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
}

export interface RunStepsResult {
  readonly steps: readonly AutomationStepTrace[]
  readonly failed: boolean
  readonly aborted: boolean
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
    let deviceId: number | undefined = step.meta.deviceId
    let sent: Readonly<Record<string, unknown>> | undefined
    const perDevice: StepDeviceTrace[] = []
    let emptyReason: string | undefined
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
    }
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
        ...devicesTrace(),
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
        ...devicesTrace(),
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
}

/** How many devices of one step are driven at once. */
export const STEP_DEVICE_CONCURRENCY = 4

export interface ActionStepDeps {
  invokeCap(call: CapCall): Promise<void>
  sleep(ms: number): Promise<void>
  onMissingVar(name: string): void
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
export function buildActionSteps(
  steps: readonly ActionStep[],
  vars: StepVars,
  deps: ActionStepDeps,
): RunnableStep[] {
  return steps.map((step): RunnableStep => {
    const meta = stepMetaOfAction(step)
    if (step.kind === 'wait') {
      return { meta, run: () => deps.sleep(step.seconds * 1000) }
    }
    const normalized = normalizeCapStep(step)
    return {
      meta,
      run: async (scope) => {
        const resolved = resolveStepArgs(step.args ?? {}, vars, deps.onMissingVar)
        const args = isPlainRecord(resolved) ? resolved : {}
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
