/**
 * The GROUPED DELIVERY orchestrator (D692) — admission, promotion, fusion, finality and
 * the close trigger of "immediate, grouped" rules.
 *
 * `NotificationCenter` owns one instance and routes into it, always on its serialized
 * `evalChain`: the object events of a grouped rule (`admit`), the tracker's label and
 * fusion hooks, track closes, the drain-tick sweep, the shutdown close and the replay
 * release. Nothing here runs off the chain, so nothing here needs a lock (C13).
 *
 * It never sees the store, the dispatcher or the outbox. Its deps are narrow: the rule
 * engine with the centre's lookups bound, the recognition outlook, the cooldown read, the
 * action runner, the track ledger (who was already notified, who was judged) and the
 * centre's close pass. The window STATE is the pure buffer (`grouped-window-buffer.ts`);
 * every decision the buffer returns is LOGGED here, because the buffer never logs (D391).
 *
 * Every line about a camera carries `tags: { deviceId }`, and every grouped line carries
 * `meta.ruleId`, `meta.rule` and `meta.windowKey`, plus `meta.trackId` (the SURVIVOR) when it
 * is about a member (spec §7).
 */

import type { IScopedLogger, NcRule } from '@camstack/types'
import { NC_GROUPING_MIN_SEC } from '@camstack/types'
import {
  type AliasResolveFailure,
  sampledOnce,
} from '../../pipeline-analytics/track-alias-resolution.js'
import type { NcEventOrigin, NcIntakeControls } from '../event-intake.js'
import type { NcEvaluation, NcRuleSubject } from '../rule-engine.js'
import type {
  NcRecognitionOutlook,
  NcRecognitionOutlookQuery,
  NcTrackLabelChanged,
  NcTracksFused,
} from './grouped-inputs.js'
import {
  groupedWindowKey,
  type NcAdmitResult,
  type NcGroupedCloseReason,
  type NcGroupedLabelOverlay,
  type NcGroupedMember,
  type NcGroupedWindow,
  NcGroupedWindowBuffer,
  type NcGroupedWindowFlags,
  type NcGroupedWindowScope,
  windowHoldAt,
  withLabelOverlay,
} from './grouped-window-buffer.js'

/**
 * The hard bound on the shutdown close (spec §3.5): `stop()` waits this long for the open
 * windows to close, then proceeds — the restart replay recovers whatever did not finish.
 */
export const NC_GROUPED_SHUTDOWN_CLOSE_MS = 2_000

/** The sampled `recognition outlook unknown` line: once per camera per 10 min (spec §7). */
const NC_GROUPED_UNKNOWN_OUTLOOK_SAMPLE_MS = 10 * 60_000
/** Bound on every sampled-once memo of this module (rule ids, (rule, track) pairs). */
const NC_GROUPED_MEMO_MAX = 4_096

/**
 * What the boot reconcile hands `beginReplay` (C5): the watermark it READ, and the overlap
 * its scan starts before it. A replayed event at or after `watermark − overlapMs` may OPEN
 * a replaying window; only an older one may not (review T10 HIGH-1b).
 */
export interface NcGroupedReplayStart {
  /** `null` = never persisted, or unreadable: every replayed event may open. */
  readonly watermark: number | null
  readonly overlapMs: number
  /**
   * Whether the notified-set hydration READ the outbox. The overlap is safe only with it
   * behind it (C9); `false` runs the replay on the strict watermark (review T10 LOW-A).
   */
  readonly hydrated: boolean
}

/** The overlap a replay actually applies: none without the hydration behind it (LOW-A). */
function effectiveOverlapMs(replay: NcGroupedReplayStart): number {
  return replay.hydrated ? replay.overlapMs : 0
}

/** The cooldown read of an OPENING subject — the key is what the line names. */
export interface NcGroupedCooldownVerdict {
  readonly key: string
  readonly cooling: boolean
}

/** A judged track's last subject for one rule (C10): what a late recognition re-evaluates. */
export interface NcGroupedJudgedEntry {
  readonly ruleId: string
  readonly subject: NcRuleSubject
}

/**
 * What the centre remembers about tracks across windows: the ones a rule already notified
 * (once per track per rule, spec §3.5) and the ones a close judged unrecognised for a rule
 * (C10). The close pass fills both; admission and the hooks only read them (and take a
 * track out of `judged` when a full match re-opens it).
 */
export interface NcGroupedTrackLedger {
  readonly notified: (ruleId: string, trackId: string) => boolean
  /** Every rule that notified this (survivor) track — the §3.4 "fused after" measurement. */
  readonly notifiedRulesFor: (trackId: string) => readonly string[]
  readonly judged: (ruleId: string, trackId: string) => boolean
  /** Every rule that judged this track on this camera, with the subject it was judged on. */
  readonly judgedFor: (deviceId: number, trackId: string) => readonly NcGroupedJudgedEntry[]
  /**
   * A refusal on a notified or judged track slides that entry's TTL (review T9a M-1): a
   * track still in view after 30 minutes must stay covered.
   */
  readonly touch: (ruleId: string, trackId: string) => void
  /** A full match re-opened the track: it leaves the rule's judged set (C10). */
  readonly unjudge: (ruleId: string, trackId: string) => void
  /** The track closed: its judgement ends with it, for every rule (C10). */
  readonly trackClosed: (deviceId: number, trackId: string) => void
}

