/**
 * Running a rule's Actions (planning#473).
 *
 * The notification centre has no step vocabulary and no executor of its own: a
 * rule hook or a button names an Action of the `actions` surface by id, and the
 * run goes through `actions.run`. The steps, the device-scope boundary, the
 * stop-at-first-failure, the throttle (`minDelaySec`), the one-run-at-a-time
 * refusal and the runs ledger are the Action's — this file only decides WHICH
 * Actions a hook edge starts and WHAT the rule's match hands them.
 *
 * What a match hands an Action is its declared **variables**, the way any other
 * caller (an automation block) passes context: an Action that declares a
 * variable named like a fire variable ({@link NC_FIRE_VARIABLES}) receives the
 * value, one that does not receives nothing. A value the Action did not declare
 * is never sent — the Actions surface refuses an unknown variable by name.
 */

import type {
  ActionEntry,
  ActionRunResult,
  ActionStep,
  ActionVariableValue,
  IScopedLogger,
} from '@camstack/types'
import type { NcRuleFireRef } from './rule-engine.js'

/** The `actions` cap as the centre uses it — a port, so a spec can stand in. */
export interface NcActionsPort {
  list(): Promise<readonly ActionEntry[]>
  run(input: {
    readonly actionId: string
    readonly variables?: Readonly<Record<string, ActionVariableValue>>
    readonly wait: boolean
    readonly deviceId?: number
    /** The match this run descends from. Absent for a button (D47). */
    readonly origin?: NcRuleFireRef
  }): Promise<ActionRunResult>
}

/** What a rule match tells an Action about itself, by declared-variable name. */
export const NC_FIRE_VARIABLES = ['device', 'deviceId', 'class', 'rule', 'ruleId'] as const
export type NcFireVariableName = (typeof NC_FIRE_VARIABLES)[number]

export type NcFireVariables = Readonly<Partial<Record<NcFireVariableName, string | number>>>

/** The Actions the centre knows about, kept in RAM and revalidated off the hot path. */
const CATALOG_MAX_AGE_MS = 60_000

/**
 * A mirror of the Actions list, for the three questions the centre must answer
 * WITHOUT a call: does this Action exist (a button is minted only for one),
 * which variables does it declare (what a match may hand it), and does it
 * actuate the alarm panel (a snooze must not silence such a rule).
 *
 * The Actions surface is the authority (D3). A failed read changes nothing —
 * the mirror keeps what it has (D49) — and a stale answer is served while one
 * refresh runs.
 */
export class NcActionCatalog {
  private byId = new Map<string, ActionEntry>()
  private loadedAt = 0
  private inflight: Promise<void> | null = null

