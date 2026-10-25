/**
 * The broker half of `streamBroker.acquireEgressTranscode` — THE ffmpeg
 * primitive's acquire / refcount / release.
 *
 * D67 landed the primitive's argv builder, its lifecycle wrapper, its schema,
 * its sharing key and its immutability rule, and codegen'd the router. It did
 * not land this: the method was declared and callable and had no body. This is
 * the body.
 *
 * ## What it guarantees
 *
 * **Exact-match sharing, never fuzzy.** Two requests whose
 * `egressTranscodeSharingKey` agree reach the same child and the same
 * `pipelineKey`. Two that differ by one field reach two children, and that is
 * accepted: the operator was explicit that several processes are fine
 * ("it's fine to have several processes — what's needed is a single convenient
 * primitive for accessing ffmpeg"). Merging nearly-identical requests onto a
 * quantised ladder would make the stream a consumer receives a function of who
 * else is watching and in what order they arrived.
 *
 * **An IMMUTABLE handle.** There is no `reconfigure` and this class exposes no
 * way to change a live entry's parameters. A consumer whose requirements change
 * releases and re-acquires; the refcount does the rest. A mutable shared handle
 * is exactly what made Alexa's `derived:alexa-<id>` a co-tenant hazard — one
 * consumer's downgrade dragged every co-tenant to 360p.
 *
 * ## Placement — why this is a CAPABILITY and not an internal module
 *
 * `stream-broker` is `placement: "any-node"`, and `classifyCapRoute` gives
 * Priority 1 to `hub-in-process`, so an unpinned `acquireEgressTranscode` never
 * leaves the hub. Placement is a CALLER-side `nodePin(nodeId)`, exactly as the
 * recorder and pipeline-runner already pin their broker calls. Nothing in this
 * file may assume hub-locality: the source url is resolved from THIS node's
 * restream registry and the returned url is host-substituted for the caller.
 * What still has to be true before a transcode genuinely runs off-hub is in
 * `docs/decisions/adr-0067.md`.
 *
 * ## Three transports, and they never share a child
 *
 * `publishLocally` selects between a PUSH child (MPEG-TS, demuxed straight into
 * a published cam stream, no restreamer at all) and a DIAL child (elementary
 * Annex-B into a restreamer the consumer dials). It is part of the sharing key,
 * because with it excluded whoever acquired FIRST decided the transport for
 * every later sharer with the same encode parameters.
 *
 * The third is FRAGMENTS: a fragmented-MP4 byte stream cut into an
 * initialisation segment plus `moof`+`mdat` units and fanned out on an
 * in-process {@link Fmp4FragmentPlane}. It has no url and no cam stream — the
 * consumer holds an object — and it is reached through
 * {@link EgressTranscodeManager.acquireFragments}, NOT through the cap.
 * `egressTransportFromRequest` can never name it, so the cap path cannot be
 * handed a fragment child by accident. Its consumers are HKSV's recording
 * delegate (phase 4) and a CamStack clip source (roadmap 4b half 2), both
 * in-process; a `fragmentMs` on the request schema would be a codegen run and a
 * `@camstack/system` train for a field nothing off-node can call. When one of
 * them lands off-node, the field goes on the schema and
 * `egressTransportFromRequest` is the single place that learns to read it.
 *
 * Each transport carries audio on its own plane: the dial child on an RTP
 * SIDECAR whose SDP is grafted onto the one the consumer negotiates, the push
 * and fragment children IN-BAND as AAC (MPEG-TS's demuxer maps aac/mp2/ac3 and
 * NOT Opus; HKSV accepts only AAC-LC / AAC-ELD). See
 * {@link EgressTranscodeManager.resolveAudioPlane}.
 *
 * ## The refcount's three boundaries
 *
 * 1. **A re-acquire inside the stop grace** revives the entry. The window
 *    between "last holder released" and "child killed" is precisely when a
 *    consumer that released to change one parameter comes back; respawning
 *    there costs a source dial and a keyframe wait for nothing.
 * 2. **The last release racing an acquire.** {@link shutdownEntry} removes the
 *    entry from the map SYNCHRONOUSLY, before it awaits `stop()`. An acquire
 *    that interleaves therefore either finds a live entry (and revives it) or
 *    finds none (and creates a fresh child) — it can never be handed a corpse.
 * 3. **A child that DIES.** {@link EgressTranscodeManager.onChildDied} removes
 *    the entry on the same synchronous rule, so one bad spawn stops being
 *    permanent for every session that follows it.
 *
 * ## The boundary this does NOT close, stated plainly
 *
 * **A consumer that dies without releasing leaks a refcount.** There is no
 * lease TTL and no heartbeat; the entry lives until something calls
 * `releaseEgressTranscode` or the broker process restarts
 * ({@link shutdownAll}). That is benign on one host — the child is a local
 * ffmpeg an operator can see in the broker panel — and it stops being benign
 * the moment the holder is on another node, which is the same condition that
 * gates a transcode running off-hub at all. Recorded in D67's "what is NOT true
 * yet" rather than half-fixed here: a TTL a consumer does not renew kills a
 * working stream, and there is no renew method to build it on.
 */

import { randomUUID } from 'node:crypto'
import type {
  EncodedPacket,
  PushAudioInfo,
  CameraStream,
  CamProfile,
  EgressTranscode,
  EgressTranscodeRequest,
  EgressTransport,
  EgressTransportPlan,
  FfmpegInvocation,
  FfmpegRateControl,
  IScopedLogger,
} from '@camstack/types'
import {
  AUDIO_PRESETS,
  egressTranscodeSharingKey,
  egressTransportFromRequest,
  errMsg,
  invocationFromEncodeProfile,
  isSoftwareDecode,
  makeSourceBrokerId,
  RATE_CONTROL_RELAXED,
  RATE_CONTROL_TIGHT,
} from '@camstack/types'
import type { AudioEncode } from '@camstack/types'
import { NO_COST_CLAIM, type ChildCostRegistry } from '@camstack/types/node'
import type { AudioSidecarCodec, FfmpegSystemConfig } from './ffmpeg-invocation.js'
import {
  defaultFfmpegSpawn,
  requireBrokerFfmpeg,
  toAudioSidecarCodec,
} from './ffmpeg-invocation.js'
import { FfmpegPushReader, type FfmpegPushReaderCallbacks } from '../rtsp/ffmpeg-push-reader.js'
import { buildFfmpegArgs } from '@camstack/types'
import {
  decideEgressCopy,
  type EgressCopyDecision,
  type EgressSourceFacts,
} from './egress-copy-decision.js'
// The fMP4 transport is a PRIMITIVE, not a broker feature: `addon-export-hap`
// needs the identical splitter/plane/child in a different runner, and the
// alternative was a second copy of it there (D84).
import { Fmp4FragmentChild, Fmp4FragmentPlane } from '@camstack/types/node'
import { isDecodeBackendFailure } from './decode-failure-attribution.js'
import { deliveredGeometry } from './egress-geometry.js'
import { waitForSourceMedia } from './egress-source-readiness.js'
import { substituteRtspHost } from './rtsp-host.js'
import { type EgressChannel, TranscodeEgress } from './transcode-egress.js'

/**
 * One running egress, reduced to what the manager needs. `TranscodeEgress` is
 * the production implementation; a test substitutes a fake so the refcount and
 * sharing behaviour are exercised without ffmpeg or sockets.
 */
export interface EgressChild {
  /** Spawn, and resolve with the dialable consumer url once bytes flow. */
  start(): Promise<string>
  stop(): Promise<void>
  /** The backend the child ACTUALLY decoded with — `null` for software. */
  decodeHwAccel(): string | null
  /**
   * Whether a fall back to software is the DECODE BACKEND's fault.
   *
   * `false` means the child died before it ever reached a decoder — an input
   * that was not there, a source that had not materialised — and the backend
   * must not be quarantined for it. Optional because a child that cannot tell
   * the difference says nothing, and silence keeps the old behaviour: blame.
   */
  hwAccelAtFault?(): boolean
}

