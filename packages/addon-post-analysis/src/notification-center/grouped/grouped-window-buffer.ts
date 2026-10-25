/**
 * The GROUPED WINDOW buffer (D692) — pure RAM state for "immediate, grouped" rules.
 *
 * A grouped rule's first matching (or candidate) subject opens ONE window per
 * `(ruleId, deviceId)`; every later subject of that rule on that camera JOINS it, never a
 * second window. D706: an ALARM rule matching during an entry delay or after a trigger
 * admits with `scope: 'rule'` — ONE window per rule, whatever camera, so one intrusion push
 * names every location of its time window. Its `deviceId` is the camera that OPENED it; a
 * member is found by its own camera and track. The window collects promotions (a face becomes an identity, a vehicle
 * gets its plate), fusions (two provisional tracks are one subject, D683) and track
 * closes, until the orchestrator (`grouped-delivery.ts`) closes it and runs the close pass.
 *
 * This module is a state machine over admissions, promotions, fusions and the clock the
 * caller passes in. It holds no media and no rules, logs nothing and knows nothing about
 * the outbox: every decision that needs the RULE (match or candidate) or the recogniser
 * OUTLOOK (final or pending) is the caller's and is handed in.
 *
 * Properties it guarantees:
 *  - **one window per key pair** — and replayed windows are kept apart from live ones
 *    (`replaying` is part of the index, D692 C5): a replayed event never joins a live
 *    window and a live event never joins a replay window;
 *  - **a deterministic key** — `grp:<ruleId>:<deviceId>:<firstTrackId>@<firstEventTs>`,
 *    where the track id is already the fusion SURVIVOR (the caller resolves aliases), so a
 *    replay re-opens the window under the same key;
 *  - **bounds** — {@link NC_GROUPED_MAX_OPEN_WINDOWS} windows, {@link NC_GROUPED_MAX_MEMBERS}
 *    members each; past either the admission is REFUSED with a typed outcome the caller
 *    logs;
 *  - **times from the event clock** — `floorAt` (the operator's 5 s minimum, decision 1)
 *    and `deadlineAt` are measured from the first event's own timestamp;
 *  - **fusion** (spec §3.4) — two members become one under the survivor, a lone absorbed
 *    member is re-keyed, an absorbed member whose survivor this rule already notified is
 *    removed; the alias is remembered so a late event under the absorbed id resolves;
 *  - **promotions are never lost** — a promotion for a track that is in no window yet (the
 *    label write can beat the persisted event to the NC) is kept, bounded, and applied at
 *    that track's admission (fresh review M-6);
 *  - **the frozen moment is the first match** (C12) — `firstMatchedSubject` is set once and
 *    never overwritten; the latest relaxed-passing `subject` is what the close verdict
 *    reads (C1).
 */

import { NC_GROUPING_MAX_SEC, NC_GROUPING_MIN_SEC } from '@camstack/types'
import type { NcEventOrigin } from '../event-intake.js'
import type { NcRuleSubject } from '../rule-engine.js'

export const NC_GROUPED_MAX_OPEN_WINDOWS = 64
export const NC_GROUPED_MAX_MEMBERS = 24
const NC_GROUPED_ALIAS_MAX = 4_096
/** Bound on promotions waiting for their track's admission (C15). */
const NC_GROUPED_EARLY_PROMOTIONS_MAX = 1_024
/** How long a promotion waits for its track's admission, on the event clock (C15). */
const NC_GROUPED_EARLY_PROMOTION_TTL_MS = NC_GROUPING_MAX_SEC * 1_000

/** Why a window closed (D692 §3.5, plus the tester's immediate close, C8). */
export type NcGroupedCloseReason = 'all-final' | 'deadline' | 'shutdown' | 'replayed' | 'test'

/**
 * The recognition fields a promotion, a retraction or a track close sets on a member's
 * subject. An overlay REPLACES the member's recognition fields as a whole: a cleared tier
 * is simply absent, so a retraction (D665) removes the name.
 */
