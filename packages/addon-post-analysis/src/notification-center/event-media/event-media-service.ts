/**
 * The notification centre's consumer of the broker's event-media production.
 *
 * ## The defect this exists to fix
 *
 * A notification carrying a gif and a video must show the SAME THING. On
 * 2026-08-08 it did not, and the operator caught it on a real doorbell press:
 * the gif came from the broker's clip ring and covered [event−3 s, event+5 s];
 * the mp4 came from the ON-DEMAND fMP4 seam
 * ([D85](../../../../../../docs/decisions/adr-0085.md)) and covered
 * [event+7 s, event+13 s], because the outbox drain asks for footage
 * `eventToDialMs=7054` after the event and a child spawned then cannot reach
 * backwards. Two sources, two windows, one event.
 *
 * ## Where the guarantee now lives, and why it is NOT here
 *
 * `streamBroker.produceEventMedia` cuts ONE window and emits every container
 * from it — the mp4 muxed from the broker's own retained AnnexB packets, the
 * gif derived from that mp4. The broker is the only process that owns those
 * packets, so making it the production point turns "the attachments agree" into
 * a property of the service rather than a discipline every consumer keeps.
 * This class is deliberately thin: it asks, it redeems two handles, it reports.
 * A second consumer (a clips API, a retrain export) writes the same twenty
 * lines and inherits the same guarantee.
 *
 * ## The fallback, and why it is coarser on purpose
 *
 * A hub whose `@camstack/server` predates the method answers 404. That must not
 * cost the notification, so the old `renderPreBufferClip` path stays — but it
 * renders ONE format, so in fallback the notification carries the mp4 only and
 * SAYS so. Shipping a gif from a second render would reintroduce exactly the
 * defect above; a missing attachment is honest, a disagreeing pair is not.
 */
import type { EventMediaArtifact, EventMediaKind, IScopedLogger } from '@camstack/types'

/** What one production covered and produced. */
export interface EventMedia {
  readonly mp4: Uint8Array | null
  readonly gif: Uint8Array | null
  /** How the media was obtained — on the log line, never re-derived. */
  readonly source: 'produced' | 'ring-fallback' | 'none'
  /** Offsets from the event, ms. NEGATIVE start = a real pre-roll. */
  readonly startOffsetMs: number | null
  readonly endOffsetMs: number | null
  readonly profile: string | null
  /** `copy` = the camera's own H.264 untouched. */
  readonly video: 'copy' | 'encode' | null
}

export interface EventMediaRequest {
  readonly deviceId: number
  /** The instant the notification is about. */
  readonly aroundMs: number
  readonly preRollSec: number
  readonly postRollSec: number
  readonly wantMp4: boolean
  readonly wantGif: boolean
  /** The rule's explicit profile preference; absent lets the broker choose. */
  readonly profile?: string
  /** The rule's playback rate for the VIDEO. Absent is {@link DEFAULT_SPEED}.
   *  A rule that explicitly asks for `1` still gets real time, and with it the
   *  copy branch. */
  readonly speed?: number
}

/** `streamBroker.produceEventMedia`, injected so this stays testable. */
export type ProduceEventMedia = (input: {
  readonly deviceId: number
  readonly aroundMs: number
  readonly preSeconds: number
  readonly postSeconds: number
  readonly kinds: readonly EventMediaKind[]
  readonly gifMaxWidth: number
  readonly gifFps: number
  /** The gif's own rate. Sent EXPLICITLY rather than left to the cap's
   *  `.default()`, which only lands once a publish train carries the schema. */
  readonly gifSpeed: number
  readonly speed: number
  readonly profile?: string
}) => Promise<{
  readonly media: readonly EventMediaArtifact[]
  readonly coverage: { readonly fromTs: number; readonly toTs: number }
  readonly profile: string
  readonly video: 'copy' | 'encode'
}>

/** `streamBroker.fetchEventMedia`, PINNED to the artifact's own node. */
export type FetchEventMedia = (
  handle: string,
  nodeId: string,
) => Promise<{ readonly base64: string } | null>

