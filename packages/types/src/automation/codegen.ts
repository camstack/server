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

import type { AutomationAction, AutomationRecipe, AutomationTrigger } from './recipe.js'
import { DEFAULT_TRACE_KEEP, validateRecipeBounds } from './recipe.js'

export interface GenerateAutomationBlockInput {
  /** The block's name — the ONE name for the artefact (§2.1). */
  readonly name: string
  readonly recipe: AutomationRecipe
}

/** How often the state mirror is re-read as the backstop for a dropped event
 *  (D8: an event WAKES the evaluation, the reconcile guarantees it). */
const RECONCILE_MS = 15_000

interface StepMeta {
  readonly kind: string
  readonly cap?: string
  readonly method?: string
  readonly deviceId?: number
}

/** What a step trace shows before the step runs. */
function stepMetaOf(action: AutomationAction): StepMeta {
  switch (action.kind) {
    case 'wait':
      return { kind: 'wait' }
    case 'code':
      return { kind: 'code' }
    case 'action':
      return { kind: 'action' }
    case 'cap':
      return {
        kind: 'cap',
        cap: action.cap,
        method: action.method,
        ...(typeof action.deviceId === 'number' ? { deviceId: action.deviceId } : {}),
      }
  }
}

function j(value: unknown): string {
  return JSON.stringify(value)
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
  // ("Run actions"), which runs the THEN half with an EMPTY vars bag. A manual
  // run bypasses only the cooldown wait, never the single/queued limits.`
    case 'interval':
      return `  // trigger ${index}: interval — every ${trigger.minutes} min, first run jittered so
  // blocks restarted together do not all fire on the same second.
  {
    let interval: ReturnType<typeof setInterval> | undefined
    const first = setTimeout(() => {
      void run({ kind: 'interval', at: Date.now() })
      interval = setInterval(() => { void run({ kind: 'interval', at: Date.now() }) }, ${j(
        trigger.minutes * 60_000,
      )})
    }, Math.floor(Math.random() * Math.min(${j(trigger.minutes * 60_000)}, 30_000)) + 1)
    disposers.push(() => {
      clearTimeout(first)
      if (interval !== undefined) clearInterval(interval)
    })
  }`
    case 'detection':
      return `  // trigger ${index}: detection — ONE fire per (device, track); a rejected event is
  // traced with its reason and never fires.
  {
    const filter = new DetectionTriggerFilter(${j(trigger)})
    disposers.push(
      ctx.eventBus.subscribe(
        { category: EventCategory.PipelineAnalyticsTrackLifecycle },
        (event) => {
          const decision = filter.evaluate(event.data, Date.now())
          if (decision.kind === 'ignore') return
          if (decision.kind === 'reject') {
            ctx.logger.debug('detection trigger rejected an event', {
              tags: { deviceId: decision.vars.deviceId },
              reason: decision.reason,
            })
          }
          void run(
            { kind: 'detection', at: Date.now(), ...decision.vars },
            decision.reason,
            decision.kind === 'fire',
          )
        },
      ),
    )
  }`
  }
}

