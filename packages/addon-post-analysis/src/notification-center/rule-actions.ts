/**
 * Running a rule's action bindings / shared sequences.
 *
 * A rule can actuate devices when it matches — arm the alarm, open a gate, turn
 * on a light. Sequences are shared entities; a rule binds to them (or authors a
 * single Do). Three properties, each of which is the difference between a
 * sequence and a list of calls:
 *
 *  - **It STOPS at the first failure.** "Unlock, then open" with the unlock
 *    failed is a door being forced. Continuing past a failed step executes an
 *    intent the operator never expressed.
 *  - **`wait` is a step**, so "unlock, wait 5s, open" is expressible at all.
 *  - **A per-sequence throttle** keyed on `sequenceId`, because the rule's
 *    cooldown governs NOTIFICATIONS and "how often may this gate physically
 *    open" is a different budget — and two rules sharing one sequence share
 *    that budget. Single Do bindings are never throttled.
 */

import type {
  IScopedLogger,
  NcActionBinding,
  NcRuleAction,
  NcSharedSequence,
} from '@camstack/types'
import type { NcRuleFireRef } from './rule-engine.js'

/**
 * Invoke one device-cap method. Returns nothing; throwing means failed.
 *
 * `origin` is the MATCH this actuation descends from, handed through
 * untouched. The runner does nothing with it — it is provenance, not a
 * parameter, and no cap input carries it. It exists because a device that is
 * itself part of the notification path (the alarm panel) otherwise cannot know
 * which detection pressed its button, and the operator then receives two
 * notifications about one incident. Absent when a BUTTON granted the run: an
 * operator tapping "Open the gate" is not a rule match, and stamping it as one
 * would attribute a photograph to a person's finger.
 */
export type NcActuator = (input: {
  readonly deviceId: number
  readonly cap: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  readonly origin?: NcRuleFireRef
}) => Promise<void>

/** Is this capability device-scoped? The only boundary on what a rule may
 *  actuate — see the cap file for why it is structural rather than a list. */
export type NcCapScopeCheck = (cap: string) => boolean

/** Look up a shared sequence by id. Absent ⇒ the binding is skipped. */
export type NcSequenceLookup = (sequenceId: string) => NcSharedSequence | null

export interface NcRuleActionRunnerDeps {
  readonly logger: IScopedLogger
  readonly actuate: NcActuator
  readonly isDeviceScoped: NcCapScopeCheck
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

/** A resolved run unit — what the runner actually steps through. */
export interface ResolvedRunSequence {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly minDelaySec?: number
  readonly actions: readonly NcRuleAction[]
  /** Shared sequences throttle; ephemeral Do wrappers do not. */
  readonly throttle: boolean
}

export interface RunSequencesInput {
  readonly ruleId: string
  readonly ruleName: string
  readonly sequences: readonly ResolvedRunSequence[]
  /** Subject device — for the log tag, never for routing. */
  readonly deviceId: number
  /** The match this run descends from, passed to every actuation. Absent for a
   *  button-granted run — see {@link NcActuator}. */
  readonly origin?: NcRuleFireRef
}

export interface RunBindingsInput {
  readonly ruleId: string
  readonly ruleName: string
  readonly bindings: readonly NcActionBinding[]
  readonly lookup: NcSequenceLookup
  readonly deviceId: number
  readonly origin?: NcRuleFireRef
}

/** What one sequence run did, for the caller's log line and for tests. */
export interface SequenceOutcome {
  readonly id: string
  readonly name: string
  readonly ran: boolean
  readonly stepsRun: number
  /** Set when a step failed; the run stopped there. */
  readonly failedAt?: number
  readonly skippedReason?: 'disabled' | 'throttled' | 'empty' | 'missing'
}

function wrapDo(action: NcRuleAction): ResolvedRunSequence {
  const name =
    action.kind === 'wait' ? `wait ${String(action.seconds)}s` : `${action.cap}.${action.method}`
  return {
    id: `do:${name}`,
    name,
    enabled: true,
    actions: [action],
    throttle: false,
  }
}

function resolveBinding(
  binding: NcActionBinding,
  lookup: NcSequenceLookup,
): ResolvedRunSequence | { readonly missing: string } {
  if (binding.kind === 'do') return wrapDo(binding.action)
  const sequence = lookup(binding.sequenceId)
  if (sequence === null) return { missing: binding.sequenceId }
  return {
    id: sequence.id,
    name: sequence.name,
    enabled: true,
    ...(sequence.minDelaySec !== undefined ? { minDelaySec: sequence.minDelaySec } : {}),
    actions: sequence.actions,
    throttle: true,
  }
}

export class NcRuleActionRunner {
  /** Last run per `sequenceId` — the throttle's memory (shared across rules). */
  private readonly lastRunAt = new Map<string, number>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: NcRuleActionRunnerDeps) {
    this.now = deps.now ?? ((): number => Date.now())
    this.sleep =
      deps.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  }

