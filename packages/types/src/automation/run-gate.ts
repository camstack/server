/**
 * The admission gate of an automation — what its execution mode decides when a
 * trigger arrives while a run is in progress, and (for `cooldown`) when the
 * last run is too recent.
 *
 * In memory by design (D49): the decision is taken off in-process counters and
 * never off a read that can fail. Only the cooldown's `lastRunStartedAt` is
 * persisted (by the block, through `ctx.storage`) so a restart cannot re-fire
 * inside the window; it is handed in, not read here.
 *
 * Usage: `admit()` once per trigger; every admitted run (`run` / `restart`, or
 * a queued one when it is dequeued) ends with exactly one `release()`, which
 * says whether a queued trigger now owns the freed slot.
 */

import type { AutomationRunMode } from './recipe.js'

export interface RunGateAdmission {
  readonly decision: 'run' | 'queued' | 'restart' | 'drop'
  readonly reason: string
}

export interface CooldownInput {
  /** A manual trigger is operator intent: it skips the cooldown wait only. */
  readonly manual: boolean
  readonly now: number
  readonly lastRunStartedAt: number | null
}

export interface CooldownVerdict {
  readonly ok: boolean
  readonly bypassed: boolean
  readonly reason: string
}

const MINUTE_MS = 60_000

function minutes(ms: number): string {
  return (ms / MINUTE_MS).toFixed(1)
}

export class RunGate {
  private active = 0
  private pending = 0

  constructor(private readonly mode: AutomationRunMode) {}

  get activeRuns(): number {
    return this.active
  }

  get queuedTriggers(): number {
    return this.pending
  }

  admit(): RunGateAdmission {
    const mode = this.mode
    switch (mode.mode) {
      case 'single':
      case 'cooldown':
        if (this.active > 0) {
          return { decision: 'drop', reason: `${mode.mode}: a run is already in progress` }
        }
        this.active += 1
        return { decision: 'run', reason: `${mode.mode}: no run in progress` }
      case 'restart':
        if (this.active > 0) {
          this.active += 1
          return {
            decision: 'restart',
            reason: `restart: aborting ${this.active - 1} run(s) in progress`,
          }
        }
        this.active += 1
        return { decision: 'run', reason: 'restart: no run in progress' }
      case 'queued':
        if (this.active === 0) {
          this.active += 1
          return { decision: 'run', reason: 'queued: no run in progress' }
        }
        if (this.pending < mode.max) {
          this.pending += 1
          return {
            decision: 'queued',
            reason: `queued: a run is in progress, waiting ${this.pending} of ${mode.max}`,
          }
        }
        return {
          decision: 'drop',
          reason: `queued: a run is in progress and the queue is full (${mode.max})`,
        }
      case 'parallel':
        if (this.active < mode.max) {
          this.active += 1
          return { decision: 'run', reason: `parallel: ${this.active} of ${mode.max} running` }
        }
        return {
          decision: 'drop',
          reason: `parallel: ${mode.max} runs already in progress`,
        }
    }
  }

  /** The run holding a slot ended (any outcome). True = a queued trigger took the slot. */
  release(): boolean {
    if (this.active > 0) this.active -= 1
    if (this.mode.mode === 'queued' && this.pending > 0) {
      this.pending -= 1
      this.active += 1
      return true
    }
    return false
  }

  /** Checked AFTER the conditions pass. Always `ok` outside `cooldown` mode. */
  cooldown(input: CooldownInput): CooldownVerdict {
    if (this.mode.mode !== 'cooldown') return { ok: true, bypassed: false, reason: '' }
    const waitMs = this.mode.minutes * MINUTE_MS
    if (input.lastRunStartedAt === null) {
      return {
        ok: true,
        bypassed: false,
        reason: `cooldown ${this.mode.minutes} min: no earlier run`,
      }
    }
    const elapsed = input.now - input.lastRunStartedAt
    if (elapsed >= waitMs) {
      return {
        ok: true,
        bypassed: false,
        reason: `cooldown ${this.mode.minutes} min: last run started ${minutes(elapsed)} min ago`,
      }
    }
    const left = `${minutes(waitMs - elapsed)} min left`
    if (input.manual) {
      return {
        ok: true,
        bypassed: true,
        reason: `cooldown ${this.mode.minutes} min bypassed by a manual trigger (${left})`,
      }
    }
    return {
      ok: false,
      bypassed: false,
      reason: `cooldown ${this.mode.minutes} min: last run started ${minutes(elapsed)} min ago, ${left}`,
    }
  }
}
