import { z } from 'zod'
import { CamProfileSchema, CLIP_BROKER_PACED_RATES } from '@camstack/types'

/**
 * The rates a clip may be OFFERED at — re-exported from the capability, which
 * is where the one list lives (D612). The broker owns the clamp; the cap owns
 * the ladder; a second list here would be the second authority D62 forbids.
 *
 * Declared at the top of the file because the clamp and the `setRate` bound
 * are DERIVED from its ends (D621). They were three literals — this array, a
 * `Math.min(4, …)` and a `.max(4)` — and that is precisely how 8 and 16 came
 * to be offered while the clamp served 4 with no line anywhere saying so. One
 * decision now has one place to be written down.
 */
export const BROKER_PACED_RATES = CLIP_BROKER_PACED_RATES

/** The slowest offered rate. Anything slower is clamped up to it. */
const MIN_PACED_RATE = Math.min(...BROKER_PACED_RATES)
/** The fastest offered rate. Anything faster is refused at the wire. */
const MAX_PACED_RATE = Math.max(...BROKER_PACED_RATES)

export const ControlMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('playRecorded'),
    deviceId: z.number(),
    epoch: z.number(),
    profile: z.string(),
  }),
  // A CLIP is another position of the same source pointer (D575), not a second
  // player: same WebRTC track, same feeder, same seek/rate/step/scrub.
  //
  // `offsetMs` is FILE-RELATIVE — milliseconds from the clip's first sample,
  // never wall time — and it is REQUIRED. An unstated position is not zero
  // (D382): a client that means "from the start" says `0`, and a client that
  // forgot is refused here rather than silently rewound.
  //
  // Every message AFTER this one (`seek`, `scrubTo`, `scrubCommit`,
  // `stepFrame`, `setRate`) travels on that same file-relative axis unchanged,
  // which is the entire reason a clip needs no protocol of its own. `goLive`
  // leaves it in one dispatch.
  z.object({
    t: z.literal('playClip'),
    deviceId: z.number(),
    clipId: z.string().min(1),
    /**
     * WHICH provider holds the file — the `addonId` of the source row the clip
     * was listed from.
     *
     * It travels because nobody downstream can work it out. The broker lives
     * in `addon-pipeline`, the same addon that registers the RECORDER's
     * videoclips provider, so a `readClipBytes` with no provider named
     * resolved in-process to that sibling — which implements the method solely
     * to explain that an analytics visit has no file behind it. Every onboard
     * clip answered with that sentence: a flash, and nothing more (3628,
     * 2026-09-21). Deriving it from the clip id's shape was the other option
     * and is exactly what D482 forbids.
     */
    provider: z.string().min(1),
    offsetMs: z.number().min(0),
    /**
     * Which TWIN of the clip — the vendor's own quality pair, on the one
     * quality scale the system has. `auto` is deliberately not in
     * `CamProfileSchema`'s domain here for the same reason
     * `videoclips.getClipPlayback` refuses it: a stored file has no broker
     * session to resolve an adaptive tier against. Absent ⇒ the provider's own
     * default; never invented here.
     */
    profile: CamProfileSchema.optional(),
  }),
  z.object({ t: z.literal('seek'), epoch: z.number() }),
  // `dragId` rides ONLY on `scrubCommit`, not on a plain `seek`: it names the
  // scrub gesture this call commits, when it commits one. Optional and
  // additive — a client that predates it, or a plain timeline tap, omits it
  // and every downstream line simply carries no id (C1).
  z.object({ t: z.literal('scrubCommit'), epoch: z.number(), dragId: z.string().optional() }),
  // EXPERIMENTAL feeder-scrub (behind the client `feederScrub` flag): the drag
  // start + per-move target. Additive + back-compat — `parseControlMessage` is a
  // discriminated-union safeParse, so a server built before this change returns
  // `null` for these kinds and silently ignores them, and a client with the flag
  // off never emits them. `scrubCommit` remains the end-of-drag commit.
  //
  // `dragId` is the client's id for this gesture (optional — a client that
  // predates it omits it and the server behaves identically, just without the
  // id on its logs). Generated where the gesture starts and echoed on every
  // message of the drag through to its commit — see C1 in the scrub-debug
  // plan: server-side lines and `[app:*]` lines cannot be ordered against each
  // other by clock (phone vs hub), so this id is what joins them instead.
  z.object({ t: z.literal('scrubStart'), dragId: z.string().optional() }),
  // `m` / `v` are the CLIENT's px→time mapping decision for the pointer sample
  // that produced this target: the mode (`fine` jog dial vs `coarse` absolute
  // zoom mapping) and the velocity in CSS px/s that decided it. The server
  // cannot observe either — velocity lives in the gesture — and without them
  // "did this drag ever enter fine mode" is unanswerable from the logs, which
  // is the question that decides whether anything downstream matters at all.
  // Keys are terse because this message rides every pointer move. Both
  // optional: an older client leaves the mapping UNKNOWN on the aggregate,
  // never mis-attributed to a mode it did not report.
  z.object({
    t: z.literal('scrubTo'),
    epoch: z.number(),
    m: z.enum(['fine', 'coarse']).optional(),
    v: z.number().optional(),
  }),
  // Receiver credit: the viewer received (and, where the platform can report
  // it, RENDERED) a pushed scrub frame. Restores the credit of the push it
  // names so the scrub train is paced by what the link actually delivered,
  // never by a timer. Additive + back-compat like the two messages above.
  //
  // `seq` echoes the `seq` of the newest `position` the viewer has seen — i.e.
  // WHICH push this ack settles. It exists because the two halves count in
  // different units and cannot both be right without it: a platform with
  // `requestVideoFrameCallback` acks once per RENDERED FRAME (N acks for a
  // sweep of N), one without acks once per POSITION (one ack for the same
  // sweep). Naming the push makes the first ack settle it and every surplus
  // ack a no-op. An ack without `seq` (a viewer older than this field) settles
  // the oldest outstanding push — the safe direction: it can only ever repay
  // too EARLY, never strand the drag.
  z.object({ t: z.literal('scrubAck'), seq: z.number().optional() }),
  // Timeline warm-up: pre-run locate + GOP fetch + demux for the instant the
  // timeline OPENS on, so the first drag's push pays none of that chain. Pure
  // cache fill — never gates live, never builds a feeder, never moves the
  // pointer. Additive + back-compat like the scrub kinds above.
  z.object({ t: z.literal('warm'), epoch: z.number(), profile: z.string() }),
  // The bound is the LADDER's own ceiling, never a literal: a viewer asking
  // for a rate above everything the cap declares is refused here rather than
  // accepted and quietly served slower. 16 lands in that branch on purpose —
  // the camera's `playSpeed 16` is an I-frame-only stream, not this one faster
  // (D620, D621).
  z.object({ t: z.literal('setRate'), rate: z.number().min(0).max(MAX_PACED_RATE) }),
  z.object({ t: z.literal('stepFrame'), dir: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({ t: z.literal('goLive') }),
  z.object({ t: z.literal('setProfile'), profile: z.string() }),
])
export type ControlMessage = z.infer<typeof ControlMessageSchema>

