/**
 * One running composition: per-field state, writes to the composed device, and
 * one deadline timer (D659).
 *
 * - Only the fields a change affects are recomputed.
 * - A cap is SEEDED once (`setCapState`, every required field present), then
 *   PATCHED (`patchCapState` merges; the runtime-state twin of "`setAll`
 *   already merges").
 * - Unavailable is per field. A nullable field is written `null`; a
 *   non-nullable one is not written and the device goes offline (D393).
 * - A `clock` field (`now` only) is recomputed when a sibling of its cap
 *   changes value, so `binary.lastChangedAt` is the last transition. A
 *   `constant` is computed once.
 * - A windowed expression reports when it flips; ONE timer at the earliest
 *   such instant. It waits for no source (D3). Every evaluation is STORED, so
 *   a deadline that moved reaches the timer even when the value did not: an
 *   unstored deadline fires early, re-evaluates to "same", and re-arms
 *   `setTimeout(0)` until the real window closes — a poll (R1).
 * - A fatal (source gone) outcome is the block's failure, and it is sticky:
 *   the device stays offline until a new runtime, created on an operator edit
 *   or restart, clears it.
 * - A write the target REFUSES or THROWS on leaves the evaluated outcomes
 *   alone and marks its cap write-pending: the next pass that evaluates any
 *   field of that cap, and every deadline pass, re-writes the WHOLE current
 *   slice (a seed if it was never seeded). No retry timer — the next source
 *   event or deadline is the retry (D3). One log line per failure transition.
 * - Nothing escapes: a pass that throws is logged, and the timer is re-armed
 *   from the stored deadlines regardless.
 * - `stop()` is terminal: every entry point is a no-op afterwards.
 *
 * Slice 2 (D663):
 * - Records are keyed by `compositionFieldKey`: two items' `status` are two
 *   records. An item-array cap is written WHOLE — a change to one item leaf
 *   re-sends every item, assembled by `assembleSlice` on the cap's `emptyItem`.
 *   A required item leaf with no fallback holds the array, named once.
 * - `'unknown'` unavailable mode writes the enum's own word.
 * - `'release'` unavailable mode hands the field BACK (ruling S1b): the target
 *   is told to `withhold` it, the field's record forgets what it wrote, and the
 *   source returning re-widens and writes it again. Stale is a value (D49),
 *   never a release — and neither is an UNCONFIRMED unavailability (a failed,
 *   first or empty read): the field is HELD on its last value, not written,
 *   not withheld, its claim kept, until the source answers (D49, fix round 2).
 *   `state().released` / `state().held` name every such field for the report.
 * - A target whose writes are asynchronous (claims on the hub) reports what did
 *   not land through `onAsyncFailure`: the cap is marked write-pending by name
 *   and re-written whole on the next pass — no retry timer (D3).
 *
 * Slice 2b (D670): evaluation — stateful memory, state-derived events before
 * their write, and reads of the composition's OWN fields answered from the
 * records rather than the hub (D670 amendment) — is `composition-evaluation.ts`.
 * Neither an event-bus failure nor a refused write can replay an event, and the
 * hub's echo of the runtime's own write re-runs nothing.
 */
import {
  type CapabilityLookup,
  type CompositionEventPlan,
  type CompositionFieldPlan,
  type CompositionFieldRead,
  type CompositionFieldState,
  compositionSliceKey,
  type FieldOutcome,
  type IScopedLogger,
  type SourceReader,
} from '@camstack/types'
import {
  type EvaluationHost,
  emitStateDerivedEvent,
  evaluateFields,
  evaluateWithOwnReaders,
  ownKeyOf,
} from './composition-evaluation.js'
import type {
  ComposedWriteTarget,
  CompositionEventEmitter,
  DeadlineTimer,
  TargetAsyncFailure,
} from './composition-target.js'
import { type AssemblerEntry, assembleSlice } from './slice-assembler.js'
import {
  fieldRecords,
  type FieldRecord,
  errorText,
  fieldKey,
  fieldPath,
  isFatal,
  isHeld,
  isReleased,
  itemOf,
  NO_FIELDS,
  namedField,
  type PendingWrite,
  pendingReason,
  type ReleasedField,
  reasonOf,
  sameOutcome,
  sameSet,
  topLevelField,
  valueOf,
  writable,
} from './field-record.js'
import type { PulseFieldSeed } from './pulse-seed.js'

