import type { CamProfile } from '@camstack/types'
import type { ClipAudioReport, ClipIncompleteReport } from './clip-stream-feeder.js'
import { serializeServerMessage, type ControlMessage } from './control-protocol'
import type { FeederState, LocateResult, ScrubMapHint } from './recorded-feeder'
import { gapReachable, profileSearchOrder } from './playback-profile-fallback.js'

/** Options forwarded to the feeder's seek — see `SeekOptions` on the feeder. */
export interface TimelineSeekOptions {
  readonly travelFromMs?: number | null
  /** The scrub gesture this seek commits — see `SeekOptions.dragId` on the
   *  feeder. Present only when this seek IS a scrub commit. */
  readonly dragId?: string
}

export interface TimelineSessionFeeder {
  seek(epochMs: number, opts?: TimelineSeekOptions): Promise<void>
  /** Playback rate: 0 pauses; anything else is clamped by the feeder to [0.25, 8]. */
  setRate(rate: number): void
  /** Feed exactly one frame forward/backward. Only meaningful while paused. */
  stepFrame(dir: 1 | -1): void
  /** Feeder-scrub: enter the scrub sub-mode. `dragId` is the client's id for
   *  this gesture (optional — see `RecordedFeeder.beginScrub`). */
  beginScrub(dragId?: string): void
  /** Feeder-scrub: push the covering keyframe for `epochMs`. `hint` carries the
   *  client's px→time mapping decision for this sample (instrumentation only —
   *  it never changes what is pushed). */
  scrubTo(epochMs: number, hint?: ScrubMapHint): void
  /** Feeder-scrub receiver credit: the viewer received a pushed frame. `seq`
   *  names the push it settles (see the control protocol). */
  scrubAck(seq?: number): void
  dispose(): void
}

export interface TimelineSessionHost {
  setLiveFeedGate(gated: boolean): void
  pushRecordedAccessUnit(annexB: Uint8Array, rtpTs90k: number, codec: 'H264' | 'H265'): void
  requestKeyframe(): void
  sendControl(raw: string): void
}

/**
 * Which clip the pointer is on. Handed to {@link TimelineSessionDeps.makeClipFeeder},
 * which builds a feeder whose byte source is that file instead of the recorder.
 * `profile` is the vendor's twin selector and is `null` when the client did not
 * name one — never defaulted here, because only the provider knows which twin
 * it holds.
 */
export interface ClipPlaybackHandle {
  readonly deviceId: number
  readonly clipId: string
  /** The `addonId` that holds the bytes — see the control message's own note. */
  readonly provider: string
  readonly profile: CamProfile | null
}

export interface MakeClipFeederArgs {
  readonly handle: ClipPlaybackHandle
}

/**
 * A clip feeder is the recorded feeder plus ONE more question: how long is
 * the clip. Optional on the type so a feeder that cannot measure (a test
 * double, a build behind this field) is still a feeder — the session then
 * reports nothing and says so, rather than guessing a length.
 */
