/**
 * Native-frame transport (S7) — the boot-time closure bundle that turns the
 * runner's `pipelineRunner.getNativeCrop` cap into the typed fetch surface the
 * rest of the addon consumes (full frames, subject crops, display crops).
 * Extracted verbatim from `onInitialize` — a pure deps-injected factory,
 * constructed ONCE at boot.
 *
 * Frame/pixel payloads NEVER cross a process boundary raw at frame-rate (D9):
 * every reply is asked for as a COMPRESSED JPEG (`wantJpeg`, 2026-07-23 — see
 * the note on that constant; do NOT "optimise" it back to raw RGB on same-node).
 *
 * ## Two arrival shapes, chosen by the DESTINATION — not by the fetch
 *
 * A consumer whose destination is a STORED JPEG gets {@link NativeCropJpeg} —
 * the runner's own bytes, handed on untouched: a decode plus a re-encode of an
 * image nobody on this side ever looks at buys nothing. The crop paths were
 * paying `base64 → Buffer → raw RGB (24.9 MB at 4K) → copy → copy → JPEG` to
 * arrive back at what the runner had already encoded at the same
 * `quality: 90`.
 *
 * Since D422 the by-handle full-frame JPEG fetch that served the detail
 * plane's `frameJpeg` rung is GONE from here: that rung reads the track's
 * PARKED key frame by `(deviceId, trackId)` (`parked-frame-client.ts`). A
 * retrieval keyed by a track never falls back to a handle, and this file must
 * not grow one back (`scripts/check-parked-frame-no-handle-fallback.ts`).
 *
 * A consumer that needs PIXELS gets {@link NativeCropRgb}. Both full-frame
 * fetches do, for a reason you can state in one line:
 *
 *  - `getNativeFullFrameRgb` — the event snapshot and the boxed timeline tiles
 *    draw on the frame before they encode it;
 *  - the display crop's FALLBACK leg — it is handed a whole FRAME and still has
 *    to cut the region out of it.
 *
 * Note that `captureDisplayCrop` is BOTH: its native-ROI leg passes through and
 * its fallback leg decodes. That split is written down once, in
 * `pipeline/display-crop.ts` — read the table there before changing either.
 *
 * ## Two failure contracts, also chosen by the caller
 *
 * {@link createNativeFrameTransport}'s `requestNativeCrop` THROWS and
 * `tryRequestNativeCrop` collapses everything to `null`. Which one a fetch uses
 * is load-bearing, not stylistic: a routing failure must stay distinguishable
 * from a retention miss — that distinction is what found 388 key-frame misses
 * behind one offline node on 2026-08-06, back when the key frame was fetched
 * here (before D422 it was; now it reads a parked parcel and never touches this
 * transport). The full-frame fetches still THROW: `event-media-dispatcher.ts`
 * (via `getNativeFullFrameRgb`) and the debug crop in `index.ts` catch it
 * themselves, and `captureDisplayCrop`'s fallback translates it to `null` at
 * its own wiring. The ROI fetches want the `null`. Do not unify them.
 */
import type { AddonContext, DecodedFrame, FrameHandle, IScopedLogger } from '@camstack/types'
import { NativeCropDedupe } from './native-crop-dedupe.js'
import { errMsg, nodePin } from '@camstack/types'
import { decodeJpegToRgb, encodeRgbCropToJpeg } from '../../shared/frame/encode-crop.js'
import { extractCrop } from '../../shared/frame/crop-extractor.js'
import { createCaptureCrop } from '../pipeline/capture-crop.js'
import type { CaptureCropFn, NoteCropOutcomeFn } from '../pipeline/capture-crop.js'
import { createDisplayCrop } from '../pipeline/display-crop.js'
import type { DisplayCropFn } from '../pipeline/display-crop.js'

/**
 * Which source `pipelineRunner.getNativeCrop` served a reply from (the
 * `NativeCropResultSchema.tier` wire field). `undefined` = a pre-tier runner
 * (version skew) omitted it, and every consumer reads that as `native`.
 */
export type FullFrameTier = 'native' | 'ram-fullframe'

/** Long-side cap for the DISPLAY-crop full-frame fallback (plate/face gallery
 *  tiles) when the native ROI missed. A generous native cap so a keyframe-native
 *  tier still yields a legible plate/face crop; the runner's ≤640 RAM tier is
 *  returned as-is (honest sub-native). Never triggers an upscale. */
const DISPLAY_FALLBACK_MAX_WIDTH = 1920

