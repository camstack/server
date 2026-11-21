/**
 * What a plain step DOES when it runs — the semantics of probe, http-request,
 * wait-until, set, notify and action, in ONE place. Two consumers call them:
 * the runner of an Action (`buildActionSteps`) and the block an automation
 * compiles to (`emitStepBody` emits a call to the same function), so a step
 * kind cannot behave one way in an Action and another in an automation.
 *
 * Pure: everything impure (clock, fetch, a TCP connect, the log) arrives in
 * {@link BodyEnv}.
 */
import {
  type AutomationHttpRequestStep,
  type AutomationRepeatLoop,
  REPEAT_ITEM_VAR,
  type AutomationNotifyStep,
  type AutomationProbeStep,
  type AutomationRunActionStep,
  type AutomationSetStep,
  type AutomationWaitUntilStep,
} from './recipe.js'
import {
  type HttpFetch,
  reachVars,
  redactUrl,
  runHttpStep,
  runProbeStep,
  type TcpConnect,
} from './reach-steps.js'
import type { StepConditionVerdict } from './step-condition.js'
import { repeatCheck, type RunnableRepeat, type StepScope } from './step-runner.js'
import { waitTimedOutMessage, waitUntil } from './wait-until.js'

/** The run, as a step body sees it: its bag, a substituter bound to it, and the injected effects. */
export interface BodyEnv {
  /** The run's variable bag: `set`, `probe` and `http-request` write it. */
  readonly vars: Record<string, unknown>
  /** `{{vars.x}}` / `{ $var }` substitution over a value, bound to the bag. */
  substitute(value: unknown): unknown
  sleep(ms: number): Promise<void>
  now(): number
  isAborted(): boolean
  info(message: string, meta: Readonly<Record<string, unknown>>): void
}

function textOf(env: BodyEnv, value: string): string {
  return String(env.substitute(value))
}

/** Header values, substituted: the values are text, and are never logged. */
export function substituteTexts(
  env: BodyEnv,
  raw: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, textOf(env, value)]))
}

/** The variables handed to an Action step, substituted and kept to primitives. */
export function substituteRunVariables(
  env: BodyEnv,
  raw: Readonly<Record<string, string | number | boolean>>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(raw)) {
    const resolved = env.substitute(value)
    if (
      typeof resolved === 'string' ||
      typeof resolved === 'number' ||
      typeof resolved === 'boolean'
    ) {
      out[key] = resolved
    }
  }
  return out
}

export interface ProbeBodyEnv extends BodyEnv {
  readonly connect: TcpConnect
}

/** A TCP reachability probe: one measurement, an expectation, an optional retry window. */
export async function runProbeBody(
  step: AutomationProbeStep,
  scope: StepScope,
  env: ProbeBodyEnv,
): Promise<void> {
  const host = textOf(env, step.host)
  const probed = await runProbeStep(
    { connect: env.connect, now: env.now, sleep: env.sleep, isAborted: env.isAborted },
    {
      host,
      port: step.port,
      timeoutSeconds: step.timeoutSeconds,
      ...(step.expect === undefined ? {} : { expect: step.expect }),
      ...(step.retryUntilSeconds === undefined
        ? {}
        : { retryUntilSeconds: step.retryUntilSeconds }),
    },
  )
  if (step.saveAs !== undefined) Object.assign(env.vars, reachVars(step.saveAs, probed.result))
  scope.setAttempts(probed.attempts, probed.message)
  env.info('probe finished', {
    host,
    port: step.port,
    met: probed.met,
    attempts: probed.attempts,
    rttMs: probed.result.rttMs,
  })
  if (!probed.met) throw new Error(`probe: ${probed.message}`)
}

export interface HttpBodyEnv extends BodyEnv {
  readonly fetch: HttpFetch
}

/**
 * An HTTP request: one measurement, an expectation, an optional retry window.
 * Header values and the body are never logged or traced.
 */
export async function runHttpBody(
  step: AutomationHttpRequestStep,
  scope: StepScope,
  env: HttpBodyEnv,
): Promise<void> {
  const url = textOf(env, step.url)
  scope.setArgs({ method: step.method, url: redactUrl(url) })
  const startedAt = env.now()
  const requested = await runHttpStep(
    { fetch: env.fetch, now: env.now, sleep: env.sleep, isAborted: env.isAborted },
    {
      method: step.method,
      url,
      timeoutSeconds: step.timeoutSeconds,
      ...(step.headers === undefined ? {} : { headers: substituteTexts(env, step.headers) }),
      ...(step.body === undefined ? {} : { body: textOf(env, step.body) }),
      ...(step.expect === undefined ? {} : { expect: step.expect }),
      ...(step.retryUntilSeconds === undefined
        ? {}
        : { retryUntilSeconds: step.retryUntilSeconds }),
    },
  )
  if (step.saveAs !== undefined) Object.assign(env.vars, reachVars(step.saveAs, requested.result))
  scope.setAttempts(requested.attempts, requested.message)
  env.info('http request finished', {
    method: step.method,
    url: redactUrl(url),
    status: requested.result.status,
    met: requested.met,
    attempts: requested.attempts,
    durationMs: env.now() - startedAt,
  })
  if (!requested.met) throw new Error(`http request: ${requested.message}`)
}