export type { ReleasedField } from './field-record.js'
export type {
  ComposedWriteTarget,
  CompositionEventEmitter,
  DeadlineTimer,
  TargetAsyncFailure,
  WriteOk,
  WriteOutcome,
  WriteRefused,
} from './composition-target.js'

export interface CompositionRuntimeDeps {
  readonly blockId: string
  readonly fields: readonly CompositionFieldPlan[]
  readonly eventPlans: readonly CompositionEventPlan[]
  readonly events: CompositionEventEmitter
  readonly target: ComposedWriteTarget
  readonly lookupCap: CapabilityLookup
  /** Effective target slices captured before an existing-target runtime takes ownership. */
  readonly initialByCap?: ReadonlyMap<string, Readonly<Record<string, unknown>> | null>
  /** Pulse start seed (D938). Absent keeps `initialByCap`. `hold` publishes nothing. */
  readonly pulseSeeds?: ReadonlyMap<string, PulseFieldSeed>
  readonly read: SourceReader
  /**
   * Whether `read` is of this composition's OWN output (an added cap on its
   * existing target, or its composed device): answered from the runtime's
   * record, never from `read`. Absent = none is.
   */
  readonly isOwnRead?: (read: CompositionFieldRead) => boolean
  readonly now: () => number
  readonly timer: DeadlineTimer
  readonly logger: IScopedLogger
}

export interface CompositionRuntimeState {
  readonly failure: string | null
  readonly available: boolean
  readonly fields: readonly CompositionFieldState[]
  readonly released: readonly ReleasedField[]
  /** `release`-mode fields HELD on their last value: unavailable, but no source has answered so (D49). */
  readonly held: readonly ReleasedField[]
}

type PassTrigger = 'start' | 'source' | 'deadline'

type RefusalCode = Extract<TargetAsyncFailure, { kind: 'refused' }>['code']

/**
 * A refusal nothing on this side can retry away: another owner holds the
 * field, the slice is invalid for the cap, the device is not known. Every
 * other outcome — a throw, an unreadable row, a migration in flight, a lost
 * claim — is transient and retried on the next pass (D6: bounded, never a loop).
 */
const TERMINAL_REFUSALS: ReadonlySet<RefusalCode> = new Set<RefusalCode>([
  'owned-by-other',
  'invalid-slice',
  'unknown-device',
])

/** What `syncReleased` did for a cap this pass. */
type ReleaseSync = 'unchanged' | 'changed' | 'failed'

export class CompositionRuntime {
  private records: ReadonlyMap<string, FieldRecord>
  private readonly startedAtMs: number
  private seeded: ReadonlySet<string> = new Set()
  private available: boolean | null = null
  private failure: string | null = null
  private disabledReason: string | null = null
  private stopped = false
  /** The last `pass threw` logged (`during: message`); cleared by a pass that completes. */
  private lastPassError: string | null = null
  private pending: ReadonlyMap<string, PendingWrite> = new Map()
  private heldBack: ReadonlySet<string> = new Set()
  /** Caps whose item array is not written because a required leaf has no value. */
  private itemsHeld: ReadonlySet<string> = new Set()
  /** Record keys currently released (S1b), for transition logs and the report. */
  private released: ReadonlySet<string> = new Set()
  /** Per cap, the top-level fields the target last accepted as withheld; absent = none. */
  private withheld: ReadonlyMap<string, ReadonlySet<string>> = new Map()
  /** Per record key, how many times the field has been released — churn the transition line reports (D391). */
  private releaseFlaps: ReadonlyMap<string, number> = new Map()
  /** Caps the target refused for good (`TERMINAL_REFUSALS`): never written again by this runtime. */
  private terminal: ReadonlyMap<string, string> = new Map()
  /** What `composition-evaluation.ts` reads and commits through. */
  private readonly evaluation: EvaluationHost

