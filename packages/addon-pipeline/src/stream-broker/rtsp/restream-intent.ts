/**
 * The dial DECLARATION a restream consumer makes on the RTSP path: what it is,
 * and how much retained history it asks for.
 *
 * The restreamer's join rules key on what kind of consumer is joining, and the
 * only thing an RTSP dial can carry before a session exists is its path. Today
 * that path already encodes one bit — `/muted`, "video only, and I am a local
 * decoder loopback" — and `RtspRestreamer.servePendingSessionsRtp` uses it to
 * withhold the catch-up burst from anything muted whose burst is older than
 * `LIVE_EDGE_MAX_SPAN_MS`.
 *
 * That rule was measured for re-clocked consumers (a HomeKit leg that is an
 * ffmpeg copy of this restream) which have ~zero decode headroom and never
 * drain a 2-3 s backlog. A per-session DETECTION decode is the opposite: it
 * decodes at source rate and publishes throttled by the FrameSlot, so it drains
 * the burst and starts producing frames immediately — and on a ~2 s-GOP camera
 * the withhold instead makes ~3 dials in 4 wait for the next live IDR, which is
 * the dominant term in the blind ramp between motion and the first inferenced
 * frame.
 *
 * So detection says so, in a SECOND path suffix rather than by widening the
 * meaning of `isMuted()`. Every other muted consumer keeps today's behaviour
 * byte-for-byte, because none of them dials this path.
 *
 * Writer and reader live in this one module on purpose: a suffix written by the
 * decode dial and parsed by the listen server has no test that catches them
 * drifting apart if they are declared in two files.
 *
 * The AMOUNT is the second half of the declaration, and it is a D382 addition.
 * D381 made the broker the only thing that decides how much history exists and
 * left the consumer's ask implicit — so declaring an intent, which detection
 * does for the live-edge exemption above, meant being handed the whole retained
 * window. An unstated amount is ZERO here: history reaches a consumer that
 * named a number and nobody else.
 */
import { PREBUFFER_MAX_MS } from '../prebuffer.js'

/** Path suffix for the audio-free variant of a restream token. */
export const MUTED_PATH_SUFFIX = '/muted'

/**
 * Path suffix for the audio-free variant dialed by a DETECTION decode session.
 * Muted in every respect (no audio, still `isMuted()`), plus exempt from the
 * live-edge join withhold.
 */
export const DETECTION_MUTED_PATH_SUFFIX = '/muted-detection'

/**
 * Path suffix for a RECORDING dial — the `events`-band recorder's ffmpeg.
 *
 * NOT muted: a recording keeps its audio, so this cannot ride the detection
 * suffix. What it shares with detection is the reason for existing — it attaches
 * AFTER the trigger, so without the retained history its footage begins after
 * the event. Measured on camera 1438 (audit 2026-08-20): the footage started
 * after the motion in 60 % of episodes, because the writer is spawned at the
 * trigger and ffmpeg's first frame is at best the live edge.
 */
export const RECORDING_PATH_SUFFIX = '/recording'

/**
 * The SENTRY counterpart of a profile's restream.
 *
 * Every profile gets one, exactly as every profile gets a `/muted`: a consumer
 * dials `<token>/sentry` instead of `<token>` and is asking for the stream
 * WITHOUT asking for the camera. It is fed the last picture while the camera
 * sleeps, and the real media the moment something wakes it — on BOTH planes.
 * The audio track is announced and filled with silence for as long as the
 * picture is being served, and the camera's own audio takes it over the instant
 * media flows (D525). Only the placeholder is mute; the path never was.
 *
 * A separate path and not a flag, for the reason `/muted` is one: the choice
 * belongs to the URL a consumer was given, so a plus catalog configured once keeps
 * asking for the same thing without a per-session negotiation, and a consumer
 * that was given the ordinary URL cannot accidentally be served a still image.
 *
 * D382 in one line: the ask is explicit and absent means zero. A path with no
 * suffix is live intent and behaves exactly as it always has.
 */
export const SENTRY_PATH_SUFFIX = '/sentry'

/**
 * Path segment prefix carrying the AMOUNT of retained history a dial asks for.
 *
 * A path segment and not a query string: the listen server matches the request
 * URI with a path regex and strips a trailing `/trackID=N`, so anything that is
 * not a segment would either break the token lookup or be dropped silently
 * between DESCRIBE and SETUP.
 */
export const PRE_ROLL_REQUEST_PREFIX = '/preroll-'

/**
 * Declared purpose of a restream dial. Both declared intents exist for the same
 * reason — the consumer attaches after the edge it needs to see — and both may
 * ASK for the pre-roll window. They differ in mute: detection is a video-only
 * decoder loopback, recording carries audio.
 */