export interface NcGroupedDeliveryDeps {
  readonly logger: IScopedLogger
  readonly now: () => number
  /** Full (`relax=false`) or relaxed evaluation, the centre's lookups bound. */
  readonly evaluate: (rule: NcRule, subject: NcRuleSubject, relax: boolean) => NcEvaluation
  /** The centre's `recognitionOutlookFor` — `unknown` (pending) when it cannot answer. */
  readonly outlook: (query: NcRecognitionOutlookQuery) => NcRecognitionOutlook
  /** The rule as it stands NOW (a rule edited mid-window is judged as edited). */
  readonly getRule: (ruleId: string) => NcRule | null
  /** The alias store's RAM read (fresh review L-1): asked before the async one. */
  readonly resolveTrackAliasSync?: (trackId: string) => string | undefined
  /** The alias store's durable read: asked only when both sync reads gave the id back. */
  readonly resolveTrackAlias?: (trackId: string) => Promise<string | null>
  /** The centre's `runRuleActions` for an object-event match (spec §3.7). */
  readonly runActions: (rule: NcRule, subject: NcRuleSubject, controls: NcIntakeControls) => void
  readonly cooldown: (rule: NcRule, subject: NcRuleSubject, now: number) => NcGroupedCooldownVerdict
  readonly ledger: NcGroupedTrackLedger
  /**
   * The centre's close pass, handed a window ALREADY taken out of the buffer, with its
   * members reserved in `closing` for the whole call (C13). Resolves to the rows it inserted.
   */
  readonly close: (window: NcGroupedWindow, reason: NcGroupedCloseReason) => Promise<number>
  /**
   * The window RECORD (spec §5): called once when a window OPENS. Best-effort and never
   * awaited — the centre's store write must not stall the evaluation chain.
   */
  readonly record: (window: NcGroupedWindow) => void
  /**
   * D706: which subjects share this admission's window — `rule` while the rule's alarm is
   * in its entry delay or has triggered (one intrusion push across cameras), else `camera`
   * (D692). Absent = always `camera`.
   */
  readonly windowScope?: (rule: NcRule, subject: NcRuleSubject) => NcGroupedWindowScope
}

export type NcGroupedRefusal =
  | 'window-full'
  | 'too-many-windows'
  | 'already-notified'
  | 'already-judged'
  | 'closing'
  /** C5: a replayed event older than the replay's slack (watermark − overlap) may join, never open. */
  | 'predates-watermark'
  /**
   * C11: `closeWindowImmediately` and a `synthetic` origin must come together. A live
   * admission carrying the flag, or a synthetic one without it, is refused — a test never
   * touches the shared buffer, and a live subject never closes a window at once.
   */
  | 'test-flag-mismatch'

/** The subject entered (or updated) a window as a match or a candidate. */
export interface NcGroupedAdmitted {
  readonly kind: 'opened' | 'joined' | 'updated'
  readonly windowKey: string
  readonly matched: boolean
  readonly matchedOn?: readonly string[]
}
/**
 * Neither a match nor a live candidate (a plain non-match, or a relaxed pass on a FINAL
 * subject). Carries the FULL evaluation, so the caller reports it exactly as a plain rule.
 */
export interface NcGroupedNoMatch {
  readonly kind: 'no-match'
  readonly evaluation: NcEvaluation
}
/** A subject that would OPEN a window, on a cooling key (spec §3.6). */
export interface NcGroupedCoolingDown {
  readonly kind: 'cooling-down'
  readonly key: string
  readonly matched: boolean
  readonly matchedOn?: readonly string[]
}
export interface NcGroupedRefused {
  readonly kind: 'refused'
  readonly why: NcGroupedRefusal
  readonly matched: boolean
  readonly matchedOn?: readonly string[]
}
/** C17: an event without a track takes the PLAIN immediate path for this rule. */
export interface NcGroupedPlain {
  readonly kind: 'plain'
  readonly reason: 'no-track'
}
/** C11: the tester's subject was closed at once as a group of one (`closeReason: 'test'`). */
export interface NcGroupedTested {
  readonly kind: 'tested'
  readonly windowKey: string
  /** Rows the group-of-one close inserted: 0 when nothing was sent (no target, snoozed, muted). */
  readonly enqueued: number
  readonly matched: boolean
  readonly matchedOn?: readonly string[]
}
export type NcGroupedAdmissionOutcome =
  | NcGroupedAdmitted
  | NcGroupedNoMatch
  | NcGroupedCoolingDown
  | NcGroupedRefused
  | NcGroupedPlain
  | NcGroupedTested

/** A member's finality (spec §4), with what it still waits for when it is not final. */
export type NcGroupedMemberFinality =
  | { readonly final: true }
  | { readonly final: false; readonly awaiting: string; readonly reason?: string }

/** What a subject is to a grouped rule after the evaluation (spec §3.2). */
interface Verdict {
  readonly matched: boolean
  readonly matchedOn?: readonly string[]
  readonly outlook: NcRecognitionOutlook
}

function pairKey(ruleId: string, trackId: string): string {
  return `${ruleId}|${trackId}`
}

/** The overlay a label hook or a closed-track subject sets on a member (C14, C16). */
function overlayOf(label: {
  readonly label?: string
  readonly identityId?: string
  readonly labelKind?: 'identity' | 'plate'
  readonly labelConfidence?: number
}): NcGroupedLabelOverlay {
  return {
    ...(label.label !== undefined ? { label: label.label } : {}),
    ...(label.identityId !== undefined ? { identityId: label.identityId } : {}),
    ...(label.labelKind !== undefined ? { labelKind: label.labelKind } : {}),
    ...(label.labelConfidence !== undefined ? { labelConfidence: label.labelConfidence } : {}),
  }
}

function awaitingOf(outlook: NcRecognitionOutlook): string | undefined {
  return outlook.final ? undefined : outlook.awaiting
}

/** A bounded "said once" memo: `true` the first time a key is seen. */
function firstTime(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false
  if (seen.size >= NC_GROUPED_MEMO_MAX) seen.clear()
  seen.add(key)
  return true
}