  constructor(private readonly deps: CompositionRuntimeDeps) {
    this.startedAtMs = deps.now()
    this.records = fieldRecords(deps.fields, deps.initialByCap, deps.lookupCap, deps.pulseSeeds)
    deps.target.onAsyncFailure?.((cap, failure) => this.onTargetWriteFailed(cap, failure))
    const eventContext = {
      deviceId: deps.target.id,
      blockId: deps.blockId,
      events: deps.events,
      logger: deps.logger,
    }
    this.evaluation = {
      records: () => this.records,
      commit: (records) => {
        this.records = records
      },
      read: deps.read,
      ...(deps.isOwnRead === undefined ? {} : { isOwnRead: deps.isOwnRead }),
      eventPlans: deps.eventPlans,
      startedAtMs: this.startedAtMs,
      emit: (plan, timestamp) => emitStateDerivedEvent(eventContext, plan, timestamp),
      logTransition: (record, outcome) => this.logTransition(record, outcome),
    }
  }

  start(): void {
    if (this.disabledReason !== null) return
    this.guarded('start', true, () => this.pass([...this.records.keys()], 'start'))
  }

  onSourcesChanged(sliceKeys: ReadonlySet<string>): void {
    if (this.disabledReason !== null) return
    this.guarded('source', true, () => {
      // The hub's echo of an own field is not a source change: it is answered
      // from the record, and the pass that changed it already re-ran its readers.
      const affected = [...this.records.values()]
        .filter((r) =>
          r.plan.reads.some(
            (read) =>
              ownKeyOf(this.evaluation, read) === null &&
              sliceKeys.has(compositionSliceKey(read.source, read.cap)),
          ),
        )
        .map((r) => fieldKey(r.plan))
      if (affected.length > 0) this.pass(affected, 'source')
    })
  }

  disable(reason: string): void {
    if (this.stopped) return
    this.disabledReason = reason
    this.deps.timer.disarm()
    this.guarded('disable', false, () => {
      // Disabling IS the answer: every release-mode field is handed back.
      const outcome: FieldOutcome = {
        state: 'unavailable',
        value: null,
        reason,
        fatal: false,
        confirmed: true,
      }
      const touched = [...this.records.values()].filter(
        (r) => !isFatal(r.outcome) && !sameOutcome(r.outcome, outcome),
      )
      for (const r of touched) this.logTransition(r, outcome)
      this.records = new Map(
        [...this.records].map(([k, r]) => [k, isFatal(r.outcome) ? r : { ...r, outcome }]),
      )
      this.writeCaps(new Set(touched.map((r) => fieldKey(r.plan))), new Set())
      this.updateAvailability()
    })
  }

  /** Terminal: no write, no evaluation and no timer after this. */
  stop(): void {
    this.stopped = true
    this.deps.timer.disarm()
  }

  /** `stop`, then wait until the target has sent nothing further. */
  quiesce(): Promise<void> {
    this.stop()
    const quiesce = this.deps.target.quiesce
    if (quiesce === undefined) return Promise.resolve()
    return quiesce.call(this.deps.target)
  }

