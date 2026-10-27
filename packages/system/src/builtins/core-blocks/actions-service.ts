/**
 * The `actions` surface: one place to list, run and stop the things an
 * operator can start — internal actions kept here, and actions an addon
 * DECLARED through the `action-source` cap.
 *
 * Decisions that shape this file:
 *  - **No catalog of its own (D3).** `list` asks the sources live, every time,
 *    and overlays the run status; nothing here remembers what a source offered.
 *  - **Every run is traced the same way**, through the shared step runner
 *    (`runSteps`), into the runs ledger under `action:<actionId>`. An addon
 *    action is one `steps.0`.
 *  - **A second run of an action that is running is refused** — traced as
 *    `skipped-overlap` and logged — never queued (a queue is a decision nobody
 *    made about order and bound).
 *  - **Permissions follow the camera (D356).** A camera links the actions the
 *    operator picked; a non-admin may `get` / `run` an action only through a
 *    camera that links it. The router's scope gate proves the caller may see
 *    that camera (it reads the top-level `deviceId`); this service proves the
 *    camera links the action. An admin, and a caller with no session identity
 *    (an automation block, in-process), are trusted.
 *  - Every refusal is a typed `ActionError` (`[not-linked] …`) and a log line.
 */
import { randomUUID } from 'node:crypto'
import {
  type ActionEntry,
  ActionError,
  type ActionLinks,
  type ActionRunChanged,
  type ActionRunResult,
  type ActionVariableValue,
  addonIdOfActionId,
  type AutomationRunOutcome,
  type AutomationRunTrace,
  type AutomationStepTrace,
  buildActionSteps,
  type CapCall,
  type CapCaller,
  type IActionsProvider,
  type IScopedLogger,
  isInternalActionId,
  resolveActionVariables,
  type RunnableStep,
  runSteps,
  type TraceValue,
} from '@camstack/types'
import type { ActionsStore } from './actions-store.js'
import { actionOwner, type RunsLedger, type RunsLedgerView } from './runs-ledger.js'

/** The ring an Action keeps. */
const ACTION_TRACE_KEEP = 20

/** The `action-source` providers, reached through `ctx.api`. */
export interface ActionSources {
  list(): Promise<ActionEntry[]>
  run(input: {
    readonly addonId: string
    readonly actionId: string
    readonly variables: Readonly<Record<string, ActionVariableValue>>
  }): Promise<void>
  stop(input: { readonly addonId: string; readonly actionId: string }): Promise<void>
}

export interface ActionsServiceDeps {
  readonly store: ActionsStore
  readonly ledger: RunsLedger
  readonly sources: ActionSources
  invokeCap(call: CapCall): Promise<void>
  emit(event: ActionRunChanged): void
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly newRunId?: () => string
}

/** A run in flight: the stop flag and whatever sleeps it can wake. */
class RunToken {
  aborted = false
  private readonly wakers = new Set<() => void>()

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        this.wakers.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      this.wakers.add(wake)
    })
  }

  abort(): void {
    this.aborted = true
    for (const wake of [...this.wakers]) wake()
  }
}

interface RunningRun {
  readonly runId: string
  readonly token: RunToken
  readonly startedAt: number
  readonly addonId: string | null
}