export interface TimelineSessionClipFeeder extends TimelineSessionFeeder {
  /**
   * The clip's own duration, in ms, once it is KNOWN — or `null` when the
   * source can never say (D393: absent is `null`, never `0`). A file-backed
   * feeder answers from its index at once; a streamed feeder (D597) answers
   * when the stream ends, and `null` if it was cut or left before that.
   * Rejects with the source's refusal when the file could not be indexed.
   */
  durationMs?(): Promise<number | null>
  /**
   * Whether this clip is carrying SOUND, and why not when it is not (D600).
   * Optional: a feeder that cannot say omits it, and the session then sends
   * nothing rather than claiming silence it has not established. The stream
   * feeder settles it from the stream's own `moov`; the file-backed feeder
   * does not implement it, because its audio comes from a different machinery
   * and nothing has asked it the question yet.
   */
  audio?(): Promise<ClipAudioReport>
  /**
   * Follow the audio answer AFTER the one {@link audio} settled, for as long
   * as this clip is on the pointer (D621).
   *
   * What the stream carries is decided once; whether the operator can HEAR it
   * is not. The broker drops every audio frame at any rate but 1× — his own
   * instruction, *"L'audio non serve in velocità non 1x!!!"* [audio is not needed at speeds other than 1x!!!] — and until this
   * existed the viewer was told nothing about it, so a clip silent at 2× and
   * a clip silent because the stream broke were the same `carried: false`.
   *
   * Optional, like `audio` itself: a feeder that cannot follow it omits it,
   * and the session then sends only the settle.
   */
  watchAudio?(listener: (report: ClipAudioReport) => void): void
  /**
   * Whether the PROVIDER delivered this clip whole (D623) — `null` when it
   * was whole, or when nothing got to say.
   *
   * Optional like the two above: a feeder that cannot ask omits it and the
   * session sends nothing. It is deliberately not derived from
   * {@link durationMs} here — the broker knows how long the media it received
   * runs, not how long the camera's catalog row said the clip was, and a
   * second authority on that is how the two come to disagree (D62).
   */
  incomplete?(): Promise<ClipIncompleteReport | null>
}

export interface TimelineSessionDeps {
  readonly session: TimelineSessionHost
  readonly deviceId: number
  /** Physical live tier selected for this adaptive session. */
  readonly initialLiveProfile?: 'high' | 'mid' | 'low'
  /** Builds a feeder bound to this session's push sink + emit seams for the given profile. */
  makeFeeder(profile: string): TimelineSessionFeeder
  /**
   * Locate a recorded segment at `epochMs` for a profile. When present,
   * `playRecorded` / `seek` try other tiers if the requested one is a gap
   * (events-mode cameras often keep only `high`). Optional: absent ⇒ no
   * fallback (unit tests that don't care about profiles).
   */
  locate?(args: { deviceId: number; profile: string; epochMs: number }): Promise<LocateResult>
  /**
   * Timeline warm-up: pre-run locate + GOP fetch + demux for `epochMs` at
   * `profile` into the session's fragment cache. MUST be safe while the
   * operator is still watching live — it never gates the feed, never builds a
   * feeder, never changes mode. Optional: absent ⇒ `warm` messages no-op.
   */
  warm?(profile: string, epochMs: number): void
  /**
   * Builds a feeder whose byte source is ONE CLIP FILE (D575) — the same
   * `RecordedFeeder`, the same demux, the same push sink, on a file-relative
   * axis. Absent ⇒ this session cannot play clips, and `playClip` is REFUSED
   * by name rather than dropped: the broker wires this only when the
   * `videoclips.readClipBytes` accessor is present.
   */
  makeClipFeeder?(args: MakeClipFeederArgs): TimelineSessionClipFeeder
  /**
   * Diagnostic seam. A branch that drops work — a `playClip` with no clip
   * source, a `setProfile` that a clip has no tier for — says so here.
   * Silence reads as "never happened".
   */
  onLog?(msg: string, data: Record<string, unknown>): void
}

/**
 * Per-viewer coordinator over one broker WebRTC session. Owns the playback mode
 * (`live` | `recorded`), the on-demand `RecordedFeeder`, and the control dispatch.
 *
 * Isolation invariant: in `live` mode the coordinator never touches the feeder or the
 * track — the shared live source feeds it. Entering recorded gates the live feed
 * (`setLiveFeedGate(true)`) so the feeder owns the track; `goLive` ungates it and
 * requests a fresh keyframe so the decoder recovers cleanly.
 */