/** Everything a child needs, resolved. Handed to {@link EgressTranscodeManagerOptions.createChild}. */
export interface EgressChildSpec {
  readonly brokerId: string
  /**
   * The camera this egress belongs to. Carried so every line the child logs can
   * be grouped per-camera — a media gap is always asked as "why is 102 worse
   * than 101?", and a line without the tag cannot answer it.
   */
  readonly deviceId: number
  readonly targetCodec: 'H264' | 'H265'
  readonly invocation: Omit<FfmpegInvocation, 'sink' | 'audioSidecar'>
  /**
   * What {@link EgressChild.start} resolves with. For a DIAL child this is the
   * channel's restream url; for a PUSH child there is no channel and this is
   * the deliberately non-dialable {@link pushOnlyUrl} — see {@link channel}.
   */
  readonly consumerUrl: string
  /**
   * The restreamer a DIAL consumer connects to. Absent for a push child: the
   * channel is a registered listen-server object, and once the sharing key
   * learned about the transport no dial consumer can ever reach a push child,
   * so minting one would register a restreamer that serves nobody and is fed
   * by nothing.
   */
  readonly channel?: EgressChannel
  /**
   * The RTP audio SIDECAR, for the dial transport only. `TranscodeEgress` binds
   * a UDP RTP receiver, forwards each datagram to the restreamer and grafts
   * ffmpeg's `m=audio` block onto the push-mode SDP — which only means
   * something to a consumer that dials that SDP. A push child carries its audio
   * IN-BAND instead; see {@link EgressTranscodeManager.createPushChild}.
   */
  readonly audio?: { readonly codec: AudioSidecarCodec }
  /**
   * When present the child emits MPEG-TS and its demuxed packets go straight
   * here — the derived mechanism's exact shape — instead of raw stdout chunks
   * into a restreamer the consumer then has to dial.
   */
  readonly pushSink?: EgressPushSink
  /** The id the push sink published, for the diagnostics that follow it. */
  readonly publishedCamStreamId?: string
  /**
   * When present the child emits a fragmented MP4 and its units go onto this
   * plane. No restreamer, no cam stream, no url — the consumer holds the plane.
   */
  readonly fragments?: {
    readonly fragmentMs: number
    readonly plane: Fmp4FragmentPlane
  }
  /**
   * Called when the child dies AFTER it started. The manager un-registers the
   * entry so the next acquire spawns a fresh child instead of sharing a corpse.
   * A hardware→software retry inside `start()` is NOT a death and must not
   * call this.
   */
  readonly onDied?: (error: Error) => void
}

type CameraStreamLookup = (deviceId: number) => readonly CameraStream[]
type ProfileSourceLookup = (deviceId: number, profile: CamProfile) => string | null
type RtspEntryLookup = (brokerId: string) => { url: string } | null
type AcquireChannelFn = (brokerId: string) => EgressChannel

/**
 * A LOCAL push destination for an egress transcode.
 *
 * Feeding one of these is the difference between the transport that renders and
 * the one that does not. Dialling the egress url republishes it as an RTP
 * source, which routes the consumer down the RTP-passthrough branch; pushing
 * access units into a broker takes the deframe branch the derived mechanism has
 * live hours on.
 */
export interface EgressPushSink {
  push: (packet: EncodedPacket) => void
  audioInfo: (info: PushAudioInfo) => void
  videoCodec: (codec: string) => void
  release: () => Promise<void>
}

/** The demux callbacks a push reader drives — `FfmpegPushReader`'s contract. */
export type PushReaderCallbacks = FfmpegPushReaderCallbacks

/**
 * The reader surface the push child drives. Production builds an
 * {@link FfmpegPushReader}; a test substitutes a fake so the hardware→software
 * retry, the liveness removal and the argv are exercised without ffmpeg.
 */
export interface PushReader {
  connect(): void
  destroy(): void
}

export type PushReaderFactory = (input: {
  readonly args: readonly string[]
  readonly callbacks: PushReaderCallbacks
}) => PushReader

export interface EgressTranscodeManagerOptions {
  readonly logger: IScopedLogger
  readonly cameraStreamLookup: CameraStreamLookup
  readonly resolveProfileSource: ProfileSourceLookup
  readonly rtspEntryLookup: RtspEntryLookup
  /**
   * Whether the SOURCE broker is carrying media right now: `true` yes, `false`
   * not yet, `null` nobody could answer (no such broker). Absent ⇒ the wait is
   * skipped entirely.
   *
   * See `egress-source-readiness.ts` for the failure this answers.
   */
  readonly sourceHasMedia?: (brokerId: string) => boolean | null
  /** Overrides {@link INPUT_RETRY_DELAY_MS}. Tests only — a real wake is slow. */
  readonly inputRetryDelayMs?: number
  readonly acquireChannel: AcquireChannelFn
  readonly ffmpegConfig: () => FfmpegSystemConfig
  /**
   * Called when a child is refused for want of the pinned ffmpeg — the host
   * starts its one shared, bounded re-resolve (`FfmpegReresolver`). Absent in a
   * spec that does not care.
   */
  readonly onFfmpegMissing?: () => void
  /**
   * The DECODER ADDON's answer for this node, through
   * `resolveEgressDecodeHwAccel` — never the kernel resolver's qsv-first order,
   * which is the known-bad one on this hardware. `null` ⇒ software, and the
   * caller has already announced it at `warn`.
   */
  readonly resolveDecodeHwAccel: (
    deviceId: number,
    override: string | undefined,
  ) => Promise<string | null>
  /** Seconds of grace before a zero-refcount child is killed. */
  readonly releaseGraceMs?: number
  readonly spawnFn?: import('./ffmpeg-invocation.js').FfmpegSpawnFn
  /**
   * The addon's child-cost registry. Each transcode child is one camera's
   * ffmpeg (the sharing key excludes the session, so two browsers on one
   * camera at one tier share one child), so the claim taken here is a true
   * per-camera cost. Absent in tests and in a runner whose addon registered no
   * registry — the child is then simply unclaimed.
   */
  readonly costRegistry?: ChildCostRegistry
  /**
   * Publish a local push cam stream for `publishAs` and return its sink.
   * Absent (or returning null) means the consumer must dial the url.
   */
  readonly publishPushStream?: (input: {
    deviceId: number
    camStreamId: string
    codec: string
    width: number
    height: number
  }) => Promise<EgressPushSink | null>
  /** Injected by tests; production builds a {@link TranscodeEgress}. */
  readonly createChild?: (spec: EgressChildSpec) => EgressChild
  /** Injected by tests; production builds an {@link FfmpegPushReader}. */
  readonly createPushReader?: PushReaderFactory
  /**
   * How long a push child may produce NOTHING before it is declared dead and
   * (once) retried in software. A child that exits announces itself sooner —
   * this bounds the case where it hangs instead.
   */
  readonly pushFirstPacketTimeoutMs?: number
  /**
   * The same bound for a FRAGMENT child, measured to the first cut UNIT rather
   * than the first byte — bytes that never parse are a child that will never
   * produce a fragment.
   */
  readonly fragmentFirstUnitTimeoutMs?: number
  /**
   * A decode backend that could not produce a single packet HERE. The broker
   * memoises `resolveDecodeHwAccel` for a minute, so without this every child
   * spawned in that window pays the same death before its own retry.
   *
   * Reported for BOTH transports: `TranscodeEgress` retries internally, and the
   * manager compares what it asked for against what the child says actually
   * ran.
   */
  readonly onDecodeHwAccelFailed?: (backend: string) => void
  /**
   * A decode backend that DID produce packets here. The twin of
   * {@link onDecodeHwAccelFailed}, and it is not decoration: the broker widens
   * a failed backend's quarantine on every consecutive failure, and without a
   * success signal a backend that recovers stays on a six-hour ladder it no
   * longer deserves.
   */
  readonly onDecodeHwAccelSucceeded?: (backend: string) => void
}

interface EgressEntry {
  readonly key: string
  readonly deviceId: number
  readonly child: EgressChild
  /** The hub-local url. Host substitution is per-CALLER, never baked in here. */
  readonly localUrl: string
  /**
   * `false` for a push child, whose url is a documented non-dialable sentinel.
   * Rewriting its host for a remote caller would turn "obviously not a url" into
   * something that looks dialable and is not.
   */
  readonly dialable: boolean
  readonly handle: EgressTranscode
  /** Non-null for the `fragments` transport — what its consumers subscribe to. */
  readonly fragments: Fmp4FragmentPlane | null
  refcount: number
  releaseTimer: NodeJS.Timeout | null
}