  state(): CompositionRuntimeState {
    return {
      failure: this.failure,
      available: this.available === true,
      fields: [...this.records.values()].map((r) => {
        const terminal = this.terminal.get(r.plan.cap)
        if (terminal !== undefined && !isFatal(r.outcome)) {
          return {
            cap: r.plan.cap,
            path: r.plan.path,
            ...itemOf(r.plan),
            state: 'unavailable',
            value: null,
            reason: terminal,
          }
        }
        const pending = this.pending.get(r.plan.cap)
        if (pending !== undefined && !isFatal(r.outcome)) {
          return {
            cap: r.plan.cap,
            path: r.plan.path,
            ...itemOf(r.plan),
            state: 'unavailable',
            value: null,
            reason: pendingReason(r.plan.cap, pending),
          }
        }
        const value = valueOf(r.outcome)
        const reason = reasonOf(r.outcome)
        return {
          cap: r.plan.cap,
          path: r.plan.path,
          ...itemOf(r.plan),
          state: r.outcome?.state ?? 'unavailable',
          value: value === undefined ? null : value,
          ...(reason === null ? {} : { reason }),
        }
      }),
      released: [...this.records.values()].filter(isReleased).map(namedField),
      held: [...this.records.values()].filter(isHeld).map(namedField),
    }
  }

  /**
   * The target's enqueued write of `cap` did not land: the cap is write-pending
   * by name and re-written WHOLE on the next pass that evaluates it (or the next
   * deadline pass). A withhold sent to that target is forgotten too, so it is
   * re-sent. No retry timer (D3).
   */
  private onTargetWriteFailed(cap: string, failure: TargetAsyncFailure): void {
    this.guarded('target-failure', false, () => {
      if (!this.deps.fields.some((f) => f.cap === cap) || this.terminal.has(cap)) return
      if (failure.kind === 'refused' && TERMINAL_REFUSALS.has(failure.code)) {
        this.markTerminal(cap, failure.code, failure.message)
        return
      }
      this.withheld = new Map([...this.withheld].filter(([c]) => c !== cap))
      this.markPending(
        cap,
        this.seeded.has(cap) ? 'patch' : 'seed',
        failure.kind === 'threw'
          ? { kind: 'threw', error: failure.error }
          : { kind: 'refused', error: `${failure.code}: ${failure.message}` },
      )
      this.updateAvailability()
    })
  }

  /**
   * The target refused this cap for good: nothing on this side can retry it
   * away (I-3). The cap is never written again by this runtime, its fields
   * report the refusal, and the block fails naming it — only the operator ends
   * this (edit or delete the block, or the competing one), like a gone source.
   */
  private markTerminal(cap: string, code: RefusalCode, message: string): void {
    const reason = `the \`${cap}\` capability was refused for good: ${code}: ${message} — only the operator ends this (edit or delete the block)`
    this.terminal = new Map([...this.terminal, [cap, reason]])
    this.pending = new Map([...this.pending].filter(([c]) => c !== cap))
    if (this.failure === null)
      this.failure = `composed write refused for good — ${cap}: ${code}: ${message}`
    this.deps.logger.error(
      'composed capability refused for good — it is not written again until the operator edits or deletes the block',
      {
        tags: { deviceId: this.deps.target.id },
        meta: { blockId: this.deps.blockId, cap, code, error: message },
      },
    )
    this.updateAvailability()
  }

  /**
   * Every entry point runs here: a no-op once stopped, nothing thrown escapes,
   * and the one timer is re-armed from the stored deadlines whatever happened.
   */
  private guarded(during: string, rearm: boolean, body: () => void): void {
    if (this.stopped) return
    let threw = false
    try {
      body()
      this.lastPassError = null
    } catch (error) {
      threw = true
      this.logPassError(during, errorText(error))
    } finally {
      // After a throw, a deadline already due was not re-evaluated: arming it
      // would fire at once, throw again and spin — a poll (D3). Only future
      // deadlines are armed; the next source event re-runs the due field.
      if (rearm && !this.stopped && this.disabledReason === null)
        this.armDeadline(threw ? this.deps.now() : null)
    }
  }