type RunInput = Parameters<IActionsProvider['run']>[0]
type GetInput = Parameters<IActionsProvider['get']>[0]

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class ActionsService implements IActionsProvider {
  private readonly store: ActionsStore
  private readonly ledger: RunsLedger
  private readonly sources: ActionSources
  private readonly invokeCap: (call: CapCall) => Promise<void>
  private readonly emit: (event: ActionRunChanged) => void
  private readonly logger: IScopedLogger
  private readonly now: () => number
  private readonly newRunId: () => string
  private readonly running = new Map<string, RunningRun>()

  constructor(deps: ActionsServiceDeps) {
    this.store = deps.store
    this.ledger = deps.ledger
    this.sources = deps.sources
    this.invokeCap = (call) => deps.invokeCap(call)
    this.emit = (event) => deps.emit(event)
    this.logger = deps.logger
    this.now = deps.now ?? Date.now
    this.newRunId = deps.newRunId ?? randomUUID
  }

  // ── reads ──────────────────────────────────────────────────────────────

  /** The internal actions only (no sources asked): who owns a ledger row. */
  listInternal(): Promise<ActionEntry[]> {
    return this.store.list()
  }

  async list(): Promise<ActionEntry[]> {
    const internal = await this.store.list()
    const addon = await this.listSourceEntries()
    return this.withStatus([...internal, ...addon])
  }

  /**
   * The sources' entries, or none when they cannot be asked. A source that is
   * down must not hide the internal actions; the failure is on the record.
   */
  private async listSourceEntries(): Promise<ActionEntry[]> {
    try {
      return await this.sources.list()
    } catch (err: unknown) {
      this.logger.warn(
        'actions: the action sources could not be listed — showing internal ones only',
        {
          meta: { error: errorMessage(err) },
        },
      )
      return []
    }
  }

  private async withStatus(entries: readonly ActionEntry[]): Promise<ActionEntry[]> {
    const views = await this.ledger.getMany(entries.map((e) => actionOwner(e.id)))
    return entries.map((entry) => this.overlayStatus(entry, views.get(actionOwner(entry.id))))
  }

  private overlayStatus(entry: ActionEntry, view: RunsLedgerView | undefined): ActionEntry {
    const running = this.running.has(entry.id)
    const ran = view !== undefined && view.lastRunStartedAt !== null
    return {
      ...entry,
      status: {
        isRunning: running || entry.status.isRunning,
        lastRunAt: ran ? view.lastRunStartedAt : entry.status.lastRunAt,
        lastError: ran ? view.lastError : entry.status.lastError,
      },
    }
  }

  private async find(actionId: string): Promise<ActionEntry | null> {
    if (isInternalActionId(actionId)) return this.store.get(actionId)
    const entries = await this.sources.list()
    return entries.find((e) => e.id === actionId) ?? null
  }

  async get(input: GetInput): Promise<{ action: ActionEntry | null }> {
    await this.authorize(input.caller, input.actionId, input.deviceId, 'read')
    const entry = await this.find(input.actionId)
    if (entry === null) return { action: null }
    const [withStatus] = await this.withStatus([entry])
    return { action: withStatus ?? entry }
  }

  async getTraces(input: { actionId: string }): Promise<{ traces: AutomationRunTrace[] }> {
    const view = await this.ledger.get(actionOwner(input.actionId))
    return { traces: [...view.traces] }
  }

  // ── permissions ─────────────────────────────────────────────────────────

  /**
   * A non-admin reaches an action only through a camera that links it. The
   * scope gate has already proved the caller may see `deviceId`; here the
   * camera has to link the action. Refused with `not-linked`, and logged.
   */
  private async authorize(
    caller: CapCaller | undefined,
    actionId: string,
    deviceId: number | undefined,
    what: 'read' | 'run',
  ): Promise<void> {
    if (caller === undefined || caller.isAdmin) return
    const linked = deviceId === undefined ? [] : await this.store.linksOf(deviceId)
    if (deviceId !== undefined && linked.includes(actionId)) return
    const reason =
      deviceId === undefined
        ? 'no camera named — a non-admin reaches an action through a camera that links it'
        : `camera ${deviceId} does not link this action`
    this.logger.warn(`action ${what} refused — ${reason}`, {
      ...(deviceId === undefined ? {} : { tags: { deviceId } }),
      meta: { actionId, userId: caller.userId },
    })
    throw new ActionError('not-linked', reason)
  }

  // ── run / stop ──────────────────────────────────────────────────────────

  async run(input: RunInput): Promise<ActionRunResult> {
    await this.authorize(input.caller, input.actionId, input.deviceId, 'run')
    const entry = await this.find(input.actionId)
    if (entry === null) throw new ActionError('not-found', `no action "${input.actionId}"`)
    const resolved = resolveActionVariables(entry.variables, input.variables)
    if (!resolved.ok) throw new ActionError('invalid-variables', resolved.error)

    const runId = this.newRunId()
    const startedAt = this.now()
    const trigger = this.triggerOf(input, resolved.values)

    if (this.running.has(entry.id)) {
      const message = 'the action is already running'
      this.logger.warn(`action run refused — ${message}`, {
        meta: {
          actionId: entry.id,
          runId,
          ...(input.origin?.blockId === undefined ? {} : { blockId: input.origin.blockId }),
        },
      })
      await this.record(entry.id, {
        runId,
        startedAt,
        endedAt: startedAt,
        trigger: { ...trigger, outcome: 'pass' },
        conditions: [],
        steps: [],
        outcome: 'skipped-overlap',
        repeat: 1,
        lastAt: startedAt,
      })
      return { runId, outcome: 'skipped-overlap', message }
    }

    const token = new RunToken()
    this.running.set(entry.id, {
      runId,
      token,
      startedAt,
      addonId: addonIdOfActionId(entry.id),
    })
    this.emit({
      actionId: entry.id,
      runId,
      isRunning: true,
      lastRunAt: startedAt,
      lastError: null,
    })
    const done = this.execute(entry, resolved.values, runId, startedAt, trigger, token)
    if (input.wait === true) return done
    void done
    return { runId, outcome: 'started' }
  }

  private triggerOf(
    input: RunInput,
    values: Readonly<Record<string, ActionVariableValue>>,
  ): AutomationRunTrace['trigger'] {
    const vars: Record<string, TraceValue> = {}
    for (const [name, value] of Object.entries(values)) vars[`var.${name}`] = value
    if (input.deviceId !== undefined) vars['deviceId'] = input.deviceId
    const blockId = input.origin?.blockId
    if (blockId !== undefined) vars['blockId'] = blockId
    return {
      kind: 'action',
      outcome: 'pass',
      reason:
        blockId !== undefined
          ? `started by automation ${blockId}`
          : `started by ${input.caller?.userId ?? 'the system'}`,
      vars,
    }
  }

  /** Never rejects: a run's failure is its outcome. */
  private async execute(
    entry: ActionEntry,
    values: Readonly<Record<string, ActionVariableValue>>,
    runId: string,
    startedAt: number,
    trigger: AutomationRunTrace['trigger'],
    token: RunToken,
  ): Promise<ActionRunResult> {
    let outcome: AutomationRunOutcome = 'failed'
    let steps: readonly AutomationStepTrace[] = []
    let message: string | undefined
    try {
      const runnable = this.runnableFor(entry, values, token)
      const result = await runSteps(runnable, {
        pathPrefix: 'steps',
        isAborted: () => token.aborted,
        abortReason: 'the run was stopped',
        now: () => this.now(),
        onFailure: (failure) => {
          this.logger.warn('action step failed — stopping the sequence', {
            ...(failure.deviceId === undefined ? {} : { tags: { deviceId: failure.deviceId } }),
            meta: { actionId: entry.id, runId, step: failure.index, error: failure.message },
          })
        },
      })
      steps = result.steps
      outcome = result.failed ? 'failed' : result.aborted ? 'aborted' : 'ran'
      message = result.steps.find((s) => s.outcome === 'error')?.message
    } catch (err: unknown) {
      message = errorMessage(err)
      this.logger.error('action run crashed', {
        meta: { actionId: entry.id, runId, error: message },
      })
    }
    const endedAt = this.now()
    const trace: AutomationRunTrace = {
      runId,
      startedAt,
      endedAt,
      trigger,
      conditions: [],
      steps: [...steps],
      outcome,
      repeat: 1,
      lastAt: endedAt,
    }
    await this.record(entry.id, trace, startedAt)
    this.running.delete(entry.id)
    this.emit({
      actionId: entry.id,
      runId,
      isRunning: false,
      outcome,
      lastRunAt: startedAt,
      lastError: outcome === 'failed' ? (message ?? 'the run failed') : null,
    })
    return { runId, outcome, ...(message === undefined ? {} : { message }) }
  }

  private runnableFor(
    entry: ActionEntry,
    values: Readonly<Record<string, ActionVariableValue>>,
    token: RunToken,
  ): RunnableStep[] {
    if (entry.source === 'internal') {
      return buildActionSteps(entry.steps ?? [], values, {
        invokeCap: (call) => this.invokeCap(call),
        sleep: (ms) => token.sleep(ms),
        onMissingVar: (name) =>
          this.logger.warn('action template referenced a variable that was never set', {
            meta: { actionId: entry.id, variable: name },
          }),
      })
    }
    return [
      {
        meta: { kind: 'addon' },
        run: () =>
          this.sources.run({ addonId: entry.addonId, actionId: entry.id, variables: values }),
      },
    ]
  }

  /** A ledger write that fails is on the record; it never fails the run it describes. */
  private async record(
    actionId: string,
    trace: AutomationRunTrace,
    runStartedAt?: number,
  ): Promise<void> {
    try {
      await this.ledger.report(actionOwner(actionId), {
        trace,
        keepTraces: ACTION_TRACE_KEEP,
        ...(runStartedAt === undefined ? {} : { runStartedAt }),
      })
    } catch (err: unknown) {
      this.logger.warn('action run could not be written to the runs ledger', {
        meta: { actionId, runId: trace.runId, error: errorMessage(err) },
      })
    }
  }

  async stop(input: { actionId: string }): Promise<void> {
    const run = this.running.get(input.actionId)
    if (run === undefined) {
      this.logger.info('action stop ignored — it is not running', {
        meta: { actionId: input.actionId },
      })
      return
    }
    run.token.abort()
    if (run.addonId !== null) {
      await this.sources.stop({ addonId: run.addonId, actionId: input.actionId })
    }
  }

  // ── authoring (internal actions only) ───────────────────────────────────

  async create(input: Parameters<IActionsProvider['create']>[0]): Promise<{ action: ActionEntry }> {
    const action = await this.store.create(input.action)
    this.logger.info('internal action created', {
      meta: { actionId: action.id, name: action.name },
    })
    return { action }
  }

  async update(input: Parameters<IActionsProvider['update']>[0]): Promise<{ action: ActionEntry }> {
    await this.requireInternal(input.actionId)
    const existing = await this.store.get(input.actionId)
    if (existing === null) throw new ActionError('not-found', `no action "${input.actionId}"`)
    const patch = input.action
    const action = await this.store.update(input.actionId, {
      name: patch.name ?? existing.name,
      steps: patch.steps ?? existing.steps ?? [],
      ...((patch.variables ?? existing.variables) === undefined
        ? {}
        : { variables: patch.variables ?? existing.variables }),
    })
    this.logger.info('internal action updated', { meta: { actionId: action.id } })
    return { action }
  }

  async delete(input: { actionId: string }): Promise<void> {
    await this.requireInternal(input.actionId)
    const removed = await this.store.delete(input.actionId)
    if (!removed) throw new ActionError('not-found', `no action "${input.actionId}"`)
    await this.ledger.delete(actionOwner(input.actionId))
    this.logger.info('internal action deleted', { meta: { actionId: input.actionId } })
  }

  /** Only an internal action is edited here; an addon one is edited where it was declared. */
  private async requireInternal(actionId: string): Promise<void> {
    if (isInternalActionId(actionId)) return
    const known = (await this.listSourceEntries()).some((e) => e.id === actionId)
    if (!known) throw new ActionError('not-found', `no action "${actionId}"`)
    this.logger.warn('action edit refused — the action is declared by an addon', {
      meta: { actionId },
    })
    throw new ActionError(
      'read-only',
      `"${actionId}" is declared by the "${addonIdOfActionId(actionId) ?? 'unknown'}" addon — edit it there`,
    )
  }

  // ── camera links ────────────────────────────────────────────────────────

  async getLinks(input: { deviceId: number }): Promise<ActionLinks> {
    return { deviceId: input.deviceId, actionIds: [...(await this.store.linksOf(input.deviceId))] }
  }

  async setLinks(input: ActionLinks): Promise<ActionLinks> {
    const actionIds = await this.store.setLinks(input.deviceId, input.actionIds)
    this.logger.info('camera action links set', {
      tags: { deviceId: input.deviceId },
      meta: { count: actionIds.length },
    })
    return { deviceId: input.deviceId, actionIds: [...actionIds] }
  }

  /** The actions this camera links, live, with their variables. A dangling link is not listed. */
  async listForCamera(input: { deviceId: number }): Promise<ActionEntry[]> {
    const ids = await this.store.linksOf(input.deviceId)
    if (ids.length === 0) return []
    const wanted = new Set(ids)
    const internal = await Promise.all(
      ids.filter(isInternalActionId).map((id) => this.store.get(id)),
    )
    const addon = ids.some((id) => !isInternalActionId(id))
      ? (await this.listSourceEntries()).filter((e) => wanted.has(e.id))
      : []
    const found = [...internal.filter((e): e is ActionEntry => e !== null), ...addon]
    const ordered = ids
      .map((id) => found.find((e) => e.id === id))
      .filter((e): e is ActionEntry => e !== undefined)
    return this.withStatus(ordered)
  }
}