/** What {@link EgressTranscodeManager.acquireFragments} hands back. */
export interface EgressFragmentHandle {
  /** The release handle — the SAME `releaseEgressTranscode` refcount. */
  readonly pipelineKey: string
  /** Subscribe here. One plane, N consumers (roadmap 4b: HKSV plus clips). */
  readonly plane: Fmp4FragmentPlane
  /** The decode backend the child ACTUALLY ran with — `null` for software. */
  readonly decodeHwAccel: string | null
  /**
   * `false` when the child ended up on the smart-COPY branch, where there is no
   * encoder to pin a key-frame grid on and `fragmentMs` degrades from a target
   * to a floor. A consumer that promised its own peer a fragment length needs
   * to know which of the two it got.
   */
  readonly fragmentLengthEnforced: boolean
}

export interface EgressFragmentRequest {
  /**
   * The encode half, exactly as the cap describes it. `publishLocally` is
   * ignored: a fragment child has no cam stream to publish.
   */
  readonly encode: EgressTranscodeRequest
  /**
   * The negotiated fragment length. HKSV negotiates this per stream, so it is
   * part of the sharing key — two consumers that agreed different lengths are
   * asking for differently-cut media.
   */
  readonly fragmentMs: number
}

/**
 * The source stream, in the two shapes this file needs it: DEFAULTED values the
 * argv builder and the handle can always print, and the UNDEFAULTED
 * {@link EgressSourceFacts} a copy decision is judged against. Keeping them
 * apart is the whole point — a default that satisfies a constraint would ship a
 * copy nobody measured.
 */
interface ResolvedEgressSource {
  /** The SOURCE broker this url restreams — the thing to wait on. */
  readonly brokerId: string
  readonly url: string
  readonly codec: 'h264' | 'h265'
  readonly width: number
  readonly height: number
  readonly facts: EgressSourceFacts
}

const DEFAULT_RELEASE_GRACE_MS = 5_000

/**
 * How long an egress child waits for its source to carry media before it is
 * spawned anyway. Sized against the measured cold open of a lazy publisher on
 * this hub (12.4 s on the wyze bridge, 5.5 s on the camera that produced the
 * mis-attributed VAAPI death) with margin — and bounded, because the wait is
 * never a refusal and a source that is genuinely dead must not hold a consumer
 * past the point where its own client has given up.
 */
const SOURCE_MEDIA_WAIT_MS = 15_000

/** Poll cadence for that wait. Flat, for the reason a materialize poll is. */
const SOURCE_MEDIA_POLL_MS = 250

/**
 * How long to wait before re-dialling a source whose input was not there.
 *
 * The first spawn is what WAKES a lazy publisher, and the measured wake on this
 * hub lands between 2.2 s and 7.8 s (`materializeMs`). Three seconds is inside
 * that band: long enough that a quick wake is already serving, short enough
 * that the second attempt still beats the consumer's own patience.
 */
const INPUT_RETRY_DELAY_MS = 3_000

/** After the first three, log one keyframe in this many. */
const KEYFRAME_LOG_EVERY = 25

/**
 * How long a push child may produce nothing before it is declared dead. The
 * observed failure EXITS in ~2 s and is caught by the error path long before
 * this; the timeout only covers a child that hangs.
 */
const DEFAULT_PUSH_FIRST_PACKET_TIMEOUT_MS = 8_000

/**
 * The url of a PUSH child, which is not dialable and is not meant to be.
 *
 * The consumer of a push child attaches by `camStreamId`; the response schema
 * still requires a string, so it gets one that cannot be mistaken for a
 * restream url. It is not an `rtsp://` address on purpose: a plausible-looking
 * url that nothing feeds is how "everything connected and the screen is black"
 * happens, and that already cost a session here.
 */
export function pushOnlyUrl(camStreamId: string): string {
  return `camstack-egress-push:${camStreamId}`
}

/**
 * The url of a FRAGMENTS child, which is not a url. Same reasoning as
 * {@link pushOnlyUrl}: the handle shape requires a string, its consumer holds a
 * plane object, and a plausible-looking `rtsp://` that nothing feeds is how
 * "everything connected and the screen is black" happens.
 */
export function fragmentsOnlyUrl(pipelineKey: string): string {
  return `camstack-egress-fragments:${pipelineKey}`
}

/** Heartbeat cadence for the push child's packet counter. ~10s of 25fps video. */
const PUSH_PACKET_LOG_EVERY = 250

const RATE_CONTROLS: Readonly<Record<'tight' | 'relaxed', FfmpegRateControl>> = {
  tight: RATE_CONTROL_TIGHT,
  relaxed: RATE_CONTROL_RELAXED,
}

/**
 * Publisher codec strings are inconsistent (`H.265` / `hevc` / `hvc1`).
 *
 * Exported so the PMT-identified codec and the DECLARED one are compared
 * through the one normalisation — two spellings of the same codec must not read
 * as a mismatch, and a real mismatch must not hide behind a spelling.
 */
export function normaliseSourceCodec(codec: string | undefined): 'h264' | 'h265' {
  const c = (codec ?? '').toLowerCase().replace(/[.\s-]/g, '')
  return c === 'h265' || c === 'hevc' || c === 'hvc1' || c === 'hev1' ? 'h265' : 'h264'
}

export class EgressTranscodeManager {
  private readonly entries = new Map<string, EgressEntry>()
  /** In-flight starts, keyed by sharing key — concurrent acquires share one. */
  private readonly pending = new Map<string, Promise<EgressEntry>>()
  private readonly releaseGraceMs: number

  /** Live egress transcodes (ffmpeg children), for the `[broker-mem]` probe. */
  activeCount(): number {
    return this.entries.size
  }

  constructor(private readonly opts: EgressTranscodeManagerOptions) {
    this.releaseGraceMs = opts.releaseGraceMs ?? DEFAULT_RELEASE_GRACE_MS
  }

  /**
   * Acquire an encoded stream matching `request`, sharing an existing child on
   * an EXACT match. The returned `pipelineKey` is the release handle.
   */
  async acquire(request: EgressTranscodeRequest): Promise<EgressTranscode> {
    const delivery = egressTransportFromRequest(request)
    const key = egressTranscodeSharingKey(request, delivery)
    return this.dial(this.share(await this.entryFor(key, request, delivery)), request.hostname)
  }

  /**
   * Acquire a live fMP4 FRAGMENT plane — the media surface HKSV's recording
   * delegate needs, and (roadmap 4b) the one a CamStack clip source attaches to
   * alongside it. Same map, same refcount, same software retry, same liveness
   * removal as the other two transports; released through the same
   * {@link release}.
   *
   * In-process only, by construction: a plane is a live object and cannot cross
   * the cap boundary. Nothing calls this yet — phases 3-4 do.
   */
  async acquireFragments(request: EgressFragmentRequest): Promise<EgressFragmentHandle> {
    const delivery: EgressTransportPlan = {
      transport: 'fragments',
      fragmentMs: request.fragmentMs,
    }
    const key = egressTranscodeSharingKey(request.encode, delivery)
    const entry = this.share(await this.entryFor(key, request.encode, delivery))
    if (entry.fragments === null) {
      // Unreachable by construction — the transport is in the sharing key, so a
      // `fragments` key can only reach a child built with a plane — and stated
      // rather than asserted with `!`, which would turn a wiring mistake into a
      // null dereference inside a consumer's generator.
      throw new Error(`acquireEgressFragments: entry ${key} has no fragment plane`)
    }
    return {
      pipelineKey: key,
      plane: entry.fragments,
      decodeHwAccel: entry.handle.decodeHwAccel,
      // `transcoded` is false exactly on the smart-copy branch, where no
      // `-force_key_frames` grid exists and the source's GOP decides.
      fragmentLengthEnforced: entry.handle.transcoded,
    }
  }

  /**
   * The entry for `key` — shared, awaited, or newly started. Every branch
   * returns an entry that has NOT yet been referenced; {@link share} is the one
   * place a refcount goes up, so a path that forgets it cannot exist.
   */
  private async entryFor(
    key: string,
    request: EgressTranscodeRequest,
    delivery: EgressTransportPlan,
  ): Promise<EgressEntry> {
    const existing = this.entries.get(key)
    if (existing) return existing

    const inflight = this.pending.get(key)
    if (inflight) return inflight

    const start = this.startChild(key, request, delivery)
    this.pending.set(key, start)
    try {
      return await start
    } finally {
      // Cleared whether it resolved or REJECTED: a failed start must not leave
      // a settled-rejected promise that every later acquire re-awaits forever,
      // which would make one bad spawn permanent for the life of the broker.
      this.pending.delete(key)
    }
  }