export type RestreamIntent = 'detection' | 'recording' | 'sentry'

/**
 * What a dial DECLARED about itself: what it is, and how much history it wants.
 *
 * One shape and not two loose fields, because the amount is meaningless without
 * the intent and the intent is no longer sufficient on its own (D382). A caller
 * that constructs this cannot state a purpose and forget to state a number.
 */
export interface RestreamDeclaration {
  /** Declared consumer purpose, or `null` for every dial that declares none. */
  readonly intent: RestreamIntent | null
  /**
   * Ms of retained history this dial ASKED for. `0` — what an absent
   * declaration resolves to — means "none": the ordinary current-GOP join
   * burst, which is what every consumer got before there was a prebuffer.
   *
   * **Zero is the default on purpose.** D381 gave the broker sole authority
   * over how much history EXISTS and left the ask implicit, so an omitted
   * request meant "the whole retained window". Detection declares its intent to
   * be exempt from the live-edge withhold — an unrelated rule — and was
   * therefore handed seconds of backlog nobody had decided it should have. A
   * default that acts without anybody choosing it is the shape of defect D381
   * itself retired; here it is retired for the ASK as well.
   */
  readonly preRollRequestMs: number
}

/** A dial that declared nothing: no purpose, no history. */
export const NO_DECLARATION: RestreamDeclaration = { intent: null, preRollRequestMs: 0 }

/**
 * What the DETECTION dial asks for.
 *
 * {@link PREBUFFER_MAX_MS} — "whatever you retain" — which is byte-for-byte
 * what D381 served this population by omission, so the ask becomes explicit
 * without the behaviour changing under an operator who was never asked. It is a
 * REQUEST, not a configuration: `capPreRollRequestMs` answers it with the
 * smaller of this and what the ring holds, and the prebuffer stays the only
 * place the amount of history is decided.
 *
 * Whether detection should ask for LESS is an operator's call on measured
 * numbers, not something a session decides for itself. The per-attach evidence
 * is the broker's `restream attach live-edge` line and the runner's
 * `session-decode: detection first frame`, which now names this request.
 */
export const DETECTION_PRE_ROLL_REQUEST_MS = PREBUFFER_MAX_MS

/**
 * What the RECORDING dial asks for: the whole retained window.
 *
 * Not a tuning knob and not a second ceiling — it is the recorder saying "as
 * much as you kept", the only correct answer for a writer whose keep gate is
 * itself derived from {@link PREBUFFER_MAX_MS} (D381). A narrower request would
 * write a segment that begins after media the broker was holding for it.
 */
export const RECORDING_PRE_ROLL_REQUEST_MS = PREBUFFER_MAX_MS

/**
 * What a dial IS, independent of the string it arrived as.
 *
 * Split out of {@link ParsedRestreamPath} so the rules that key on a dial
 * ({@link isLiveEdgeOnlyDial}, {@link sdpVariantFor}) can be asked by an
 * `RtspSession`, which holds these two fields and never sees a path. One
 * authority for each rule, reachable from both sides of the wire.
 */
export interface RestreamDialShape {
  /**
   * Video-only: this session is served no audio RTP, and is answered with an
   * SDP that declares no `m=audio`.
   *
   * This means AUDIO and nothing else. It used to double as "this consumer
   * re-clocks and must join at the live edge" — see {@link isLiveEdgeOnlyDial}
   * for why those are now two questions.
   */
  readonly muted: boolean
  /** What this dial said about itself. {@link NO_DECLARATION} when it said nothing. */
  readonly declaration: RestreamDeclaration
}

/** A restream request path split into the token, the mute bit and the declaration. */
export interface ParsedRestreamPath extends RestreamDialShape {
  /** The token the restreamer registry is keyed by (suffixes stripped). */
  readonly lookupPath: string
}

/**
 * A request the ring could conceivably answer, or `0`.
 *
 * Clamped at {@link PREBUFFER_MAX_MS} — the widest window any prebuffer holds —
 * so a hand-typed or corrupted path cannot name a number the mechanics
 * downstream would then have to defend against. Anything unparseable is `0` and
 * never "everything": an amount nobody can read is not a declaration.
 */
function clampRequest(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(PREBUFFER_MAX_MS, Math.floor(value))
}

/**
 * Render an amount as the request segment, or as nothing at all.
 *
 * A zero request appends NOTHING rather than `/preroll-0`: the two mean the
 * same thing, and a path with two spellings is a path with two parsers.
 */
function requestSegment(requestMs: number): string {
  const ms = clampRequest(requestMs)
  return ms > 0 ? `${PRE_ROLL_REQUEST_PREFIX}${ms}` : ''
}

