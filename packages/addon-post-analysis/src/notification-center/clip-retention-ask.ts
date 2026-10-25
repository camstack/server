/**
 * HOW MUCH FOOTAGE this hub's notification rules will ever reach back for, per
 * camera — derived from the rules, in front, instead of guessed.
 *
 * The companion to `footage-source.ts`: that module decides WHO can still serve
 * a moment, given how much the ring holds; this one decides how much the ring
 * should hold in the first place. Both read the same arithmetic, and the same
 * per-camera number now feeds both (`clipRetentionSecFor`).
 *
 * ## The mapping, and why each row is what it is
 *
 * | the rule | what it asks the ring to hold |
 * | --- | --- |
 * | `enabled: false` | nothing — a rule that cannot fire cannot cut |
 * | an `occupancy` condition, whatever it attaches | {@link NC_CLIP_RETENTION_MAX_SEC} (60 s) |
 * | neither `media.gif` nor `media.clip` | **nothing** |
 * | grouped (`ruleGroupingApplies`: immediate detection; sound and track-end excluded), with gif/clip | `preRoll + postRoll + `{@link NC_CLIP_DISPATCH_MARGIN_SEC}` + groupingSec`, capped at {@link NC_CLIP_RETENTION_MAX_SEC} |
 * | anything else | `preRoll + postRoll + `{@link NC_CLIP_DISPATCH_MARGIN_SEC} |
 *
 * **Occupancy is the one exception to "a still asks nothing"** (D691). The
 * operator asked for a minute of buffer on every camera an occupancy rule
 * follows, and the departure's picture needs it: a became-free edge names the
 * object that LEFT, and when it cannot (a parked entry, no live track) the
 * still is a frame of the departure cut from this ring at `observedAt` —
 * never the empty space at commit time. One minute of the cheapest profile is
 * the cost (≈ bitrate × 60 s, bounded by `CLIP_RING_MAX_BYTES`).
 *
 * **Otherwise a still is not footage.** `media.attach` (`best`, `best-matching`,
 * `keyFrame`) is served by the track's own media and the still shelf — it never
 * reads the broker's clip ring. Only `gif` and `clip` cut from the ring, and on
 * this hub that is the difference between 22 cameras paying a minute each and
 * the handful that actually deliver video paying for what they deliver.
 *
 * **The margin is the dispatch lag, not a cushion.** The cut is not taken at
 * the anchor: the row is enqueued, the drain tick picks it up (2 s), a rule
 * that also wants a still waits for one ({@link NC_STILL_WAIT_MS}, 3 s), and a
 * retry can miss a tick. Ten seconds covers that path with room; the post-roll
 * wait itself is already counted as `postRollSec`.
 *
 * **Why occupancy is the ceiling, and nothing else comes close.** An occupancy
 * edge is not observed, it is CONFIRMED — by an independent read that lands
 * after the condition's own `sustainSeconds` (29 s on this hub) plus the
 * recheck's own lag (D279). Its clip is therefore anchored well in the past,
 * and the other source cannot take that moment over yet: measured against
 * `recording.getAvailability` for a 10 s window at several anchors, full
 * coverage arrived at −18 s on device 104 and −26 s on 101 and 102 — the
 * recordings' edge is a PHASE of the 10-second segment cycle, not a number. So
 * the ring has to bridge from the event to the point the recordings can serve
 * it: the worst measured phase (26 s) plus the confirmation lag (29 s) is 55 s,
 * and {@link NC_CLIP_RETENTION_MAX_SEC} is the round number above it. Every
 * other rule kind is anchored on a moment the dispatcher saw happen, so it
 * needs the window and the queueing delay and nothing more.
 *
 * ## Absence is not zero
 *
 * A camera named by no ask is being told it needs **nothing**. That is only a
 * safe thing to say when the rules have actually been read — which is why the
 * plan this module builds carries `rulesLoaded`, and why the broker treats a
 * plan it has never received as UNKNOWN rather than empty. See
 * {@link buildClipRetentionPlan}.
 */
import {
  NC_CLIP_POST_ROLL_DEFAULT_SEC,
  NC_CLIP_PRE_ROLL_DEFAULT_SEC,
  type NcClipRetentionAsk,
  type NcClipRetentionPlan,
  NC_CLIP_RETENTION_MAX_SEC,
  type NcMediaPolicy,
  type NcRule,
  ruleGroupingApplies,
} from '@camstack/types'
import { effectiveMediaPolicyForRule } from './rule-engine.js'

