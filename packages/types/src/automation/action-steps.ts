/**
 * The runnable form of an Action's steps: every kind an automation's Then has
 * except `code` (which is bundled into a block of its own), built for the ONE
 * runner (`runSteps`). Variables are substituted per step, at the moment it
 * runs, so a missing one fails THAT step (traced) and leaves the later ones
 * not-run.
 *
 * What a step does when it runs is in `step-bodies.ts`, shared with the block
 * an automation compiles to. The switch below is exhaustive: a step kind added
 * to `ActionStep` without a builder here does not compile.
 */
import { vocabCall } from '../device/cap-vocabulary/action-index.js'
import type { ActionStep, AutomationBodyStep, AutomationBranchStep } from './recipe.js'
import type { AutomationWhen } from './when.js'
import {
  type BodyEnv,
  repeatLoopFields,
  runActionBody,
  runHttpBody,
  runNotifyBody,
  runProbeBody,
  runSetBody,
  runWaitUntilBody,
  type RepeatBodyEnv,
} from './step-bodies.js'
import type { StepConditionVerdict } from './step-condition.js'
import {
  type ActionStepDeps,
  commandStepMeta,
  isPlainRecord,
  resolveStepArgs,
  resolveStepArgsWithTemplates,
  type RunnableStep,
  runForDevices,
  type StepMeta,
  type StepScope,
  type StepVars,
} from './step-runner.js'

/** How often a `wait-until` of an Action re-reads its condition when the consumer does not say. */
export const ACTION_WAIT_POLL_MS = 5_000

/** Any step the builder takes: an Action's own, or one nested in a block. */
type BuildableStep = ActionStep | AutomationBodyStep | AutomationBranchStep

interface BuildContext {
  /** The run's variable bag, written by `set`, `probe` and `http-request`. */
  readonly bag: Record<string, unknown>
  readonly deps: ActionStepDeps
  /** Whether the list being built sits inside a block step (`choose`, `repeat`, `parallel`). */
  readonly nested: boolean
}

const NO_EVALUATOR: StepConditionVerdict = {
  result: 'unknown',
  reason: 'this consumer has no condition evaluator',
}

function stepMetaOf(step: BuildableStep): StepMeta {
  switch (step.kind) {
    case 'command':
      return commandStepMeta(step.target, step.actionId)
    case 'wait':
    case 'action':
    case 'notify':
    case 'probe':
    case 'http-request':
    case 'wait-until':
    case 'set':
    case 'stop':
    case 'choose':
    case 'parallel':
    case 'repeat':
      return { kind: step.kind }
    default:
      return assertNever(step)
  }
}

function assertNever(step: never): never {
  throw new Error(`step kind not handled by the Action runner: ${JSON.stringify(step)}`)
}

/** The step needs an effect this consumer did not provide: it fails when it RUNS, with the name of what is missing. */
function missing(kind: string, what: string): Error {
  return new Error(`this consumer cannot run a ${kind} step: it has no ${what}`)
}

function bodyEnv(ctx: BuildContext): BodyEnv {
  const { deps, bag } = ctx
  return {
    vars: bag,
    substitute: (value) => resolveStepArgs(value, bag, (name) => deps.onMissingVar(name)),
    sleep: (ms) => deps.sleep(ms),
    now: deps.now ?? Date.now,
    isAborted: deps.isAborted ?? (() => false),
    info: (message, meta) => deps.info?.(message, meta),
  }
}

function readerOf(ctx: BuildContext): (when: AutomationWhen) => Promise<StepConditionVerdict> {
  const evaluate = ctx.deps.evaluateCondition
  return async (when) => (evaluate === undefined ? NO_EVALUATOR : evaluate(when))
}

/** The guard and the else list of a step (#472), bound to the run; `{}` for an unguarded step. */
function guardOf(
  step: BuildableStep,
  ctx: BuildContext,
): Pick<RunnableStep, 'guard' | 'otherwise'> {
  const when = 'if' in step ? step.if : undefined
  if (when === undefined) return {}
  const read = readerOf(ctx)
  const otherwise = 'else' in step ? step.else : undefined
  return {
    guard: () => read(when),
    ...(otherwise === undefined ? {} : { otherwise: buildList(otherwise, ctx) }),
  }
}

