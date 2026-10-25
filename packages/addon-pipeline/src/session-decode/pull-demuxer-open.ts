/**
 * How the pull decode worker OPENS its demuxer — and why it does not re-probe
 * what it was already told.
 *
 * ## The cost this exists to remove
 *
 * A cold detection session is ~5.25 s at the median from attach to first
 * decoded frame, and `forkToFrameMs` is ~4.7 s of it. A trace on device 102
 * split that as: fork + module load 0.20 s, RTSP dial 0.05 s, the restreamer's
 * join burst fully drained by 0.41 s — and then the FIRST decoded frame at
 * 3.17 s. Nothing was waiting on the camera: a keyframe-first GOP had already
 * been delivered and sat inside libav.
 *
 * What sits in that gap is `avformat_find_stream_info`. For an RTP/RTSP input
 * the container declares no frame rate, so the probe keeps reading until it has
 * estimated one — it drains the burst in milliseconds and then waits on LIVE
 * packets arriving at camera rate. At 5.9-8.3 fps that wait is seconds, and it
 * is paid again on every re-dial (the coordinator's give-up docblock already
 * names "the RTSP setup and the probe it has already paid for").
 *
 * ## Why the probe is redundant here, specifically
 *
 * The worker never dials a camera. It dials the BROKER'S OWN RTSP restream, and
 * that restreamer refuses PLAY until it has the parameter sets
 * (`RtspRestreamer.isReady()` requires `codecParams`, set only once SPS+PPS —
 * or VPS+SPS+PPS — have been collected). Its SDP is then built by
 * `sdp-builder.ts`, which always emits `sprop-parameter-sets`. So by
 * construction: if `avformat_open_input` succeeded against this URL, libav's
 * RTSP demuxer has already parsed an SDP that fully describes the video stream
 * and has populated `codecpar` (codec id + extradata) from it. The probe then
 * spends seconds re-deriving what the SDP said.
 *
 * `skipStreamInfo: true` therefore skips a redundant probe, not a necessary
 * one — and `parseExtradata()` fills width/height/pix_fmt from the SPS we were
 * handed, in memory, with no I/O. That is the whole lever: **use the
 * parameters, do not re-read the stream.**
 *
 * ## What this deliberately is NOT
 *
 * It is NOT the AnnexB seed push the broker's frame-handle plane used (removed,
 * D762). That path handed the decoder a hand-depacketized BYTE STREAM, and on
 * Reolink's 4K FU-A-fragmented rfc4571 it produced zero decodable frames —
 * which is the entire reason pull mode exists
 * (`docs/design/decode-path.md`, "Push mode vs PULL mode"). Passing PARAMETERS
 * is not passing a STREAM: libav still demuxes the RTP itself, byte for byte as
 * before. Only the redundant re-derivation is dropped.
 *
 * ## The fallback, and why it is a fallback and not a guess
 *
 * If the opened input does NOT describe a video stream with extradata — a URL
 * that is not the broker restream, a future container that needs probing, a
 * restreamer that somehow served a parameter-set-free SDP — this re-opens WITH
 * the probe and says so. A session that starts slowly is a regression in
 * latency; a session that starts wrong is a camera that detects nothing, and
 * this path has shipped that failure before.
 *
 * The rollback is `CAMSTACK_DECODE_PROBE_STREAM_INFO=1` (read by the worker,
 * passed in as `forceStreamInfoProbe`): it restores the unconditional probe
 * inline, with no deploy. That flag is also the A/B — `demuxerOpenMs` with it
 * set minus `demuxerOpenMs` with it clear IS the probe's measured cost.
 */

/** The subset of a node-av `CodecParameters` this seam reads. */
export interface PullCodecParametersLike {
  /**
   * Bytes of codec extradata the CONTAINER supplied — for an RTSP input, the
   * SPS/PPS (or VPS/SPS/PPS) libav decoded out of the SDP's `sprop-*` fmtp
   * attributes. Zero means the open told us nothing about the codec, which is
   * the only condition under which the probe is still worth its seconds.
   */
  readonly extradataSize: number
  /**
   * Fill width / height / pixel format from `extradata`. A pure in-memory parse
   * of the SPS — no I/O, no packet reads. This is the work
   * `avformat_find_stream_info` would have done for us, minus the waiting.
   * Returns an ffmpeg error code (negative on failure).
   */
  parseExtradata(): number
}

/** The subset of a node-av `Stream` this seam reads. */
export interface PullVideoStreamLike {
  readonly codecpar: PullCodecParametersLike
}

/**
 * The subset of a node-av `Demuxer` this seam uses.
 *
 * Deliberately narrow, and deliberately NOT part of the return type: the caller
 * gets its own concrete demuxer back and calls `video()` on THAT, so the real
 * `Stream` type reaches `Decoder.create` without a cast.
 */