export interface NcGroupedLabelOverlay {
  readonly label?: string
  readonly identityId?: string
  readonly labelKind?: 'identity' | 'plate'
  /** Only a CLOSED member carries one (`subjectFromTrack`), C16. */
  readonly labelConfidence?: number
}

/** Intake controls a window keeps from the admission that OPENED it (ignored on a join). */
export interface NcGroupedWindowFlags {
  readonly bypassCooldown: boolean
  readonly bypassMute: boolean
  readonly closeImmediately: boolean
}

export interface NcGroupedMember {
  /** The SURVIVOR id. */
  readonly trackId: string
  readonly className: string
  /** C1: the latest RELAXED-PASSING subject for this track, its overlay applied. */
  readonly subject: NcRuleSubject
  /** The full (un-relaxed) verdict on {@link subject} at its last evaluation. */
  readonly matched: boolean
  /** `matchedOn` of that verdict when matched (best-matching reads it per tile). */
  readonly matchedOn?: readonly string[]
  /** C12: the subject of the member's FIRST full match — set once, never overwritten. */
  readonly firstMatchedSubject?: NcRuleSubject
  readonly firstMatchedAt?: number
  /** First admission instant (event timestamp) — the ordering key. */
  readonly firstSeenAt: number
  /** The track closed (spec §4 item 2). */
  readonly closed: boolean
  /** The recognition overlay currently applied (absent = none ever). */
  readonly overlay?: NcGroupedLabelOverlay
  /** Ids folded into this member by fusion, for the record and the notified set. */
  readonly absorbedIds: readonly string[]
}

export interface NcGroupedWindow {
  readonly key: string
  readonly ruleId: string
  readonly deviceId: number
  readonly groupingSec: number
  readonly openedAt: number
  readonly floorAt: number
  readonly deadlineAt: number
  /** C5: re-opened by the boot reconcile and not yet released by it. */
  readonly replaying: boolean
  readonly origin: NcEventOrigin
  readonly flags: NcGroupedWindowFlags
  /** Last admission instant (event clock) — the record's `lastGrowthAt`. */
  readonly lastAdmittedAt: number
  readonly members: readonly NcGroupedMember[]
  /** D706: `rule` = one window per rule across cameras (an alarm intrusion). Absent = camera. */
  readonly scope?: NcGroupedWindowScope
}

/** Which subjects share a window: one camera's (D692), or the whole rule's (D706). */
export type NcGroupedWindowScope = 'camera' | 'rule'

export interface NcGroupedAdmission {
  readonly ruleId: string
  readonly deviceId: number
  readonly groupingSec: number
  /** Already the SURVIVOR id. */
  readonly trackId: string
  readonly className: string
  readonly subject: NcRuleSubject
  readonly matched: boolean
  readonly matchedOn?: readonly string[]
  readonly replaying: boolean
  readonly origin: NcEventOrigin
  readonly flags: NcGroupedWindowFlags
  /**
   * When an admission OPENS a window at an instant that is not its subject's own: a late
   * recognition re-opens a judged track at the recognition instant (review T8 H-1), while
   * the member keeps the event it was judged on. Absent = the subject's timestamp.
   */
  readonly openAt?: number
  /** D706: `rule` while the alarm is in an entry delay or triggered. Absent = camera. */
  readonly scope?: NcGroupedWindowScope
}

export interface NcGroupedOpened {
  readonly kind: 'opened'
  readonly window: NcGroupedWindow
  readonly member: NcGroupedMember
  readonly appliedEarlyPromotion: boolean
}
export interface NcGroupedJoined {
  readonly kind: 'joined'
  readonly window: NcGroupedWindow
  readonly member: NcGroupedMember
  readonly appliedEarlyPromotion: boolean
}
export interface NcGroupedUpdated {
  readonly kind: 'updated'
  readonly window: NcGroupedWindow
  readonly member: NcGroupedMember
}
export interface NcGroupedWindowFull {
  readonly kind: 'window-full'
  readonly window: NcGroupedWindow
}
export interface NcGroupedTooManyWindows {
  readonly kind: 'too-many-windows'
  readonly open: number
}
export type NcAdmitResult =
  | NcGroupedOpened
  | NcGroupedJoined
  | NcGroupedUpdated
  | NcGroupedWindowFull
  | NcGroupedTooManyWindows