/**
 * Clamp a requested playback rate onto the supported domain:
 * {0} ∪ [{@link MIN_PACED_RATE}, {@link MAX_PACED_RATE}] — the ends of
 * {@link BROKER_PACED_RATES} itself. 0 (and any non-finite / non-positive
 * input) pauses; anything else is a continuous rate clamped into that band.
 * Single server-side authority — the feeder applies it to every inbound
 * `setRate`.
 *
 * That every ladder entry survives this unchanged is now structural rather
 * than a discipline. What is NOT structural, and is therefore the gate that
 * matters, is whether the pacer really empties a clip `rate` times faster:
 * `clip-stream-feeder.spec` drives every entry and measures it.
 */
export function clampPlaybackRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0
  return Math.min(MAX_PACED_RATE, Math.max(MIN_PACED_RATE, rate))
}

/**
 * Does a clip carry SOUND at this rate?
 *
 * ONE predicate, read by the branch that DROPS the audio
 * (`ClipStreamFeeder.pushNextAudio`) and by the branch that TELLS the viewer
 * why it is silent — because a second copy of `rate !== 1` is exactly the
 * disagreeing second switch D62 forbids, and the telling would then be able
 * to describe a drop that did not happen (or miss one that did).
 *
 * *"L'audio non serve in velocità non 1x!!!"* [audio is not needed at speeds other than 1x!!!] — the operator, 2026-09-23.
 * Resampling would need a decoder this path has not got, and pitch-shifted
 * sound is worse than none.
 *
 * Rate 0 is PAUSE, not a rate: nothing plays at all there, so it is not this
 * predicate's business and callers hold their last non-zero rate instead.
 */