  /** Drop one reference. The child dies when the last holder releases. */
  async release(input: { pipelineKey: string }): Promise<{
    released: boolean
    refcount: number
  }> {
    const entry = this.entries.get(input.pipelineKey)
    if (!entry) {
      // A stale handle from before a broker respawn is normal, not a fault —
      // and a throw here would leave the CALLER's bookkeeping inconsistent on a
      // path it has no way to retry.
      this.opts.logger.debug('egress transcode: release of an unknown handle', {
        meta: { pipelineKey: input.pipelineKey },
      })
      return { released: false, refcount: 0 }
    }

    if (entry.refcount === 0) {
      // A second release of a handle already at zero is a bookkeeping bug in
      // the CONSUMER, and it is the twin of the leak this primitive cannot yet
      // close: one leaves a child running forever, the other kills a child
      // another holder is still watching. Neither is silent.
      this.opts.logger.warn(
        'egress transcode: DOUBLE release — the handle already had no holders',
        {
          tags: { deviceId: entry.deviceId },
          meta: { pipelineKey: entry.key },
        },
      )
      return { released: false, refcount: 0 }
    }

    entry.refcount -= 1
    this.opts.logger.info('egress transcode: released', {
      tags: { deviceId: entry.deviceId },
      meta: { pipelineKey: entry.key, refcount: entry.refcount },
    })
    if (entry.refcount > 0) return { released: true, refcount: entry.refcount }

    if (entry.releaseTimer) clearTimeout(entry.releaseTimer)
    entry.releaseTimer = setTimeout(() => {
      const current = this.entries.get(entry.key)
      // A consumer may have re-acquired inside the grace — `share` cleared the
      // timer, but a timer already queued still fires, so re-read the refcount.
      if (!current || current.refcount > 0) return
      void this.shutdownEntry(current)
    }, this.releaseGraceMs)
    entry.releaseTimer.unref?.()
    return { released: true, refcount: 0 }
  }