export class TimelineSession {
  private mode: 'live' | 'recorded' = 'live'
  private feeder: TimelineSessionFeeder | null = null
  private profile = 'mid'
  /**
   * What the CLIENT asked for, kept apart from what is playing: a seek
   * re-resolves from the request, so a range where High exists again gets
   * High back instead of inheriting the Mid the previous seek fell to.
   */
  private requestedProfile = 'mid'
  /** Transport rate belongs to the session, not to one profile-specific feeder.
   *  Scrub pins `low`; release restores the selected playback profile and may
   *  therefore rebuild the feeder. Carrying the rate keeps a paused scrub
   *  paused across that required quality transition. */
  private rate = 1
  private liveProfileReported = false
  /** The live rung after an in-place tier switch; undefined = `initialLiveProfile`. */
  private liveProfile: 'high' | 'mid' | 'low' | undefined = undefined
  /**
   * The last position the viewer was SHOWN (every `_emitPosition`). Handed to
   * `seek` as `travelFromMs` so the seek travel animation works across feeder
   * REBUILDS — `playRecorded` builds a fresh feeder per tap, and a fresh
   * feeder has no cursor to travel from. Cleared on goLive: after live, an
   * old recorded position is not where the viewer is coming from.
   */
  private lastPositionMs: number | null = null
  /**
   * The clip the pointer is on, or `null` when the recorded source is the
   * recorder's own footage.
   *
   * It is deliberately NOT a third `mode`. Clip playback IS recorded mode with
   * a different byte source, so `currentMode` still reads `recorded` and every
   * invariant built on it holds unchanged — the adaptive ladder still suspends
   * itself while the pointer is off live, and `goLive` still leaves in one
   * dispatch (D570's go-live terminator: a mode `GO_LIVE` cannot leave is a
   * loop, and the cheapest way not to have one is not to add the mode).
   */
  private clip: ClipPlaybackHandle | null = null

  constructor(private readonly deps: TimelineSessionDeps) {
    deps.session.setLiveFeedGate(false)
  }

  /**
   * Which source the track is currently carrying. Read by the broker's
   * adaptive ladder, which must NOT act while the pointer is off live: a tier
   * switch is a close-and-recreate re-offer, and that disposes this
   * coordinator — the viewer silently lands back on live at the wrong moment
   * with no code path to restore the pointer.
   */
  get currentMode(): 'live' | 'recorded' {
    return this.mode
  }