export class NcGroupedDelivery {
  private readonly buffer = new NcGroupedWindowBuffer()
  /** C13: survivor and absorbed ids of a window whose close is in flight, per rule. */
  private readonly closing = new Map<string, number>()
  /** Windows taken out of the buffer whose close pass has not returned yet (review T9b L-1). */
  private readonly inFlight = new Map<string, NcGroupedWindow>()
  private readonly noTrackReported = new Set<string>()
  private readonly inertReported = new Set<string>()
  private readonly judgedRefusalReported = new Set<string>()
  private readonly unknownOutlookReportedAt = new Map<number, number>()
  /**
   * C5: the replay the boot reconcile started, between `beginReplay` and `releaseReplay`.
   * A `null` watermark = none was ever persisted (or it could not be read): every replayed
   * event may open — the direction of the doubt is DELIVERING, and the notified-set
   * hydration still refuses whatever was already sent.
   */
  private replay: NcGroupedReplayStart | null = null
  /** Replayed events refused `predates-watermark` in this replay, per camera (D391). */
  private readonly replayRefused = new Map<number, number>()
  private readonly reportAliasFailure: (failure: AliasResolveFailure) => void

  constructor(private readonly deps: NcGroupedDeliveryDeps) {
    this.reportAliasFailure = sampledOnce(NC_GROUPED_MEMO_MAX, (failure) => {
      this.deps.logger.warn(
        'grouped window: track alias resolution failed — reading the id as asked (D315)',
        {
          ...(failure.deviceId !== undefined ? { tags: { deviceId: failure.deviceId } } : {}),
          meta: {
            method: failure.method,
            trackId: failure.id,
            error: failure.error instanceof Error ? failure.error.message : String(failure.error),
          },
        },
      )
    })
  }

  // ── admission ─────────────────────────────────────────────────────

  /** Called by `evaluateAndEnqueue` for a grouped rule on an `object-event` subject. */
  async admit(
    rule: NcRule,
    subjectIn: NcRuleSubject,
    controls: NcIntakeControls,
    origin: NcEventOrigin,
  ): Promise<NcGroupedAdmissionOutcome> {
    const asked = subjectIn.trackId
    if (asked === undefined) {
      // C17: never a silent refusal — the caller delivers it as a plain immediate.
      if (firstTime(this.noTrackReported, rule.id)) {
        this.deps.logger.info(
          'grouped rule: event without a track — delivered as plain immediate',
          {
            tags: { deviceId: subjectIn.deviceId },
            meta: { ruleId: rule.id, rule: rule.name, eventId: subjectIn.recordId },
          },
        )
      }
      return { kind: 'plain', reason: 'no-track' }
    }
    const closeAtOnce = controls.closeWindowImmediately === true
    if (closeAtOnce !== (origin === 'synthetic'))
      return this.refuseTestFlag(rule, subjectIn, origin)
    const survivor = await this.resolveTrack(subjectIn.deviceId, asked)
    const subject: NcRuleSubject =
      survivor === asked ? subjectIn : { ...subjectIn, trackId: survivor }
    // C5 (a): the replay keeps the deadlines on the EVENTS' clock — a replaying window of
    // this rule and camera whose deadline this event is past closed before it happened.
    if (origin === 'reconcile') await this.closeReplayDue(rule.id, subject)

    // Steps 3–4 (fresh review M-1): evaluate, and run the actions on a MATCH, BEFORE any
    // refusal — an actuation is never grouped, delayed or deduplicated (spec §3.7).
    const full = this.deps.evaluate(rule, subject, false)
    const outlook = this.outlookFor(subject)
    if (!full.matched) {
      const relaxed = this.deps.evaluate(rule, subject, true)
      // A candidate needs BOTH signals (review T3-M2): `pendingOn` alone also marks a
      // FINAL subject recognised as somebody else.
      const pending = relaxed.pendingOn !== undefined && relaxed.pendingOn.length > 0
      if (!pending || outlook.final) return { kind: 'no-match', evaluation: full }
    } else {
      this.deps.runActions(rule, subject, controls)
    }
    const verdict: Verdict = {
      matched: full.matched,
      ...(full.matchedOn !== undefined ? { matchedOn: full.matchedOn } : {}),
      outlook,
    }
    const matchedFields = {
      matched: verdict.matched,
      ...(verdict.matchedOn !== undefined ? { matchedOn: verdict.matchedOn } : {}),
    }
    const memberMeta = {
      ruleId: rule.id,
      rule: rule.name,
      trackId: survivor,
      eventId: subject.recordId,
    }

    // The refusals, after the actions.
    if (this.deps.ledger.notified(rule.id, survivor)) {
      this.deps.ledger.touch(rule.id, survivor)
      this.deps.logger.debug('grouped window: track already notified by this rule', {
        tags: { deviceId: subject.deviceId },
        meta: memberMeta,
      })
      return { kind: 'refused', why: 'already-notified', ...matchedFields }
    }
    if (this.deps.ledger.judged(rule.id, survivor)) {
      if (!full.matched) {
        this.deps.ledger.touch(rule.id, survivor)
        // C10 (operator ruling 2026-10-02): the FIRST suppressed re-open per (rule, track)
        // says so; repeats say nothing at all, so a stranger costs no log churn.
        if (firstTime(this.judgedRefusalReported, pairKey(rule.id, survivor))) {
          this.deps.logger.info(
            'grouped window: not re-opened — the track was judged unrecognised for this rule',
            { tags: { deviceId: subject.deviceId }, meta: memberMeta },
          )
        }
        return { kind: 'refused', why: 'already-judged', ...matchedFields }
      }
      // A full match: the identity the rule asks for arrived — a fresh window, once. The
      // track leaves the judged set only when that window really takes it (below).
    }
    if (this.isClosing(rule.id, survivor)) {
      this.deps.logger.debug('grouped window: track is in a window being closed', {
        tags: { deviceId: subject.deviceId },
        meta: memberMeta,
      })
      return { kind: 'refused', why: 'closing', ...matchedFields }
    }
    if (closeAtOnce) return this.testClose(rule, subject, survivor, verdict, controls)
    const outcome = await this.enter(rule, subject, survivor, verdict, controls, origin)
    this.unjudgeWhenTaken(rule.id, survivor, outcome)
    return outcome
  }