  /**
   * Stop every child. The one mitigation available for a holder that died
   * without releasing: a leaked refcount never outlives the broker process.
   */
  async shutdownAll(): Promise<void> {
    const all = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(all.map((entry) => this.shutdownEntry(entry, false)))
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async startChild(
    key: string,
    request: EgressTranscodeRequest,
    delivery: EgressTransportPlan,
  ): Promise<EgressEntry> {
    const deviceId = request.deviceId
    const source = this.resolveSource(request)
    const cfg = this.opts.ffmpegConfig()
    const decodeHwAccel = await this.opts.resolveDecodeHwAccel(deviceId, request.decodeHwAccel)
    const fragments = delivery.transport === 'fragments'

    // Local publication, when the consumer asked for it. Doing this BEFORE the
    // child starts means the broker exists to receive the first packet rather
    // than dropping it while a publish is in flight.
    // The broker names the stream, from its OWN sharing key, so two consumers
    // that dedupe onto one child also land on one published stream.
    const publishedCamStreamId = `egress:${key.replace(/^egress:/, '')}`
    // What the child will REALLY deliver. The scale filter is `min(<asked>,iw)`
    // — it has never upscaled — but the published record carried what was
    // ASKED, so a 640×360 stream was advertised to the cluster as 1280×720 and
    // `pickStream` offered it at that size (device 106, 2026-09-13).
    const delivered = deliveredGeometry({
      requestedWidth: request.encode.video.width,
      requestedHeight: request.encode.video.height,
      // The undefaulted truth, never `source.width/height` — those carry a
      // 1280×720 GUESS for the argv builder when the resolution could not be
      // read, and capping against a guess would shrink a healthy stream.
      sourceWidth: source.facts.width,
      sourceHeight: source.facts.height,
    })
    const pushSink =
      fragments || request.publishLocally !== true || this.opts.publishPushStream === undefined
        ? null
        : await this.opts.publishPushStream({
            deviceId,
            camStreamId: publishedCamStreamId,
            codec: request.encode.video.codec,
            // A profile may leave the geometry to the source; the published
            // record then carries 0 rather than a number invented here, and a
            // consumer reading 0 knows it was never stated.
            width: delivered.width ?? 0,
            height: delivered.height ?? 0,
          })
    if (request.publishLocally === true && pushSink === null && !fragments) {
      // The consumer will fall back to dialling the url, which works but takes
      // the RTP-passthrough branch. Silence would make that look deliberate.
      this.opts.logger.warn(
        'egress transcode: local publication REFUSED — the consumer must dial the url',
        {
          tags: { deviceId },
          meta: { pipelineKey: key, camStreamId: publishedCamStreamId },
        },
      )
    }

    const audio = this.resolveAudioPlane(key, request, delivery.transport)
    const copyDecision = this.decideCopy(key, request, source)
    // The key-frame grid the fragment length rides on. Absent on the copy
    // branch by construction — there is no encoder to instruct — which is what
    // `fragmentLengthEnforced` reports back to the consumer.
    const fragmentSeconds = fragments ? (delivery.fragmentMs ?? 0) / 1000 : undefined

    const full: FfmpegInvocation = invocationFromEncodeProfile({
      // The DELIVERED geometry, not the asked one: `min(<asked>,iw)` already
      // produced this, and stating it here is what makes the argv, the record
      // and the picture agree instead of two of the three.
      profile: {
        video: { ...request.encode.video, ...delivered },
        audio: audio.profileAudio,
      },
      sourceCodec: source.codec,
      sourceUrl: source.url,
      decodeHwAccel,
      // Not the derived stream's unconditional re-encode: a request is a set of
      // CONSTRAINTS, and re-encoding a source that already satisfies every one
      // of them buys nothing. `decideCopy` is conservative — any unknown source
      // fact means encode — and it has already logged which knob decided.
      forceReencode: !copyDecision.copy,
      hardwareEncoders: false,
      logLevel: 'warning',
      threadCount: cfg.threadCount,
      rateControl: RATE_CONTROLS[request.rateControl ?? 'relaxed'],
      ...(request.bitstreamFilter !== undefined
        ? { bitstreamFilter: request.bitstreamFilter }
        : {}),
      ...(request.pixelFormat !== undefined ? { pixelFormat: request.pixelFormat } : {}),
      ...(fragmentSeconds !== undefined ? { forceKeyFramesSeconds: fragmentSeconds } : {}),
      // The sink and the sidecar belong to the child, which allocates them.
      sink: { kind: 'stdout', container: 'h264' },
    })
    const { sink: _sink, audioSidecar: _audioSidecar, ...plan } = full

    const targetCodec: 'H264' | 'H265' = request.encode.video.codec === 'h265' ? 'H265' : 'H264'
    const brokerId = `egress:${deviceId}:${randomUUID().slice(0, 8)}`
    const plane = fragments ? new Fmp4FragmentPlane(this.opts.logger.child('egress-fmp4')) : null
    // Neither a push nor a fragment child has a restreamer: nothing feeds it,
    // and after the sharing key learned about the transport no dial consumer
    // can share one.
    const channel = pushSink === null && plane === null ? this.opts.acquireChannel(brokerId) : null
    const consumerUrl =
      channel !== null
        ? channel.consumerUrl
        : plane !== null
          ? fragmentsOnlyUrl(key)
          : pushOnlyUrl(publishedCamStreamId)
    // The source, BEFORE the child. Spawning ffmpeg against a loopback whose
    // publisher has not materialised is a death on the input that costs the
    // whole process its hardware decode (see `egress-source-readiness.ts`).
    await this.awaitSourceMedia(deviceId, key, source)

    const child = this.createChild({
      brokerId,
      deviceId,
      targetCodec,
      invocation: plan,
      consumerUrl,
      ...(channel === null ? {} : { channel }),
      ...(audio.sidecarCodec === null ? {} : { audio: { codec: audio.sidecarCodec } }),
      ...(pushSink === null ? {} : { pushSink, publishedCamStreamId }),
      ...(plane === null ? {} : { fragments: { fragmentMs: delivery.fragmentMs ?? 0, plane } }),
      onDied: (error) => this.onChildDied(key, error),
    })

    let localUrl: string
    try {
      localUrl = await child.start()
    } catch (err) {
      // BOTH resources, not just the channel. Releasing only the channel left
      // the cam stream published forever: one dead `egress:*` entry in the
      // broker's registry per failed session, each one attachable and fed by
      // nothing.
      channel?.release()
      // A plane whose producer never started must not be left for a consumer
      // to park a generator on.
      plane?.dispose()
      if (pushSink !== null) {
        await pushSink.release().catch((releaseErr: unknown) => {
          this.opts.logger.warn('egress transcode: retracting the failed publication failed', {
            tags: { deviceId },
            meta: { pipelineKey: key, brokerId, error: errMsg(releaseErr) },
          })
        })
      }
      this.opts.logger.error('egress transcode: child failed to start', {
        tags: { deviceId },
        meta: { pipelineKey: key, brokerId, error: errMsg(err) },
      })
      throw err
    }

    const actualHwAccel = child.decodeHwAccel()
    if (decodeHwAccel !== null && !isSoftwareDecode(decodeHwAccel) && actualHwAccel === null) {
      // The child fell back on its own. Told to the broker so no later child
      // pays the same death before its own retry — but ONLY when the death was
      // the backend's. A child that died opening its input never reached a
      // decoder, and quarantining one for that cost every other camera thirty
      // minutes of hardware decode (measured 2026-09-13).
      if (child.hwAccelAtFault?.() !== false) this.opts.onDecodeHwAccelFailed?.(decodeHwAccel)
    } else if (actualHwAccel !== null && !isSoftwareDecode(actualHwAccel)) {
      // Hardware RAN. Reported for the same reason the failure is: a backend
      // whose quarantine has widened has to be able to earn its way back.
      this.opts.onDecodeHwAccelSucceeded?.(actualHwAccel)
    }
    const entry: EgressEntry = {
      key,
      deviceId,
      child,
      localUrl,
      dialable: pushSink === null && plane === null,
      fragments: plane,
      handle: {
        url: localUrl,
        pipelineKey: key,
        videoCodec: targetCodec,
        // On the copy branch the consumer receives the SOURCE geometry — the
        // requested width/height were a ceiling the source already fit, not a
        // rescale, and reporting them would be a number nothing produced.
        resolution:
          plan.video.kind === 'copy'
            ? { width: source.width, height: source.height }
            : {
                width: request.encode.video.width ?? source.width,
                height: request.encode.video.height ?? source.height,
              },
        transcoded: plan.video.kind === 'encode',
        // Non-null ONLY when the local publication actually happened, so a
        // consumer can branch on it instead of assuming its request was
        // honoured.
        camStreamId: pushSink === null ? null : publishedCamStreamId,
        encoder: plan.video.kind === 'encode' ? plan.video.encoder : 'copy',
        decodeHwAccel: actualHwAccel,
      },
      refcount: 0,
      releaseTimer: null,
    }
    this.entries.set(key, entry)
    this.opts.logger.info('egress transcode: started', {
      tags: { deviceId },
      meta: {
        pipelineKey: key,
        brokerId,
        sourceUrl: source.url,
        transport: delivery.transport,
        encoder: entry.handle.encoder,
        decodeHwAccel: actualHwAccel ?? 'software',
        tag: request.tag,
      },
    })
    if (plane !== null && plan.video.kind === 'copy') {
      // The consumer asked for an N-millisecond fragment and is getting the
      // SOURCE's GOP, because a copy has no encoder to pin a key-frame grid on.
      // `fragmentLengthEnforced: false` says the same thing in the handle; this
      // says it where an operator reading logs will find it.
      this.opts.logger.warn(
        'egress transcode: fragment length is dictated by the SOURCE GOP — this child COPIES',
        {
          tags: { deviceId },
          meta: { pipelineKey: key, fragmentMs: delivery.fragmentMs },
        },
      )
    }
    return entry
  }

  /**
   * Copy or encode, and SAY which — once per child, with the failing
   * constraints named. Masking the complexity must not mean hiding the
   * decision: "why is this camera pinning a core?" and "why does this stream
   * look like the source?" are the same question asked from two directions.
   */
  private decideCopy(
    key: string,
    request: EgressTranscodeRequest,
    source: ResolvedEgressSource,
  ): EgressCopyDecision {
    const decision = decideEgressCopy(request.encode.video, source.facts)
    this.opts.logger.info(
      decision.copy
        ? 'egress transcode: COPY — the source already satisfies every requested constraint'
        : 'egress transcode: ENCODE — the source cannot satisfy the request',
      {
        tags: { deviceId: request.deviceId },
        meta: {
          pipelineKey: key,
          sourceCodec: source.facts.codec ?? 'unknown',
          unsatisfied: decision.unsatisfied.map((u) => `${u.constraint}: ${u.reason}`),
        },
      },
    )
    return decision
  }

  /**
   * The audio plane for this request, per TRANSPORT.
   *
   *  - **dial** — an RTP SIDECAR. The elementary Annex-B sink cannot carry
   *    audio in-band, so a second RTP output goes to a UDP port the egress
   *    binds and its `m=audio` block is grafted onto the SDP the consumer
   *    negotiates.
   *  - **push** — IN-BAND, as AAC. MPEG-TS can mux audio and the sidecar's SDP
   *    graft means nothing to a consumer that never dials; the broker's own
   *    audio plane then decodes the AAC and re-encodes whatever the session
   *    negotiated (Opus, for both Alexa and the browser). AAC and not the
   *    requested codec because the demuxer maps `0x0f` (aac), `0x03`/`0x04`
   *    (mp2) and `0x81` (ac3) and NOT Opus (`0x06`) — in-band Opus is the plane
   *    that was encoded and discarded at the demuxer for months.
   *  - **fragments** — IN-BAND, as AAC, for a different reason with the same
   *    answer: HKSV accepts AAC-LC and AAC-ELD and nothing else, and an fMP4
   *    fragment has no second plane to graft an SDP onto. This is precisely why
   *    the recorder's segments cannot serve HKSV — they are `libopus`
   *    (`recorder/addon/ffmpeg-args.ts`, deliberately, for the WebRTC copy path).
   *
   * Every substitution and every drop is announced. A branch that discards work
   * silently reads as "it never happened".
   */
  private resolveAudioPlane(
    key: string,
    request: EgressTranscodeRequest,
    transport: EgressTransport,
  ): { profileAudio: AudioEncode; sidecarCodec: AudioSidecarCodec | null } {
    const deviceId = request.deviceId
    const requestedAudio = request.encode.audio
    const requestedCodec = requestedAudio === 'passthrough' ? 'passthrough' : requestedAudio.codec
    if (requestedCodec === 'passthrough') {
      return { profileAudio: 'passthrough', sidecarCodec: null }
    }

    if (transport !== 'dial') {
      const container = transport === 'push' ? 'MPEG-TS' : 'fMP4 fragment'
      // The shared camera-mic AAC preset, not numbers invented here — every
      // source in this repo is a mono mic and the presets are the one place
      // that is written down. `channels` is narrower on `AudioEncode` (1 | 2)
      // than on the ffmpeg plan, so it is carried through the narrow shape.
      const aac = AUDIO_PRESETS.aac
      const profileAudio: AudioEncode = {
        codec: 'aac',
        bitrateKbps: aac.bitrateKbps ?? 128,
        sampleRateHz: aac.sampleRateHz ?? 48000,
        channels: aac.channels === 2 ? 2 : 1,
      }
      this.opts.logger.info(
        requestedCodec === 'aac'
          ? `egress transcode: audio rides IN-BAND in the ${container}`
          : `egress transcode: audio rides IN-BAND as AAC — the requested codec cannot cross the ${container}`,
        {
          tags: { deviceId },
          meta: {
            pipelineKey: key,
            transport,
            requested: requestedCodec,
            carried: 'aac',
            // Named so nobody re-derives it from a black Echo: the session's
            // own audio plane re-encodes this to whatever it negotiated. On the
            // fragment transport there is no re-encode — HKSV takes the AAC as
            // it is, which is why the codec is not negotiable there.
            note:
              transport === 'push'
                ? 'the broker decodes it and re-encodes what the session negotiated'
                : 'HKSV accepts only AAC-LC / AAC-ELD — this is the carried codec, not a stand-in',
          },
        },
      )
      return { profileAudio, sidecarCodec: null }
    }

    const sidecarCodec: AudioSidecarCodec | null =
      requestedCodec === 'aac' || requestedCodec === 'opus' || requestedCodec === 'pcmu'
        ? toAudioSidecarCodec(requestedCodec)
        : null
    // `copy` IS a legitimate instruction and says nothing; any other codec we
    // cannot emit is work being discarded, and that has to be announced. Note
    // the old guard compared the whole union against the string `'passthrough'`
    // AND against `.codec === 'copy'` in one expression, which is why its warn
    // never fired for the case it described.
    if (sidecarCodec === null && requestedCodec !== 'copy') {
      this.opts.logger.warn(
        'egress transcode: audio codec has no sidecar mapping — the audio plane is DROPPED',
        {
          tags: { deviceId },
          meta: { pipelineKey: key, audioCodec: requestedCodec },
        },
      )
    }
    // The sidecar carries the audio; the primary output stays video-only.
    return { profileAudio: 'passthrough', sidecarCodec }
  }

  /**
   * A child died after it started. The entry is removed SYNCHRONOUSLY — the
   * same rule the last-release race obeys — so the next acquire spawns a fresh
   * child instead of being handed a corpse, which is what happened until the
   * refcount happened to drain.
   */
  private onChildDied(key: string, error: Error): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    if (entry.releaseTimer) {
      clearTimeout(entry.releaseTimer)
      entry.releaseTimer = null
    }
    this.opts.logger.warn('egress transcode: child DIED — the entry is no longer shareable', {
      tags: { deviceId: entry.deviceId },
      meta: {
        pipelineKey: key,
        refcount: entry.refcount,
        error: errMsg(error),
      },
    })
    void entry.child.stop().catch((stopErr: unknown) => {
      this.opts.logger.warn('egress transcode: stopping a dead child failed', {
        tags: { deviceId: entry.deviceId },
        meta: { pipelineKey: key, error: errMsg(stopErr) },
      })
    })
  }