function emitAction(action: AutomationAction, index: number): string {
  const step = (body: string): string => `    {
      meta: STEP_META[${index}]!,
      run: async (scope) => {
${body}
      },
    },`
  switch (action.kind) {
    case 'wait':
      return step(`        await sleep(${j(action.seconds * 1000)})`)
    case 'cap': {
      if (Array.isArray(action.deviceId)) {
        return step(`        for (const deviceId of ${j(action.deviceId)}) {
          scope.setDeviceId(deviceId)
          await actuate(deviceId, ${j(action.cap)}, ${j(action.method)}, ${j(
            action.args ?? {},
          )}, vars)
        }`)
      }
      const target =
        typeof action.deviceId === 'number'
          ? j(action.deviceId)
          : `resolveTarget(vars, ${j(action.deviceId.$var)})`
      return step(`        const deviceId = ${target}
        scope.setDeviceId(deviceId)
        await actuate(deviceId, ${j(action.cap)}, ${j(action.method)}, ${j(
          action.args ?? {},
        )}, vars)`)
    }
    case 'action':
      return step(`        // an Action run, awaited: the step takes THAT run's outcome
        const result = await ctx.api.actions.run.mutate({
          actionId: ${j(action.actionId)},
          variables: substituteVariables(${j(action.variables ?? {})}, vars),
          wait: true,
          origin: { blockId: BLOCK_ID ?? undefined },
        })
        if (result.outcome !== 'ran') {
          throw new Error('action ' + ${j(action.actionId)} + ' ' + result.outcome + (result.message === undefined ? '' : ': ' + result.message))
        }`)
    case 'code':
      return step(`        // inline code action — a fragment of THIS block, bundled by esbuild
        await (async () => {
${action.code
  .split('\n')
  .map((line) => `          ${line}`)
  .join('\n')}
        })()`)
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
  const runMode = recipe.runMode ?? { mode: 'single' }
  const stepMeta = recipe.actions.map(stepMetaOf)

  return `import type {
  AddonContext,
  AutomationConditionTraceNode,
  AutomationRunTrace,
  AutomationRunVerdict,
  AutomationStepTrace,
  RunnableStep,
} from '@camstack/types'
import {
  ConditionMirror,
  DetectionTriggerFilter,
  EventCategory,
  RunGate,
  buildTriggerTrace,
  collectMirrorSources,
  coreBlockIdFromAddonId,
  evaluateConditionTree,
  isSkippedTrace,
  mergeSkipTraces,
  resolveDeviceTarget,
  resolveStepArgs,
  runSteps,
} from '@camstack/types'

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

/** How triggers that arrive while busy (or cooling down) are handled. */
const RUN_MODE = ${j(runMode)} as const

/** Run traces kept (a ring, held in the hub's runs ledger). */
const KEEP_TRACES = ${recipe.keepTraces ?? DEFAULT_TRACE_KEEP}

const CONDITIONS = ${recipe.conditions === undefined ? 'undefined' : 'AUTOMATION_RECIPE.conditions'}

/** Skips that repeat are folded into one trace; it goes to the hub after this. */
const SKIP_FLUSH_MS = 5_000

/** Static facts about each action step, for its trace. */
const STEP_META: ReadonlyArray<{ kind: string; cap?: string; method?: string; deviceId?: number }> = ${j(stepMeta)}

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
  const gate = new RunGate(RUN_MODE)
  const mirror = new ConditionMirror(collectMirrorSources(CONDITIONS))
  const BLOCK_ID = coreBlockIdFromAddonId(ctx.id)
  /** The cooldown stamp: memory is the authority at fire time (D49); the hub ledger is read once at start. */
  let lastRunStartedAt: number | null = null
  /** True when the stamp could not be read at start — the first run is let through and says so. */
  let stampUnknown = false
  let sendChain: Promise<void> = Promise.resolve()
  let pendingSkip: AutomationRunTrace | undefined
  let skipTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let runCounter = 0
  const runningTokens = new Set<RunToken>()
  const queue: QueuedRun[] = []

  interface RunToken {
    aborted: boolean
    wake?: () => void
  }
  interface QueuedRun {
    readonly trigger: Record<string, unknown>
    readonly reason: string
    readonly queuedAt: number
  }

  /** Sleep that a restart can cut short. */
  const abortableSleep = (ms: number, token: RunToken): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      token.wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })

  // ── the hub's runs ledger: the stamp is read ONCE here, the ring is written through RPC ──
  async function loadState(): Promise<void> {
    if (BLOCK_ID === null) {
      ctx.logger.warn('this is not a core-block addon id — no run ledger, cooldown and traces will not survive a restart', { addonId: ctx.id })
      return
    }
    try {
      const doc = await ctx.api.coreBlocks.getAutomationRunState.query({ blockId: BLOCK_ID })
      lastRunStartedAt = doc.lastRunStartedAt
    } catch (err: unknown) {
      stampUnknown = true
      ctx.logger.warn('could not read the stored cooldown stamp — the first run is let through', {
        blockId: BLOCK_ID,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function send(payload: { trace?: AutomationRunTrace; runStartedAt?: number }): Promise<void> {
    if (BLOCK_ID === null) return Promise.resolve()
    const blockId = BLOCK_ID
    sendChain = sendChain.then(async () => {
      try {
        await ctx.api.coreBlocks.reportAutomationRun.mutate({ blockId, keepTraces: KEEP_TRACES, ...payload })
      } catch (err: unknown) {
        ctx.logger.warn('could not report the run to the hub ledger', {
          blockId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
    return sendChain
  }

  function flushSkip(): void {
    if (skipTimer !== undefined) {
      clearTimeout(skipTimer)
      skipTimer = undefined
    }
    if (pendingSkip === undefined) return
    const trace = pendingSkip
    pendingSkip = undefined
    void send({ trace })
  }

  /** A skip identical to the one waiting is COUNTED on it; anything else flushes it first. */
  function record(trace: AutomationRunTrace): void {
    if (isSkippedTrace(trace)) {
      if (pendingSkip !== undefined) {
        const merged = mergeSkipTraces(pendingSkip, trace)
        if (merged !== null) {
          pendingSkip = merged
          return
        }
        flushSkip()
      }
      pendingSkip = trace
      skipTimer = setTimeout(flushSkip, SKIP_FLUSH_MS)
      return
    }
    flushSkip()
    void send({ trace })
  }

  // ── the condition mirror (D49): memory only at fire time ──
  async function refreshMirror(): Promise<void> {
    const report = await mirror.refresh({
      fetchSlice: (deviceId, cap) => ctx.api.deviceState.getCapSlice.query({ deviceId, capName: cap }),
      fetchStableIds: async () => {
        const all = await ctx.api.deviceManager.listAll.query({})
        return new Map(all.devices.flatMap((d: { stableId?: string; id: number }) =>
          d.stableId === undefined ? [] : [[d.stableId, d.id] as [string, number]]))
      },
    })
    if (report.kept > 0) {
      ctx.logger.debug('condition mirror kept stale values for sources it could not read', report)
    }
  }

  /** Read one cap field off the state mirror. Returns undefined when the device,
   *  the cap or the field cannot be resolved — the caller decides what that
   *  means, and it always logs. (Used by the device-state TRIGGER, which the
   *  reconcile backs; conditions read the ConditionMirror instead.) */
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

  /** A {$var} action target, resolved from the run's bag BEFORE dispatch — the
   *  action runner only ever sees a number. */
  function resolveTarget(vars: Record<string, unknown>, name: string): number {
    return resolveDeviceTarget(vars, name)
  }

  function warnMissingVar(name: string): void {
    ctx.logger.warn('template referenced a var that was never set', { var: name })
  }

  /** Substitute {{vars.x}} slots and { $var } values. Substitution only — never evaluation. */
  function substitute(value: unknown, vars: Record<string, unknown>): unknown {
    return resolveStepArgs(value, vars, warnMissingVar)
  }

  /** The variables handed to an Action step, substituted and kept to primitives. */
  function substituteVariables(
    raw: Record<string, string | number | boolean>,
    vars: Record<string, unknown>,
  ): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(raw)) {
      const resolved = substitute(value, vars)
      if (typeof resolved === 'string' || typeof resolved === 'number' || typeof resolved === 'boolean') {
        out[key] = resolved
      }
    }
    return out
  }

  async function actuate(
    deviceId: number,
    cap: string,
    method: string,
    args: Record<string, unknown>,
    vars: Record<string, unknown>,
  ): Promise<void> {
    const substituted = substitute(args, vars)
    const resolved: Record<string, unknown> =
      substituted !== null && typeof substituted === 'object' ? { ...substituted } : {}
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

  /** The THEN half, through the ONE shared step runner: stops at the first
   *  failure (continuing past a failed step executes an intent the operator
   *  never expressed); every step is traced, the ones after a failure (or an
   *  abort) are marked not-run. */
  async function runActions(
    vars: Record<string, unknown>,
    token: RunToken,
  ): Promise<{ steps: readonly AutomationStepTrace[]; failed: boolean }> {
    const sleep = (ms: number): Promise<void> => abortableSleep(ms, token)
    const steps: RunnableStep[] = [
${recipe.actions.map((a, i) => emitAction(a, i)).join('\n')}
    ]
    return runSteps(steps, {
      pathPrefix: 'actions',
      isAborted: () => token.aborted,
      abortReason: 'aborted by a restart',
      now: () => Date.now(),
      onFailure: (failure) => {
        ctx.logger.warn('action failed — stopping the sequence', {
          ...(failure.deviceId === undefined ? {} : { tags: { deviceId: failure.deviceId } }),
          step: failure.index,
          error: failure.message,
        })
      },
    })
  }

  function deviceTags(trigger: Record<string, unknown>): { tags?: { deviceId: number } } {
    const deviceId = trigger['deviceId']
    return typeof deviceId === 'number' ? { tags: { deviceId } } : {}
  }

  function newRunId(at: number): string {
    runCounter += 1
    return at.toString(36) + '-' + runCounter.toString(36)
  }

  /** A trigger that never became a run (rejected, or dropped by the run mode). */
  function skipTrace(
    trigger: Record<string, unknown>,
    reason: string,
    outcome: AutomationRunTrace['outcome'],
    verdict: AutomationRunVerdict | undefined,
    accepted: boolean,
  ): AutomationRunTrace {
    const now = Date.now()
    return {
      runId: newRunId(now),
      startedAt: now,
      endedAt: now,
      trigger: buildTriggerTrace(trigger, accepted ? 'pass' : 'fail', reason),
      conditions: [],
      ...(verdict === undefined ? {} : { verdict }),
      steps: [],
      outcome,
      repeat: 1,
      lastAt: now,
    }
  }

  /** One admitted run: conditions (memory only), the cooldown, the actions. */
  async function execute(
    trigger: Record<string, unknown>,
    reason: string,
    admission: AutomationRunVerdict,
  ): Promise<void> {
    const token: RunToken = { aborted: false }
    runningTokens.add(token)
    const startedAt = Date.now()
    const runId = newRunId(startedAt)
    let verdict = admission
    let outcome: AutomationRunTrace['outcome'] = 'ran'
    let nodes: AutomationConditionTraceNode[] = []
    let steps: AutomationStepTrace[] = []
    try {
      const evaluation = evaluateConditionTree(CONDITIONS, mirror, Date.now())
      nodes = [...evaluation.nodes]
      for (const node of nodes) {
        if (node.kind === 'condition' && node.observed === null && node.deviceId !== undefined) {
          ctx.logger.warn('condition leaf value unknown — treated as false', {
            tags: { deviceId: node.deviceId },
            path: node.path,
            cap: node.cap,
            fieldPath: node.fieldPath,
          })
        }
      }
      if (!evaluation.pass) {
        outcome = 'skipped-conditions'
        ctx.logger.debug('automation did not run — conditions were false', { trigger, ...deviceTags(trigger) })
        return
      }
      const letThrough = stampUnknown && RUN_MODE.mode === 'cooldown'
      const cooldown = letThrough
        ? { ok: true, bypassed: true, reason: 'cooldown stamp unreadable at start — run let through' }
        : gate.cooldown({
            manual: trigger['kind'] === 'manual',
            now: Date.now(),
            lastRunStartedAt,
          })
      if (!cooldown.ok) {
        outcome = 'skipped-cooldown'
        verdict = { mode: RUN_MODE, decision: 'cooldown', reason: cooldown.reason }
        ctx.logger.info('automation did not run — ' + cooldown.reason, deviceTags(trigger))
        return
      }
      if (cooldown.bypassed) verdict = { mode: RUN_MODE, decision: 'bypass', reason: cooldown.reason }
      // Stamped when the actions START, and reported to the hub before they run,
      // so a restart mid-run cannot fire again inside the window.
      lastRunStartedAt = startedAt
      stampUnknown = false
      await send({ runStartedAt: startedAt })
      ctx.logger.info('automation running', { trigger, ...deviceTags(trigger) })
      const vars: Record<string, unknown> = { ...trigger }
      const result = await runActions(vars, token)
      steps = result.steps
      outcome = token.aborted ? 'aborted' : result.failed ? 'failed' : 'ran'
    } catch (err: unknown) {
      outcome = 'failed'
      ctx.logger.warn('automation run failed', { error: err instanceof Error ? err.message : String(err), ...deviceTags(trigger) })
    } finally {
      runningTokens.delete(token)
      const endedAt = Date.now()
      record({
        runId,
        startedAt,
        endedAt,
        trigger: buildTriggerTrace(trigger, 'pass', reason),
        conditions: nodes,
        verdict,
        steps,
        outcome,
        repeat: 1,
        lastAt: endedAt,
      })
      if (gate.release()) {
        const next = queue.shift()
        if (next !== undefined && !stopped) {
          void execute(next.trigger, next.reason, {
            mode: RUN_MODE,
            decision: 'queued',
            reason: 'queued, then ran after waiting ' + (Date.now() - next.queuedAt) + ' ms',
          })
        }
      }
    }
  }

  /** Every trigger lands here. \`accepted\` = the trigger itself was satisfied
   *  (a rejected detection event is only traced). */
  async function run(
    trigger: Record<string, unknown>,
    reason = 'fired',
    accepted = true,
  ): Promise<void> {
    await ready
    if (stopped) return
    if (!accepted) {
      record(skipTrace(trigger, reason, 'skipped-trigger', undefined, false))
      return
    }
    const admission = gate.admit()
    const verdict: AutomationRunVerdict = { mode: RUN_MODE, decision: admission.decision, reason: admission.reason }
    switch (admission.decision) {
      case 'drop':
        ctx.logger.info('automation trigger dropped — ' + admission.reason, deviceTags(trigger))
        record(skipTrace(trigger, reason, 'skipped-overlap', verdict, true))
        return
      case 'queued':
        ctx.logger.info('automation trigger queued — ' + admission.reason, deviceTags(trigger))
        queue.push({ trigger, reason, queuedAt: Date.now() })
        return
      case 'restart':
        ctx.logger.info('automation restarting — ' + admission.reason, deviceTags(trigger))
        for (const running of runningTokens) {
          running.aborted = true
          running.wake?.()
        }
        break
      case 'run':
        break
    }
    await execute(trigger, reason, verdict)
  }

  const ready: Promise<void> = (async () => {
    await loadState()
    await refreshMirror()
  })()

  if (CONDITIONS !== undefined) {
    disposers.push(
      ctx.eventBus.subscribe({ category: EventCategory.DeviceStateChanged }, (event) => {
        const data = event.data
        const deviceId = data['deviceId']
        const capName = data['capName']
        if (typeof deviceId === 'number' && typeof capName === 'string') {
          mirror.apply(deviceId, capName, data['slice'])
        }
      }),
    )
    const mirrorReconcile = setInterval(() => { void refreshMirror() }, RECONCILE_MS)
    disposers.push(() => clearInterval(mirrorReconcile))
  }

${recipe.triggers.map((t, i) => emitTrigger(t, i)).join('\n\n')}

  return () => {
    stopped = true
    queue.length = 0
    flushSkip()
    for (const running of runningTokens) {
      running.aborted = true
      running.wake?.()
    }
    for (const dispose of disposers) dispose()
  }
}
`
}