/** `streamBroker.renderPreBufferClip` — the pre-method fallback, one format per
 *  call. The caller passes the SAME window and the SAME profile to both. */
export type RenderRingClip = (input: {
  readonly deviceId: number
  readonly aroundMs: number
  readonly preRollSec: number
  readonly postRollSec: number
  readonly format: 'gif' | 'mp4'
  readonly maxWidth: number
  readonly fps: number
  readonly speed: number
  readonly profile?: string
}) => Promise<Uint8Array | null>

export interface EventMediaServiceDeps {
  readonly logger: IScopedLogger
  readonly produce: ProduceEventMedia
  readonly fetch: FetchEventMedia
  readonly renderRingClip: RenderRingClip
  readonly now?: () => number
}

/**
 * Long side of the gif.
 *
 * 640, against the 480 the notification used to ask for. Measured on a real 101
 * clip: 480 px at 8 fps is 195 KB and 640 px is 324 KB — both far under the
 * smallest cap any notifier declares (pushover's 5 MiB), and the difference is
 * the one an operator notices on a phone.
 */
export const NC_GIF_MAX_WIDTH = 640

/**
 * The gif's PLAYBACK frame rate — 12. Not the number of source frames that go
 * into it: the derive samples `NC_GIF_FPS / NC_GIF_SPEED` = 3 source frames a
 * second and `setpts` turns them into 12 played ones.
 *
 * 12 rather than the 8 the real-time gif used, because it is now sped up: at
 * 4×, a gif that PLAYED at 8 fps would sample 2 source frames a second and read
 * as the slideshow the old 5-at-2× did. 12 keeps it moving and STILL carries
 * fewer frames overall (3/s of source against 8/s), which is why a 4× gif is
 * the smaller file as well as the shorter one.
 */
export const NC_GIF_FPS = 12

/**
 * How fast the notification gif plays: **4×**, by operator request. A ~12 s
 * window is over in ~3 s, which is the amount of attention a lock-screen
 * attachment actually gets.
 *
 * The mp4 now follows at the same rate ({@link DEFAULT_SPEED}) by operator
 * decision, so the two attachments agree on the timeline as well as on the
 * window. The knobs stay SEPARATE regardless: a rule that asks for a real-time
 * video still gets one, and gets the copy branch with it.
 */
export const NC_GIF_SPEED = 4

/**
 * The VIDEO's playback rate — 4×, the same as {@link NC_GIF_SPEED}.
 *
 * This was 1, and the reasoning for 1 was sound as far as it went: `speed !== 1`
 * fails `clipCanCopy`, so a sped-up video cannot be the camera's own H.264
 * copied — it is a `libx264` burst. The OPERATOR priced that and took it. It is
 * one encode per event over a ~12 s window, not a permanent transcode child
 * ([D84](../../../../../../docs/decisions/adr-0084.md) is about the latter), and
 * it was measured on a real 101 720p cut before being chosen: **0.23 s of
 * encode, 254 KB out**, against the 922 KB the copy of the same window carried.
 * The re-encode is smaller than what it replaces.
 *
 * So both attachments now agree on the timeline as well as on the window: one
 * clip, one rate, two containers.
 */
const DEFAULT_SPEED = 4

/** The fallback mp4's requested width — the cap's own ceiling, so a rendition
 *  at or below 1080p is an identity scale and the broker copies it. */
const RING_MP4_MAX_WIDTH = 1920
/** MP4 keeps the source cadence; this only bounds the muxer. The cap caps at 15. */
const RING_MP4_FPS = 15

const NO_MEDIA: EventMedia = {
  mp4: null,
  gif: null,
  source: 'none',
  startOffsetMs: null,
  endOffsetMs: null,
  profile: null,
  video: null,
}

export class EventMediaService {
  constructor(private readonly deps: EventMediaServiceDeps) {}

  /**
   * Cut this event. Never throws — a notification that lost its media is still
   * a notification, and every branch that drops it logs why.
   */
  async cut(request: EventMediaRequest): Promise<EventMedia> {
    if (!request.wantMp4 && !request.wantGif) return NO_MEDIA
    const produced = await this.produce(request)
    if (produced !== null) return produced
    return this.fallbackToRing(request)
  }