  /** The cam stream a request resolves to, or `null` when it names none. */
  private resolvedCamStreamId(request: EgressTranscodeRequest): string | null {
    return request.source.kind === 'profile'
      ? this.opts.resolveProfileSource(request.deviceId, request.source.profile)
      : request.source.camStreamId
  }

  private createChild(spec: EgressChildSpec): EgressChild {
    if (this.opts.createChild) return this.opts.createChild(spec)
    // The pinned binary or a refusal named for this camera — never PATH (D540).
    // A throw here fails the acquire, which is the caller's refusal path.
    const ffmpegBinaryPath = requireBrokerFfmpeg(this.opts.ffmpegConfig().binaryPath, {
      logger: this.opts.logger,
      deviceId: spec.deviceId,
      purpose: 'egress transcode',
      ...(this.opts.onFfmpegMissing === undefined ? {} : { onMissing: this.opts.onFfmpegMissing }),
    })
    if (spec.fragments) return this.createFragmentChild(spec, spec.fragments, ffmpegBinaryPath)
    if (spec.pushSink) return this.createPushChild(spec, spec.pushSink, ffmpegBinaryPath)
    const channel = spec.channel
    if (channel === undefined) {
      // Unreachable by construction — `startChild` mints a channel for every
      // non-push child — and stated rather than assumed, because the alternative
      // is a `!` that turns a wiring mistake into a null dereference at spawn.
      throw new Error('egress transcode: a dial child was created without a channel')
    }
    const egress = new TranscodeEgress(
      {
        logger: this.opts.logger.child('egress'),
        ffmpegBinaryPath,
        spawnFn: this.opts.spawnFn ?? defaultFfmpegSpawn,
        // The channel is already allocated, so the egress reuses it rather than
        // minting a second restreamer for the same child.
        acquireChannel: () => channel,
        // A child that exits after going live is a corpse, not a stream: the
        // manager un-registers the entry so the next acquire spawns fresh.
        ...(spec.onDied ? { onChildExit: spec.onDied } : {}),
        // This manager knows the camera it is transcoding for. Nothing has to
        // deduce it from a pid afterwards.
        claimCost: (pid) =>
          this.opts.costRegistry?.claim({
            role: 'transcode',
            deviceId: spec.deviceId,
            unit: spec.brokerId,
            pid,
          }) ?? NO_COST_CLAIM,
      },
      {
        brokerId: spec.brokerId,
        targetCodec: spec.targetCodec,
        invocation: spec.invocation,
        ...(spec.audio ? { audio: spec.audio } : {}),
      },
    )
    return {
      start: () => egress.start(),
      stop: () => egress.stop(),
      // `TranscodeEgress` retries in software itself when a hardware child
      // produces nothing, so the REQUESTED backend is not necessarily the one
      // that ran. Reporting the requested value would be the silent-downgrade
      // failure this primitive exists to make loud.
      decodeHwAccel: () => egress.activeDecodeHwAccel(),
    }
  }

  /**
   * The FRAGMENT child: fragmented MP4 out, split into units, fanned onto a
   * plane. It has no url and no cam stream — {@link EgressChild.start} still
   * has to resolve with a string, so it resolves with the deliberately
   * non-dialable {@link fragmentsOnlyUrl} sentinel.
   *
   * The child owns the software retry and the liveness reporting itself, in the
   * same shape as the other two transports; this wrapper is the adapter, not
   * the logic. See the primitive's `ffmpeg/fmp4-fragment-child.ts`.
   */
  private createFragmentChild(
    spec: EgressChildSpec,
    fragments: {
      readonly fragmentMs: number
      readonly plane: Fmp4FragmentPlane
    },
    ffmpegBinaryPath: string,
  ): EgressChild {
    const child = new Fmp4FragmentChild(
      {
        logger: this.opts.logger.child('egress-fmp4'),
        ffmpegBinaryPath,
        spawnFn: this.opts.spawnFn ?? defaultFfmpegSpawn,
        ...(this.opts.fragmentFirstUnitTimeoutMs === undefined
          ? {}
          : { firstUnitTimeoutMs: this.opts.fragmentFirstUnitTimeoutMs }),
        ...(spec.onDied ? { onChildExit: spec.onDied } : {}),
      },
      {
        sourceId: spec.brokerId,
        deviceId: spec.deviceId,
        fragmentMs: fragments.fragmentMs,
        invocation: spec.invocation,
        plane: fragments.plane,
      },
    )
    return {
      start: async () => {
        await child.start()
        return spec.consumerUrl
      },
      stop: () => child.stop(),
      // What ACTUALLY ran, not what was requested — the software retry is
      // inside the child, and reporting the request is the silent downgrade
      // this primitive exists to make loud.
      decodeHwAccel: () => child.activeDecodeHwAccel(),
    }
  }