/** Split a trailing `/preroll-<ms>` off a path: the rest, and the amount. */
function splitRequest(streamPath: string): { readonly rest: string; readonly requestMs: number } {
  const at = streamPath.lastIndexOf(PRE_ROLL_REQUEST_PREFIX)
  if (at < 0) return { rest: streamPath, requestMs: 0 }
  const digits = streamPath.slice(at + PRE_ROLL_REQUEST_PREFIX.length)
  if (!/^\d+$/.test(digits)) return { rest: streamPath.slice(0, at), requestMs: 0 }
  return { rest: streamPath.slice(0, at), requestMs: clampRequest(Number(digits)) }
}

/**
 * Split a restream request path (already stripped of `rtsp://host:port/` and of
 * any `/trackID=N` control suffix) into its token, mute bit and declaration.
 *
 * The request segment is read FIRST because it is always last on the wire, and
 * an amount with no intent in front of it is discarded: history is served on
 * the strength of a declared purpose, so a bare number has nothing to attach
 * to and the token keeps whatever it was called.
 */
export function parseRestreamPath(streamPath: string): ParsedRestreamPath {
  const { rest, requestMs } = splitRequest(streamPath)
  const declare = (intent: RestreamIntent): RestreamDeclaration => ({
    intent,
    preRollRequestMs: requestMs,
  })
  if (rest.endsWith(SENTRY_PATH_SUFFIX)) {
    return {
      lookupPath: rest.slice(0, -SENTRY_PATH_SUFFIX.length),
      // NOT muted. This branch used to answer `true`, with the reasoning that
      // "an `m=audio` nobody fills stalls a consumer's ffmpeg, and for the
      // hours a camera may sit in sentry nobody fills it" — right about the
      // hazard, wrong about the remedy. The mute belonged to the PLACEHOLDER,
      // not to the path: the track is announced and FILLED, with silence while
      // the picture is being served and the camera's own RTP the instant media
      // flows. A decision taken here is taken once, from a string, and RTSP
      // cannot renegotiate — so `true` here meant a sentry consumer could never
      // receive audio, awake or asleep. (D525)
      muted: false,
      declaration: declare('sentry'),
    }
  }
  if (rest.endsWith(RECORDING_PATH_SUFFIX)) {
    return {
      lookupPath: rest.slice(0, -RECORDING_PATH_SUFFIX.length),
      muted: false,
      declaration: declare('recording'),
    }
  }
  if (rest.endsWith(DETECTION_MUTED_PATH_SUFFIX)) {
    return {
      lookupPath: rest.slice(0, -DETECTION_MUTED_PATH_SUFFIX.length),
      muted: true,
      declaration: declare('detection'),
    }
  }
  if (rest.endsWith(MUTED_PATH_SUFFIX)) {
    return {
      lookupPath: rest.slice(0, -MUTED_PATH_SUFFIX.length),
      muted: true,
      declaration: NO_DECLARATION,
    }
  }
  return { lookupPath: streamPath, muted: false, declaration: NO_DECLARATION }
}

/**
 * Which SDP variant a parsed dial is answered with.
 *
 * Three and not two, because the sentry's SDP is neither of the existing ones:
 * the FULL SDP is whatever the current connection produced — video-only while
 * the camera sleeps, since it is built from the placeholder frame — and the
 * MUTED one is video-only by construction. A sentry needs the video the
 * placeholder is drawing PLUS the audio track it will be filled with, which
 * only the restreamer's retained audio shape can supply.
 *
 * Keeping it a third variant rather than widening the full SDP is deliberate:
 * an `m=audio` is announced only to the population this system actually fills,
 * so the stall hazard the old mute was defending against cannot reach anybody
 * else.
 */
export type RestreamSdpVariant = 'full' | 'muted' | 'sentry'

/** The variant this dial is answered with. */
export function sdpVariantFor(parsed: RestreamDialShape): RestreamSdpVariant {
  if (parsed.declaration.intent === 'sentry') return 'sentry'
  return parsed.muted ? 'muted' : 'full'
}

/**
 * Whether this dial is a RE-CLOCKING leg, which may only join at the live edge.
 *
 * `isMuted()` used to answer two unrelated questions at once, and un-muting the
 * sentry made the conflation load-bearing:
 *
 *  - "serve this session no audio" — what the word means, and all it means now;
 *  - "this consumer re-emits what it receives on a real-time clock, has ~zero
 *    decode headroom, and never drains a 2-3 s catch-up burst" — the rule
 *    `LIVE_EDGE_MAX_SPAN_MS` was measured for (a HomeKit leg that is an ffmpeg
 *    copy of this restream).
 *
 * The two coincided only because every consumer that re-clocked also happened
 * to be video-only. A sentry is the counter-example: it re-clocks exactly like
 * the `/muted` legs — it is the same ffmpeg-copy shape — and it now carries
 * audio. So the join rule asks THIS, not the mute, and every population keeps
 * its measured behaviour byte-for-byte: `/muted` yes, `/sentry` yes, detection
 * no (it drains the burst by construction — D193), recording and plain no.
 */