export interface PullDemuxerLike {
  video(): PullVideoStreamLike | undefined
  [Symbol.dispose]?(): void
}

/** The `Demuxer.open` options this seam sets. */
export interface PullDemuxerOpenOptions {
  readonly options: Record<string, string>
  readonly signal: AbortSignal
  readonly skipStreamInfo: boolean
}

/** Injected `Demuxer.open`. Generic so the caller keeps its concrete demuxer type. */
export type PullDemuxerOpener<TDemuxer extends PullDemuxerLike> = (
  url: string,
  options: PullDemuxerOpenOptions,
) => Promise<TDemuxer>

/** Inputs for {@link openPullDemuxer}. */
export interface OpenPullDemuxerParams<TDemuxer extends PullDemuxerLike> {
  readonly url: string
  /** The demuxer/protocol options dictionary (`rtsp_transport`, `probesize`, …). */
  readonly demuxerOptions: Record<string, string>
  readonly signal: AbortSignal
  readonly open: PullDemuxerOpener<TDemuxer>
  /** `CAMSTACK_DECODE_PROBE_STREAM_INFO=1` — restore the unconditional probe. */
  readonly forceStreamInfoProbe: boolean
  /**
   * Diagnostic sink. Written ONLY when the fast path is abandoned or the SPS
   * parse fails — never once per dial. A branch that silently falls back to the
   * expensive path reads as "the fast path did not help".
   */
  readonly note: (message: string) => void
}

/** Outcome of {@link openPullDemuxer}. */
export interface PullDemuxerOpenResult<TDemuxer extends PullDemuxerLike> {
  readonly demuxer: TDemuxer
  /**
   * Wall time spent inside `Demuxer.open`, summed over both attempts when the
   * fallback fired.
   *
   * With `streamInfoProbed: false` this is `avformat_open_input` alone — the
   * RTSP DESCRIBE/SETUP/PLAY handshake, including any time the restreamer held
   * PLAY waiting for its source. With `streamInfoProbed: true` it ALSO contains
   * `avformat_find_stream_info`. The two readings are not the same measurement,
   * which is exactly why the boolean travels with the number.
   */
  readonly demuxerOpenMs: number
  /** Whether `avformat_find_stream_info` actually ran. */
  readonly streamInfoProbed: boolean
}

/**
 * Open the pull input, skipping `avformat_find_stream_info` when the opened
 * container already describes its video stream.
 *
 * The demuxer is returned even when no video stream was found: disposing it is
 * the caller's existing `closeInput()` responsibility, and taking that over
 * here would double-free.
 */
export async function openPullDemuxer<TDemuxer extends PullDemuxerLike>(
  params: OpenPullDemuxerParams<TDemuxer>,
): Promise<PullDemuxerOpenResult<TDemuxer>> {
  const startedAt = Date.now()

  if (params.forceStreamInfoProbe) {
    const demuxer = await params.open(params.url, {
      options: params.demuxerOptions,
      signal: params.signal,
      skipStreamInfo: false,
    })
    return { demuxer, demuxerOpenMs: Date.now() - startedAt, streamInfoProbed: true }
  }

  const demuxer = await params.open(params.url, {
    options: params.demuxerOptions,
    signal: params.signal,
    skipStreamInfo: true,
  })
  const videoStream = demuxer.video()
  if (videoStream && videoStream.codecpar.extradataSize > 0) {
    // The SDP already carried the parameter sets. Derive geometry from them
    // instead of reading packets for it.
    const parsed = videoStream.codecpar.parseExtradata()
    if (parsed < 0) {
      // Not fatal — the decoder parses the SPS itself on its first packet, and
      // every filtergraph in this worker is built from the DECODED frame's
      // dimensions, never the stream's. Still said out loud: a silent parse
      // failure here is how "the fast path is fine" stops being checkable.
      params.note(
        `decode-worker-child: SPS parse from SDP extradata failed (${parsed}) — ` +
          'decoding anyway, geometry comes from the first decoded frame\n',
      )
    }
    return { demuxer, demuxerOpenMs: Date.now() - startedAt, streamInfoProbed: false }
  }

  // Nothing usable came out of the open. Pay the probe rather than hand
  // `Decoder.create` a stream nobody described.
  params.note(
    'decode-worker-child: opened input did not describe a video stream ' +
      `(videoStream=${videoStream ? 'present' : 'absent'}, ` +
      `extradataSize=${videoStream?.codecpar.extradataSize ?? 0}) — ` +
      're-opening WITH the stream-info probe\n',
  )
  demuxer[Symbol.dispose]?.()
  const probed = await params.open(params.url, {
    options: params.demuxerOptions,
    signal: params.signal,
    skipStreamInfo: false,
  })
  return { demuxer: probed, demuxerOpenMs: Date.now() - startedAt, streamInfoProbed: true }
}
