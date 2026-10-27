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

function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'automation' : slug
}

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
  switch (action.kind) {
    case 'wait':
      return `      case ${index}: await sleep(${j(action.seconds * 1000)}); break`
    case 'cap': {
      if (Array.isArray(action.deviceId)) {
        return `      case ${index}: {
        for (const deviceId of ${j(action.deviceId)}) {
          stepDeviceId = deviceId
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
        stepDeviceId = deviceId
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
  const runMode = recipe.runMode ?? { mode: 'single' }
  const stepMeta = recipe.actions.map(stepMetaOf)
  const statePath = `automations/${slugOf(name)}.json`

  return `import type {
  AddonContext,
  AutomationConditionTraceNode,
  AutomationRunTrace,
  AutomationRunVerdict,
  AutomationStateDoc,
  AutomationStepTrace,
} from '@camstack/types'
import {
  AUTOMATION_STATE_LOCATION,
  AutomationStateDocSchema,
  ConditionMirror,
  DetectionTriggerFilter,
  EventCategory,
  RunGate,
  appendTrace,
  buildTriggerTrace,
  collectMirrorSources,
  evaluateConditionTree,
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

/** Run traces kept (a ring, persisted through ctx.storage). */
const KEEP_TRACES = ${recipe.keepTraces ?? DEFAULT_TRACE_KEEP}

const CONDITIONS = ${recipe.conditions === undefined ? 'undefined' : 'AUTOMATION_RECIPE.conditions'}

/** Where this automation keeps its cooldown stamp and trace ring. */
const STATE_PATH = ${j(statePath)}

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
  let state: AutomationStateDoc = { version: 1, lastRunStartedAt: null, traces: [] }
  let persistChain: Promise<void> = Promise.resolve()
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

  // ── persistence: the cooldown stamp and the trace ring, via ctx.storage ──
  async function loadState(): Promise<void> {
    const storage = ctx.storage
    if (storage === undefined) {
      ctx.logger.warn('no ctx.storage — cooldown and traces will not survive a restart')
      return
    }
    try {
      const where = { location: AUTOMATION_STATE_LOCATION, relativePath: STATE_PATH }
      if (!(await storage.exists(where))) return
      const parsed = AutomationStateDocSchema.safeParse(JSON.parse((await storage.read(where)).toString('utf8')))
      if (parsed.success) state = parsed.data
      else ctx.logger.warn('stored automation state is invalid — starting empty', { error: parsed.error.message })
    } catch (err: unknown) {
      ctx.logger.warn('could not read the stored automation state — starting empty', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function persist(): void {
    const doc = state
    persistChain = persistChain.then(async () => {
      const storage = ctx.storage
      if (storage === undefined) return
      try {
        await storage.write({
          location: AUTOMATION_STATE_LOCATION,
          relativePath: STATE_PATH,
          data: Buffer.from(JSON.stringify(doc), 'utf8'),
        })
      } catch (err: unknown) {
        ctx.logger.warn('could not persist the automation state', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  function record(trace: AutomationRunTrace): void {
    state = { ...state, traces: appendTrace(state.traces, trace, KEEP_TRACES) }
    persist()
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

  /** The THEN half. Stops at the first failure — continuing past a failed step
   *  executes an intent the operator never expressed. Every step is traced; the
   *  ones after a failure (or an abort) are marked not-run. */
  async function runActions(
    vars: Record<string, unknown>,
    token: RunToken,
  ): Promise<{ steps: AutomationStepTrace[]; failed: boolean }> {
    const sleep = (ms: number): Promise<void> => abortableSleep(ms, token)
    const steps: AutomationStepTrace[] = []
    let failed = false
    for (let step = 0; step < ${recipe.actions.length}; step += 1) {
      const meta = STEP_META[step]!
      const path = 'actions.' + step
      if (failed || token.aborted) {
        steps.push({ ...meta, path, outcome: 'not-run', message: failed ? 'an earlier step failed' : 'aborted by a restart' })
        continue
      }
      const startedAt = Date.now()
      let stepDeviceId: number | undefined = meta.deviceId
      try {
        switch (step) {
${recipe.actions.map((a, i) => emitAction(a, i)).join('\n')}
        }
        steps.push({ ...meta, deviceId: stepDeviceId, path, startedAt, endedAt: Date.now(), outcome: 'ok' })
      } catch (err: unknown) {
        failed = true
        const message = err instanceof Error ? err.message : String(err)
        ctx.logger.warn('action failed — stopping the sequence', {
          ...(stepDeviceId === undefined ? {} : { tags: { deviceId: stepDeviceId } }),
          step,
          error: message,
        })
        steps.push({ ...meta, deviceId: stepDeviceId, path, startedAt, endedAt: Date.now(), outcome: 'error', message })
      }
    }
    return { steps, failed }
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
      const cooldown = gate.cooldown({
        manual: trigger['kind'] === 'manual',
        now: Date.now(),
        lastRunStartedAt: state.lastRunStartedAt,
      })
      if (!cooldown.ok) {
        outcome = 'skipped-cooldown'
        verdict = { mode: RUN_MODE, decision: 'cooldown', reason: cooldown.reason }
        ctx.logger.info('automation did not run — ' + cooldown.reason, deviceTags(trigger))
        return
      }
      if (cooldown.bypassed) verdict = { mode: RUN_MODE, decision: 'bypass', reason: cooldown.reason }
      // Stamped when the actions START, and persisted before they run, so a
      // restart mid-run cannot fire again inside the window.
      state = { ...state, lastRunStartedAt: startedAt }
      persist()
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
    for (const running of runningTokens) {
      running.aborted = true
      running.wake?.()
    }
    for (const dispose of disposers) dispose()
  }
}
`
}