  /**
   * The LOCAL child: MPEG-TS out, demuxed straight into a broker.
   *
   * Structurally identical to the derived mechanism's feeder — same
   * `FfmpegPushReader`, same container, same per-frame packets — and it differs
   * from it in exactly the way the primitive is meant to: the argv comes from
   * the one builder, the child is refcounted and deduplicated on an exact
   * sharing key, and the hwaccel is the decoder addon's answer rather than a
   * second opinion.
   *
   * ## Audio rides IN-BAND, as AAC
   *
   * The sidecar exists because an elementary Annex-B sink cannot carry audio;
   * MPEG-TS can, and the sidecar's SDP graft means nothing to a consumer that
   * never dials. `resolveAudioPlane` therefore asks for AAC here whatever the
   * request named, because the demuxer maps `0x0f` (aac), `0x03`/`0x04` (mp2)
   * and `0x81` (ac3) and NOT Opus (`0x06`) — the broker's own audio plane then
   * decodes it and re-encodes what the session negotiated. The docblock this
   * replaces claimed the audio "rides in-band here" while this function ignored
   * `spec.audio` entirely and every argv it built carried `-an`.
   *
   * ## It retries in SOFTWARE, exactly like the dial path
   *
   * `-hwaccel vaapi` fails to create a device inside the stream-broker runner on
   * the live hub — `code=244`, "Device creation failed: -12" — and this reader
   * has no retry of its own, so the child died ~2 s after spawn with
   * `packetsOut=0` and the Echo closed on "no source media". `TranscodeEgress`
   * masked the same failure on the dial path with its own software retry, which
   * is why only this transport was dark.
   */
  private createPushChild(
    spec: EgressChildSpec,
    sink: EgressPushSink,
    ffmpegBinaryPath: string,
  ): EgressChild {
    const logger = this.opts.logger.child('egress-push')
    const deviceId = spec.deviceId
    const timeoutMs = this.opts.pushFirstPacketTimeoutMs ?? DEFAULT_PUSH_FIRST_PACKET_TIMEOUT_MS
    // Counted here, at the ONLY point where a packet leaves the ffmpeg child.
    // Without it "no media reached the session" cannot be told apart from "the
    // child produced nothing" — the two have identical symptoms downstream.
    let packetsOut = 0
    /** The backend the RUNNING child decodes with — `null` after a fallback. */
    let activeHwAccel: string | null = spec.invocation.decodeHwAccel
    let reader: PushReader | null = null
    /**
     * Which spawn is CURRENT. A failure reported by a superseded attempt — the
     * hardware child the software retry replaced — must never evict the healthy
     * entry the retry produced. `destroy()` normally silences the old reader
     * first, and "normally" is not a property to bet an Echo session on.
     */
    let generation = 0

    const makeReader = (input: {
      args: readonly string[]
      callbacks: PushReaderCallbacks
    }): PushReader => {
      if (this.opts.createPushReader) return this.opts.createPushReader(input)
      return new FfmpegPushReader(
        {
          ffmpegPath: ffmpegBinaryPath,
          args: [...input.args],
          logger,
          ...(this.opts.spawnFn ? { spawnFn: this.opts.spawnFn } : {}),
        },
        input.callbacks,
        'egress push',
      )
    }

    /**
     * One spawn. Resolves on the FIRST packet (the pipeline is live) and
     * rejects if the child fails or is silent before then — the same shape
     * `TranscodeEgress.spawnAttempt` has, so both transports fail the acquire
     * rather than handing back a handle nothing feeds.
     */
    const spawnAttempt = (decodeHwAccel: string | null): Promise<void> => {
      const mine = ++generation
      const args = buildFfmpegArgs({
        ...spec.invocation,
        decodeHwAccel,
        sink: { kind: 'stdout', container: 'mpegts' },
      })
      logger.info('egress push: spawning ffmpeg child', {
        tags: { deviceId },
        meta: {
          brokerId: spec.brokerId,
          camStreamId: spec.publishedCamStreamId,
          ffmpegPath: ffmpegBinaryPath,
          decodeHwAccel: decodeHwAccel ?? 'software',
          // The full argv, once, so a sink that produces nothing can be
          // diagnosed without another round trip to the host.
          argv: args.join(' '),
        },
      })
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          reject(new Error(`egress push: no packet within ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
        const settle = (fail?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (fail) reject(fail)
          else resolve()
        }

        reader = makeReader({
          args,
          callbacks: {
            onVideoCodec: (codec) => {
              logger.info('egress push: video codec identified from the PMT', {
                tags: { deviceId },
                meta: {
                  brokerId: spec.brokerId,
                  camStreamId: spec.publishedCamStreamId,
                  codec,
                },
              })
              sink.videoCodec(codec)
            },
            onEncodedPacket: (packet) => {
              packetsOut += 1
              if (packetsOut === 1) {
                settle()
                logger.info('egress push: FIRST packet out of the ffmpeg child', {
                  tags: { deviceId },
                  meta: {
                    brokerId: spec.brokerId,
                    camStreamId: spec.publishedCamStreamId,
                    type: packet.type,
                    codec: packet.codec,
                    bytes: packet.data.length,
                    keyframe: packet.keyframe,
                    pts: packet.pts,
                    dts: packet.dts,
                  },
                })
              } else if (packet.keyframe === true) {
                // Keyframe SIZE, every keyframe. On a link with no NACK — an
                // Echo sends no RTCP at all — a keyframe is an all-or-nothing
                // unit: at ~1200 bytes of RTP payload a 108 KB IDR is ~90
                // packets sharing one timestamp, and with one slice per frame
                // losing any of them costs the whole picture until the next
                // one. The size is the thing that decides how likely that is,
                // and nothing was measuring it.
                keyframesOut += 1
                if (keyframesOut <= 3 || keyframesOut % KEYFRAME_LOG_EVERY === 0) {
                  logger.info('egress push: keyframe out', {
                    tags: { deviceId },
                    meta: {
                      brokerId: spec.brokerId,
                      camStreamId: spec.publishedCamStreamId,
                      keyframesOut,
                      bytes: packet.data.length,
                      // How many RTP packets this frame becomes, near enough:
                      // the number that matters for survivability.
                      approxRtpPackets: Math.ceil(packet.data.length / 1200),
                    },
                  })
                }
              } else if (packetsOut % PUSH_PACKET_LOG_EVERY === 0) {
                logger.info('egress push: packets still flowing out of the ffmpeg child', {
                  tags: { deviceId },
                  meta: {
                    brokerId: spec.brokerId,
                    camStreamId: spec.publishedCamStreamId,
                    packetsOut,
                    type: packet.type,
                    bytes: packet.data.length,
                  },
                })
              }
              sink.push(packet)
            },
            onAudioInfo: (info) => {
              logger.info('egress push: audio identified in the MPEG-TS', {
                tags: { deviceId },
                meta: {
                  brokerId: spec.brokerId,
                  camStreamId: spec.publishedCamStreamId,
                  codec: info.codec,
                  sampleRate: info.sampleRate,
                  channels: info.channels,
                },
              })
              sink.audioInfo(info)
            },
            // Neither of these was wired, so a child that died on spawn or
            // exited on the first frame produced NOT ONE line anywhere. Silence
            // read as "it is running".
            onError: (error) => {
              logger.error(
                'egress push: ffmpeg child FAILED — no further packets will be produced',
                {
                  tags: { deviceId },
                  meta: {
                    brokerId: spec.brokerId,
                    camStreamId: spec.publishedCamStreamId,
                    packetsOut,
                    decodeHwAccel: decodeHwAccel ?? 'software',
                    error: errMsg(error),
                  },
                },
              )
              // Before the first packet this is the START failing, and `start`
              // decides whether to retry. After it, the child is a corpse and
              // the entry must stop being shareable.
              if (!settled) {
                settle(error)
                return
              }
              // Settled and still the current child ⇒ a corpse. A superseded
              // attempt reporting late is not, and neither is a `stop()`.
              if (mine === generation) spec.onDied?.(error)
            },
            onTeardown: () => {
              logger.info('egress push: reader torn down', {
                tags: { deviceId },
                meta: {
                  brokerId: spec.brokerId,
                  camStreamId: spec.publishedCamStreamId,
                  packetsOut,
                },
              })
            },
          },
        })
        reader.connect()
      })
    }

    // Whether the FIRST attempt's death is attributable to the decode backend.
    // Read by the caller so a source that was not ready yet cannot cost every
    // other camera its hardware decode.
    let keyframesOut = 0
    let hwAccelAtFault = true
    return {
      hwAccelAtFault: () => hwAccelAtFault,
      start: async () => {
        const requested = spec.invocation.decodeHwAccel
        /** Whether a same-decode retry already produced a live child. */
        let recoveredOnRetry = false
        const inputRetryDelayMs = this.opts.inputRetryDelayMs ?? INPUT_RETRY_DELAY_MS
        try {
          await spawnAttempt(requested)
        } catch (err) {
          if (requested === null || isSoftwareDecode(requested)) throw err
          // WHO failed. Until this asked, any first-attempt failure was read as
          // "hardware produced no packets" and quarantined the backend for
          // thirty minutes, process-wide — including the failure measured on
          // 2026-09-13, where the child was spawned three seconds before its
          // source publisher existed and never reached a decoder at all.
          const blameBackend = isDecodeBackendFailure(errMsg(err))
          hwAccelAtFault = blameBackend
          if (!blameBackend) {
            // The decoder was never reached: the input was not there. Falling
            // back to SOFTWARE is the wrong remedy for that — it cures nothing
            // and costs the whole session its hardware decode. Measured on 640
            // (2026-09-13): the first child died on `Error opening input`
            // against a lazy publisher that had not woken yet, the software
            // retry five seconds later succeeded, and every Alexa session on
            // that camera ran on the CPU because of a race.
            //
            // The first spawn IS the wake — a lazy publisher materialises
            // because someone dials it — so the right answer is to dial the
            // same thing again once it has had a moment. ONE retry: a second
            // failure is a source that is genuinely not there, and the software
            // fallback below is the honest last word.
            logger.info('egress push: the input was not there — retrying the SAME decode', {
              tags: { deviceId },
              meta: {
                brokerId: spec.brokerId,
                camStreamId: spec.publishedCamStreamId,
                decodeHwAccel: requested,
                afterMs: inputRetryDelayMs,
                error: errMsg(err),
              },
            })
            reader?.destroy()
            await new Promise<void>((resolve) => {
              setTimeout(resolve, inputRetryDelayMs).unref?.()
            })
            try {
              await spawnAttempt(requested)
              recoveredOnRetry = true
            } catch (retryErr) {
              logger.warn('egress push: the input was STILL not there — falling to SOFTWARE', {
                tags: { deviceId },
                meta: {
                  brokerId: spec.brokerId,
                  camStreamId: spec.publishedCamStreamId,
                  decodeHwAccel: requested,
                  error: errMsg(retryErr),
                },
              })
            }
          }
          // The retry landed on the SAME decode — nothing to announce and
          // nothing to fall back to. Control joins the common tail below rather
          // than returning here, so the "publishing LOCALLY" line is written
          // exactly once however the child got started.
          if (!recoveredOnRetry) {
            // Every software outcome is announced — on this hub a silent fall
            // back is a flow bug, not a capability limit (D67), and this one is a
            // flow bug the operator can act on. The line now says whose fault it
            // was, because "retrying in software" was being read as a verdict on
            // the GPU when half the time the GPU was never asked.
            logger.warn(
              blameBackend
                ? 'egress push: hardware decode produced NO packets — retrying in SOFTWARE'
                : 'egress push: the child died before the decoder — retrying in SOFTWARE, backend NOT blamed',
              {
                tags: { deviceId },
                meta: {
                  brokerId: spec.brokerId,
                  camStreamId: spec.publishedCamStreamId,
                  decodeHwAccel: requested,
                  blameBackend,
                  error: errMsg(err),
                },
              },
            )
            reader?.destroy()
            activeHwAccel = null
            await spawnAttempt(null)
          }
        }
        logger.info('egress transcode: publishing LOCALLY — no rtsp round trip', {
          tags: { deviceId },
          meta: {
            brokerId: spec.brokerId,
            camStreamId: spec.publishedCamStreamId,
            // Said out loud because the url in the response is NOT dialable:
            // this transport is chosen by `publishLocally` and the consumer
            // attaches by camStreamId.
            url: spec.consumerUrl,
          },
        })
        return spec.consumerUrl
      },
      stop: async () => {
        reader?.destroy()
        await sink.release()
      },
      // What ACTUALLY ran, which is not what was requested once the software
      // retry has fired. Reporting the request here is precisely the silent
      // downgrade this primitive exists to make loud.
      decodeHwAccel: () => activeHwAccel,
    }
  }

  /** Take a reference and cancel any pending stop. */
  private share(entry: EgressEntry): EgressEntry {
    entry.refcount += 1
    if (entry.releaseTimer) {
      clearTimeout(entry.releaseTimer)
      entry.releaseTimer = null
    }
    this.opts.logger.info('egress transcode: acquired', {
      tags: { deviceId: entry.deviceId },
      meta: { pipelineKey: entry.key, refcount: entry.refcount },
    })
    return entry
  }

  /**
   * Rewrite the DIAL address for this caller. The restreamer is bound on
   * `0.0.0.0` and is the same object either way, so the substitution happens
   * per-caller and outside the shared entry — baking a host into the entry
   * would fork the child once per consuming node.
   */
  private dial(entry: EgressEntry, hostname: string | undefined): EgressTranscode {
    // A push child's url is a sentinel nothing dials; host-substituting it
    // would dress "obviously not a url" up as a route.
    if (!entry.dialable) return entry.handle
    if (hostname === undefined || hostname.length === 0) return entry.handle
    return {
      ...entry.handle,
      url: substituteRtspHost(entry.localUrl, hostname),
    }
  }

  private async shutdownEntry(entry: EgressEntry, unregister = true): Promise<void> {
    if (entry.releaseTimer) {
      clearTimeout(entry.releaseTimer)
      entry.releaseTimer = null
    }
    // SYNCHRONOUS removal, before any await: an acquire that interleaves with
    // the stop must never be handed a corpse. See the class docblock.
    if (unregister) this.entries.delete(entry.key)
    this.opts.logger.info('egress transcode: stopping — no holders left', {
      tags: { deviceId: entry.deviceId },
      meta: { pipelineKey: entry.key },
    })
    try {
      await entry.child.stop()
    } catch (err) {
      this.opts.logger.warn('egress transcode: shutdown error', {
        tags: { deviceId: entry.deviceId },
        meta: { pipelineKey: entry.key, error: errMsg(err) },
      })
    }
  }

  /**
   * The source's broker restream url, so every consumer rides the broker's ONE
   * source dial. A targeted source that has never been dialed is refused rather
   * than silently substituted — the consumer asked for a specific stream.
   */
  /**
   * Hold the spawn until the source is carrying media, under a bound.
   *
   * Never throws and never refuses: a source that says nothing by the deadline
   * is spawned against anyway, and the line says what was waited. The only
   * thing this changes is WHEN ffmpeg opens the loopback.
   */
  private async awaitSourceMedia(
    deviceId: number,
    key: string,
    source: ResolvedEgressSource,
  ): Promise<void> {
    const hasMedia = this.opts.sourceHasMedia
    if (hasMedia === undefined) return
    const verdict = await waitForSourceMedia({
      hasMedia: () => hasMedia(source.brokerId),
      timeoutMs: SOURCE_MEDIA_WAIT_MS,
      pollMs: SOURCE_MEDIA_POLL_MS,
      now: () => Date.now(),
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms).unref?.()
        }),
    })
    if (verdict.outcome === 'live') return
    this.opts.logger.info('egress transcode: waited for the SOURCE before spawning', {
      tags: { deviceId },
      meta: {
        pipelineKey: key,
        sourceBrokerId: source.brokerId,
        outcome: verdict.outcome,
        waitedMs: verdict.waitedMs,
        ready: verdict.ready,
      },
    })
  }

  private resolveSource(request: EgressTranscodeRequest): ResolvedEgressSource {
    const deviceId = request.deviceId
    const camStreamId = this.resolvedCamStreamId(request)
    if (camStreamId === null || camStreamId === undefined || camStreamId.length === 0) {
      throw new Error(
        `acquireEgressTranscode: profile "${
          request.source.kind === 'profile' ? request.source.profile : '?'
        }" has no assigned source for device ${deviceId}`,
      )
    }
    const brokerId = makeSourceBrokerId(deviceId, camStreamId)
    const entry = this.opts.rtspEntryLookup(brokerId)
    if (!entry?.url) {
      throw new Error(`acquireEgressTranscode: source ${brokerId} is not dialed`)
    }
    const stream = this.opts.cameraStreamLookup(deviceId).find((s) => s.camStreamId === camStreamId)
    const declaredCodec = stream?.codec !== undefined && stream.codec.length > 0
    return {
      brokerId,
      url: entry.url,
      // Defaulted for the ARGV builder, which needs a concrete target; the
      // undefaulted truth lives in `facts` and is what a constraint is judged
      // against. A default that satisfies a constraint is a copy nobody
      // measured.
      codec: normaliseSourceCodec(stream?.codec),
      width: stream?.resolution?.width ?? 1280,
      height: stream?.resolution?.height ?? 720,
      facts: {
        ...(declaredCodec ? { codec: normaliseSourceCodec(stream?.codec) } : {}),
        ...(stream?.resolution
          ? { width: stream.resolution.width, height: stream.resolution.height }
          : {}),
        ...(stream?.fps !== undefined ? { fps: stream.fps } : {}),
      },
    }
  }
}