  /**
   * C11: the flag and the origin disagree — refused, loudly (D391: a branch that drops work
   * says so). The subject is neither evaluated nor admitted.
   */
  private refuseTestFlag(
    rule: NcRule,
    subject: NcRuleSubject,
    origin: NcEventOrigin,
  ): NcGroupedRefused {
    this.deps.logger.warn('grouped window: close-at-once flag refused', {
      tags: { deviceId: subject.deviceId },
      meta: {
        ruleId: rule.id,
        rule: rule.name,
        origin,
        reason:
          origin === 'synthetic'
            ? 'a synthetic admission must close at once — it never joins the shared buffer'
            : 'only a synthetic producer may close a window at once',
        eventId: subject.recordId,
      },
    })
    return { kind: 'refused', why: 'test-flag-mismatch', matched: false }
  }

  /**
   * A stored grouped rule the grouping does not apply to (spec §2.2): inert, and said
   * ONCE per rule. The caller takes the plain path.
   */
  noteInertRule(rule: NcRule, deviceId?: number): void {
    if (!firstTime(this.inertReported, rule.id)) return
    // At rule load there is no camera yet (review T8 L-2): a rule-level line.
    this.deps.logger.info('grouped rule cannot group this kind — groupingSec ignored', {
      ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
      meta: {
        ruleId: rule.id,
        rule: rule.name,
        delivery: rule.delivery,
        groupingSec: rule.groupingSec,
      },
    })
  }

  // ── hooks (always called on the chain) ────────────────────────────

  /** A track's label changed: promote (or demote, C14) its members, then re-judge them. */
  async onLabelChanged(input: NcTrackLabelChanged): Promise<void> {
    const overlay = overlayOf(input.label)
    const touched =
      input.change === 'accepted'
        ? this.buffer.promote({
            deviceId: input.deviceId,
            trackId: input.trackId,
            label: overlay,
            at: this.deps.now(),
          })
        : this.buffer.demote(input.deviceId, input.trackId, overlay)
    const windows = new Map<string, NcGroupedWindow>()
    const inWindowOf = new Set<string>()
    for (const { window, before, after } of touched) {
      inWindowOf.add(window.ruleId)
      const rule = this.deps.getRule(window.ruleId)
      if (rule === null) continue
      const full = this.deps.evaluate(rule, after.subject, false)
      this.buffer.setVerdict(window.key, after.trackId, full.matched, full.matchedOn)
      // The member's MATCH: its actions run now, once (spec §3.7).
      if (!before.matched && full.matched) this.deps.runActions(rule, after.subject, {})
      this.deps.logger.info(
        input.change === 'accepted'
          ? 'grouped window: subject promoted'
          : 'grouped window: subject demoted — the recognition was taken back',
        {
          tags: { deviceId: window.deviceId },
          meta: {
            ruleId: rule.id,
            rule: rule.name,
            windowKey: window.key,
            trackId: after.trackId,
            from: before.subject.label ?? before.className,
            to: after.subject.label ?? after.className,
            ...(after.subject.labelKind !== undefined
              ? { labelKind: after.subject.labelKind }
              : {}),
            nowMatched: full.matched,
          },
        },
      )
      const current = this.buffer.byKey(window.key)
      if (current !== undefined) windows.set(current.key, current)
    }
    if (input.change === 'accepted') await this.reopenJudged(input, inWindowOf)
    for (const window of windows.values()) await this.checkClose(window)
  }

  /** Two tracks are one subject (D683): fold them in every window (spec §3.4). */
  async onTracksFused(input: NcTracksFused): Promise<void> {
    const effects = this.buffer.fuse(
      input.deviceId,
      input.survivorId,
      input.absorbedId,
      this.deps.ledger.notified,
    )
    for (const effect of effects) {
      const window = effect.window
      const ruleName = this.deps.getRule(window.ruleId)?.name
      const base = {
        ruleId: window.ruleId,
        ...(ruleName !== undefined ? { rule: ruleName } : {}),
        windowKey: window.key,
      }
      if (effect.kind === 'dropped-notified') {
        this.deps.logger.info('grouped member dropped — fused-into-notified', {
          tags: { deviceId: window.deviceId },
          meta: { ...base, trackId: input.survivorId, absorbedId: input.absorbedId },
        })
      } else {
        this.deps.logger.info('grouped window: members fused', {
          tags: { deviceId: window.deviceId },
          meta: {
            ...base,
            trackId: input.survivorId,
            survivorId: input.survivorId,
            absorbedId: input.absorbedId,
            membersBefore: effect.membersBefore,
            membersAfter: effect.membersAfter,
          },
        })
      }
      if (effect.windowRemoved) {
        // Fresh review M-T6-2: the buffer REMOVED the emptied window. It never reaches the
        // close pass — there is nobody left to judge — but it is never silent either.
        this.deps.logger.info('grouped window closed with NO notification', {
          tags: { deviceId: window.deviceId },
          meta: {
            ...base,
            reason: 'fused-into-notified',
            dropped: [{ trackId: input.absorbedId, reason: 'fused-into-notified' }],
          },
        })
        continue
      }
      const current = this.buffer.byKey(window.key)
      if (current !== undefined) await this.checkClose(current)
    }
    if (effects.length === 0) {
      const rules = this.deps.ledger.notifiedRulesFor(input.survivorId)
      if (rules.length > 0) {
        // The §3.4 measurement: one-shot, so nothing changes — but it is counted.
        this.deps.logger.info('grouped notification: a member was fused after the message left', {
          tags: { deviceId: input.deviceId },
          meta: {
            ruleIds: [...rules],
            trackId: input.survivorId,
            survivorId: input.survivorId,
            absorbedId: input.absorbedId,
          },
        })
      }
    }
  }