  /** Once per distinct failure, not once per pass: a reader that keeps throwing logs one line. */
  private logPassError(during: string, error: string): void {
    const key = `${during}: ${error}`
    if (key === this.lastPassError) return
    this.lastPassError = key
    this.deps.logger.error(
      'composition pass threw — the runtime keeps running; the next source event or deadline re-runs it',
      {
        tags: { deviceId: this.deps.target.id },
        meta: { blockId: this.deps.blockId, during, error },
      },
    )
  }

  private pass(keys: readonly string[], trigger: PassTrigger): void {
    const initial = trigger === 'start'
    const now = this.deps.now()
    const calculated = evaluateWithOwnReaders(
      this.evaluation,
      keys.filter((k) => {
        const role = this.records.get(k)?.plan.role
        return role === 'derived' || role === 'accumulator'
      }),
      now,
    )
    const followers = [...this.records.values()]
      .filter((r) =>
        r.plan.role === 'clock'
          ? initial || calculated.valueCaps.has(r.plan.cap)
          : r.plan.role === 'constant' && initial,
      )
      .map((r) => fieldKey(r.plan))
    const extra = evaluateFields(this.evaluation, followers, now)
    const evaluatedCaps = new Set(
      [...keys, ...followers].flatMap((k) => {
        const cap = this.records.get(k)?.plan.cap
        return cap === undefined ? [] : [cap]
      }),
    )
    const retry = new Set(
      [...this.pending.keys()].filter((cap) => trigger === 'deadline' || evaluatedCaps.has(cap)),
    )
    this.writeCaps(new Set([...calculated.keys, ...extra.keys]), retry)
    this.updateFailure()
    this.updateAvailability()
  }

  private recordsOf(cap: string): readonly FieldRecord[] {
    return [...this.records.values()].filter((r) => r.plan.cap === cap)
  }

  /** `retry`: write-pending caps this pass re-writes WHOLE, whether or not a value changed. */
  private writeCaps(touched: ReadonlySet<string>, retry: ReadonlySet<string>): void {
    const caps = new Set([
      ...[...touched].flatMap((k) => {
        const cap = this.records.get(k)?.plan.cap
        return cap === undefined ? [] : [cap]
      }),
      ...retry,
    ])
    for (const cap of caps) {
      if (this.terminal.has(cap)) continue
      const sync = this.syncReleased(cap)
      if (sync === 'failed') continue
      if (!this.seeded.has(cap)) this.seedCap(cap)
      // A changed withhold narrows or re-widens the claim: the claim over the
      // remaining fields goes out NOW, with every current value — not when a
      // sibling next happens to change (I-1).
      else if (this.pending.has(cap) || sync === 'changed')
        this.patchWholeCap(cap, sync === 'changed')
      else this.patchCap(cap, touched)
    }
  }

  /**
   * S1b: tell the target which fields of `cap` are released, when that set
   * changed since it last accepted one. A released record forgets what it wrote,
   * so the source returning writes it again. False when the target refused or
   * threw: the cap is write-pending and the withhold is re-sent next pass.
   */
  private syncReleased(cap: string): ReleaseSync {
    const records = this.recordsOf(cap)
    this.logReleaseTransitions(cap, records)
    const releasedRecords = records.filter(isReleased)
    this.records = new Map(
      [...this.records].map(([k, r]) =>
        releasedRecords.includes(r) && r.hasWritten
          ? [k, { ...r, hasWritten: false, written: undefined }]
          : [k, r],
      ),
    )
    const withhold = this.deps.target.withhold
    if (withhold === undefined) return 'unchanged'
    const fields = new Set(releasedRecords.map((r) => topLevelField(r.plan)))
    if (sameSet(fields, this.withheld.get(cap) ?? NO_FIELDS)) return 'unchanged'
    let failed: PendingWrite | null
    try {
      const outcome = withhold.call(this.deps.target, cap, [...fields].toSorted())
      failed = outcome.ok ? null : { kind: 'refused', error: outcome.error }
    } catch (error) {
      failed = { kind: 'threw', error: errorText(error) }
    }
    if (failed !== null) {
      this.markPending(cap, this.seeded.has(cap) ? 'patch' : 'seed', failed)
      return 'failed'
    }
    this.withheld = new Map(
      [...this.withheld.entries()]
        .filter(([c]) => c !== cap)
        .concat(fields.size === 0 ? [] : [[cap, fields]]),
    )
    return 'changed'
  }