/** Write the run's own bag, for the steps after this one — substitution only, never evaluation. */
export function runSetBody(step: Pick<AutomationSetStep, 'vars'>, env: BodyEnv): void {
  Object.assign(env.vars, substituteRunVariables(env, step.vars))
}

export interface WaitUntilBodyEnv extends BodyEnv {
  /** Read the step's condition NOW. */
  read(): Promise<StepConditionVerdict>
  /** Resolve at the next reason to read again, and no later than `ms` from now. */
  nextWake(ms: number): Promise<void>
}

/** Pause until the condition is true; at the timeout, `continue` marks the step timed out, `stop` ends the run as a failure. */
export async function runWaitUntilBody(
  step: AutomationWaitUntilStep,
  scope: StepScope,
  env: WaitUntilBodyEnv,
  path: string,
): Promise<void> {
  const waited = await waitUntil({
    read: env.read,
    timeoutMs: step.timeoutS * 1000,
    now: env.now,
    isAborted: env.isAborted,
    nextWake: env.nextWake,
  })
  if (waited.result !== 'timed-out') return
  const message = waitTimedOutMessage(step.timeoutS, waited.lastReason)
  env.info('wait-until timed out', {
    step: path,
    onTimeout: step.onTimeout,
    reason: waited.lastReason,
  })
  if (step.onTimeout === 'stop') scope.stop(message, 'failed')
  else scope.markTimedOut(message)
}

/** What a notification send answered (the shape `sendToExportedTarget` returns). */
export type NotifySendResult =
  | { readonly status: 'sent' }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'failed'; readonly message: string }

export interface NotifyBodyEnv extends BodyEnv {
  send(input: {
    readonly targetId: string
    readonly title?: string
    readonly body: string
  }): Promise<NotifySendResult>
}

/** A notification through one target: the one send path the exporters use. */
export async function runNotifyBody(step: AutomationNotifyStep, env: NotifyBodyEnv): Promise<void> {
  const sent = await env.send({
    targetId: step.targetId,
    body: textOf(env, step.body),
    ...(step.title === undefined ? {} : { title: textOf(env, step.title) }),
  })
  if (sent.status === 'refused') throw new Error(`notification target ${sent.reason}`)
  if (sent.status === 'failed') throw new Error(`notification failed: ${sent.message}`)
}

/** What a run of another Action answered. */
export interface RunActionResult {
  readonly outcome: string
  readonly message?: string | undefined
}

export interface RunActionBodyEnv extends BodyEnv {
  run(input: {
    readonly actionId: string
    readonly variables: Readonly<Record<string, string | number | boolean>>
  }): Promise<RunActionResult>
}

/** An Action run, awaited: the step takes THAT run's outcome. */
export async function runActionBody(
  step: AutomationRunActionStep,
  env: RunActionBodyEnv,
): Promise<void> {
  const result = await env.run({
    actionId: step.actionId,
    variables: substituteRunVariables(env, step.variables ?? {}),
  })
  if (result.outcome !== 'ran') {
    throw new Error(
      `action ${step.actionId} ${result.outcome}${result.message === undefined ? '' : `: ${result.message}`}`,
    )
  }
}

export interface RepeatBodyEnv extends BodyEnv {
  /** Read a loop's condition NOW. */
  read(
    when: Extract<AutomationRepeatLoop, { by: 'while' | 'until' }>['when'],
  ): Promise<StepConditionVerdict>
}

/** How a `repeat` decides its iterations, as the fields of a RunnableRepeat. */
export type RepeatLoopFields = Pick<
  RunnableRepeat,
  'limit' | 'limitIsTimeout' | 'before' | 'after' | 'between'
>

/**
 * `nested` is whether the loop sits inside a block step: a `forEach` one level
 * down gives back the device of the loop around it, when there is one; any
 * other loop leaves its last device in place.
 */
export function repeatLoopFields(
  loop: AutomationRepeatLoop,
  env: RepeatBodyEnv,
  nested: boolean,
): RepeatLoopFields {
  switch (loop.by) {
    case 'count':
      return { limit: loop.count, limitIsTimeout: false }
    case 'forEach': {
      // `before` is also called once past the last device (the runner reads it
      // before its limit): that call ends the loop.
      const ids = loop.target.ids
      let outer: unknown
      return {
        limit: ids.length,
        limitIsTimeout: false,
        before: async (iteration) => {
          if (iteration === 0) outer = env.vars[REPEAT_ITEM_VAR]
          const id = ids[iteration]
          if (id !== undefined) env.vars[REPEAT_ITEM_VAR] = id
          else if (nested && outer !== undefined) env.vars[REPEAT_ITEM_VAR] = outer
          return { go: true }
        },
      }
    }
    case 'while':
    case 'until': {
      const check = async () => repeatCheck(loop.by, await env.read(loop.when))
      const waitS = loop.waitS
      return {
        limit: loop.maxIterations,
        limitIsTimeout: true,
        ...(loop.by === 'while' ? { before: check } : { after: check }),
        ...(waitS === undefined ? {} : { between: () => env.sleep(waitS * 1000) }),
      }
    }
  }
}
