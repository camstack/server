/**
 * Pull-based frame-plane interfaces for session-decode pipeline.
 * Codec-agnostic contract for both worker and coordinator implementations.
 */

/**
 * A bounding box in NORMALIZED [0,1] frame coordinates ({@link NormalizedBbox}).
 * The decode worker resolves it against the RETAINED native frame's real pixel
 * dimensions, so a caller crops at native resolution knowing only the
 * detection-res bbox divided by the detection-res dims.
 */
export interface NormalizedBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** The rgb pixels + actual dimensions of a native-resolution crop. */
export interface NativeCropResult {
  readonly bytes: Uint8Array
  readonly width: number
  readonly height: number
  /**
   * Internal source for runner telemetry. Public `getNativeCrop.tier` cannot
   * name `tile` (cap is `native | ram-fullframe`); tile is still native-res.
   */
  readonly source?: 'lease' | 'tile'
}

/**
 * The outcome of ONE native-crop round trip: the pixels, or the miss WITH the
 * worker's own account of it.
 *
 * A bare `null` was the shape here until 2026-09-07, and it is why every miss
 * on this cluster reached the operator as the single word `worker-lease-gone`.
 * The worker distinguishes four failures with four different fixes — nothing
 * retained for the frame, a rectangle no tile contains, retention switched off,
 * a cut that outran its encode — names them precisely, and the only place that
 * string survived was a `debug` line with no `deviceId` tag. So a per-camera
 * query returned misses and no reasons, and 2 223 of 2 223 misses in a 3 h
 * window looked identical.
 *
 * The reason travels WITH the outcome for the same reason the tier does: the
 * runner is the side that knows the round trip and the caller is the side that
 * knows the consequence, and until both halves are on one line neither can be
 * read. `workerReason` is diagnostic only — nothing branches on its text.
 */
export type NativeCropAttempt =
  | { readonly kind: 'crop'; readonly crop: NativeCropResult }
  | { readonly kind: 'miss'; readonly workerReason?: string }

/**
 * Represents a single video frame image with format and buffer capabilities.
 * Supports optional transformations (crop, resize, format conversion) on demand.
 */
export interface FrameImage {
  /**
   * Image width in pixels.
   */
  readonly width: number

  /**
   * Image height in pixels.
   */
  readonly height: number

  /**
   * Pixel format: RGB (24-bit) or grayscale (8-bit).
   */
  readonly format: 'rgb' | 'gray'

  /**
   * The worker-local frame id — the correlation key for a later
   * {@link FrameImage.nativeCrop} of THIS frame, valid until the worker's
   * bounded native-retention ring evicts it. `undefined` for frame sources that
   * do not support native-res crops (e.g. a non-session-decode adapter).
   */
  readonly frameId?: number

  /**
   * Convert image to a buffer with optional transformations.
   * @param opts - Optional crop, resize, and format conversion parameters.
   * @returns Promise resolving to a Uint8Array buffer.
   */
  toBuffer(opts?: FrameImageOptions): Promise<Uint8Array>

  /**
   * Best-effort NATIVE-resolution crop of `bbox` from THIS frame, downloading
   * ONLY the crop region (never the full native frame). Resolves a typed
   * {@link NativeCropAttempt}: the pixels, or a `miss` carrying the worker's
   * own reason — the caller falls back to a detection-res crop and can finally
   * say WHY. Safe to call after {@link FrameImage.close}: native crops are a
   * distinct, best-effort read that outlives the per-frame `toBuffer` lifetime.
   */
  nativeCrop?(bbox: NormalizedBbox, maxWidth?: number): Promise<NativeCropAttempt>

  /**
   * THIS frame's detections are known: cut one native subject TILE per box and
   * end the hold on the frame.
   *
   * The tiles are what a LATE crop is served from — measured on this cluster
   * the ask arrives 2.2-9.9 s after the frame, long past any window in which
   * holding the raster itself would have been affordable. Each `bbox` is the
   * detection's own box; the source pads it into a container and never derives
   * a model-input rectangle from it (D52).
   *
   * Best-effort, synchronous-return, never awaited: it must not be able to
   * delay the caller. An EMPTY list still ends the hold. Present only for
   * sources that hold native frames.
   */
  cutTiles?(bboxes: readonly NormalizedBbox[]): void

  /**
   * Prompt-release the worker's RAM native-frame hold for THIS frame — the
   * consumer is done cutting native crops from it. Best-effort and idempotent;
   * the hold is also bounded by a frame count, so omitting this only defers
   * reclaim. Present only for frame sources that hold a native frame.
   */
  releaseNativeLease?(): void

  /**
   * Tell the frame source that THIS frame was admitted to inference — i.e. its
   * id can later ride an inference result and be named by a native-crop
   * request. The session-decode worker uses it to lease only the frames a crop
   * can ever ask for (`nativeLeaseAdmission: 'inferred'`); sources without a
   * lease omit it.
   *
   * Call it from the same synchronous turn that received the frame: the
   * worker decides this frame's retention inside the NEXT pull.
   */
  markInferred?(): void