  /**
   * Before the `track-end` rules are evaluated: the member is closed — final (spec §4) —
   * and carries the closed track's label, with its confidence (C16).
   */
  async onTrackClosed(subject: NcRuleSubject): Promise<void> {
    const trackId = subject.trackId
    if (trackId === undefined) return
    // C10: a judgement lives for the track's life — the TTL only catches a lost close.
    this.deps.ledger.trackClosed(subject.deviceId, trackId)
    this.forgetJudgedRefusals(trackId)
    const touched = this.buffer.closeTrack(subject.deviceId, trackId, overlayOf(subject))
    for (const window of touched) {
      const rule = this.deps.getRule(window.ruleId)
      const member = window.members.find(
        (m) => m.trackId === this.buffer.resolve(subject.deviceId, trackId),
      )
      if (rule !== null && member !== undefined) {
        const full = this.deps.evaluate(rule, member.subject, false)
        this.buffer.setVerdict(window.key, member.trackId, full.matched, full.matchedOn)
        if (!member.matched && full.matched) this.deps.runActions(rule, member.subject, {})
      }
      const current = this.buffer.byKey(window.key)
      if (current !== undefined) await this.checkClose(current)
    }
  }

  /**
   * The drain-tick sweep: deadlines, and windows whose floor passed with every member
   * already final (C3: passing the floor is not an input). Replaying windows wait for
   * `releaseReplay` (C5).
   */
  async sweep(now: number): Promise<void> {
    for (const window of this.buffer.due(now)) await this.closeWindow(window.key, 'deadline')
    for (const window of this.buffer.all()) {
      if (!window.replaying) await this.checkClose(window)
    }
  }

  /** Close every window (the bounded shutdown close, spec §3.5). */
  async closeAll(reason: 'shutdown'): Promise<void> {
    for (const window of this.buffer.all()) await this.closeWindow(window.key, reason)
  }

  /**
   * The watermark ceiling (spec §5): the oldest hold of every window whose message has not
   * been written — the open ones AND the ones whose close is in flight, already out of the
   * buffer (review T10 HIGH-1a). A crash between the take and the enqueue must replay it.
   */
  watermarkCeiling(): number | undefined {
    let oldest = this.buffer.oldestHoldAt()
    for (const window of this.inFlight.values()) {
      const hold = windowHoldAt(window)
      oldest = oldest === undefined ? hold : Math.min(oldest, hold)
    }
    return oldest
  }

  /**
   * Start the boot replay (C5). `start.watermark` is the one the reconcile READ before it
   * scanned. The watermark is written off the evaluation path, so an event stamped before a
   * write can still be evaluated after it and open a window that predates it (review T10
   * HIGH-1b): a replayed event inside the scan's overlap (`watermark − overlapMs`) may
   * therefore OPEN a replaying window — the notified-set hydration, not the watermark, is
   * the exactly-once guard (C9). Only an older event may JOIN but never open. When the
   * hydration did not read (`hydrated: false`) there is no such guard and the overlap is 0:
   * the strict watermark (review T10 LOW-A).
   */
  beginReplay(start: NcGroupedReplayStart): void {
    this.replay = start
    this.replayRefused.clear()
  }

  /**
   * End the replay (C5): due windows close as `replayed`, the rest go live or fold into
   * the live window. Every member a merge could not fit is said, one line each, and the
   * replay says how many events it refused for predating the watermark (D391).
   */
  async releaseReplay(): Promise<void> {
    this.reportReplayRefusals()
    this.replay = null
    this.replayRefused.clear()
    for (const release of this.buffer.releaseReplay(this.deps.now())) {
      const window = release.window
      const ruleName = this.deps.getRule(window.ruleId)?.name
      const base = {
        ruleId: window.ruleId,
        ...(ruleName !== undefined ? { rule: ruleName } : {}),
        windowKey: window.key,
      }
      if (release.kind === 'due') {
        await this.closeTaken(window, 'replayed')
        continue
      }
      if (release.kind === 'released') {
        this.deps.logger.debug('grouped window: replay released live', {
          tags: { deviceId: window.deviceId },
          meta: base,
        })
        continue
      }
      this.deps.logger.info('grouped window: replay merged into the live window', {
        tags: { deviceId: window.deviceId },
        meta: { ...base, replayKey: release.replayKey, members: window.members.length },
      })
      for (const member of release.dropped) {
        this.deps.logger.info('grouped window is full — replayed subject not added', {
          tags: { deviceId: window.deviceId },
          meta: { ...base, trackId: member.trackId, members: window.members.length },
        })
      }
    }
  }