export interface NcGroupedPromotion {
  readonly deviceId: number
  readonly trackId: string
  readonly label: NcGroupedLabelOverlay
  /** Event-clock instant of the change — ages a promotion still waiting for admission. */
  readonly at: number
}

export interface NcPromotedMember {
  readonly window: NcGroupedWindow
  readonly before: NcGroupedMember
  readonly after: NcGroupedMember
}

export interface NcFusionEffect {
  readonly kind: 'merged' | 'rekeyed' | 'dropped-notified'
  readonly window: NcGroupedWindow
  readonly membersBefore: number
  readonly membersAfter: number
  /**
   * The window lost its last member and was REMOVED (fresh review M-T6-2): a later subject
   * opens a fresh window with its own deadline instead of joining a dead one. The caller
   * logs it as a window closed with no notification.
   */
  readonly windowRemoved: boolean
}

/** A replaying window released after the reconcile (C5). */
export interface NcReplayDue {
  /** Past its deadline at release time: REMOVED, for the caller to close as `replayed`. */
  readonly kind: 'due'
  readonly window: NcGroupedWindow
  readonly replayKey: string
}
export interface NcReplayReleased {
  /** Now a live window with its original deadline. */
  readonly kind: 'released'
  readonly window: NcGroupedWindow
  readonly replayKey: string
}
export interface NcReplayMerged {
  /** Folded into the live window of the same rule and camera (`window`). */
  readonly kind: 'merged'
  readonly window: NcGroupedWindow
  readonly replayKey: string
  /** Replay members that did not fit the live window's bound — the caller logs each (D391). */
  readonly dropped: readonly NcGroupedMember[]
}
/** A replaying window at the end of the reconcile (C5). */
export type NcReplayRelease = NcReplayDue | NcReplayReleased | NcReplayMerged

/** Predicate the caller passes: did this rule already notify this (survivor) track? */
export type NcNotifiedPredicate = (ruleId: string, trackId: string) => boolean

export function groupedWindowKey(
  ruleId: string,
  deviceId: number,
  trackId: string,
  at: number,
): string {
  return `grp:${ruleId}:${String(deviceId)}:${trackId}@${String(at)}`
}

interface MutableWindow {
  key: string
  ruleId: string
  deviceId: number
  groupingSec: number
  openedAt: number
  floorAt: number
  deadlineAt: number
  replaying: boolean
  origin: NcEventOrigin
  flags: NcGroupedWindowFlags
  lastAdmittedAt: number
  members: NcGroupedMember[]
  scope?: NcGroupedWindowScope
}

interface EarlyPromotion {
  readonly overlay: NcGroupedLabelOverlay
  readonly at: number
}

function indexKey(
  ruleId: string,
  deviceId: number,
  replaying: boolean,
  scope: NcGroupedWindowScope = 'camera',
): string {
  const where = scope === 'rule' ? '*' : String(deviceId)
  return `${ruleId}|${where}|${replaying ? 'replay' : 'live'}`
}

/** The index pair a window is filed under. */
function pairOf(w: MutableWindow, replaying: boolean = w.replaying): string {
  return indexKey(w.ruleId, w.deviceId, replaying, w.scope)
}

/** Does this window hold subjects of `deviceId`? A rule-scope window may hold several. */
function covers(w: MutableWindow, deviceId: number): boolean {
  if (w.deviceId === deviceId) return true
  return w.scope === 'rule' && w.members.some((m) => m.subject.deviceId === deviceId)
}