  // ── the production path ────────────────────────────────────────────────

  private async produce(request: EventMediaRequest): Promise<EventMedia | null> {
    const deviceId = request.deviceId
    const log = this.deps.logger
    const kinds: EventMediaKind[] = []
    if (request.wantMp4) kinds.push('mp4')
    if (request.wantGif) kinds.push('gif')

    let production: Awaited<ReturnType<ProduceEventMedia>>
    try {
      production = await this.deps.produce({
        deviceId,
        aroundMs: request.aroundMs,
        preSeconds: request.preRollSec,
        postSeconds: request.postRollSec,
        kinds,
        gifMaxWidth: NC_GIF_MAX_WIDTH,
        gifFps: NC_GIF_FPS,
        gifSpeed: NC_GIF_SPEED,
        speed: request.speed ?? DEFAULT_SPEED,
        ...(request.profile !== undefined ? { profile: request.profile } : {}),
      })
    } catch (err) {
      // Two very different causes, one branch on purpose: a hub that predates
      // the method (404) and a camera whose ring does not cover the moment both
      // mean "the production point could not serve this", and both fall back.
      // The MESSAGE is what tells them apart, so it is carried verbatim.
      log.warn(
        'nc media: the broker could not produce this event — falling back to the clip ring',
        {
          tags: { deviceId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      )
      return null
    }

    const mp4 = await this.redeem(deviceId, production.media, 'mp4')
    const gif = await this.redeem(deviceId, production.media, 'gif')
    if (mp4 === null && gif === null) {
      log.warn('nc media: the production carried no artifact — falling back to the clip ring', {
        tags: { deviceId },
        meta: { kinds: kinds.join(','), profile: production.profile },
      })
      return null
    }
    const startOffsetMs = production.coverage.fromTs - request.aroundMs
    const endOffsetMs = production.coverage.toTs - request.aroundMs
    log.info('nc media: one production, every attachment', {
      tags: { deviceId },
      meta: {
        profile: production.profile,
        video: production.video,
        mp4Bytes: mp4?.byteLength ?? null,
        gifBytes: gif?.byteLength ?? null,
        // The number the operator's report was about. NEGATIVE means the media
        // starts BEFORE the event — the whole point of the exercise.
        startOffsetMs,
        endOffsetMs,
        // Stated rather than implied: both attachments below came out of one
        // window of one rendition.
        sharedWindow: true,
      },
    })
    return {
      mp4,
      gif,
      source: 'produced',
      startOffsetMs,
      endOffsetMs,
      profile: production.profile,
      video: production.video,
    }
  }

  /**
   * Redeem one artifact handle at the node that produced it.
   *
   * `null` is not an error here — a production simply may not carry the kind
   * (a gif whose derive failed says so on the broker's own log line). A handle
   * that FAILS to redeem is different and is logged, because it means the bytes
   * existed and did not arrive.
   */
  private async redeem(
    deviceId: number,
    media: readonly EventMediaArtifact[],
    kind: EventMediaKind,
  ): Promise<Uint8Array | null> {
    const artifact = media.find((m) => m.kind === kind)
    if (artifact === undefined) return null
    try {
      const res = await this.deps.fetch(artifact.handle, artifact.nodeId)
      if (res === null) {
        this.deps.logger.warn('nc media: an artifact handle expired before it could be fetched', {
          tags: { deviceId },
          meta: { kind, handle: artifact.handle, nodeId: artifact.nodeId },
        })
        return null
      }
      const buf = Buffer.from(res.base64, 'base64')
      if (buf.byteLength === 0) return null
      const bytes = new Uint8Array(buf.byteLength)
      bytes.set(buf)
      return bytes
    } catch (err) {
      this.deps.logger.warn('nc media: fetching an artifact failed — that attachment is dropped', {
        tags: { deviceId },
        meta: {
          kind,
          handle: artifact.handle,
          nodeId: artifact.nodeId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return null
    }
  }

  // ── the fallback ───────────────────────────────────────────────────────

  /**
   * The pre-`produceEventMedia` path: `renderPreBufferClip`, once per container.
   *
   * Weaker than a production and deliberately so — the coherence here rests on
   * the two calls being given IDENTICAL parameters rather than on there being
   * one render. That is defensible because the ring only ever grows forward and
   * `windowAround` selects by wall clock around the same instant, so two calls
   * seconds apart choose the same packets; the one thing that could differ is
   * the rendition, so the profile is pinned to whatever the FIRST call actually
   * used and handed to the second.
   *
   * It exists for one reason: a hub whose `@camstack/server` predates the
   * production method must not stop attaching footage, and three of the four
   * live rules on this install ask for a gif and nothing else.
   */
  private async fallbackToRing(request: EventMediaRequest): Promise<EventMedia> {
    const deviceId = request.deviceId
    const speed = request.speed ?? DEFAULT_SPEED
    const window = {
      deviceId,
      aroundMs: request.aroundMs,
      preRollSec: request.preRollSec,
      postRollSec: request.postRollSec,
      speed,
      ...(request.profile !== undefined ? { profile: request.profile } : {}),
    }
    try {
      // The video FIRST when it is wanted: it is the call that arms the
      // broker's retention on the preferred rendition, so the gif behind it
      // reads the same ring.
      const mp4 = request.wantMp4
        ? await this.deps.renderRingClip({
            ...window,
            format: 'mp4',
            // The widest the cap will take. On a 1280-wide rendition this is an
            // identity scale, which is what makes the broker COPY instead of
            // re-encoding to `libx264 -crf 28`.
            maxWidth: RING_MP4_MAX_WIDTH,
            fps: RING_MP4_FPS,
          })
        : null
      const gif = request.wantGif
        ? await this.deps.renderRingClip({
            ...window,
            format: 'gif',
            maxWidth: NC_GIF_MAX_WIDTH,
            // The ring renderer's `fps` is the SOURCE sampling rate, not the
            // playback one the production path takes, so the division is done
            // here: 3 sampled frames a second played at 4× is the same 12 fps
            // gif. Getting this wrong makes the fallback gif four times the
            // frames of the produced one for no visible gain.
            fps: NC_GIF_FPS / NC_GIF_SPEED,
            // The gif's rate, not the rule's — same reason as the produced path.
            speed: NC_GIF_SPEED,
          })
        : null
      if ((mp4 === null || mp4.byteLength === 0) && (gif === null || gif.byteLength === 0)) {
        this.deps.logger.warn('nc media: the clip ring covered nothing — no footage attached', {
          tags: { deviceId },
          meta: { aroundMs: request.aroundMs },
        })
        return NO_MEDIA
      }
      this.deps.logger.info('nc media: served by the clip-ring FALLBACK', {
        tags: { deviceId },
        meta: {
          mp4Bytes: mp4?.byteLength ?? null,
          gifBytes: gif?.byteLength ?? null,
          profile: request.profile ?? null,
          // Same window, same profile for both calls — the rates differ on
          // purpose (the gif is 4×) and do not select packets. Coherence by
          // construction is the PRODUCTION path; this is coherence by
          // discipline, and saying which one served is how they stay
          // distinguishable in a report.
          sharedWindow: 'by-parameters',
        },
      })
      return {
        mp4: mp4 !== null && mp4.byteLength > 0 ? mp4 : null,
        gif: gif !== null && gif.byteLength > 0 ? gif : null,
        source: 'ring-fallback',
        // The ring selects by wall clock around the moment, so the window it
        // covers is the one that was asked for.
        startOffsetMs: -Math.max(0, request.preRollSec) * 1000,
        endOffsetMs: Math.max(0, request.postRollSec) * 1000,
        profile: request.profile ?? null,
        video: null,
      }
    } catch (err) {
      this.deps.logger.warn('nc media: the clip ring failed too — this event ships no footage', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return NO_MEDIA
    }
  }
}