  /** One INFO line per camera that refused anything, then one for the whole replay (D391). */
  private reportReplayRefusals(): void {
    const replay = this.replay
    let refused = 0
    for (const [deviceId, count] of this.replayRefused) {
      refused += count
      this.deps.logger.info('grouped replay: events older than the watermark opened no window', {
        tags: { deviceId },
        meta: {
          refused: count,
          watermark: replay?.watermark ?? null,
          ...(replay !== null
            ? { overlapMs: effectiveOverlapMs(replay), hydrated: replay.hydrated }
            : {}),
        },
      })
    }
    this.deps.logger.info('grouped replay released', {
      meta: {
        refused,
        cameras: this.replayRefused.size,
        watermark: replay?.watermark ?? null,
        ...(replay !== null
          ? { overlapMs: effectiveOverlapMs(replay), hydrated: replay.hydrated }
          : {}),
      },
    })
  }

  openWindowsFor(ruleId: string): readonly NcGroupedWindow[] {
    return this.buffer.all().filter((w) => w.ruleId === ruleId)
  }

  openWindows(): readonly NcGroupedWindow[] {
    return this.buffer.all()
  }

  /** Windows whose close is in flight right now — out of the buffer, not yet closed. */
  closingWindows(): readonly NcGroupedWindow[] {
    return [...this.inFlight.values()]
  }

  /** A member's finality (spec §4): a recognition, a closed track, or the outlook. */
  finalityOf(window: NcGroupedWindow, member: NcGroupedMember): NcGroupedMemberFinality {
    const kind = member.subject.labelKind
    if (kind === 'identity' || kind === 'plate' || member.closed) return { final: true }
    const outlook = this.deps.outlook({
      deviceId: window.deviceId,
      trackId: member.trackId,
      className: member.className,
      now: this.deps.now(),
    })
    if (outlook.final) return { final: true }
    if (outlook.awaiting === 'unknown') {
      return { final: false, awaiting: 'unknown', reason: outlook.reason }
    }
    return { final: false, awaiting: outlook.awaiting }
  }

  // ── internals ────────────────────────────────────────────────────

  /** Open, join or update — the cooldown gates only an OPEN (spec §3.6). */
  private async enter(
    rule: NcRule,
    subject: NcRuleSubject,
    survivor: string,
    verdict: Verdict,
    controls: NcIntakeControls,
    origin: NcEventOrigin,
    openAt?: number,
  ): Promise<NcGroupedAdmissionOutcome> {
    const replaying = origin === 'reconcile'
    const matchedFields = {
      matched: verdict.matched,
      ...(verdict.matchedOn !== undefined ? { matchedOn: verdict.matchedOn } : {}),
    }
    const now = this.deps.now()
    const scope = this.deps.windowScope?.(rule, subject) ?? 'camera'
    if (this.buffer.get(rule.id, subject.deviceId, replaying, scope) === undefined) {
      const replay = this.replay
      const watermark = replay?.watermark ?? null
      if (
        replaying &&
        replay !== null &&
        watermark !== null &&
        subject.timestamp < watermark - effectiveOverlapMs(replay)
      ) {
        // C5 (c): the previous process held the watermark below every window it left open,
        // and an event evaluated late lands at most one overlap before it — so this event's
        // window was settled before the crash. Re-opening it would send it a second time.
        this.replayRefused.set(
          subject.deviceId,
          (this.replayRefused.get(subject.deviceId) ?? 0) + 1,
        )
        this.deps.logger.debug('replayed event predates the watermark — no window opened', {
          tags: { deviceId: subject.deviceId },
          meta: {
            ruleId: rule.id,
            rule: rule.name,
            trackId: survivor,
            eventId: subject.recordId,
            eventAt: subject.timestamp,
            watermark,
            overlapMs: effectiveOverlapMs(replay),
            hydrated: replay.hydrated,
          },
        })
        return { kind: 'refused', why: 'predates-watermark', ...matchedFields }
      }
      const cooldown = this.deps.cooldown(rule, subject, now)
      if (cooldown.cooling && controls.bypassCooldown !== true) {
        this.deps.logger.debug('rule matched but is cooling down', {
          tags: { deviceId: subject.deviceId },
          meta: {
            ruleId: rule.id,
            rule: rule.name,
            key: cooldown.key,
            eventId: subject.recordId,
            trackId: survivor,
          },
        })
        return { kind: 'cooling-down', key: cooldown.key, ...matchedFields }
      }
    }
    const result = this.buffer.admit({
      ruleId: rule.id,
      deviceId: subject.deviceId,
      groupingSec: rule.groupingSec ?? NC_GROUPING_MIN_SEC,
      trackId: survivor,
      className: subject.classNames[0] ?? 'unknown',
      subject,
      matched: verdict.matched,
      ...(verdict.matchedOn !== undefined ? { matchedOn: verdict.matchedOn } : {}),
      replaying,
      origin,
      flags: flagsOf(controls),
      ...(openAt !== undefined ? { openAt } : {}),
      ...(scope === 'rule' ? { scope } : {}),
    })
    this.logAdmission(rule, subject, survivor, verdict, result)
    if (result.kind === 'window-full' || result.kind === 'too-many-windows') {
      return { kind: 'refused', why: result.kind, ...matchedFields }
    }
    await this.checkClose(result.window)
    return { kind: result.kind, windowKey: result.window.key, ...matchedFields }
  }

