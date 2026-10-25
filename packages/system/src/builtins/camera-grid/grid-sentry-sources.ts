/**
 * Which URL a grid dials for one source: the live stream, or the SENTRY one.
 *
 * ## What "sentryMuted" turned out to be
 *
 * The operator asked for a stream that *"non esiste ancora"* [does not exist yet]. It half did.
 * `SENTRY_PATH_SUFFIX` has existed since the sentry shipped. What did not exist is the
 * WRITER that turns an acquired restream url into that dial, and the broker
 * telling a consumer whether one is on offer. Both are now in
 * `addon-pipeline/src/stream-broker`: `withSentryIntent`, and `sentryUrl` on
 * the `getStreamWithCodec` result.
 *
 * ## It is NOT muted, and this comment used to say it was
 *
 * `parseRestreamPath` answered `muted: true` for `/sentry` when this was
 * written, and D525 changed it to `false` the next day: the mute belonged to
 * the PLACEHOLDER, not to the path. The track is announced and FILLED — silence
 * while the still picture is served, the camera's own RTP the instant media
 * flows — because a decision taken from a string is taken once and RTSP cannot
 * renegotiate, so `true` there meant a sentry consumer could never receive
 * audio, awake or asleep.
 *
 * A grid takes no audio from any source (`audio: 'none'`), so nothing about the
 * composite changes either way. The correction is here because the old sentence
 * described the design that was REPLACED, which is the one kind of comment that
 * reads as verification.
 *
 * ## The rule, and the fallback it refuses
 *
 * An offered sentry is TAKEN. There is no sleep check and no fallback, and that
 * is deliberate: "use the sentry if the camera is asleep, otherwise the live
 * stream" reads reasonable and is exactly the wake. Whether a battery camera is
 * asleep right now is a fact that changes between the read and the dial, and
 * the dial is what wakes it. The ONE question asked is the one the broker
 * already owns — is this camera offered a sentry at all — and the broker only
 * offers it to a battery camera that declares the signals cap.
 *
 * ## What the operator sees
 *
 * A cell whose source is asleep composes that camera's last picture, held, for
 * as long as it sleeps — visible, legible, and obviously not moving. The two
 * alternatives are the ones D519 and the sentry both exist to refuse: dropping
 * the cell (a hole an operator files as a broken grid) and dialling the camera
 * (eleven seconds of battery for five seconds of video, measured on device 106).
 */

/** What `streamBroker.getStreamWithCodec` handed back for one source. */
export interface GridSourceAcquisition {
  readonly url: string
  /**
   * The sentry counterpart, when the BROKER offers one. Absent and `null` mean
   * the same thing — this camera has no sentry — and neither is ever resolved
   * into the live url by guessing.
   */
  readonly sentryUrl?: string | null
  readonly pipelineKey: string
}

export interface GridSourceDial {
  readonly url: string
  /** The key the acquisition was issued under — releasing anything else leaks a dial. */
  readonly pipelineKey: string
  /** What this cell is actually reading. Logged, so a still cell is never a mystery. */
  readonly mode: 'live' | 'sentry'
}

export function gridSourceDial(acquired: GridSourceAcquisition): GridSourceDial {
  const sentryUrl = acquired.sentryUrl
  if (typeof sentryUrl === 'string' && sentryUrl.length > 0) {
    return { url: sentryUrl, pipelineKey: acquired.pipelineKey, mode: 'sentry' }
  }
  return { url: acquired.url, pipelineKey: acquired.pipelineKey, mode: 'live' }
}