export function audioPlaysAtRate(rate: number): boolean {
  return rate === 1
}

export const ServerMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('state'),
    state: z.enum(['live', 'loading', 'playing', 'paused', 'gap', 'ended', 'error']),
  }),
  // `seq` is present only on the position a SCRUB PUSH emitted, and names that
  // push: the viewer echoes it back on `scrubAck` so the feeder knows which
  // outstanding push an ack settles. Optional — playback/step positions carry
  // no push, and a viewer that predates it simply acks without one.
  z.object({ t: z.literal('position'), epochMs: z.number(), seq: z.number().optional() }),
  z.object({ t: z.literal('liveProfile'), profile: z.enum(['high', 'mid', 'low']) }),
  // The recorded tier ACTUALLY playing, next to the one the client asked for.
  // Sent whenever the pair changes — a seek that fell to Mid because High has
  // no footage there, and the seek that got High back. Additive: an older
  // client's parser ignores an unknown `t`.
  z.object({
    t: z.literal('servedProfile'),
    profile: z.enum(['high', 'mid', 'low']),
    requested: z.string(),
  }),
  // The REAL length of the clip on the pointer (D575), measured by the broker
  // from the file's own index once the clip's first seek has resolved. Named
  // by clip so a late report cannot be pinned on the next file. The `position`
  // messages that follow a `playClip` are FILE-RELATIVE (the field is still
  // spelled `epochMs`); this is the axis they are measured against. Strictly
  // positive: a measurement that failed is not sent, and never zero (D393).
  // Additive: an older client's parser ignores an unknown `t`.
  z.object({
    t: z.literal('clipDuration'),
    clipId: z.string().min(1),
    durationMs: z.number().positive(),
  }),
  // `clipTransport` USED TO BE HERE (D602) and was removed by D612.
  //
  // It declared, per clip, what that clip could be driven to do. Measured:
  // it could not vary per clip. The broker's `chooseClipPath` reads exactly
  // two inputs — whether `dialClipStream` and `readClipBytes` are wired —
  // and both are constants of the broker's own closure; the `profile` it is
  // handed is documented as not read (D599). So every clip of a provider is
  // served the same way, and this channel carried a value with no information
  // the provider did not already have.
  //
  // The one authority is now `videoclips.getPlaybackOptions`, asked per
  // camera and per provider BEFORE a clip is picked — which is also when a
  // surface needs it, rather than after the first byte. Two channels that
  // can disagree are worse than one (D62).
  //
  // ROLLOUT ORDER, and it is not symmetric: the viewer reads the ABSENCE of
  // the old message as `LEGACY_CONTROLS` — free seek, backward step — on
  // purpose, so that a viewer newer than its hub never refuses a gesture
  // that worked. A viewer that has not yet learned `getPlaybackOptions`,
  // against a hub that has stopped sending this message, therefore falls
  // back to free seeking on a forward-only stream. The VIEWER ships first.
  // See D612.
  // Whether the clip on the pointer is carrying SOUND, and why not when it is
  // not (D600). The viewer has no other way to tell a clip whose camera has no
  // microphone from a playback that lost its audio — both are silence — and
  // "we do not know" is a third answer, so a branch that cannot say sends
  // nothing rather than claiming `false`. Named by clip so a late report
  // cannot be pinned on the next file. Additive: an older client's parser
  // ignores an unknown `t`.
  /**
   * The clip on the pointer did not arrive whole (D623).
   *
   * Sent ONCE, when the provider's stream ends, and only when the provider
   * itself said so — the broker never infers it from its own demux, because
   * "how long is this clip" and "how much of it did the camera send" are two
   * questions and only the provider has the second one's answer.
   *
   * It exists because a truncated replay and a short recording are the same
   * picture: the clip plays, it stops early, and nothing says which. Measured
   * on an Amcrest 3836 on 2026-09-23: 4.26 s of a 45 s clip reached the peer
   * and the provider logged it `complete`, because that camera exits its mux
   * 0 after hanging up. The operator's instruction is that a dropped session
   * is NOT retried — *"Se cade la sessione cade non fa niente, magari
   * mostriamo un errore dove mostriamo anche l'errore di stream"* [if the session drops, it drops, nothing happens; maybe we show an error where we also show the stream error] — so this
   * message is a statement, never a cue to dial again. A retry would contend
   * for the camera's single replay lane exactly while it is already failing.
   *
   * `stream-short` = less media than the catalog row says the clip covers;
   * `stream-empty` = a session that was granted and carried no picture at
   * all, which is diagnosed at the camera rather than at the clip and so is
   * never folded into the first. A provider that could not CHECK says nothing
   * here — it says so on its own log line; "we did not verify" is not
   * something to put on a screen.
   *
   * Named by clip so a late report cannot be pinned on the next file.
   * Additive: an older client's parser ignores an unknown `t`.
   */
  z.object({
    t: z.literal('clipIncomplete'),
    clipId: z.string().min(1),
    code: z.enum(['stream-short', 'stream-empty']),
    /** The provider's own sentence, already Latin-1 safe. Shown where the
     *  stream error is shown. */
    reason: z.string().min(1),
  }),
  z
    .object({
      t: z.literal('clipAudio'),
      clipId: z.string().min(1),
      carried: z.boolean(),
      codec: z.enum(['opus', 'pcmu']).optional(),
      /** Why there is no sound. Present iff `carried` is false. */
      reason: z
        .enum([
          'not-negotiated',
          'not-offered',
          'no-audio-track',
          'unsupported-codec',
          'codec-mismatch',
          'stream-failed',
          /**
           * The clip is playing at a rate other than 1× and the broker drops
           * every audio frame there, deliberately (D600, D621).
           *
           * It exists because the five reasons above are all PERMANENT facts
           * about the clip and this one is not: it comes and goes with the
           * speed chip, and a viewer told `stream-failed` when the operator
           * merely pressed 2× has been told something false. Without it a clip
           * silent at 2× and a clip silent because the stream broke were the
           * same `carried: false` — a D391 defect that widening the ladder
           * would have multiplied, which is why this shipped first.
           *
           * Unlike the others this message is RE-SENT: whenever the rate
           * crosses the 1× boundary, the viewer is told the new truth for the
           * clip it is already playing.
           */
          'rate',
        ])
        .optional(),
      /**
       * The rate the sound is suppressed AT. Present iff `reason` is `rate`,
       * and refused otherwise — see the check below.
       */
      rate: z.number().positive().optional(),
    })
    // A rate silence that does not name the rate is the unanswerable message
    // it replaces, and a rate on any other reason reads as one. The pairing is
    // enforced rather than documented: `serializeServerMessage` parses on the
    // way out, so a branch that gets it wrong throws instead of shipping.
    .check((ctx) => {
      const value = ctx.value
      if ((value.reason === 'rate') === (value.rate !== undefined)) return
      ctx.issues.push({
        code: 'custom',
        message: '`rate` is present exactly when `reason` is `rate`',
        input: value,
        path: ['rate'],
      })
    }),
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>

export function parseControlMessage(raw: string): ControlMessage | null {
  try {
    const parsed = ControlMessageSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function serializeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(ServerMessageSchema.parse(msg))
}