  private logAdmission(
    rule: NcRule,
    subject: NcRuleSubject,
    survivor: string,
    verdict: Verdict,
    result: NcAdmitResult,
  ): void {
    const tags = { deviceId: subject.deviceId }
    const awaiting = awaitingOf(verdict.outlook)
    const state = {
      matched: verdict.matched,
      ...(awaiting !== undefined ? { awaiting } : {}),
    }
    if (result.kind === 'too-many-windows' || result.kind === 'window-full') {
      this.deps.logger.info('grouped window is full — subject not added', {
        tags,
        meta: {
          ruleId: rule.id,
          rule: rule.name,
          ...(result.kind === 'window-full'
            ? { windowKey: result.window.key, members: result.window.members.length }
            : { openWindows: result.open }),
          trackId: survivor,
          eventId: subject.recordId,
          refused: result.kind,
        },
      })
      return
    }
    const meta = {
      ruleId: rule.id,
      rule: rule.name,
      windowKey: result.window.key,
      trackId: survivor,
      eventId: subject.recordId,
    }
    if (result.kind === 'opened') {
      this.deps.record(result.window)
      this.deps.logger.info('grouped window opened', {
        tags,
        meta: {
          ...meta,
          closesAt: result.window.deadlineAt,
          floorAt: result.window.floorAt,
          ...state,
          ...(result.window.replaying ? { replaying: true } : {}),
        },
      })
    } else if (result.kind === 'joined') {
      this.deps.logger.info('grouped window: subject joined', {
        tags,
        meta: {
          ...meta,
          className: result.member.className,
          members: result.window.members.length,
          ...state,
        },
      })
    } else {
      // The per-event volume of a member already in the window: DEBUG is enough.
      this.deps.logger.debug('grouped window: member updated', {
        tags,
        meta: { ...meta, ...state },
      })
    }
  }

  /**
   * C11: the tester's subject never touches the shared buffer — a group of one, closed at
   * once with `closeReason: 'test'`, so a real subject never inherits its bypasses.
   */
  private async testClose(
    rule: NcRule,
    subject: NcRuleSubject,
    survivor: string,
    verdict: Verdict,
    controls: NcIntakeControls,
  ): Promise<NcGroupedAdmissionOutcome> {
    const at = subject.timestamp
    const member: NcGroupedMember = {
      trackId: survivor,
      className: subject.classNames[0] ?? 'unknown',
      subject,
      matched: verdict.matched,
      ...(verdict.matched && verdict.matchedOn !== undefined
        ? { matchedOn: verdict.matchedOn }
        : {}),
      ...(verdict.matched ? { firstMatchedSubject: subject, firstMatchedAt: at } : {}),
      firstSeenAt: at,
      closed: false,
      absorbedIds: [],
    }
    const groupingSec = rule.groupingSec ?? NC_GROUPING_MIN_SEC
    const window: NcGroupedWindow = {
      key: groupedWindowKey(rule.id, subject.deviceId, survivor, at),
      ruleId: rule.id,
      deviceId: subject.deviceId,
      groupingSec,
      openedAt: at,
      floorAt: at + NC_GROUPING_MIN_SEC * 1_000,
      deadlineAt: at + groupingSec * 1_000,
      replaying: false,
      origin: 'synthetic',
      flags: flagsOf(controls),
      lastAdmittedAt: at,
      members: [member],
    }
    const enqueued = await this.closeTaken(window, 'test')
    return {
      kind: 'tested',
      windowKey: window.key,
      enqueued,
      matched: verdict.matched,
      ...(verdict.matchedOn !== undefined ? { matchedOn: verdict.matchedOn } : {}),
    }
  }

  /**
   * C10: a late recognition of a JUDGED track in no window of that rule re-evaluates the
   * rule on the subject it was judged on, the new label applied. Only a FULL match opens a
   * fresh window (and the track leaves the judged set); a candidate opens nothing.
   */
  private async reopenJudged(
    input: NcTrackLabelChanged,
    inWindowOf: ReadonlySet<string>,
  ): Promise<void> {
    const survivor = this.buffer.resolve(input.deviceId, input.trackId)
    for (const entry of this.deps.ledger.judgedFor(input.deviceId, survivor)) {
      if (inWindowOf.has(entry.ruleId)) continue
      const rule = this.deps.getRule(entry.ruleId)
      if (rule === null) continue
      const subject = withLabelOverlay(
        { ...entry.subject, trackId: survivor },
        overlayOf(input.label),
      )
      const full = this.deps.evaluate(rule, subject, false)
      if (!full.matched) continue
      this.deps.runActions(rule, subject, {})
      const verdict: Verdict = {
        matched: true,
        ...(full.matchedOn !== undefined ? { matchedOn: full.matchedOn } : {}),
        outlook: this.outlookFor(subject),
      }
      // Review T8 H-1: the window opens at the RECOGNITION instant — its own key, floor and
      // deadline — never at the judged event's (long past) timestamp, which would close it
      // at once and could re-use the judging window's key. The member keeps the judged
      // event as its frozen moment (C12), and the watermark holds at THAT event
      // (`windowHoldAt`, review T10 LOW-5), so a crash before the close replays it.
      const outcome = await this.enter(
        rule,
        subject,
        survivor,
        verdict,
        {},
        'pipeline',
        this.deps.now(),
      )
      this.unjudgeWhenTaken(rule.id, survivor, outcome)
      this.deps.logger.info('grouped window: reopened by a late recognition', {
        tags: { deviceId: input.deviceId },
        meta: {
          ruleId: rule.id,
          rule: rule.name,
          trackId: survivor,
          outcome: outcome.kind,
          ...('windowKey' in outcome ? { windowKey: outcome.windowKey } : {}),
        },
      })
    }
  }

  /**
   * The early close (C3): once the floor has passed and every member is final. Never for
   * a replaying window (C5: the wall clock is far past every floor during a replay).
   */
  private async checkClose(window: NcGroupedWindow): Promise<void> {
    if (window.replaying) return
    if (this.deps.now() < window.floorAt) return
    for (const member of window.members) {
      const finality = this.finalityOf(window, member)
      if (finality.final) continue
      if (finality.awaiting === 'unknown') this.reportUnknownOutlook(window, finality.reason)
      return
    }
    await this.closeWindow(window.key, 'all-final')
  }