  /** One info line per field per direction, never one per pass. */
  private logReleaseTransitions(cap: string, records: readonly FieldRecord[]): void {
    const now = new Set(records.filter(isReleased).map((r) => fieldKey(r.plan)))
    const before = new Set(
      records.filter((r) => this.released.has(fieldKey(r.plan))).map((r) => fieldKey(r.plan)),
    )
    for (const r of records) {
      const key = fieldKey(r.plan)
      const direction =
        now.has(key) && !before.has(key)
          ? 'released'
          : !now.has(key) && before.has(key)
            ? 'reclaimed'
            : null
      if (direction === null) continue
      const flaps = (this.releaseFlaps.get(key) ?? 0) + (direction === 'released' ? 1 : 0)
      this.releaseFlaps = new Map([...this.releaseFlaps, [key, flaps]])
      this.deps.logger.info(
        direction === 'released'
          ? 'composed field released to the native provider — its source is unavailable'
          : 'composed field reclaimed from the native provider — its source is back',
        {
          tags: { deviceId: this.deps.target.id },
          meta: {
            blockId: this.deps.blockId,
            cap,
            field: fieldPath(r.plan),
            direction,
            reason: reasonOf(r.outcome) ?? 'value available again',
            flaps,
          },
        },
      )
    }
    this.released = new Set([...[...this.released].filter((k) => !before.has(k)), ...now])
  }

  private seedCap(cap: string): void {
    const records = this.recordsOf(cap)
    // A HELD field holds the seed too: a claim over it would send no value for it.
    const missing = records
      .filter((r) => (r.plan.required || isHeld(r)) && writable(r) === undefined && !isReleased(r))
      .map((r) => fieldPath(r.plan))
    if (missing.length > 0) return this.holdBackSeed(cap, missing)
    this.heldBack = new Set([...this.heldBack].filter((c) => c !== cap))
    const entries = this.entriesFor(cap, records)
    if (!this.write(cap, 'seed', entries)) return
    this.seeded = new Set([...this.seeded, cap])
    this.markWritten(cap, entries)
  }

  private patchCap(cap: string, touched: ReadonlySet<string>): void {
    const entries = this.entriesFor(
      cap,
      this.recordsOf(cap).filter(
        (r) => touched.has(fieldKey(r.plan)) && (!r.hasWritten || writable(r) !== r.written),
      ),
    )
    if (entries.length === 0) return
    if (this.write(cap, 'patch', entries)) this.markWritten(cap, entries)
  }

  /**
   * After a failed write nothing is known about what landed, and after a
   * changed withhold the claim must be re-stated: send every current value.
   * `afterWithhold` with nothing left to write means the cap was released
   * whole — a pending write is moot then, not retried (M-2).
   */
  private patchWholeCap(cap: string, afterWithhold = false): void {
    const entries = this.entriesFor(cap, this.recordsOf(cap))
    if (entries.length === 0) {
      if (afterWithhold && this.pending.has(cap)) this.dropPending(cap)
      return
    }
    if (this.write(cap, 'patch', entries)) this.markWritten(cap, entries)
  }

  private dropPending(cap: string): void {
    this.pending = new Map([...this.pending].filter(([c]) => c !== cap))
    this.deps.logger.info(
      'composed capability released whole — its pending write is moot, nothing is left to write',
      { tags: { deviceId: this.deps.target.id }, meta: { blockId: this.deps.blockId, cap } },
    )
  }