  /**
   * Resolve bindings via the sequence store and run each, in order.
   *
   * Never throws: an actuation that fails must not cost the NOTIFICATION about
   * the very same event.
   */
  async runBindings(input: RunBindingsInput): Promise<readonly SequenceOutcome[]> {
    const sequences: ResolvedRunSequence[] = []
    const missing: SequenceOutcome[] = []
    for (const binding of input.bindings) {
      const resolved = resolveBinding(binding, input.lookup)
      if ('missing' in resolved) {
        this.deps.logger.warn('rule action binding skipped — sequence missing', {
          tags: { deviceId: input.deviceId },
          meta: { ruleId: input.ruleId, sequenceId: resolved.missing },
        })
        missing.push({
          id: resolved.missing,
          name: resolved.missing,
          ran: false,
          stepsRun: 0,
          skippedReason: 'missing',
        })
        continue
      }
      sequences.push(resolved)
    }
    const ran = await this.run({
      ruleId: input.ruleId,
      ruleName: input.ruleName,
      deviceId: input.deviceId,
      sequences,
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    })
    return [...missing, ...ran]
  }

  /**
   * Run every enabled sequence, in order.
   *
   * Prefer {@link runBindings} at call sites that hold bindings. This remains
   * for button grants (force-enabled shared sequence) and tests.
   */
  async run(input: RunSequencesInput): Promise<readonly SequenceOutcome[]> {
    const out: SequenceOutcome[] = []
    for (const sequence of input.sequences) {
      out.push(await this.runOne(input, sequence))
    }
    return out
  }

  private async runOne(
    input: RunSequencesInput,
    sequence: ResolvedRunSequence,
  ): Promise<SequenceOutcome> {
    if (!sequence.enabled) {
      return {
        id: sequence.id,
        name: sequence.name,
        ran: false,
        stepsRun: 0,
        skippedReason: 'disabled',
      }
    }
    if (sequence.actions.length === 0) {
      return {
        id: sequence.id,
        name: sequence.name,
        ran: false,
        stepsRun: 0,
        skippedReason: 'empty',
      }
    }
    const now = this.now()
    const minDelayMs = sequence.throttle ? (sequence.minDelaySec ?? 0) * 1000 : 0
    const last = this.lastRunAt.get(sequence.id)
    if (minDelayMs > 0 && last !== undefined && now - last < minDelayMs) {
      this.deps.logger.debug('rule action sequence throttled', {
        tags: { deviceId: input.deviceId },
        meta: {
          ruleId: input.ruleId,
          sequenceId: sequence.id,
          sequence: sequence.name,
          sinceLastMs: now - last,
        },
      })
      return {
        id: sequence.id,
        name: sequence.name,
        ran: false,
        stepsRun: 0,
        skippedReason: 'throttled',
      }
    }
    if (sequence.throttle) this.lastRunAt.set(sequence.id, now)

    let stepsRun = 0
    for (const [index, action] of sequence.actions.entries()) {
      try {
        await this.step(action, input.origin)
        stepsRun += 1
      } catch (err) {
        this.deps.logger.warn('rule action failed — stopping the sequence', {
          tags: { deviceId: input.deviceId },
          meta: {
            ruleId: input.ruleId,
            rule: input.ruleName,
            sequenceId: sequence.id,
            sequence: sequence.name,
            step: index,
            action: action.kind === 'cap' ? `${action.cap}.${action.method}` : 'wait',
            error: String(err),
          },
        })
        return {
          id: sequence.id,
          name: sequence.name,
          ran: true,
          stepsRun,
          failedAt: index,
        }
      }
    }
    this.deps.logger.info('rule actions ran', {
      tags: { deviceId: input.deviceId },
      meta: {
        ruleId: input.ruleId,
        rule: input.ruleName,
        sequenceId: sequence.id,
        sequence: sequence.name,
        steps: stepsRun,
      },
    })
    return { id: sequence.id, name: sequence.name, ran: true, stepsRun }
  }

  private async step(action: NcRuleAction, origin: NcRuleFireRef | undefined): Promise<void> {
    if (action.kind === 'wait') {
      await this.sleep(action.seconds * 1000)
      return
    }
    if (!this.deps.isDeviceScoped(action.cap)) {
      throw new Error(
        `rule action refused: "${action.cap}" is not a device capability — only devices can be actuated`,
      )
    }
    await this.deps.actuate({
      deviceId: action.deviceId,
      cap: action.cap,
      method: action.method,
      args: action.args ?? {},
      ...(origin !== undefined ? { origin } : {}),
    })
  }
}

/** Force-enable a shared sequence for a button tap (always runs, still throttled). */
export function asForcedSequence(sequence: NcSharedSequence): ResolvedRunSequence {
  return {
    id: sequence.id,
    name: sequence.name,
    enabled: true,
    ...(sequence.minDelaySec !== undefined ? { minDelaySec: sequence.minDelaySec } : {}),
    actions: sequence.actions,
    throttle: true,
  }
}