/** A device command: resolve the target, substitute the args, dispatch one call per device. */
async function runCommand(
  step: Extract<BuildableStep, { kind: 'command' }>,
  scope: StepScope,
  ctx: BuildContext,
): Promise<void> {
  const { deps, bag } = ctx
  // an unknown action id fails HERE, at run, before its target is resolved
  vocabCall(step.actionId, undefined)
  const templated = await resolveStepArgsWithTemplates(
    step.args ?? {},
    bag,
    (name) => deps.onMissingVar(name),
    deps.renderTemplates,
  )
  if (templated.notes.length > 0) scope.setTemplateNotes(templated.notes)
  const args = isPlainRecord(templated.value) ? templated.value : {}
  const target = await deps.resolveTarget(step.target, step.actionId, bag, {
    actionId: step.actionId,
    owner: deps.owner,
  })
  if (target.deviceIds.length === 0) {
    scope.markEmpty(target.emptyReason ?? 'the target matched no device')
    return
  }
  // the one place the action id becomes a cap method (baked args win)
  const call = vocabCall(step.actionId, args)
  scope.setArgs(args)
  const [only] = target.deviceIds
  if (target.deviceIds.length === 1 && only !== undefined) {
    scope.setDeviceId(only)
    await deps.invokeCap({ deviceId: only, cap: call.cap, method: call.method, args: call.args })
    return
  }
  await runForDevices(target.deviceIds, scope, (deviceId) =>
    deps.invokeCap({ deviceId, cap: call.cap, method: call.method, args: call.args }),
  )
}

function buildStep(step: BuildableStep, ctx: BuildContext, path: string): RunnableStep {
  const { deps } = ctx
  const env = bodyEnv(ctx)
  const read = readerOf(ctx)
  const meta = stepMetaOf(step)
  const common = {
    meta,
    ...guardOf(step, ctx),
    ...(step.enabled === false ? { disabled: true as const } : {}),
    ...('continueOnError' in step && step.continueOnError === true
      ? { continueOnError: true }
      : {}),
  }
  const inside: BuildContext = { ...ctx, nested: true }
  switch (step.kind) {
    case 'wait':
      return { ...common, run: () => deps.sleep(step.seconds * 1000) }
    case 'command':
      return { ...common, run: (scope) => runCommand(step, scope, ctx) }
    case 'action': {
      const run = deps.runAction
      return {
        ...common,
        run: async () => {
          if (run === undefined) throw missing('action', 'way to run another action')
          await runActionBody(step, { ...env, run })
        },
      }
    }
    case 'notify': {
      const send = deps.sendNotification
      return {
        ...common,
        run: async () => {
          if (send === undefined) throw missing('notify', 'notification sender')
          await runNotifyBody(step, { ...env, send })
        },
      }
    }
    case 'probe': {
      const connect = deps.connect
      return {
        ...common,
        run: async (scope) => {
          if (connect === undefined) throw missing('probe', 'network access')
          await runProbeBody(step, scope, { ...env, connect })
        },
      }
    }
    case 'http-request': {
      const fetchFn = deps.fetch
      return {
        ...common,
        run: async (scope) => {
          if (fetchFn === undefined) throw missing('http-request', 'network access')
          await runHttpBody(step, scope, { ...env, fetch: fetchFn })
        },
      }
    }
    case 'wait-until': {
      const poll = deps.waitPollMs ?? ACTION_WAIT_POLL_MS
      return {
        ...common,
        run: (scope) =>
          runWaitUntilBody(
            step,
            scope,
            {
              ...env,
              read: () => read(step.when),
              // nothing wakes an Action: it re-reads on a fixed pause, never past the timeout
              nextWake: (ms) => deps.sleep(Math.min(ms, poll)),
            },
            path,
          ),
      }
    }
    case 'set':
      return { ...common, run: async () => runSetBody(step, env) }
    case 'stop':
      return {
        ...common,
        run: async (scope) => {
          scope.stop(String(env.substitute(step.reason)), step.outcome)
        },
      }
    case 'choose':
      return {
        ...common,
        run: async () => {},
        choose: {
          branches: step.branches.map((branch, at) => ({
            guard: () => read(branch.if),
            steps: buildList(branch.steps, inside, `${path}.branches.${at}.steps`),
          })),
          ...(step.else === undefined
            ? {}
            : { otherwise: buildList(step.else, inside, `${path}.else`) }),
        },
      }
    case 'parallel':
      return {
        ...common,
        run: async () => {},
        parallel: buildList(step.steps, inside, `${path}.steps`),
      }
    case 'repeat': {
      const repeatEnv: RepeatBodyEnv = { ...env, read }
      return {
        ...common,
        run: async () => {},
        repeat: {
          steps: buildList(step.steps, inside, `${path}.steps`),
          ...repeatLoopFields(step.loop, repeatEnv, ctx.nested),
        },
      }
    }
    default:
      return assertNever(step)
  }
}

function buildList(
  steps: readonly BuildableStep[],
  ctx: BuildContext,
  path = 'steps',
): RunnableStep[] {
  return steps.map((step, at) => buildStep(step, ctx, `${path}.${at}`))
}

/**
 * The runnable form of an Action's steps, bound to one run's variables. The
 * bag is copied: `set`, `probe` and `http-request` write to THIS run's copy.
 */
export function buildActionSteps(
  steps: readonly ActionStep[],
  vars: StepVars,
  deps: ActionStepDeps,
): RunnableStep[] {
  return buildList(steps, { bag: { ...vars }, deps, nested: false })
}