  /**
   * What one write of `cap` carries: the writable `candidates` — and, when any
   * of them is an item leaf, EVERY item leaf of the cap, because the array is
   * written whole (a patch of `items` replaces it). A required item leaf with
   * no value holds the whole array (its top-level siblings still go out).
   */
  private entriesFor(cap: string, candidates: readonly FieldRecord[]): readonly AssemblerEntry[] {
    const top = candidates.filter((r) => r.plan.item === undefined)
    if (!candidates.some((r) => r.plan.item !== undefined)) return this.writableEntries(top)
    const items = this.recordsOf(cap).filter((r) => r.plan.item !== undefined)
    const missing = items
      .filter((r) => r.plan.required && writable(r) === undefined)
      .map((r) => fieldPath(r.plan))
    if (missing.length > 0) {
      this.holdItems(cap, missing)
      return this.writableEntries(top)
    }
    this.itemsHeld = new Set([...this.itemsHeld].filter((c) => c !== cap))
    return this.writableEntries([...top, ...items])
  }

  private writableEntries(records: readonly FieldRecord[]): readonly AssemblerEntry[] {
    return records.flatMap((r) => {
      const value = writable(r)
      return value === undefined ? [] : [{ plan: r.plan, value }]
    })
  }

  private holdItems(cap: string, missing: readonly string[]): void {
    if (this.itemsHeld.has(cap)) return
    this.itemsHeld = new Set([...this.itemsHeld, cap])
    this.deps.logger.warn(
      'composed items held — a required item field has no value; the array is not written until it does',
      {
        tags: { deviceId: this.deps.target.id },
        meta: { blockId: this.deps.blockId, cap, missing },
      },
    )
  }

  private holdBackSeed(cap: string, missing: readonly string[]): void {
    if (this.heldBack.has(cap)) return
    this.heldBack = new Set([...this.heldBack, cap])
    this.deps.logger.warn('composed capability not seeded yet — a required field has no value', {
      tags: { deviceId: this.deps.target.id },
      meta: { blockId: this.deps.blockId, cap, missing },
    })
  }

  /** One write. A refusal or a throw marks the cap write-pending; true when the target took it. */
  private write(cap: string, op: 'seed' | 'patch', entries: readonly AssemblerEntry[]): boolean {
    let failed: PendingWrite | null
    try {
      const values = assembleSlice(entries, this.deps.lookupCap)
      const outcome =
        op === 'seed' ? this.deps.target.seed(cap, values) : this.deps.target.patch(cap, values)
      failed = outcome.ok ? null : { kind: 'refused', error: outcome.error }
    } catch (error) {
      failed = { kind: 'threw', error: errorText(error) }
    }
    if (failed === null) {
      this.clearPending(cap)
      return true
    }
    this.markPending(cap, op, failed)
    return false
  }

  private clearPending(cap: string): void {
    if (!this.pending.has(cap)) return
    this.pending = new Map([...this.pending].filter(([c]) => c !== cap))
    this.deps.logger.info('composed capability written again after a failed write', {
      tags: { deviceId: this.deps.target.id },
      meta: { blockId: this.deps.blockId, cap },
    })
  }

  private markPending(cap: string, op: 'seed' | 'patch', failed: PendingWrite): void {
    const wasPending = this.pending.has(cap)
    this.pending = new Map([...this.pending, [cap, failed]])
    if (wasPending) return
    const message =
      failed.kind === 'refused'
        ? 'composed capability refused a write — its whole slice is re-written on the next pass that evaluates it'
        : 'composed capability write threw — its whole slice is re-written on the next pass that evaluates it'
    this.deps.logger.warn(message, {
      tags: { deviceId: this.deps.target.id },
      meta: { blockId: this.deps.blockId, cap, op, error: failed.error },
    })
  }