/** The member for `(deviceId, trackId)`: in a rule-scope window, the camera must match too. */
function memberIndex(w: MutableWindow, deviceId: number, trackId: string): number {
  return w.members.findIndex(
    (m) => m.trackId === trackId && (w.scope !== 'rule' || m.subject.deviceId === deviceId),
  )
}

function trackKey(deviceId: number, trackId: string): string {
  return `${String(deviceId)}|${trackId}`
}

/**
 * Strip a subject's recognition fields, then apply the overlay (C14: a replacement).
 * Exported for the orchestrator's late re-open of a judged track (C10).
 */
export function withLabelOverlay(
  subject: NcRuleSubject,
  overlay: NcGroupedLabelOverlay | undefined,
): NcRuleSubject {
  if (overlay === undefined) return subject
  const { label: _l, identityId: _i, labelKind: _k, labelConfidence: _c, ...rest } = subject
  return {
    ...rest,
    ...(overlay.label !== undefined ? { label: overlay.label } : {}),
    ...(overlay.identityId !== undefined ? { identityId: overlay.identityId } : {}),
    ...(overlay.labelKind !== undefined ? { labelKind: overlay.labelKind } : {}),
    ...(overlay.labelConfidence !== undefined ? { labelConfidence: overlay.labelConfidence } : {}),
  }
}

function snapshot(w: MutableWindow): NcGroupedWindow {
  return Object.freeze({ ...w, members: Object.freeze([...w.members]) })
}

/** The more specific of two overlays for one fused subject (spec §3.4). */
function fusedOverlay(
  survivor: NcGroupedMember,
  absorbed: NcGroupedMember,
): NcGroupedLabelOverlay | undefined {
  const s =
    survivor.subject.labelKind !== undefined ? (survivor.overlay ?? labelOf(survivor)) : undefined
  const a =
    absorbed.subject.labelKind !== undefined ? (absorbed.overlay ?? labelOf(absorbed)) : undefined
  // Both recognised: the survivor's wins (the tracker already WARNs on a disagreement).
  if (s !== undefined) return s
  if (a !== undefined) return a
  return survivor.overlay ?? absorbed.overlay
}

function labelOf(member: NcGroupedMember): NcGroupedLabelOverlay {
  const s = member.subject
  return {
    ...(s.label !== undefined ? { label: s.label } : {}),
    ...(s.identityId !== undefined ? { identityId: s.identityId } : {}),
    ...(s.labelKind !== undefined ? { labelKind: s.labelKind } : {}),
    ...(s.labelConfidence !== undefined ? { labelConfidence: s.labelConfidence } : {}),
  }
}

/** The earlier first match of two pieces of one subject, named after the survivor. */
function earlierFirstMatch(
  s: NcGroupedMember,
  a: NcGroupedMember,
): Pick<NcGroupedMember, 'firstMatchedSubject' | 'firstMatchedAt'> {
  const sAt = s.firstMatchedAt
  const aAt = a.firstMatchedAt
  if (
    aAt !== undefined &&
    a.firstMatchedSubject !== undefined &&
    (sAt === undefined || aAt < sAt)
  ) {
    return {
      firstMatchedSubject: { ...a.firstMatchedSubject, trackId: s.trackId },
      firstMatchedAt: aAt,
    }
  }
  return {}
}

/**
 * Two pieces of ONE subject become one member under `s` (spec §3.4): the more specific
 * label (the survivor's when both are identities), the earlier first sight and first
 * match, a match if either matched, closed only if both closed. Used by fusion and by a
 * replay merge alike.
 */
function mergeMembers(s: NcGroupedMember, a: NcGroupedMember): NcGroupedMember {
  const overlay = fusedOverlay(s, a)
  return {
    ...s,
    ...(overlay !== undefined ? { overlay } : {}),
    subject: withLabelOverlay(s.subject, overlay),
    matched: s.matched || a.matched,
    firstSeenAt: Math.min(s.firstSeenAt, a.firstSeenAt),
    closed: s.closed && a.closed,
    absorbedIds:
      s.trackId === a.trackId ? s.absorbedIds : [...s.absorbedIds, a.trackId, ...a.absorbedIds],
    ...earlierFirstMatch(s, a),
  }
}