  private reportUnknownOutlook(window: NcGroupedWindow, reason: string | undefined): void {
    const now = this.deps.now()
    const last = this.unknownOutlookReportedAt.get(window.deviceId)
    if (last !== undefined && now - last < NC_GROUPED_UNKNOWN_OUTLOOK_SAMPLE_MS) return
    if (this.unknownOutlookReportedAt.size >= NC_GROUPED_MEMO_MAX) {
      this.unknownOutlookReportedAt.clear()
    }
    this.unknownOutlookReportedAt.set(window.deviceId, now)
    const ruleName = this.deps.getRule(window.ruleId)?.name
    this.deps.logger.info('grouped window: recognition outlook unknown — waiting the full window', {
      tags: { deviceId: window.deviceId },
      meta: {
        ruleId: window.ruleId,
        ...(ruleName !== undefined ? { rule: ruleName } : {}),
        windowKey: window.key,
        ...(reason !== undefined ? { reason } : {}),
      },
    })
  }

  /**
   * C5 (a): before a replayed event is admitted, every REPLAYING window of its rule and
   * camera whose deadline is at or before the event's own timestamp closes as `replayed`.
   */
  private async closeReplayDue(ruleId: string, subject: NcRuleSubject): Promise<void> {
    for (const window of this.buffer.replayDue(ruleId, subject.deviceId, subject.timestamp)) {
      await this.closeWindow(window.key, 'replayed')
    }
  }

  private async closeWindow(key: string, reason: NcGroupedCloseReason): Promise<void> {
    const window = this.buffer.take(key)
    if (window === undefined) return
    await this.closeTaken(window, reason)
  }

  /**
   * C13: the members are reserved BEFORE the first await and released in a `finally`; the
   * close pass moves them into `notified` before it returns when it inserted a row.
   */
  private async closeTaken(window: NcGroupedWindow, reason: NcGroupedCloseReason): Promise<number> {
    const ids = window.members.flatMap((m) => [m.trackId, ...m.absorbedIds])
    for (const id of ids) {
      const key = pairKey(window.ruleId, id)
      this.closing.set(key, (this.closing.get(key) ?? 0) + 1)
    }
    this.inFlight.set(window.key, window)
    try {
      return await this.deps.close(window, reason)
    } catch (error) {
      // Review T8 M-2: one window's failed close must not take the rest of the sweep with
      // it — and a window taken out of the buffer and never sent is never silent (D391).
      const ruleName = this.deps.getRule(window.ruleId)?.name
      this.deps.logger.warn('grouped window close failed — window lost', {
        tags: { deviceId: window.deviceId },
        meta: {
          ruleId: window.ruleId,
          ...(ruleName !== undefined ? { rule: ruleName } : {}),
          windowKey: window.key,
          closeReason: reason,
          members: window.members.map((m) => m.trackId),
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return 0
    } finally {
      this.inFlight.delete(window.key)
      for (const id of ids) {
        const key = pairKey(window.ruleId, id)
        const left = (this.closing.get(key) ?? 1) - 1
        if (left <= 0) this.closing.delete(key)
        else this.closing.set(key, left)
      }
    }
  }

  /**
   * C10 / review T8 M-4: a judged track leaves the judged set only when a window really
   * TOOK it — never on a refusal (cooling, closing, full) that left it outside every window.
   */
  private unjudgeWhenTaken(
    ruleId: string,
    trackId: string,
    outcome: NcGroupedAdmissionOutcome,
  ): void {
    if (outcome.kind !== 'opened' && outcome.kind !== 'joined' && outcome.kind !== 'updated') return
    if (this.deps.ledger.judged(ruleId, trackId)) this.deps.ledger.unjudge(ruleId, trackId)
    // Review T9a L-4: a track judged AGAIN later is said again.
    this.judgedRefusalReported.delete(pairKey(ruleId, trackId))
  }

  /** Review T9a L-4: the said-once memo of a track that closed ends with it. */
  private forgetJudgedRefusals(trackId: string): void {
    for (const key of [...this.judgedRefusalReported]) {
      if (key.endsWith(`|${trackId}`)) this.judgedRefusalReported.delete(key)
    }
  }

  private isClosing(ruleId: string, trackId: string): boolean {
    return this.closing.has(pairKey(ruleId, trackId))
  }

  private outlookFor(subject: NcRuleSubject): NcRecognitionOutlook {
    const trackId = subject.trackId
    if (trackId === undefined) return { final: true }
    return this.deps.outlook({
      deviceId: subject.deviceId,
      trackId,
      className: subject.classNames[0] ?? 'unknown',
      ...(subject.labelKind !== undefined ? { labelKind: subject.labelKind } : {}),
      now: this.deps.now(),
    })
  }

  /**
   * The survivor of a track id (fresh review L-1): the buffer's own fusion map, then the
   * alias store's RAM read, and only then its durable read. A durable read that FAILS
   * reads the id as asked (D315), said once per id.
   */
  private async resolveTrack(deviceId: number, trackId: string): Promise<string> {
    const local = this.buffer.resolve(deviceId, trackId)
    if (local !== trackId) return local
    const hot = this.deps.resolveTrackAliasSync?.(trackId)
    if (hot !== undefined) return hot
    const resolve = this.deps.resolveTrackAlias
    if (resolve === undefined) return trackId
    try {
      return (await resolve(trackId)) ?? trackId
    } catch (error) {
      this.reportAliasFailure({ method: 'grouped-admission', id: trackId, deviceId, error })
      return trackId
    }
  }
}

function flagsOf(controls: NcIntakeControls): NcGroupedWindowFlags {
  return {
    bypassCooldown: controls.bypassCooldown === true,
    bypassMute: controls.bypassMute === true,
    closeImmediately: false,
  }
}