  private markWritten(cap: string, entries: readonly AssemblerEntry[]): void {
    const written = new Map(entries.map((e) => [fieldKey(e.plan), e.value] as const))
    this.records = new Map(
      [...this.records].map(([k, r]) =>
        r.plan.cap === cap && written.has(k)
          ? [k, { ...r, hasWritten: true, written: written.get(k) }]
          : [k, r],
      ),
    )
  }

  private updateAvailability(): void {
    const blocking = [...this.records.values()]
      .filter((r) => r.plan.unavailable === 'offline' && r.outcome?.state === 'unavailable')
      .map((r) => fieldKey(r.plan))
    const unseeded = [...new Set(this.deps.fields.map((f) => f.cap))].filter(
      (c) => !this.seeded.has(c),
    )
    const writePending = [...this.pending.keys()]
    const available =
      this.disabledReason === null &&
      this.failure === null &&
      blocking.length === 0 &&
      unseeded.length === 0 &&
      writePending.length === 0
    if (available === this.available) return
    // The mirror moves only once the target took it: a throw is retried next pass.
    this.deps.target.setAvailable(available)
    this.available = available
    const extras = {
      tags: { deviceId: this.deps.target.id },
      meta: {
        blockId: this.deps.blockId,
        blocking,
        unseeded,
        writePending,
        failure: this.failure,
        disabled: this.disabledReason,
      },
    }
    if (available) this.deps.logger.info('composed device available', extras)
    else
      this.deps.logger.warn(
        'composed device unavailable — a field has no value, a write is pending, or the block failed',
        extras,
      )
  }

  private updateFailure(): void {
    if (this.failure !== null) return
    const fatal = [...this.records.values()].find(
      (r) => r.outcome?.state === 'unavailable' && r.outcome.fatal,
    )
    if (fatal === undefined || fatal.outcome === null || fatal.outcome.state !== 'unavailable')
      return
    this.failure = `source missing — ${fatal.outcome.reason}`
    this.deps.logger.error(
      'composition failed: a source is gone — only the operator ends this (repair the source, edit or delete the block)',
      {
        tags: { deviceId: this.deps.target.id },
        meta: {
          blockId: this.deps.blockId,
          field: fieldKey(fatal.plan),
          reason: fatal.outcome.reason,
        },
      },
    )
  }

  /** `after`: arm only deadlines later than this instant; null arms the earliest stored one. */
  private armDeadline(after: number | null): void {
    const deadlines = [...this.records.values()].flatMap((r) =>
      r.outcome !== null &&
      r.outcome.state !== 'unavailable' &&
      r.outcome.deadline !== null &&
      (after === null || r.outcome.deadline > after)
        ? [r.outcome.deadline]
        : [],
    )
    if (deadlines.length === 0) {
      this.deps.timer.disarm()
      return
    }
    this.deps.timer.arm(Math.min(...deadlines), () => this.onDeadline())
  }

  private onDeadline(): void {
    this.guarded('deadline', true, () => {
      const now = this.deps.now()
      const due = [...this.records.values()]
        .filter(
          (r) =>
            r.outcome !== null &&
            r.outcome.state !== 'unavailable' &&
            r.outcome.deadline !== null &&
            r.outcome.deadline <= now,
        )
        .map((r) => fieldKey(r.plan))
      if (due.length > 0) this.pass(due, 'deadline')
    })
  }

  private logTransition(record: FieldRecord, outcome: FieldOutcome): void {
    const from = record.outcome?.state ?? 'pending'
    if (from === 'pending' && outcome.state === 'fresh') return
    const extras = {
      tags: { deviceId: this.deps.target.id },
      meta: {
        blockId: this.deps.blockId,
        cap: record.plan.cap,
        field: record.plan.path,
        from,
        to: outcome.state,
        reason: reasonOf(outcome),
      },
    }
    const message = `composed field ${fieldKey(record.plan)}: ${from} → ${outcome.state}`
    if (outcome.state === 'fresh') this.deps.logger.info(message, extras)
    else this.deps.logger.warn(message, extras)
  }
}