/** A lone absorbed member re-keyed to its survivor — every frozen subject names it. */
function rekey(a: NcGroupedMember, survivorId: string): NcGroupedMember {
  return {
    ...a,
    trackId: survivorId,
    subject: { ...a.subject, trackId: survivorId },
    ...(a.firstMatchedSubject !== undefined
      ? { firstMatchedSubject: { ...a.firstMatchedSubject, trackId: survivorId } }
      : {}),
    absorbedIds: [...a.absorbedIds, a.trackId],
  }
}

function earlier(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

/**
 * How far back a window holds the watermark (D692 §5): its opening, or an earlier member
 * event. A window re-opened by a late recognition (C10) opens at the recognition instant,
 * but its member is frozen at the judged event (C12) — a crash must replay from THAT event,
 * so the hold is the earliest of the two (review T10 LOW-5).
 */
export function windowHoldAt(w: NcGroupedWindow): number {
  let hold = w.openedAt
  for (const m of w.members) hold = Math.min(hold, m.firstSeenAt)
  return hold
}

export class NcGroupedWindowBuffer {
  private readonly windows = new Map<string, MutableWindow>()
  private readonly byPair = new Map<string, string>()
  private readonly aliases = new Map<string, string>()
  private readonly early = new Map<string, EarlyPromotion>()

  get size(): number {
    return this.windows.size
  }

  all(): readonly NcGroupedWindow[] {
    return [...this.windows.values()].map(snapshot)
  }

  get(
    ruleId: string,
    deviceId: number,
    replaying: boolean,
    scope: NcGroupedWindowScope = 'camera',
  ): NcGroupedWindow | undefined {
    const key = this.byPair.get(indexKey(ruleId, deviceId, replaying, scope))
    const w = key === undefined ? undefined : this.windows.get(key)
    return w === undefined ? undefined : snapshot(w)
  }

  byKey(key: string): NcGroupedWindow | undefined {
    const w = this.windows.get(key)
    return w === undefined ? undefined : snapshot(w)
  }

  onDevice(deviceId: number): readonly NcGroupedWindow[] {
    return [...this.windows.values()].filter((w) => covers(w, deviceId)).map(snapshot)
  }

  /** Open or join (or update this track's member). */
  admit(input: NcGroupedAdmission): NcAdmitResult {
    const pair = indexKey(input.ruleId, input.deviceId, input.replaying, input.scope)
    const openKey = this.byPair.get(pair)
    const open = openKey === undefined ? undefined : this.windows.get(openKey)
    if (open !== undefined) {
      const at = memberIndex(open, input.deviceId, input.trackId)
      const existing = at >= 0 ? open.members[at] : undefined
      if (existing !== undefined) {
        const subject = withLabelOverlay(input.subject, existing.overlay)
        const updated = this.withVerdict({ ...existing, subject }, input.matched, input.matchedOn)
        open.members[at] = updated
        open.lastAdmittedAt = Math.max(open.lastAdmittedAt, input.subject.timestamp)
        return { kind: 'updated', window: snapshot(open), member: updated }
      }
      if (open.members.length >= NC_GROUPED_MAX_MEMBERS) {
        return { kind: 'window-full', window: snapshot(open) }
      }
      const { member, applied } = this.newMember(input)
      open.members.push(member)
      open.lastAdmittedAt = Math.max(open.lastAdmittedAt, input.subject.timestamp)
      return { kind: 'joined', window: snapshot(open), member, appliedEarlyPromotion: applied }
    }
    if (this.windows.size >= NC_GROUPED_MAX_OPEN_WINDOWS) {
      return { kind: 'too-many-windows', open: this.windows.size }
    }
    const openedAt = input.openAt ?? input.subject.timestamp
    const key = groupedWindowKey(input.ruleId, input.deviceId, input.trackId, openedAt)
    const { member, applied } = this.newMember(input)
    const w: MutableWindow = {
      key,
      ruleId: input.ruleId,
      deviceId: input.deviceId,
      groupingSec: input.groupingSec,
      openedAt,
      floorAt: openedAt + NC_GROUPING_MIN_SEC * 1_000,
      deadlineAt: openedAt + input.groupingSec * 1_000,
      replaying: input.replaying,
      origin: input.origin,
      flags: input.flags,
      lastAdmittedAt: openedAt,
      members: [member],
      ...(input.scope === 'rule' ? { scope: 'rule' as const } : {}),
    }
    this.windows.set(key, w)
    this.byPair.set(pair, key)
    return { kind: 'opened', window: snapshot(w), member, appliedEarlyPromotion: applied }
  }

  /** Overlay a promotion on every member of the track; remembered when none exists yet. */
  promote(p: NcGroupedPromotion): readonly NcPromotedMember[] {
    // Always remembered (fresh review L-T6-4): another rule's window may admit this track
    // later, and its event may predate the recognition.
    this.rememberEarly(p)
    return this.applyOverlay(p.deviceId, p.trackId, p.label)
  }

  /** A retraction (C14): the same replacement, never remembered for a later admission. */
  demote(
    deviceId: number,
    trackId: string,
    label: NcGroupedLabelOverlay,
  ): readonly NcPromotedMember[] {
    this.early.delete(trackKey(deviceId, trackId))
    return this.applyOverlay(deviceId, trackId, label)
  }

  /** Record the caller's fresh full verdict for one member. */
  setVerdict(
    key: string,
    trackId: string,
    matched: boolean,
    matchedOn: readonly string[] | undefined,
  ): NcGroupedMember | undefined {
    const w = this.windows.get(key)
    if (w === undefined) return undefined
    const at = w.members.findIndex((m) => m.trackId === trackId)
    const member = at >= 0 ? w.members[at] : undefined
    if (member === undefined) return undefined
    const updated = this.withVerdict(member, matched, matchedOn)
    w.members[at] = updated
    return updated
  }

  /** Mark a member's track closed, overlaying the closed track's label (with confidence). */
  closeTrack(
    deviceId: number,
    trackId: string,
    label: NcGroupedLabelOverlay,
  ): readonly NcGroupedWindow[] {
    const id = this.resolve(deviceId, trackId)
    const touched: NcGroupedWindow[] = []
    for (const w of this.windows.values()) {
      if (!covers(w, deviceId)) continue
      const at = memberIndex(w, deviceId, id)
      const member = at >= 0 ? w.members[at] : undefined
      if (member === undefined) continue
      w.members[at] = {
        ...member,
        closed: true,
        overlay: label,
        subject: withLabelOverlay(member.subject, label),
      }
      touched.push(snapshot(w))
    }
    return touched
  }

  /** Fold `absorbedId` into `survivorId` in every window on the device (spec §3.4). */
  fuse(
    deviceId: number,
    survivorIdIn: string,
    absorbedIdIn: string,
    notified: NcNotifiedPredicate,
  ): readonly NcFusionEffect[] {
    const survivorId = this.resolve(deviceId, survivorIdIn)
    const absorbedId = this.resolve(deviceId, absorbedIdIn)
    this.rememberAlias(deviceId, absorbedId, survivorId)
    if (survivorId === absorbedId) return []
    const effects: NcFusionEffect[] = []
    for (const w of [...this.windows.values()]) {
      if (!covers(w, deviceId)) continue
      const a = w.members[memberIndex(w, deviceId, absorbedId)]
      if (a === undefined) continue
      const before = w.members.length
      const s = w.members[memberIndex(w, deviceId, survivorId)]
      let kind: NcFusionEffect['kind']
      if (notified(w.ruleId, survivorId)) {
        w.members = w.members.filter((m) => m.trackId !== absorbedId)
        kind = 'dropped-notified'
      } else if (s !== undefined) {
        const merged = mergeMembers(s, a)
        w.members = w.members
          .filter((m) => m.trackId !== absorbedId)
          .map((m) => (m.trackId === survivorId ? merged : m))
        kind = 'merged'
      } else {
        w.members = w.members.map((m) => (m.trackId === absorbedId ? rekey(a, survivorId) : m))
        kind = 'rekeyed'
      }
      const windowRemoved = w.members.length === 0
      if (windowRemoved) this.take(w.key)
      effects.push({
        kind,
        window: snapshot(w),
        membersBefore: before,
        membersAfter: w.members.length,
        windowRemoved,
      })
    }
    return effects
  }

  /** Synchronous alias read: an absorbed id this buffer saw fused → its survivor; else itself. */
  resolve(deviceId: number, trackId: string): string {
    let id = trackId
    for (let hops = 0; hops < 16; hops += 1) {
      const next = this.aliases.get(trackKey(deviceId, id))
      if (next === undefined || next === id) return id
      id = next
    }
    return id
  }

  /** Remove and return the window (the caller runs the close pass). */
  take(key: string): NcGroupedWindow | undefined {
    const w = this.windows.get(key)
    if (w === undefined) return undefined
    this.windows.delete(key)
    const pair = pairOf(w)
    if (this.byPair.get(pair) === key) this.byPair.delete(pair)
    return snapshot(w)
  }

  /** Non-replaying windows whose deadline has passed at `now` (C5: replaying ones never). */
  due(now: number): readonly NcGroupedWindow[] {
    return [...this.windows.values()]
      .filter((w) => !w.replaying && w.deadlineAt <= now)
      .map(snapshot)
  }

  /** Replaying windows of one rule and camera whose deadline is at or before `upTo` (C5). */
  replayDue(ruleId: string, deviceId: number, upTo: number): readonly NcGroupedWindow[] {
    return [...this.windows.values()]
      .filter(
        (w) => w.replaying && w.ruleId === ruleId && covers(w, deviceId) && w.deadlineAt <= upTo,
      )
      .map(snapshot)
  }

  /**
   * End the replay mark on every window (C5), at `now`:
   *  - a replay window already past its deadline is REMOVED and returned as `due` — the
   *    caller closes it with `replayed`;
   *  - one whose rule and camera hold a LIVE window is merged into it: a track in both is
   *    folded like a fusion; members past the live window's bound are returned as
   *    `dropped`, for the caller to log;
   *  - otherwise it goes live with its original deadline.
   */
  releaseReplay(now: number): readonly NcReplayRelease[] {
    const out: NcReplayRelease[] = []
    for (const w of [...this.windows.values()]) {
      if (!w.replaying) continue
      this.windows.delete(w.key)
      this.byPair.delete(pairOf(w, true))
      if (w.deadlineAt <= now) {
        out.push({ kind: 'due', window: snapshot(w), replayKey: w.key })
        continue
      }
      const liveKey = this.byPair.get(pairOf(w, false))
      const live = liveKey === undefined ? undefined : this.windows.get(liveKey)
      if (live !== undefined) {
        const dropped: NcGroupedMember[] = []
        for (const m of w.members) {
          const at = memberIndex(live, m.subject.deviceId, m.trackId)
          const existing = at >= 0 ? live.members[at] : undefined
          if (existing !== undefined) {
            // One track in both: one subject — folded exactly like a fusion.
            live.members[at] = mergeMembers(existing, m)
          } else if (live.members.length < NC_GROUPED_MAX_MEMBERS) {
            live.members.push(m)
          } else {
            dropped.push(m)
          }
        }
        out.push({ kind: 'merged', window: snapshot(live), replayKey: w.key, dropped })
        continue
      }
      w.replaying = false
      this.windows.set(w.key, w)
      this.byPair.set(pairOf(w, false), w.key)
      out.push({ kind: 'released', window: snapshot(w), replayKey: w.key })
    }
    return out
  }

  /** The oldest hold of an open window ({@link windowHoldAt}) — the watermark ceiling (§5). */
  oldestHoldAt(): number | undefined {
    let oldest: number | undefined
    for (const w of this.windows.values()) oldest = earlier(oldest, windowHoldAt(w))
    return oldest
  }

  // ── internals ────────────────────────────────────────────────────────

  private newMember(input: NcGroupedAdmission): { member: NcGroupedMember; applied: boolean } {
    const key = trackKey(input.deviceId, input.trackId)
    const waiting = this.early.get(key)
    const fresh =
      waiting !== undefined &&
      input.subject.timestamp - waiting.at <= NC_GROUPED_EARLY_PROMOTION_TTL_MS
    if (waiting !== undefined) this.early.delete(key)
    const overlay = fresh ? waiting.overlay : undefined
    const base: NcGroupedMember = {
      trackId: input.trackId,
      className: input.className,
      subject: withLabelOverlay(input.subject, overlay),
      matched: false,
      firstSeenAt: input.subject.timestamp,
      closed: false,
      ...(overlay !== undefined ? { overlay } : {}),
      absorbedIds: [],
    }
    return { member: this.withVerdict(base, input.matched, input.matchedOn), applied: fresh }
  }

  /** Apply a verdict; the first match freezes the subject it matched on (C12). */
  private withVerdict(
    member: NcGroupedMember,
    matched: boolean,
    matchedOn: readonly string[] | undefined,
  ): NcGroupedMember {
    const { matchedOn: _old, ...rest } = member
    const firstMatch =
      matched && member.firstMatchedSubject === undefined
        ? { firstMatchedSubject: member.subject, firstMatchedAt: member.subject.timestamp }
        : {}
    return {
      ...rest,
      matched,
      ...(matched && matchedOn !== undefined ? { matchedOn } : {}),
      ...firstMatch,
    }
  }

  private applyOverlay(
    deviceId: number,
    trackIdIn: string,
    overlay: NcGroupedLabelOverlay,
  ): readonly NcPromotedMember[] {
    const trackId = this.resolve(deviceId, trackIdIn)
    const out: NcPromotedMember[] = []
    for (const w of this.windows.values()) {
      if (!covers(w, deviceId)) continue
      const at = memberIndex(w, deviceId, trackId)
      const before = at >= 0 ? w.members[at] : undefined
      if (before === undefined) continue
      const after: NcGroupedMember = {
        ...before,
        overlay,
        subject: withLabelOverlay(before.subject, overlay),
      }
      w.members[at] = after
      out.push({ window: snapshot(w), before, after })
    }
    return out
  }

  private rememberEarly(p: NcGroupedPromotion): void {
    const key = trackKey(p.deviceId, this.resolve(p.deviceId, p.trackId))
    this.early.delete(key)
    this.early.set(key, { overlay: p.label, at: p.at })
    while (this.early.size > NC_GROUPED_EARLY_PROMOTIONS_MAX) {
      const oldest = this.early.keys().next().value
      if (oldest === undefined) break
      this.early.delete(oldest)
    }
  }

  private rememberAlias(deviceId: number, absorbedId: string, survivorId: string): void {
    if (absorbedId === survivorId) return
    const key = trackKey(deviceId, absorbedId)
    this.aliases.delete(key)
    this.aliases.set(key, survivorId)
    // A promotion still waiting under the absorbed id now belongs to the survivor
    // (fresh review L-T6-2) — unless the survivor has a newer one of its own.
    const waiting = this.early.get(key)
    if (waiting !== undefined) {
      this.early.delete(key)
      const survivorKey = trackKey(deviceId, survivorId)
      const own = this.early.get(survivorKey)
      if (own === undefined || own.at < waiting.at) this.early.set(survivorKey, waiting)
    }
    while (this.aliases.size > NC_GROUPED_ALIAS_MAX) {
      const oldest = this.aliases.keys().next().value
      if (oldest === undefined) break
      this.aliases.delete(oldest)
    }
  }
}