  constructor(
    private readonly port: Pick<NcActionsPort, 'list'>,
    private readonly logger: IScopedLogger,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    this.inflight ??= this.read().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /** Start a refresh when the mirror is older than its window; never awaited. */
  revalidate(): void {
    if (this.now() - this.loadedAt < CATALOG_MAX_AGE_MS) return
    void this.load()
  }

  private async read(): Promise<void> {
    try {
      const entries = await this.port.list()
      this.byId = new Map(entries.map((entry) => [entry.id, entry]))
      this.loadedAt = this.now()
    } catch (err: unknown) {
      this.logger.warn('actions list failed — keeping the Actions already known', {
        meta: { known: this.byId.size, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  get(actionId: string): ActionEntry | undefined {
    return this.byId.get(actionId)
  }

  knownIds(): ReadonlySet<string> {
    this.revalidate()
    return new Set(this.byId.keys())
  }

  /** The steps of an internal Action, `undefined` for an unknown or addon-declared one. */
  stepsOf(actionId: string): readonly ActionStep[] | undefined {
    return this.byId.get(actionId)?.steps
  }
}

/** What one Action run did, for the caller's log line and for tests. */
export interface NcActionRunOutcome {
  readonly actionId: string
  readonly ran: boolean
  /** The run's outcome as the Actions surface answered; absent when the call itself failed. */
  readonly outcome?: ActionRunResult['outcome']
  readonly error?: string
}

export interface NcHookRunInput {
  readonly ruleId: string
  readonly ruleName: string
  /** Subject device — the log tag and the run's `deviceId`. */
  readonly deviceId: number
  readonly actionIds: readonly string[]
  readonly fire: NcFireVariables
  /** The match, forwarded as the Action run's command origin (D705). */
  readonly origin?: NcRuleFireRef
}

/** The variables an Action declared, filled from what the match offers. */
export function variablesFor(
  entry: ActionEntry | undefined,
  fire: NcFireVariables,
): Readonly<Record<string, ActionVariableValue>> {
  const out: Record<string, ActionVariableValue> = {}
  for (const declared of entry?.variables ?? []) {
    const value = (NC_FIRE_VARIABLES as readonly string[]).includes(declared.name)
      ? Reflect.get(fire, declared.name)
      : undefined
    if (typeof value === 'number' && declared.type === 'number') out[declared.name] = value
    else if (typeof value === 'string' && declared.type === 'string') out[declared.name] = value
    else if (
      typeof value === 'string' &&
      declared.type === 'select' &&
      (declared.options ?? []).includes(value)
    ) {
      out[declared.name] = value
    }
  }
  return out
}

export class NcRuleActionRunner {
  constructor(
    private readonly port: NcActionsPort,
    private readonly catalog: NcActionCatalog,
    private readonly logger: IScopedLogger,
  ) {}

  /**
   * Run the Actions of one hook edge, in order, each to its end.
   *
   * Never throws: an Action that cannot start must not cost the NOTIFICATION
   * about the very same event. A failed or refused Action does not stop the
   * next one — each is its own sequence with its own stop-at-first-failure.
   */
  async runHook(input: NcHookRunInput): Promise<readonly NcActionRunOutcome[]> {
    const out: NcActionRunOutcome[] = []
    for (const actionId of input.actionIds) {
      out.push(await this.runOne(input, actionId, true))
    }
    return out
  }

  /**
   * Run the Action a spent button token granted. Throws when the Action did not
   * run to its end — the action plane turns that into the page that says so.
   */
  async runGranted(input: {
    readonly ruleId: string
    readonly ruleName: string
    readonly deviceId: number
    readonly actionId: string
  }): Promise<void> {
    const result = await this.runOne(
      { ...input, actionIds: [input.actionId], fire: {} },
      input.actionId,
      true,
    )
    if (result.error !== undefined) throw new Error(result.error)
    if (!result.ran) {
      throw new Error(`the action did not run (${result.outcome ?? 'unknown'})`)
    }
  }

  private async runOne(
    input: NcHookRunInput,
    actionId: string,
    wait: boolean,
  ): Promise<NcActionRunOutcome> {
    this.catalog.revalidate()
    try {
      const result = await this.port.run({
        actionId,
        variables: variablesFor(this.catalog.get(actionId), input.fire),
        wait,
        deviceId: input.deviceId,
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
      })
      const ran = result.outcome === 'ran' || result.outcome === 'started'
      const meta = {
        ruleId: input.ruleId,
        rule: input.ruleName,
        actionId,
        runId: result.runId,
        outcome: result.outcome,
        ...(result.message === undefined ? {} : { message: result.message }),
      }
      if (ran) {
        this.logger.info('rule action ran', { tags: { deviceId: input.deviceId }, meta })
      } else {
        // A refusal (already running, throttled) or a failed run is on the
        // record with its reason — it is work the rule asked for and did not get.
        this.logger.warn('rule action did not run', { tags: { deviceId: input.deviceId }, meta })
      }
      return { actionId, ran, outcome: result.outcome }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err)
      this.logger.warn('rule action could not start', {
        tags: { deviceId: input.deviceId },
        meta: { ruleId: input.ruleId, rule: input.ruleName, actionId, error },
      })
      return { actionId, ran: false, error }
    }
  }
}