  /**
   * Whether a CONSUMER still holds this frame — somebody who is going to read
   * it (queued, in flight, resolving a view) — as opposed to a holder that only
   * PARKED it for a read that may come later (D656). Called on each transition
   * by the one owner of the image's references (the local frame registry); an
   * image starts consumer-held. A session-decode source uses it to decide what
   * a teardown drain waits for; sources without a drain omit it.
   */
  setPendingConsumer?(pending: boolean): void

  /**
   * Release image resources (GPU textures, shared memory, etc.).
   */
  close(): void
}

/**
 * Options for {@link FrameImage.toBuffer} transformations.
 */
export interface FrameImageOptions {
  /**
   * Optional crop region: { left, top, width, height } in pixels.
   */
  readonly crop?: { left: number; top: number; width: number; height: number }

  /**
   * Optional resize target: { width, height } in pixels.
   * Applied after crop if both specified.
   */
  readonly resize?: { width: number; height: number }

  /**
   * Optional format conversion: RGB, grayscale, or one content-sized JPEG.
   * Defaults to the image's native format.
   */
  readonly format?: 'rgb' | 'gray' | 'jpeg'
}

/**
 * A single video frame with timestamp and associated image data.
 */
export interface VideoFrame {
  /**
   * Frame timestamp in milliseconds (e.g., Date.now() or monotonic clock).
   */
  readonly timestamp: number

  /**
   * Wall clock at which this frame was SHOT, as opposed to decoded.
   *
   * For a live frame the two are the same to within the decode latency, and
   * this is simply the publish instant. For a frame reconstructed out of the
   * restreamer's retained history it is up to a whole pre-roll window earlier —
   * see `media-clock.ts` for the anchor and for why a `Date.now()` here would
   * silently date a track at session open instead of at the moment the subject
   * was there. Absent ⇒ the consumer falls back to its own wall clock.
   */
  readonly capturedAt?: number

  /**
   * True when this frame came out of the session's PRE-ROLL catch-up burst —
   * retained history replayed at session open, not live footage. Consumers
   * route it to the runner's bounded pre-roll lane instead of the latest-only
   * live queue, and never let it delay a live frame.
   */
  readonly preRoll?: boolean

  /**
   * Frame image data.
   */
  readonly image: FrameImage
}

/**
 * Video source descriptor for frame generation.
 */
export interface VideoFrameSource {
  /**
   * Restream URL (RTSP, RTMP, or HTTP) for pulling video.
   */
  readonly restreamUrl: string

  /**
   * Device ID associated with this source.
   */
  readonly deviceId: number

  /**
   * Video codec (e.g., 'h264', 'h265', 'mjpeg').
   */
  readonly codec: string
}

/**
 * Options for video frame generation.
 */
export interface VideoFrameGenOptions {
  /**
   * Target frames per second (optional).
   * If specified, frames are throttled to this rate.
   */
  readonly fps?: number

  /**
   * Milliseconds of retained history this dial ASKED the broker for
   * (`preRollRequestOf`, read back off the url actually dialed). Two things
   * depend on it and nothing else can supply either: it anchors the session's
   * media clock (`media-clock.ts`), and it is the window the catch-up burst
   * plans its stride over (`pre-roll-burst.ts`). Absent or `0` ⇒ no history was
   * asked for, so there is no burst and every frame is live.
   */
  readonly preRollMs?: number

  /**
   * Frames the catch-up burst may send to inference. `0` disables the burst
   * outright — the pre-roll is then still decoded (it is how the dial reaches a
   * decodable GOP) and still discarded, which is the pre-change behaviour.
   */
  readonly preRollMaxFrames?: number

  /**
   * Output pixel format: RGB or grayscale (optional).
   * Defaults to a sensible default per codec/source.
   */
  readonly format?: 'rgb' | 'gray'
}

/**
 * Pull-driven async generator for video frames from a source.
 * Frame production is demand-driven: frame N+1 is not produced
 * until frame N is consumed from the iterator.
 *
 * @example
 * ```ts
 * const source = { restreamUrl: 'rtsp://...', deviceId: 1, codec: 'h264' }
 * const gen = createVideoFrameGenerator()
 * const it = gen.generateVideoFrames(source, { fps: 30 })
 * for await (const frame of it) {
 *   const buf = await frame.image.toBuffer()
 *   await processFrame(buf)
 *   frame.image.close()
 * }
 * ```
 */
export interface VideoFrameGenerator {
  /**
   * Generate video frames from the given source.
   * @param source - Video source descriptor (URL, device ID, codec).
   * @param opts - Generation options (FPS, format).
   * @returns Async generator yielding {@link VideoFrame} objects.
   *          Back-pressure ensures frame N+1 is not produced until frame N is consumed.
   */
  generateVideoFrames(
    source: VideoFrameSource,
    opts: VideoFrameGenOptions,
  ): AsyncGenerator<VideoFrame, void>
}