/**
 * Seconds between the moment a clip is ABOUT and the moment it is CUT.
 *
 * The drain tick (2 s) + the still wait a footage rule piggybacks on (3 s) +
 * head-room for a retry that misses a tick. Without it the ring drops the
 * pre-roll a heartbeat before the renderer asks for it, which is the same
 * silent "no clip" the flat retention was raised to fix — only cheaper to
 * reproduce.
 */
export const NC_CLIP_DISPATCH_MARGIN_SEC = 10

/** Does this media policy ever cut footage from the broker's clip ring? */
function wantsFootage(media: NcMediaPolicy): boolean {
  return media.gif === true || media.clip === true
}

/** The ask ONE rule makes, or `null` when it needs no retained footage. */
function askSecondsFor(rule: NcRule): { seconds: number; reason: 'window' | 'occupancy' } | null {
  if (!rule.enabled) return null
  // BEFORE the footage gate (D691): a camera an occupancy rule follows holds
  // the full minute whatever the rule attaches.
  if (rule.conditions.occupancy !== undefined) {
    return { seconds: NC_CLIP_RETENTION_MAX_SEC, reason: 'occupancy' }
  }
  // The EFFECTIVE policy, as delivery reads it: a sensor rule's stored
  // gif/clip/rolls are ignored (one snapshot, operator ruling 2026-10-01), so
  // asking the ring to hold history for them is history nobody cuts.
  const media = effectiveMediaPolicyForRule(rule)
  if (!wantsFootage(media)) return null
  const pre = media.clipPreRollSec ?? NC_CLIP_PRE_ROLL_DEFAULT_SEC
  const post = media.clipPostRollSec ?? NC_CLIP_POST_ROLL_DEFAULT_SEC
  // D692 §6.3: a grouped rule's row is enqueued up to `groupingSec` after its anchor (the
  // window's open), so the ring must hold that much longer for the cut to stay warm.
  // The slack beyond `groupingSec` is the post-roll plus 10 s of dispatch margin; a cut
  // that still outlives the ring falls through to the recordings path, which is the
  // designed overflow, so this ask is not padded further.
  const grouped = rule.groupingSec !== undefined && ruleGroupingApplies(rule) ? rule.groupingSec : 0
  const seconds = Math.min(
    pre + post + NC_CLIP_DISPATCH_MARGIN_SEC + grouped,
    NC_CLIP_RETENTION_MAX_SEC,
  )
  return { seconds, reason: 'window' }
}

/**
 * Every rule's demand on every camera it can fire on.
 *
 * One ask per (rule, camera), and a rule with no `conditions.devices` produces
 * ONE device-less ask meaning "every camera" — expanding it here would require
 * the camera list, which this module deliberately does not have and the broker
 * already does.
 */
export function deriveClipRetentionAsks(rules: readonly NcRule[]): readonly NcClipRetentionAsk[] {
  const asks: NcClipRetentionAsk[] = []
  for (const rule of rules) {
    const ask = askSecondsFor(rule)
    if (ask === null) continue
    const profile = effectiveMediaPolicyForRule(rule).profile
    const base = {
      seconds: ask.seconds,
      reason: ask.reason,
      ruleId: rule.id,
      ruleName: rule.name,
      ...(profile !== undefined ? { profile } : {}),
    }
    const devices = rule.conditions.devices
    if (devices === undefined || devices.length === 0) {
      asks.push(base)
      continue
    }
    for (const deviceId of devices) asks.push({ ...base, deviceId })
  }
  return asks
}

/** The whole answer the `getClipRetentionAsks` cap method serves. */
export function buildClipRetentionPlan(
  rules: readonly NcRule[],
  rulesLoaded: boolean,
): NcClipRetentionPlan {
  return { rulesLoaded, asks: deriveClipRetentionAsks(rules) }
}

/**
 * How many seconds ONE camera's ring is being asked to hold — the MAX over the
 * asks that reach it, device-less asks included.
 *
 * Zero means every rule that can fire on this camera is a rule that never cuts
 * footage. The broker applies its own ceilings (its time clamp and the ring's
 * byte budget) on top; this number is the ASK, not the allocation.
 */
export function clipRetentionSecFor(asks: readonly NcClipRetentionAsk[], deviceId: number): number {
  let seconds = 0
  for (const ask of asks) {
    if (ask.deviceId !== undefined && ask.deviceId !== deviceId) continue
    if (ask.seconds > seconds) seconds = ask.seconds
  }
  return seconds
}