  async handleControl(msg: ControlMessage): Promise<void> {
    this.emitLiveProfile()
    switch (msg.t) {
      case 'playRecorded': {
        // Leaving a clip is not a special case: the recorded source simply
        // takes the pointer back, and `playAt` rebuilds against the recorder.
        this.leaveClip()
        this.requestedProfile = msg.profile
        await this.playAt(msg.epoch, msg.profile, { travelFromMs: this.lastPositionMs })
        break
      }
      case 'playClip': {
        await this.playClip(
          msg.deviceId,
          msg.clipId,
          msg.provider,
          msg.profile ?? null,
          msg.offsetMs,
        )
        break
      }
      case 'seek': {
        // On a clip the epoch is already file-relative and there is no tier
        // ladder to resolve — the pointer just moves.
        if (this.clip) {
          await this.feeder?.seek(msg.epoch)
          break
        }
        await this.playAt(msg.epoch, this.requestedProfile, { travelFromMs: this.lastPositionMs })
        break
      }
      case 'scrubCommit': {
        if (this.clip) {
          if (msg.dragId !== undefined) await this.feeder?.seek(msg.epoch, { dragId: msg.dragId })
          else await this.feeder?.seek(msg.epoch)
          break
        }
        // No travel-from: the drag already showed the travel — a commit lands.
        // `dragId` rides along ONLY when the caller sent one — omitting the
        // options object entirely when there is nothing to carry keeps this
        // call identical (same argument shape) to a client that never sends
        // one, which existing callers and tests depend on.
        if (msg.dragId !== undefined) {
          await this.playAt(msg.epoch, this.requestedProfile, { dragId: msg.dragId })
        } else {
          await this.playAt(msg.epoch, this.requestedProfile)
        }
        break
      }
      case 'scrubStart': {
        // EXPERIMENTAL feeder-scrub: entering scrub implies recorded mode.
        const feeder = this.mode === 'recorded' && this.feeder ? this.feeder : this.enterRecorded()
        feeder.beginScrub(msg.dragId)
        break
      }
      case 'scrubTo': {
        // Ignored unless recorded (mirrors stepFrame). A scrubTo without a prior
        // scrubStart is additionally a no-op at the feeder (guarded on scrubbing).
        // The mapping hint rides along when the client reported BOTH halves —
        // a mode without its velocity would put a guessed number into the
        // per-drag percentiles, so it is dropped whole.
        const hint: ScrubMapHint | undefined =
          msg.m !== undefined && msg.v !== undefined
            ? { mode: msg.m, velocityPxPerS: msg.v }
            : undefined
        if (this.mode === 'recorded') this.feeder?.scrubTo(msg.epoch, hint)
        break
      }
      case 'scrubAck':
        // Receiver credit for the scrub train — meaningless outside recorded.
        // `seq` names the push being settled (absent from a viewer older than
        // the field; the feeder then settles the oldest outstanding push).
        if (this.mode === 'recorded') this.feeder?.scrubAck(msg.seq)
        break
      case 'setRate':
        this.rate = msg.rate
        this.feeder?.setRate(msg.rate)
        break
      case 'stepFrame':
        // Frame stepping only makes sense against the recorded feeder (the
        // feeder itself further requires rate 0). Ignored in live mode.
        if (this.mode === 'recorded') this.feeder?.stepFrame(msg.dir)
        break
      case 'setProfile':
        // A clip is ONE file: it has no recorded tier, and rebuilding its
        // feeder for a tier it does not have would throw away the fetched
        // bytes and the index for nothing. Refused, and SAID — a silent no-op
        // here reads exactly like a tier change that worked.
        if (this.clip) {
          this.deps.onLog?.(
            'clip playback: setProfile ignored — a clip file has no recorded tier',
            {
              deviceId: this.clip.deviceId,
              clipId: this.clip.clipId,
              requested: msg.profile,
            },
          )
          break
        }
        // An UNCHANGED profile is a no-op. The client's scrub choreography
        // re-sent setProfile on every host scrubStart re-send (the documented
        // storm `beginScrub` is hardened against), and every re-send while
        // recorded tore the feeder down MID-DRAG — eight rebuild/rebase cycles
        // a minute in production Loki (2026-08-02), and no pushed frame
        // survived long enough to render. The feeder's storm defense was being
        // bypassed through this side door; a genuine profile change (and only
        // that) still rebuilds.
        this.requestedProfile = msg.profile
        if (msg.profile === this.profile) break
        this.profile = msg.profile
        if (this.mode === 'recorded') this.enterRecorded()
        break
      case 'warm':
        // Fire-and-forget cache fill — deliberately OUTSIDE the mode machine:
        // the timeline opens while the operator is still watching live, and
        // warming must not gate the feed or build a feeder to be useful.
        this.deps.warm?.(msg.profile, msg.epoch)
        break
      case 'goLive':
        this.goLive()
        break
    }
  }

  /** Tear down any current feeder, gate the live feed, and build a fresh feeder. Returns it. */
  private enterRecorded(): TimelineSessionClipFeeder {
    this.feeder?.dispose()
    this.deps.session.setLiveFeedGate(true)
    this.mode = 'recorded'
    // While the pointer is on a clip, "recorded" means THAT file: a scrub that
    // has to rebuild a feeder mid-clip must not silently land on the recorder's
    // footage under the operator's finger.
    const clip = this.clip
    const makeClip = this.deps.makeClipFeeder
    const feeder =
      clip && makeClip ? makeClip({ handle: clip }) : this.deps.makeFeeder(this.profile)
    if (this.rate !== 1) feeder.setRate(this.rate)
    this.feeder = feeder
    return feeder
  }