export function isLiveEdgeOnlyDial(dial: RestreamDialShape): boolean {
  if (dial.declaration.intent === 'detection') return false
  if (dial.declaration.intent === 'sentry') return true
  return dial.muted
}

/**
 * The amount a dial URL asks for, read back off the URL itself.
 *
 * For the LOG on the consumer's side. The runner's
 * `session-decode: detection first frame` line has to be able to say what this
 * attach asked for, and reading it off the string that was actually dialed —
 * rather than off the constant the caller meant to pass — is what makes the
 * line evidence instead of a restatement of intent.
 */
export function preRollRequestOf(restreamUrl: string): number {
  return splitRequest(restreamUrl).requestMs
}

/**
 * Rewrite an acquired restream URL to declare the detection intent and the
 * history it asks for.
 *
 * `requestMs` is REQUIRED. It used to be absent, and absent meant the whole
 * retained window — the defect D382 removes. `0` is a legitimate, explicit
 * "none": the session still declares detection, which is what lifts the
 * live-edge withhold it dialed this path for in the first place.
 *
 * Only a MUTED url is rewritten. `resolveSourceUrl` falls back to the
 * audio-bearing url when the broker has no muted variant; that session is not
 * muted, the live-edge withhold never applied to it, and appending the suffix
 * would only break the token lookup. Idempotent, amount included.
 */
export function withDetectionIntent(restreamUrl: string, requestMs: number): string {
  const { rest } = splitRequest(restreamUrl)
  if (rest.endsWith(DETECTION_MUTED_PATH_SUFFIX)) return `${rest}${requestSegment(requestMs)}`
  if (!rest.endsWith(MUTED_PATH_SUFFIX)) return restreamUrl
  const base = rest.slice(0, -MUTED_PATH_SUFFIX.length)
  return `${base}${DETECTION_MUTED_PATH_SUFFIX}${requestSegment(requestMs)}`
}

/**
 * Rewrite an acquired restream URL to declare the RECORDING intent and the
 * history it asks for.
 *
 * The mirror image of {@link withDetectionIntent}'s guard: only a NON-muted url
 * is rewritten. A recorder handed the muted variant (a device with no audio, or
 * `audio: 'none'`) is already the detection population's shape, and appending
 * this suffix would only break the token lookup. Idempotent, amount included.
 */
export function withRecordingIntent(restreamUrl: string, requestMs: number): string {
  const { rest } = splitRequest(restreamUrl)
  if (rest.endsWith(MUTED_PATH_SUFFIX) || rest.endsWith(DETECTION_MUTED_PATH_SUFFIX)) {
    return restreamUrl
  }
  if (rest.endsWith(RECORDING_PATH_SUFFIX)) return `${rest}${requestSegment(requestMs)}`
  return `${rest}${RECORDING_PATH_SUFFIX}${requestSegment(requestMs)}`
}

/**
 * Rewrite an acquired restream URL into the SENTRY dial — the counterpart of
 * {@link withDetectionIntent} and {@link withRecordingIntent}, and the one the
 * sentry path shipped without.
 *
 * "sentryMuted", which is what the operator asked a composite camera to take
 * from a battery source, is not a second intent — and it is not muted either,
 * though this comment said so until 2026-09-18. D525 made `parseRestreamPath`
 * answer `muted: false` for `/sentry`: the mute belongs to the PLACEHOLDER, not
 * to the path, so the track is announced and filled with silence while the
 * picture is served and with the camera's own RTP the instant media flows.
 *
 * What stands is the REPLACEMENT: this rewrites whatever the url declared
 * rather than appending to it — `<token>/muted/sentry` would parse back to the
 * token `<token>/muted`, a lookup that finds nothing and says nothing.
 *
 * The pre-roll request is dropped for the same reason the sentry declares none:
 * there is no history in a still picture, and D382 says the ask is explicit.
 *
 * Idempotent. Safe on any of the url shapes the broker hands out.
 */
export function withSentryIntent(restreamUrl: string): string {
  const { rest } = splitRequest(restreamUrl)
  for (const suffix of [
    SENTRY_PATH_SUFFIX,
    RECORDING_PATH_SUFFIX,
    DETECTION_MUTED_PATH_SUFFIX,
    MUTED_PATH_SUFFIX,
  ]) {
    if (rest.endsWith(suffix)) return `${rest.slice(0, -suffix.length)}${SENTRY_PATH_SUFFIX}`
  }
  return `${rest}${SENTRY_PATH_SUFFIX}`
}