/** A normalized [0,1] region in the frame's own space. */
export interface NormalizedCropRegion {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Raw RGB pixels + their actual dimensions, as returned by a crop fetch. */
export interface NativeCropRgb {
  readonly bytes: Buffer
  readonly width: number
  readonly height: number
  /**
   * WHICH SURFACE served these pixels. Carried because the dimensions cannot
   * say it: the runner's ≤640 RAM store returns an ROI in detection-frame
   * space, and for anything but a tiny box that is indistinguishable from a
   * native crop of a small subject. The tier is the only honest signal, and
   * `getNativeCrop`'s cap schema has always shipped it — this side simply
   * dropped it on the floor.
   *
   * `undefined` = a pre-tier runner (version skew). Treated as `native`.
   */
  readonly tier?: FullFrameTier
}

/**
 * A crop in its WIRE form — the JPEG the OWNING runner encoded — plus the pixel
 * dimensions it was cut at and the source tier.
 *
 * The twin of {@link NativeCropRgb}, for consumers whose destination is a
 * STORED JPEG. Nothing on this side decodes it: the runner already encoded at
 * the same `quality: 90` this addon would re-encode at, so a decode here buys a
 * second generation of loss and five allocations, and buys no caller anything.
 *
 * `width`/`height` are the reply's own, not a decode's — the runner reports the
 * dims of the very raster it encoded (`encodeNativeCropResult` in
 * `pipeline-runner/index.ts:2612`), so they describe these exact bytes.
 *
 * The `tier` rides through UNCHANGED, absent staying absent: it is read off the
 * reply, never off the pixels, so the NATIVE-OR-NOTHING gate is identical on
 * both shapes.
 */
export interface NativeCropJpeg {
  readonly jpeg: Buffer
  readonly width: number
  readonly height: number
  readonly tier?: FullFrameTier
}

/** The decoded full frame PLUS the source tier (the display fallback's reason). */
export interface TieredFullFrame {
  readonly frame: DecodedFrame
  readonly tier: FullFrameTier
}

/** The closure bundle `onInitialize` hands to dispatchers/recognizers. */
export interface NativeFrameTransport {
  /** Full-frame fetch by handle (bbox {0,0,1,1}) at the handle's own width. */
  readonly getRemoteFrame: (handle: FrameHandle) => Promise<DecodedFrame | null>
  /** Tier-agnostic full frame capped to `maxWidth` (timeline boxed tiles). */
  readonly getNativeFullFrameRgb: (
    handle: FrameHandle,
    maxWidth: number,
  ) => Promise<DecodedFrame | null>
  /**
   * The same full frame as {@link getNativeFullFrameRgb} but in its wire JPEG
   * form, for the consumers that only RE-ENCODE it (boxed timeline tiles): they
   * draw and encode inside one libvips pipeline and no RGB surface is ever
   * materialised in this process (D867). Throws like the RGB fetch.
   */
  readonly getNativeFullFrameJpeg: (
    handle: FrameHandle,
    maxWidth: number,
  ) => Promise<NativeCropJpeg | null>
  /**
   * NATIVE-OR-NOTHING subject-crop JPEG (crop/thumbnail/faceCrop/plateCrop).
   * A `ram-fullframe` reply is REFUSED (`null`), not served — see the tier gate
   * in the implementation. `deviceId` is for the refusal log's `tags` only.
   */
  readonly getNativeCropJpeg: (
    frameHandle: FrameHandle,
    normalizedBbox: NormalizedCropRegion,
    maxWidth?: number,
    deviceId?: number,
  ) => Promise<Buffer | null>
  /** ENRICHMENT crop capture — native-strict, `null` on a native miss. */
  readonly captureCrop: CaptureCropFn
  /** DISPLAY crop capture — bounded honest fallback, never upscaled. */
  readonly captureDisplayCrop: DisplayCropFn
}

export interface NativeFrameTransportDeps {
  /** The addon's tRPC api surface (`ctx.api`). */
  readonly api: AddonContext['api']
  /** This node's id — decides raw-RGB (same-node) vs compressed-JPEG replies. */
  readonly ownNodeId: string
  readonly logger: IScopedLogger
  /**
   * Per-camera enrichment-crop outcome counter (`failure-contribution`).
   * Absent in tests that construct the transport for its fetch surface alone.
   */
  readonly noteCropOutcome?: NoteCropOutcomeFn
}

/** Shape of one `getNativeCrop` reply across runner versions/transports. */
interface NativeCropReply {
  // Raw RGB — present on the same-node (in-process/UDS) path. ABSENT
  // when the runner returned a compressed `jpeg` (cross-node path).
  bytes?: ArrayLike<number>
  // Base64 JPEG — the COMPRESSED cross-node payload (fits Moleculer's
  // maxPacketSize; no raw pixels cross the process boundary). Present
  // ONLY when the fetch requested `encodeJpeg`. A pre-encode runner
  // (version skew) ignores `encodeJpeg` and returns `bytes` instead.
  jpeg?: string
  // The same compressed JPEG as bytes — what a runner answers when the fetch
  // set `acceptJpegBytes` (D462). Exactly one of `jpeg` / `jpegBytes` is
  // present on the compressed path.
  jpegBytes?: Uint8Array
  width: number
  height: number
  // Present on tier-aware runners (S1); ABSENT on a pre-tier runner
  // (version skew) → every tier reader treats absent as `native`.
  tier?: 'native' | 'ram-fullframe'
}

/**
 * Turn one `getNativeCrop` reply into the arrival shape a caller asked for.
 * Generic so the request and its error handling live in ONE place
 * ({@link createNativeFrameTransport}'s `fetchNativeCrop`) while the two shapes
 * stay separate functions — a second copy of the request is how `encodeJpeg`
 * would eventually differ by caller.
 */
type NativeCropNormalizer<TShape> = (reply: NativeCropReply) => Promise<TShape | null>

/** The whole-frame rectangle. `getNativeCrop` classifies a request as
 *  full-frame from its BBOX, so this constant IS the routing decision. */
const FULL_FRAME_BBOX: NormalizedCropRegion = { x: 0, y: 0, w: 1, h: 1 }

/** The same classification the RUNNER applies to decide "full frame" from the
 *  bbox (`getNativeCrop`), restated here so the two cannot drift. */
function isFullFrameBbox(bbox: NormalizedCropRegion): boolean {
  return bbox.x <= 0.001 && bbox.y <= 0.001 && bbox.w >= 0.999 && bbox.h >= 0.999
}

/** Throttle for the native-crop HIT/FALLBACK metric window line. */
const NATIVE_CROP_METRIC_INTERVAL_MS = 30_000

/**
 * Above this `maxWidth`, a full-frame fetch is a NATIVE full frame (~1–1.5 MB
 * on a 4K camera) rather than a boxed timeline tile or a pinned ≤106 detection
 * frame (tens of kB). The two belong in different counters or the window line
 * says "full frames" and means two payload classes three orders of magnitude
 * apart. (D470) No caller asks for that rung since D422 (the key frame) and
 * D680 (the group shot); the counter stays so the next one is seen.
 */
const FULL_FRAME_TILE_WIDTH_CEILING = 1920

export function createNativeFrameTransport(deps: NativeFrameTransportDeps): NativeFrameTransport {
  const { api, logger } = deps
  // Full-frame + native-crop retrieval both route through the runner that
  // owns the frame (`pipelineRunner.getNativeCrop`, routed by `handle.nodeId`)
  // — shm-ring removal 2026-07-16. Narrowed so a runner without the method
  // (version skew) simply yields no frame/crop; media is best-effort.
  const pipelineRunnerApi = (
    api as {
      pipelineRunner?: {
        getNativeCrop?: {
          query: (input: unknown, opts?: unknown) => Promise<NativeCropReply | null>
        }
      }
    }
  ).pipelineRunner
  // A crop fetched from a REMOTE node must come back COMPRESSED: a native 4K
  // full frame is ~26 MB of raw RGB — larger than Moleculer's 10 MB
  // maxPacketSize, so the response packet is DROPPED and the call 60s-times-out
  // (the cross-node native-media miss). Asking the OWNING runner to JPEG-encode
  // in-process ships ~0.5–2 MB instead and honours "never raw cross-process".
  // 2026-07-23 relay-pressure fix: request JPEG for SAME-NODE fetches too.
  // A same-node raw-RGB crop reply (0.7-26 MB) transits the UDS parent relay (same-node) or Moleculer (cross-node)
  // in hub-main; under morning capture load those buffers ballooned hub-main
  // to 2-4 GB RSS in hours, and its GC pauses stalled event delivery (frame
  // batches arriving ~2 s late -> recycled handles -> missing first/last
  // frames). JPEG cuts the relay payload 10-20x for one encode on the owning
  // runner + one decode here — the same cost the cross-node path always
  // paid. `cropReplyToRgb` already handles both reply shapes.
  const wantJpeg = (_handle: FrameHandle): boolean => true
  // Normalize a `getNativeCrop` reply into raw RGB regardless of transport:
  // same-node → raw `bytes`; cross-node → decode the compressed `jpeg` back to
  // RGB in-process, so every downstream consumer keeps its RGB contract.
  const cropReplyToRgb = async (reply: NativeCropReply): Promise<NativeCropRgb | null> => {
    // The tier rides through the transport decode UNCHANGED. An absent tier
    // stays absent (it means "pre-tier runner", which every consumer must read
    // as `native` for back-compat) rather than being collapsed here — a
    // default chosen in the decoder would be a second authority on quality.
    const tier = reply.tier
    if (reply.jpegBytes !== undefined) {
      const rgb = await decodeJpegToRgb(reply.jpegBytes)
      return {
        bytes: rgb.bytes,
        width: rgb.width,
        height: rgb.height,
        ...(tier !== undefined ? { tier } : {}),
      }
    }
    if (reply.jpeg !== undefined) {
      const rgb = await decodeJpegToRgb(reply.jpeg)
      // NOT copied. `decodeJpegToRgb` allocates this buffer per call via sharp
      // and hands it over; nothing else holds it, and every consumer only READS
      // it (`extractCrop`, `drawBoxedFrame` — both hand it straight to sharp,
      // and the key-frame path already passes the same buffer to two encodes).
      // The copy that used to be here duplicated a full raw-RGB surface — 6.2 MB
      // per 1920-wide key frame, immediately garbage.
      return {
        bytes: rgb.bytes,
        width: rgb.width,
        height: rgb.height,
        ...(tier !== undefined ? { tier } : {}),
      }
    }
    if (reply.bytes !== undefined) {
      return {
        bytes: Buffer.from(reply.bytes),
        width: reply.width,
        height: reply.height,
        ...(tier !== undefined ? { tier } : {}),
      }
    }
    return null
  }
  // Normalize a `getNativeCrop` reply into a STORED-JPEG-ready buffer. The
  // ordinary path is the first branch and it is the whole point: `wantJpeg` is
  // unconditionally true, so the runner has already encoded, and the only work
  // left is base64 → Buffer.
  //
  // The `bytes` branch is VERSION SKEW ONLY — a pre-encode runner ignores
  // `encodeJpeg` and answers in raw RGB (documented on `NativeCropReply`). That
  // reply has to be encoded here or there is no JPEG at all, so the decode this
  // change removes is not removed from it: there was never one to remove.
  const cropReplyToJpeg = async (reply: NativeCropReply): Promise<NativeCropJpeg | null> => {
    const tier = reply.tier
    if (reply.jpegBytes !== undefined) {
      return {
        jpeg: Buffer.from(reply.jpegBytes),
        width: reply.width,
        height: reply.height,
        ...(tier !== undefined ? { tier } : {}),
      }
    }
    if (reply.jpeg !== undefined) {
      return {
        jpeg: Buffer.from(reply.jpeg, 'base64'),
        width: reply.width,
        height: reply.height,
        ...(tier !== undefined ? { tier } : {}),
      }
    }
    if (reply.bytes !== undefined) {
      return {
        jpeg: await encodeRgbCropToJpeg(Buffer.from(reply.bytes), reply.width, reply.height),
        width: reply.width,
        height: reply.height,
        ...(tier !== undefined ? { tier } : {}),
      }
    }
    return null
  }
  // Reply → decoded full frame. Shared by both full-frame normalizers so the
  // RGB materialisation happens in exactly one place.
  const replyToDecodedFrame = (rgb: NativeCropRgb): DecodedFrame => ({
    data: rgb.bytes,
    width: rgb.width,
    height: rgb.height,
    format: 'rgb',
    timestamp: 0,
  })
  const replyToFullFrame: NativeCropNormalizer<DecodedFrame> = async (reply) => {
    const rgb = await cropReplyToRgb(reply)
    return rgb === null ? null : replyToDecodedFrame(rgb)
  }
  const replyToTieredFullFrame: NativeCropNormalizer<TieredFullFrame> = async (reply) => {
    const rgb = await cropReplyToRgb(reply)
    if (rgb === null) return null
    return {
      frame: replyToDecodedFrame(rgb),
      tier: reply.tier === 'ram-fullframe' ? 'ram-fullframe' : 'native',
    }
  }
  // Full-frame fetch by handle → the runner's FULL-FRAME `getNativeCrop`
  // (bbox {0,0,1,1}), routed by `handle.nodeId`. Same-node in-process / UDS;
  // cross-node Moleculer. Replaces the old shm read / `decoder.getFrame`.
  const getRemoteFrame = async (handle: FrameHandle): Promise<DecodedFrame | null> =>
    // `closeWindowAfter`: this path never reaches `bumpCropMetric`, so without
    // it a process whose traffic is full frames publishes no window at all.
    closeWindowAfter(requestNativeCrop(handle, FULL_FRAME_BBOX, handle.width, replyToFullFrame))
  // Full NATIVE frame by handle: `getNativeCrop` full-frame WITH an explicit
  // `maxWidth` routes tier-1 (the retained native surface downscaled worker-side
  // to `maxWidth`), NOT the ≤640 RAM store. Routed by `handle.nodeId`; `null` on
  // any miss/version-skew.
  //
  // THROWS, deliberately — see {@link requestNativeCrop}: a routing failure
  // reaches the caller as an exception so it is never mistaken for a miss.
  // `event-media-dispatcher.ts` and the debug crop in `index.ts` catch it
  // themselves; the DISPLAY fallback, which needs a `null` instead, does its
  // own catch at the wiring below.
  //
  // Tier-agnostic: the event snapshot and the boxed timeline tiles
  // legitimately accept the ≤640 fallback (honest low-res), so the tier is not
  // even read.
  const getNativeFullFrameRgb = async (
    handle: FrameHandle,
    maxWidth: number,
  ): Promise<DecodedFrame | null> =>
    closeWindowAfter(requestNativeCrop(handle, FULL_FRAME_BBOX, maxWidth, replyToFullFrame))
  // The same full-frame request, arriving as the wire JPEG (no decode here).
  // For the boxed timeline tiles, whose destination is a stored JPEG: the draw
  // and the encode run in one libvips pipeline (`drawBoxedJpeg`). Throws, like
  // the RGB twin.
  const getNativeFullFrameJpeg = async (
    handle: FrameHandle,
    maxWidth: number,
  ): Promise<NativeCropJpeg | null> =>
    closeWindowAfter(requestNativeCrop(handle, FULL_FRAME_BBOX, maxWidth, cropReplyToJpeg))
  // The same fetch PLUS the source tier, for the one caller that reads it: the
  // display crop's fallback leg names its `reason` (`keyframe-native` vs
  // `detection-raster`) from it. Absent `tier` (pre-tier runner) collapses to
  // `'native'`. Throws exactly like {@link getNativeFullFrameRgb}.
  const fetchNativeFullFrameTiered = async (
    handle: FrameHandle,
    maxWidth: number,
  ): Promise<TieredFullFrame | null> =>
    closeWindowAfter(requestNativeCrop(handle, FULL_FRAME_BBOX, maxWidth, replyToTieredFullFrame))
  // Throttled native-crop HIT vs detection-frame FALLBACK metric — confirms
  // the worker retention window is adequate in production.
  const cropMetricLogger = logger.child('NativeCrop')
  let nativeHits = 0
  let nativeFallbacks = 0
  let lastCropMetricAt = 0
  // Wire calls by payload class, drained with the window (D470). These count
  // REQUESTS, so they are directly comparable with hub-main's
  // `socketTopActions` call column for `pipeline-runner.getNativeCrop`.
  let roiFetches = 0
  let fullFrames = 0
  let nativeFullFrames = 0
  const bumpCropMetric = (hit: boolean): void => {
    if (hit) nativeHits += 1
    else nativeFallbacks += 1
    maybeLogCropWindow()
  }
  /**
   * Publish the window once `request` has SETTLED — never before, or the line
   * carries a window whose own outcome has not been counted yet and throttles
   * away the one that has. `finally`, so the deliberate throw of the
   * full-frame fetches still reaches their callers.
   */
  const closeWindowAfter = async <T>(request: Promise<T>): Promise<T> => {
    try {
      return await request
    } finally {
      maybeLogCropWindow()
    }
  }
  // Emitted from BOTH the ROI path and the full-frame path: until D470 the
  // window line only ever fired on an ROI outcome, so a process whose traffic
  // was entirely full frames — which is what this one turned out to be —
  // logged its crop window at the rate of its smallest consumer.
  const maybeLogCropWindow = (): void => {
    const now = Date.now()
    if (now - lastCropMetricAt < NATIVE_CROP_METRIC_INTERVAL_MS) return
    lastCropMetricAt = now
    // The dedupe's own tally rides the SAME window, so "how many crops did we
    // want" and "how many crossed the wire" are read off one line instead of
    // being correlated by hand. Without it the only evidence for the dedupe is
    // the router's RSS, which is allocator residue and answers a different
    // question.
    const dedupe = cropDedupe.drainCounts()
    cropMetricLogger.info('native-crop window', {
      meta: {
        nativeHits,
        detectionFrameFallbacks: nativeFallbacks,
        wireFetches: dedupe.fetched,
        coalesced: dedupe.coalesced,
        reusedInWindow: dedupe.reused,
        // Every `getNativeCrop` this process issued in the window, by payload
        // class. `roiCalls` is the deduped path (`wireFetches` is its post-
        // dedupe half); the other two bypass the dedupe entirely.
        roiCalls: roiFetches,
        tileFullFrameCalls: fullFrames,
        nativeFullFrameCalls: nativeFullFrames,
      },
    })
    roiFetches = 0
    fullFrames = 0
    nativeFullFrames = 0
  }
  // ONE ROI round-trip, shared by both arrival shapes below: ask the owning
  // runner (routed by `handle.nodeId`) for the padded ROI cut from its retained
  // native surface, and answer `null` on any miss/error. Only the request and
  // its failure handling live here — how the reply is READ is the caller's, so
  // the two shapes can never drift into asking the runner for two different
  // things.
  //
  // The reply's dims are the RC-2 provenance signal on both shapes: a genuine
  // native hit returns the ROI in NATIVE pixel space, whereas the runner's ≤640
  // RAM-store fallback returns it at detection-frame (≤640) scale — for a small
  // subject box that is a tiny (e.g. 47px) stamp indistinguishable from a native
  // hit unless we inspect the width.
  //
  // THROWS. A transport/routing failure reaches the caller as an exception on
  // purpose: on 2026-08-06 telling `error` from `native-miss` was the whole
  // finding — 403 of the day's key-frame misses (the key frame was fetched
  // here until D422) were `getNativeCrop not routable to node <X>:
  // node-offline`, one offline laptop, invisible while it was swallowed. The
  // full-frame fetches keep that contract for their callers
  // ({@link getNativeFullFrameRgb}). A caller that wants a miss instead uses
  // {@link tryRequestNativeCrop}.
  const requestNativeCrop = async <TShape>(
    frameHandle: FrameHandle,
    bbox: NormalizedCropRegion,
    maxWidth: number | undefined,
    normalize: NativeCropNormalizer<TShape>,
  ): Promise<TShape | null> => {
    if (!pipelineRunnerApi?.getNativeCrop) return null
    // EVERY `getNativeCrop` this addon issues is counted here, split by the
    // shape that decides the payload size (D470). The dedupe's `wireFetches`
    // counts ONLY the ROI path — it is the only path routed through it — and
    // on 2026-09-12 that read 13/min while hub-main's `socketTopActions` read
    // 135/min for this action at ~970 kB each. The 122 that made up 97% of the
    // bytes were full frames, and no counter on this side could see them: the
    // investigation had to be done by dividing bytes by calls.
    if (isFullFrameBbox(bbox)) {
      if (maxWidth !== undefined && maxWidth > FULL_FRAME_TILE_WIDTH_CEILING) nativeFullFrames += 1
      else fullFrames += 1
    } else {
      roiFetches += 1
    }
    const native = await pipelineRunnerApi.getNativeCrop.query(
      {
        handle: frameHandle,
        bbox,
        ...(maxWidth !== undefined ? { maxWidth } : {}),
        encodeJpeg: wantJpeg(frameHandle),
        // We read bytes (D462). The very next thing this file used to do with
        // `jpeg` was `Buffer.from(reply.jpeg, 'base64')` — the string existed
        // only because the schema said so, and it cost the relay a
        // multi-megabyte old-space allocation per call.
        acceptJpegBytes: true,
      },
      nodePin(frameHandle.nodeId),
    )
    if (!native || native.width <= 0 || native.height <= 0) return null
    return await normalize(native)
  }
  // The SAME request, with every failure — routing, or a reply that will not
  // DECODE — collapsed to `null`. For the ROI callers, whose contract is
  // "null = miss, retry / fall back" and who have no catch of their own.
  //
  // The NORMALIZER is inside the catch, not outside it: a truncated reply must
  // arrive as that `null` too, or `createDisplayCrop` — which awaits its legs
  // bare — would skip leg 2 and lose a tile the retained frame could still
  // have served.
  /**
   * Bounded and brief on purpose. Coalescing costs nothing; the 1.5 s window
   * holds at most 12 crops in THIS process to keep far more than that off
   * hub-main. It must never grow into the memory it was written to save.
   */
  const cropDedupe = new NativeCropDedupe<NativeCropJpeg>({
    now: () => Date.now(),
    ttlMs: 1_500,
    maxEntries: 12,
  })

  const tryRequestNativeCrop = async <TShape>(
    frameHandle: FrameHandle,
    bbox: NormalizedCropRegion,
    maxWidth: number | undefined,
    normalize: NativeCropNormalizer<TShape>,
  ): Promise<TShape | null> => {
    try {
      return await requestNativeCrop(frameHandle, bbox, maxWidth, normalize)
    } catch (err) {
      cropMetricLogger.debug('native crop request failed — falling back', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }
  // The ROI in its wire JPEG form. This is now the ONLY ROI fetch: after F1b
  // every ROI consumer's destination is a stored (or handed-on) JPEG, and the
  // raw-RGB ROI fetch that used to sit here had no callers left.
  const fetchNativeCropJpeg = async (
    frameHandle: FrameHandle,
    paddedNorm: NormalizedCropRegion,
    maxWidth?: number,
  ): Promise<NativeCropJpeg | null> =>
    // ONE wire request per (frame, region, size). Face, plate, clip, detail and
    // the best shot all pull ROIs by handle, and every reply crosses hub-main as
    // a msgpack buffer — 81% of its outbound bytes, and the reason that process
    // sits ~12% above its RSS budget with a recurring stop-the-world reclaim.
    //
    // The WHOLE reply is what is shared, not just the bytes: the tier gate in
    // `getNativeCropJpeg` reads `reply.tier`, so a coalesced caller must see the
    // same reply the gate would have seen. See `native-crop-dedupe.ts`.
    cropDedupe.run(frameHandle, paddedNorm, maxWidth, () =>
      tryRequestNativeCrop(frameHandle, paddedNorm, maxWidth, cropReplyToJpeg),
    )

  // Best-effort NATIVE-resolution crop as JPEG (no size floor: a full-frame
  // ROI legitimately spans the whole raster). Returns
  // a JPEG on a hit, `null` on any miss/error → fall back.
  //
  // PASS-THROUGH. Every `captureCrop` consumer hands this buffer on as opaque
  // JPEG: `persistObjectEmbeddingBests` stores it (`mediaStore.putReplacing`),
  // `captureCropBase64` base64s it into `runDetailSubtree({ cropJpeg })` where
  // the RUNNER decodes it (D52), and the confirmation gate ships it to
  // `pipelineExecutor.runPipeline({ image })` which decodes it too. Not one of
  // them reads a pixel here.
  const tryNativeCrop = async (
    frameHandle: FrameHandle,
    paddedNorm: NormalizedCropRegion,
    maxWidth?: number,
  ): Promise<Buffer | null> => {
    const native = await fetchNativeCropJpeg(frameHandle, paddedNorm, maxWidth)
    return native?.jpeg ?? null
  }
  // Event/track subject crops (crop/thumbnail/faceCrop/plateCrop) fetch their
  // square-safe ROI from the runner's NATIVE surface. NATIVE-OR-NOTHING: on any
  // miss/error — OR a `ram-fullframe` tier — we return null (dispatcher SKIPS
  // the write and retries per-frame) — never an upscaled ≤640 tile. `maxWidth` is OPTIONAL and OMITTED by the
  // subject-crop callers (uncapped true-native crop, decision #3); the RC-2
  // width floor is gone (an uncapped native ROI legitimately spans any size).
  //
  // PASS-THROUGH. Both consumers hand this buffer on as opaque JPEG:
  // `cropSubjectRegion` returns it straight to the event-media write, and
  // `cropSubjectVariants` feeds it to `composeWideCentralSquareThumbnail`,
  // which reads `sharp(slab).metadata()` and — whenever the window is fully in
  // frame, which after the 2026-07-31 slide it almost always is — returns the
  // slab VERBATIM. Neither reads a pixel here.
  //
  // The TIER GATE below is unaffected by the shape: it reads `reply.tier`, a
  // field, and the log's `servedWidth`/`servedHeight` are the reply's own dims.
  const getNativeCropJpeg = async (
    frameHandle: FrameHandle,
    normalizedBbox: NormalizedCropRegion,
    maxWidth?: number,
    deviceId?: number,
  ): Promise<Buffer | null> => {
    const native = await fetchNativeCropJpeg(frameHandle, normalizedBbox, maxWidth)
    if (!native) {
      bumpCropMetric(false)
      return null
    }
    // TIER GATE — only an explicit `ram-fullframe` is refused; an ABSENT tier
    // (pre-tier runner, mixed-version cluster) is accepted. A subject crop is
    // NATIVE-OR-NOTHING by contract (`pipeline-runner.cap.ts`), and this path
    // is reachable: the runner decides "full frame" from the BBOX, so a 16:9
    // best-shot window that spans the whole raster (a large or full-frame
    // subject) skips the native lease and is served from the ≤640 RAM store.
    // Accepting it stores a best shot pinned at detection resolution and calls
    // it native. On a refusal the caller's own retry runs, and at close the
    // keyFrame-derived thumbnail already covers the track.
    if (native.tier === 'ram-fullframe') {
      bumpCropMetric(false)
      cropMetricLogger.info('subject crop refused: sub-native tier (will retry, no masquerade)', {
        ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
        meta: {
          tier: native.tier,
          handle: `${frameHandle.shmId}#${frameHandle.slot}#${frameHandle.seq}`,
          handleNodeId: frameHandle.nodeId,
          servedWidth: native.width,
          servedHeight: native.height,
        },
      })
      return null
    }
    bumpCropMetric(true)
    return native.jpeg
  }
  // ENRICHMENT crops (face / plate / clip / detail classifier) are
  // NATIVE-STRICT by handle (S4): native-first via `tryNativeCrop`, and on a
  // native miss they return `null` — the enrichment round for that frame is
  // SKIPPED (logged) and the detail scheduler re-runs on a later frame. The
  // old ≤640 `extractCrop` detection-raster fallback is retired: an upscaled /
  // low-res crop must NEVER be fed to the recognition models.
  const captureCrop = createCaptureCrop({
    tryNativeCrop,
    bumpCropMetric,
    // Per-CAMERA hit/miss counter behind `failure-contribution`. The throttled
    // `native-crop window` line above stays exactly as it is: it is process-
    // global and has no `deviceId`, so it can say the fleet is missing 25% of
    // its crops and never say which camera (`key-frame-metrics.ts` documents
    // what that cost). Optional so a caller without counters degrades to the
    // pre-counter behaviour instead of failing to construct.
    ...(deps.noteCropOutcome !== undefined ? { noteCropOutcome: deps.noteCropOutcome } : {}),
    logger: logger.child('CaptureCrop'),
  })
  // DISPLAY crops (plate/face gallery tiles) get a BOUNDED fallback the
  // native-strict `captureCrop` refuses: on a native-ROI miss they crop the
  // SAME padded ROI out of the retained full frame (keyframe-native tier, or
  // the runner's ≤640 RAM tier — honest sub-native, NEVER upscaled) so the
  // gallery always has a visible image. Model-input crops keep `captureCrop`.
  // `fetchFallbackFrame` tags the tier as the log reason.
  //
  // ONE leg passes through and ONE leg crops — see the table in
  // `pipeline/display-crop.ts`, which is where that distinction is written down.
  // Leg 1's ROI was cut by the runner, so it is handed on (F1b); leg 2 is a
  // whole FRAME, so it keeps its pixels and its decode.
  const captureDisplayCrop: DisplayCropFn = createDisplayCrop({
    fetchNativeRoiJpeg: async (handle, norm, maxWidth) =>
      (await fetchNativeCropJpeg(handle, norm, maxWidth))?.jpeg ?? null,
    fetchFallbackFrame: async (handle) => {
      // The display crop's contract is `null`, never a throw — and
      // `fetchNativeFullFrameTiered` throws on purpose (see its note).
      // The translation happens HERE, at the one caller that wants it, and the
      // dropped branch is named rather than silent.
      const tiered = await fetchNativeFullFrameTiered(handle, DISPLAY_FALLBACK_MAX_WIDTH).catch(
        (err: unknown) => {
          logger
            .child('DisplayCrop')
            .debug('fallback full-frame fetch failed — treating as a miss', {
              meta: { nodeId: handle.nodeId, error: errMsg(err) },
            })
          return null
        },
      )
      if (!tiered || tiered.frame.format !== 'rgb') return null
      return {
        frame: {
          // NOT copied — `cropReplyToRgb` just allocated this buffer and no one
          // else holds it. `extractCrop` only reads it.
          bytes: tiered.frame.data,
          width: tiered.frame.width,
          height: tiered.frame.height,
        },
        reason: tiered.tier === 'ram-fullframe' ? 'detection-raster' : 'keyframe-native',
      }
    },
    cropRegionToJpeg: async (bytes, w, h, norm) => (await extractCrop(bytes, w, h, norm)).crop,
    logger: logger.child('DisplayCrop'),
  })

  return {
    getRemoteFrame,
    getNativeFullFrameRgb,
    getNativeFullFrameJpeg,
    getNativeCropJpeg,
    captureCrop,
    captureDisplayCrop,
  }
}