  /**
   * Put the pointer on a clip file: same track, same feeder, same control
   * protocol, on the clip's own axis.
   *
   * A session with no clip byte source REFUSES by name — it never gates the
   * live feed, never builds a feeder and never leaves the operator on a frozen
   * frame with no explanation (D391: the branch that accepts work and produces
   * nothing is the same branch as the one that drops it).
   */
  private async playClip(
    deviceId: number,
    clipId: string,
    provider: string,
    profile: CamProfile | null,
    offsetMs: number,
  ): Promise<void> {
    if (!this.deps.makeClipFeeder) {
      this.deps.onLog?.(
        'clip playback: refused — no clip byte source wired on this session (videoclips.readClipBytes absent)',
        { deviceId, clipId, provider, profile, offsetMs },
      )
      this._emitState('error')
      return
    }
    this.clip = { deviceId, clipId, provider, profile }
    this.lastPositionMs = null
    const feeder = this.enterRecorded()
    // No travel-from: a clip's axis has no relationship to where the recorded
    // pointer previously was, so an animated travel would cross two timelines.
    await feeder.seek(offsetMs)
    // What the clip can be DRIVEN to do is no longer reported here (D612).
    // It could not vary per clip — the broker's transport choice reads only
    // provider-level wiring — so it is answered once, per provider, by
    // `videoclips.getPlaybackOptions`, before a clip is even picked.
    await Promise.all([
      this.reportClipDuration(clipId, feeder),
      this.reportClipAudio(clipId, feeder),
      // Settles only when the stream ENDS — minutes after the other two, and
      // in parallel with them, because it must not hold the clip's start.
      this.reportClipIncomplete(clipId, feeder),
    ])
  }

