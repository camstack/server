/**
 * The two track sets a grouped rule keeps across windows (D692) — RAM only.
 *
 *  - **notified** (spec §3.5, "once per track per rule"): a track a window of rule R
 *    already delivered is never in a later window of R. Filled when a close INSERTED a row,
 *    with the survivor id and every absorbed id of each kept member. It ends with the
 *    track's CLOSE (review T9a M-1); the 30-minute TTL is only the backstop for a close that
 *    never arrives, and every refusal it makes SLIDES the TTL, so a track still in view
 *    after 30 minutes stays covered. Pruned on every add; Task 10 re-hydrates it at boot
 *    from the outbox rows.
 *  - **judged** (C10, operator ruling 2026-10-02): a member dropped at close because the
 *    rule's recognition scope did not see the identity it asks for (`recognition-not-final`
 *    or `recognised-out-of-scope`). While judged, the track's later events do not re-open a
 *    window of that rule unless the FULL rule matches. Kept for the track's life — the
 *    track close removes it — and bounded by a 30-minute TTL and 4 096 entries (oldest
 *    first) for a close that never arrives. A respawn forgets it, which costs at most one
 *    more window per track (stated in D692).
 *
 * Both are keyed by `(ruleId, trackId)`. A track id is the tracker's id, unique across
 * cameras; the judged entry still carries its camera so a late recognition only re-opens
 * on the camera that judged it.
 */

import type { NcRuleSubject } from '../rule-engine.js'

export const NC_NOTIFIED_TRACK_TTL_MS = 30 * 60_000
export const NC_JUDGED_TRACK_TTL_MS = 30 * 60_000
export const NC_JUDGED_TRACK_MAX = 4_096

function pairKey(ruleId: string, trackId: string): string {
  return `${ruleId}|${trackId}`
}

interface NotifiedEntry {
  readonly ruleId: string
  readonly trackId: string
  /** The kept member's survivor: a closing survivor takes the ids it absorbed with it. */
  readonly survivorId: string
  readonly at: number
}

/** Once per track per rule (spec §3.5). */
export class NcNotifiedTracks {
  /** Insertion order is `at` order: every add is stamped with the close instant. */
  private readonly entries = new Map<string, NotifiedEntry>()

  constructor(private readonly now: () => number) {}

  /** `survivorId` defaults to the first id (the survivor, then its absorbed ids). */
  add(ruleId: string, trackIds: readonly string[], at: number, survivorId = trackIds[0]): void {
    this.prune()
    if (survivorId === undefined) return
    for (const trackId of trackIds) {
      const key = pairKey(ruleId, trackId)
      // Re-inserted, so the map stays in stamp order for the prune.
      this.entries.delete(key)
      this.entries.set(key, { ruleId, trackId, survivorId, at })
    }
  }

  /**
   * A refusal on a LIVE entry slides its TTL (review T9a M-1): the track is still in view,
   * so the 30 minutes count from the last time it was refused, not from the close.
   */
  touch(ruleId: string, trackId: string): void {
    const key = pairKey(ruleId, trackId)
    const entry = this.entries.get(key)
    if (entry === undefined || !this.live(entry.at)) return
    this.entries.delete(key)
    this.entries.set(key, { ...entry, at: this.now() })
  }

  /**
   * The track closed (review T9a M-1): the entry ends with it, for every rule. A closing
   * SURVIVOR also takes the ids it absorbed; a closing absorbed id takes only itself.
   */
  trackClosed(trackId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.trackId === trackId || entry.survivorId === trackId) this.entries.delete(key)
    }
  }

  has(ruleId: string, trackId: string): boolean {
    const entry = this.entries.get(pairKey(ruleId, trackId))
    return entry !== undefined && this.live(entry.at)
  }

  /** Every rule that notified this track — the §3.4 "fused after the message left" line. */
  rulesFor(trackId: string): readonly string[] {
    const out: string[] = []
    for (const entry of this.entries.values()) {
      if (entry.trackId === trackId && this.live(entry.at)) out.push(entry.ruleId)
    }
    return out
  }

  get size(): number {
    return this.entries.size
  }

  private live(at: number): boolean {
    return this.now() - at < NC_NOTIFIED_TRACK_TTL_MS
  }

  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (this.live(entry.at)) return
      this.entries.delete(key)
    }
  }
}

/** One judged `(rule, track)`: what a late recognition re-evaluates (C10). */
export interface NcJudgedTrack {
  readonly ruleId: string
  readonly deviceId: number
  /** The judged id — the survivor itself, or one of its absorbed ids. */
  readonly trackId: string
  /** The survivor at the close that judged it. */
  readonly survivorId: string
  /** The member's subject at close (C1: the latest relaxed-passing one, overlay applied). */
  readonly subject: NcRuleSubject
  readonly at: number
}

/** One close's judgement of one member: its survivor id and every id it absorbed. */
export interface NcJudgedTrackInput {
  readonly ruleId: string
  readonly deviceId: number
  readonly survivorId: string
  readonly trackIds: readonly string[]
  readonly subject: NcRuleSubject
  readonly at: number
}

/** A member the rule's recognition scope judged at close (C10). */
export class NcJudgedTracks {
  /** Insertion order is age order — the bound evicts the oldest first. */
  private readonly entries = new Map<string, NcJudgedTrack>()

  constructor(private readonly now: () => number) {}

  add(input: NcJudgedTrackInput): void {
    this.prune()
    for (const trackId of input.trackIds) {
      const key = pairKey(input.ruleId, trackId)
      this.entries.delete(key)
      this.entries.set(key, {
        ruleId: input.ruleId,
        deviceId: input.deviceId,
        trackId,
        survivorId: input.survivorId,
        subject: input.subject,
        at: input.at,
      })
    }
    while (this.entries.size > NC_JUDGED_TRACK_MAX) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  has(ruleId: string, trackId: string): boolean {
    const entry = this.entries.get(pairKey(ruleId, trackId))
    return entry !== undefined && this.live(entry.at)
  }

  /** Every live judged entry of this track on this camera, one per rule. */
  forTrack(deviceId: number, trackId: string): readonly NcJudgedTrack[] {
    const out: NcJudgedTrack[] = []
    for (const entry of this.entries.values()) {
      if (entry.trackId === trackId && entry.deviceId === deviceId && this.live(entry.at)) {
        out.push(entry)
      }
    }
    return out
  }

  /** A refusal on a LIVE entry slides its TTL (review T9a M-1). */
  touch(ruleId: string, trackId: string): void {
    const key = pairKey(ruleId, trackId)
    const entry = this.entries.get(key)
    if (entry === undefined || !this.live(entry.at)) return
    this.entries.delete(key)
    this.entries.set(key, { ...entry, at: this.now() })
  }

  /** A full match re-opened the track: it leaves this rule's set. */
  remove(ruleId: string, trackId: string): void {
    this.entries.delete(pairKey(ruleId, trackId))
  }

  /**
   * The track closed: its judgement ends with it, for every rule. A closing SURVIVOR also
   * takes the ids it absorbed; a closing absorbed id takes only itself.
   */
  trackClosed(deviceId: number, trackId: string): number {
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (entry.deviceId !== deviceId) continue
      if (entry.trackId !== trackId && entry.survivorId !== trackId) continue
      this.entries.delete(key)
      removed += 1
    }
    return removed
  }

  get size(): number {
    return this.entries.size
  }

  private live(at: number): boolean {
    return this.now() - at < NC_JUDGED_TRACK_TTL_MS
  }

  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (this.live(entry.at)) return
      this.entries.delete(key)
    }
  }
}