  /**
   * Tell the viewer whether this clip has sound.
   *
   * Silence has causes the operator cannot tell apart by listening — a camera
   * with no microphone, a transport that carried no audio, a session that
   * negotiated none, and (D621) a clip playing at anything but 1×, where the
   * broker drops every frame on purpose — so the viewer is told which. Every
   * branch that sends nothing says so (D391): a feeder that cannot answer, an
   * answer that rejected, and an answer that landed after the pointer had left
   * the clip, which must not be pinned on whatever came next.
   *
   * The first answer SETTLES; the rate does not, so this also subscribes for
   * as long as the clip is on the pointer.
   */
  private async reportClipAudio(clipId: string, feeder: TimelineSessionClipFeeder): Promise<void> {
    if (feeder.audio === undefined) {
      this.deps.onLog?.('clip playback: audio not reported — this feeder cannot say', {
        deviceId: this.deps.deviceId,
        clipId,
      })
      return
    }
    let report: ClipAudioReport
    try {
      report = await feeder.audio()
    } catch (err) {
      this.deps.onLog?.('clip playback: audio not reported — the answer failed', {
        deviceId: this.deps.deviceId,
        clipId,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    this.sendClipAudio(clipId, report)
    // What the stream CARRIES is settled; whether the operator can hear it is
    // not, because the broker drops every audio frame at any rate but 1×
    // (D600, D621). Follow it for as long as the pointer stays on this clip.
    feeder.watchAudio?.((later) => this.sendClipAudio(clipId, later))
  }

  /**
   * Send one `clipAudio`, or say why nothing was sent.
   *
   * ONE place, for the settle and for every later change: they are the same
   * statement about the same clip, and a second builder is how the two would
   * come to disagree about what `reason` means. The clip-identity guard lives
   * here too — a report that lands after the pointer has left names a clip
   * nobody is playing, and the viewer would mute whatever came next.
   */
  private sendClipAudio(clipId: string, report: ClipAudioReport): void {
    if (this.clip?.clipId !== clipId) {
      this.deps.onLog?.('clip playback: audio dropped — the pointer has left this clip', {
        deviceId: this.deps.deviceId,
        clipId,
        carried: report.carried,
        reason: report.reason,
      })
      return
    }
    this.deps.onLog?.('clip playback: audio reported', {
      deviceId: this.deps.deviceId,
      clipId,
      carried: report.carried,
      codec: report.codec,
      reason: report.reason,
      rate: report.rate,
      detail: report.detail,
    })
    this.deps.session.sendControl(
      serializeServerMessage({
        t: 'clipAudio',
        clipId,
        carried: report.carried,
        ...(report.codec !== null ? { codec: report.codec } : {}),
        ...(report.reason !== null ? { reason: report.reason } : {}),
        // Present exactly when the reason is `rate` — the wire schema refuses
        // the pair any other way round, and `serializeServerMessage` parses on
        // the way out, so a branch that gets it wrong throws here.
        ...(report.reason === 'rate' && report.rate !== undefined ? { rate: report.rate } : {}),
      }),
    )
  }

  /**
   * Tell the operator that the clip he is watching did not arrive whole
   * (D623), in the surface that already shows him a stream error.
   *
   * Awaited AFTER the stream ends, which is when the provider gets to speak,
   * and guarded by the clip identity for the same reason the audio report is:
   * a late answer names a clip nobody is playing and the viewer would put the
   * complaint on whatever came next.
   *
   * There is no retry here and there must not be one. *"Se cade la sessione
   * cade non fa niente"* [if the session drops, it drops, nothing happens] — the operator, 2026-09-23. A second dial would
   * contend for the camera's single replay lane exactly while that lane is
   * already failing.
   */
  private async reportClipIncomplete(
    clipId: string,
    feeder: TimelineSessionClipFeeder,
  ): Promise<void> {
    if (feeder.incomplete === undefined) {
      this.deps.onLog?.(
        'clip playback: completeness not reported — this feeder cannot ask the provider',
        { deviceId: this.deps.deviceId, clipId },
      )
      return
    }
    let report: ClipIncompleteReport | null
    try {
      report = await feeder.incomplete()
    } catch (err) {
      this.deps.onLog?.('clip playback: completeness not reported — the answer failed', {
        deviceId: this.deps.deviceId,
        clipId,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    // A whole clip has nothing to say, and says nothing. The absence is the
    // statement — never a `clipIncomplete` with a falsy code.
    if (report === null) return
    if (this.clip?.clipId !== clipId) {
      this.deps.onLog?.('clip playback: completeness dropped — the pointer has left this clip', {
        deviceId: this.deps.deviceId,
        clipId,
        code: report.code,
      })
      return
    }
    this.deps.onLog?.('clip playback: the clip did not arrive whole', {
      deviceId: this.deps.deviceId,
      clipId,
      code: report.code,
      reason: report.reason,
    })
    this.deps.session.sendControl(
      serializeServerMessage({
        t: 'clipIncomplete',
        clipId,
        code: report.code,
        reason: report.reason,
      }),
    )
  }

  /**
   * Tell the viewer how long the file on the pointer REALLY is.
   *
   * The clip source has measured this from the MP4 index since D575 and no
   * one asked: the viewer's only other length is the camera's catalog row,
   * which freezes while a file is still growing. Asked AFTER the first seek,
   * because that seek is what loads and indexes the file — the cheap question
   * has already been answered by then and this costs no second read.
   *
   * Every branch that sends nothing says so (D391): a feeder with no measure,
   * a measure that rejected, and a measure that landed after the pointer had
   * already left this clip — that last one must not be pinned on whatever
   * came next.
   */
  private async reportClipDuration(
    clipId: string,
    feeder: TimelineSessionClipFeeder,
  ): Promise<void> {
    if (feeder.durationMs === undefined) {
      this.deps.onLog?.('clip playback: duration not reported — this feeder cannot measure it', {
        deviceId: this.deps.deviceId,
        clipId,
      })
      return
    }
    let durationMs: number | null
    try {
      durationMs = await feeder.durationMs()
    } catch (err) {
      this.deps.onLog?.('clip playback: duration not reported — the measure failed', {
        deviceId: this.deps.deviceId,
        clipId,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (this.clip?.clipId !== clipId) {
      this.deps.onLog?.('clip playback: duration dropped — the pointer has left this clip', {
        deviceId: this.deps.deviceId,
        clipId,
        durationMs,
      })
      return
    }
    if (durationMs === null) {
      // The source ended without a length — a stream cut short, or left. Not
      // zero, and not sent: the viewer keeps whatever it already draws.
      this.deps.onLog?.('clip playback: duration unknown — the source ended without a length', {
        deviceId: this.deps.deviceId,
        clipId,
      })
      return
    }
    if (!(durationMs > 0)) {
      // The schema refuses it anyway; say why rather than throw out of dispatch.
      this.deps.onLog?.('clip playback: duration not reported — the measure is not positive', {
        deviceId: this.deps.deviceId,
        clipId,
        durationMs,
      })
      return
    }
    this.deps.session.sendControl(serializeServerMessage({ t: 'clipDuration', clipId, durationMs }))
  }

  /** Drop the clip pointer. Every path back to the recorder's own footage — a
   *  `playRecorded` and `goLive` — goes through here, so there is exactly one
   *  place that can forget to. */
  private leaveClip(): void {
    if (!this.clip) return
    this.clip = null
    this.feeder?.dispose()
    this.feeder = null
    this.mode = 'live'
  }

  /**
   * Play recorded footage at `epochMs`. If `locate` is wired and the requested
   * profile has no segment, try high → mid → low so events-mode cameras that
   * only kept one tier still play.
   */
  private async playAt(
    epochMs: number,
    requestedProfile: string,
    opts?: TimelineSeekOptions,
  ): Promise<void> {
    const profile = await this.resolveProfile(requestedProfile, epochMs)
    this.reportServedProfile(profile, requestedProfile)
    const profileChanged = profile !== this.profile
    this.profile = profile
    // Keep the feeder when playback stays on the same profile. Rebuilding
    // it on every timeline tap discarded pause/rate + the demuxed working
    // set, turning a seek into a cold start and making the next frame-step
    // run against a fresh rate-1 feeder.
    const feeder =
      this.mode === 'recorded' && this.feeder && !profileChanged
        ? this.feeder
        : this.enterRecorded()
    // Omit the second arg when there are no seek options — callers (and
    // tests) treat `seek(epoch)` and `seek(epoch, { travelFromMs })` as
    // distinct: scrub-commit must not invent a travel-from.
    if (opts) await feeder.seek(epochMs, opts)
    else await feeder.seek(epochMs)
  }

  /**
   * The profile this session will actually play, given the one asked for.
   *
   * **The requested tier wins whenever it has footage AT ALL** — a segment
   * covering `epochMs`, or a gap carrying a `nearestEdgeMs`, which means
   * "footage exists on this tier, just not here" and is exactly what the
   * feeder's snap-to-nearest needs. Only a tier that records NOTHING is
   * abandoned, and then the answer is the first tier that demonstrably does.
   * Falling back to `requested` when nothing has footage anywhere is the last
   * resort: the session default is `mid`, and no camera on this cluster records
   * `mid`, so returning it for a tap into a gap left the feeder with nothing to
   * snap to and turned a recoverable crack into `seek-no-footage` — the
   * operator sees "no recording" on a camera that recorded seconds either side.
   *
   * The requested tier is checked to EXHAUSTION before any other is consulted,
   * and that ordering is load-bearing twice over:
   *
   * 1. The scrub is pinned to `low` by the client, and every D163 pre-cache
   *    behaviour is gated on `deps.profile === 'low'` by exact string equality
   *    — the ±15 min entry warm, the whole-segment read, and the 48 MB
   *    fragment budget (2 MB for anything else). `profileSearchOrder` puts
   *    `high` BEFORE `low`, so a momentary `low` gap used to hand the drag a
   *    `high` feeder and silently turn all three off. The client cannot repair
   *    that: it re-sends `setProfile` only when its own `lastSentProfile`
   *    mirror disagrees, and the mirror never learns the server moved.
   * 2. `seek` and `scrubCommit` route through `playAt`, so every finger-release
   *    pays this loop. locate is a cap RPC (1-8 s on cold footage); walking the
   *    ladder to re-confirm a pin the caller already holds is latency the
   *    operator feels as a slow commit.
   */
  private async resolveProfile(requested: string, epochMs: number): Promise<string> {
    const locate = this.deps.locate
    if (!locate) return requested
    let withFootage: string | null = null
    for (const profile of profileSearchOrder(requested)) {
      // A locate that REJECTS (recorder cap down, a deadline) is "no answer
      // for this tier", never a dead tap: before this catch, the rejection
      // threw out of handleControl ahead of enterRecorded, so the tap set no
      // gate, built no feeder and gave no feedback — silently, and exactly
      // when the recorder was struggling. A fallible read may cost the
      // fallback, never the mode flip (D49).
      let loc: LocateResult
      try {
        loc = await locate({ deviceId: this.deps.deviceId, profile, epochMs })
      } catch {
        continue
      }
      if (loc.kind === 'segment') return profile
      // A gap counts as footage only where the feeder could SNAP to it. A
      // tier whose nearest edge is hours away — High deleted for this range
      // but still recording on a new disk — would play nothing here, and
      // used to win anyway, turning Mid footage into "no recording".
      if (withFootage === null && gapReachable(loc, epochMs)) {
        // The REQUESTED tier proving it records ends the search: snap-to-nearest
        // can serve this gap, and changing tier here is what cost the scrub its
        // `low` pin (see the docblock).
        if (profile === requested) return profile
        withFootage = profile
      }
    }
    return withFootage ?? requested
  }

  /** The (served, requested) pair last told to the client, or null. */
  private lastServedReport: string | null = null

  /**
   * Never a silent switch (D62 spirit): the client learns which tier it is
   * watching whenever the pair changes — including the seek that gets the
   * requested tier back. Sent only when the served tier is one the wire
   * schema names; a session default outside the ladder is not reported.
   */
  private reportServedProfile(profile: string, requested: string): void {
    const key = `${profile}<${requested}`
    if (key === this.lastServedReport) return
    if (profile === requested && this.lastServedReport === null) {
      this.lastServedReport = key
      return
    }
    if (profile !== 'high' && profile !== 'mid' && profile !== 'low') return
    this.lastServedReport = key
    this.deps.session.sendControl(
      serializeServerMessage({ t: 'servedProfile', profile, requested }),
    )
  }

  private goLive(): void {
    this.clip = null
    this.feeder?.dispose()
    this.feeder = null
    this.lastPositionMs = null
    this.deps.session.setLiveFeedGate(false)
    this.deps.session.requestKeyframe()
    this.mode = 'live'
    this._emitState('live')
  }

  /** Emit seam: the broker wires the feeder's onState callback to this. */
  _emitState(state: FeederState | 'live'): void {
    this.deps.session.sendControl(serializeServerMessage({ t: 'state', state }))
  }

  /** Emit seam: the broker wires the feeder's onPosition callback to this.
   *  `pushSeq` rides along only on the position a scrub push emitted — the
   *  viewer echoes it on `scrubAck` so the credit is repaid to the right push. */
  _emitPosition(epochMs: number, pushSeq?: number): void {
    this.lastPositionMs = epochMs
    this.deps.session.sendControl(
      serializeServerMessage(
        pushSeq === undefined
          ? { t: 'position', epochMs }
          : { t: 'position', epochMs, seq: pushSeq },
      ),
    )
  }

  private emitLiveProfile(): void {
    const profile = this.liveProfile ?? this.deps.initialLiveProfile
    if (this.liveProfileReported || profile === undefined) return
    this.liveProfileReported = true
    this.deps.session.sendControl(serializeServerMessage({ t: 'liveProfile', profile }))
  }

  /**
   * The live rung moved under this coordinator — an adaptive tier switch that
   * stayed on the session (D733). Before D733 a tier change built a new
   * coordinator, which reported its own `initialLiveProfile`; now the same one
   * outlives the switch and must say what the viewer is watching. Reported at
   * once when the viewer has already been told a profile, otherwise on its
   * first control message as before.
   */
  setLiveProfile(profile: 'high' | 'mid' | 'low'): void {
    if (this.liveProfile === profile) return
    this.liveProfile = profile
    if (!this.liveProfileReported) return
    this.deps.session.sendControl(serializeServerMessage({ t: 'liveProfile', profile }))
  }

  dispose(): void {
    this.feeder?.dispose()
    this.feeder = null
  }
}
