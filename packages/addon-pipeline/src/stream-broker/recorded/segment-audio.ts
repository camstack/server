/**
 * segment-audio — turn one `.m4s` fragment's audio into 8 kHz µ-law (PCMU)
 * access units, matching the WebRTC audio sender's negotiated codec
 * (`audio/PCMU`, 8 kHz, PT 0 — see session.ts). Recorded audio is stored as AAC
 * (the recorder transcodes every camera's audio to AAC); WebRTC speaks PCMU.
 *
 * Implementation: run the fragment through
 * `ffmpeg -vn -ar 8000 -ac 1 -c:a pcm_mulaw -f mulaw` (a crash-isolated
 * subprocess — this replaced the old in-process `node-av` `DecodeRuntime`
 * decode + hand-rolled µ-law companding). ffmpeg decodes the AAC, resamples to
 * 8 kHz mono, and companded µ-law bytes come out on stdout; we slice them into
 * fixed 20 ms (160-sample) PCMU frames here.
 *
 * Output: 20 ms PCMU frames with segment-relative `ptsMs`, ready to push on the
 * session's audio sender alongside the recorded video.
 *
 * Best-effort by contract: returns [] when the fragment has no usable audio
 * (ffmpeg exits non-zero → tolerated, empty output), and the caller swallows
 * throws — recorded audio must NEVER block recorded video.
 */
import { runFfmpegOnce } from './ffmpeg-run-once.js'

/** A single PCMU (µ-law, 8 kHz) audio access unit (one 20 ms frame). */
export interface PcmuAccessUnit {
  /** 160 µ-law bytes (20 ms @ 8 kHz mono). */
  readonly data: Uint8Array
  /** Source presentation time in milliseconds (segment-relative). */
  readonly ptsMs: number
}

/** PCMU target: 8 kHz mono, 160 samples (20 ms) per RTP frame. */
const FRAME_SAMPLES = 160
const FRAME_MS = 20

/**
 * ffmpeg arguments to decode one `.m4s` fragment's audio (read from stdin) into
 * raw 8 kHz mono µ-law bytes on stdout. `-vn` drops video (handled by
 * `segment-demux`); `-c:a pcm_mulaw -f mulaw` companded output = one byte per
 * 8 kHz sample. Exported for the spec.
 */
export const SEGMENT_AUDIO_FFMPEG_ARGS: readonly string[] = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  'pipe:0',
  '-vn',
  '-map',
  '0:a:0',
  '-ar',
  '8000',
  '-ac',
  '1',
  '-c:a',
  'pcm_mulaw',
  '-f',
  'mulaw',
  'pipe:1',
]

/**
 * Slice a contiguous 8 kHz µ-law byte stream (one byte per sample) into fixed
 * 160-sample (20 ms) PCMU frames, dropping any trailing partial frame. `ptsMs`
 * is derived from the running frame index — audio is continuous 8 kHz, and each
 * recorded segment re-anchors its own timeline downstream, so the frames start
 * at 0 (segment-relative). Pure, so it unit-tests without ffmpeg.
 */
export function sliceMuLawToPcmuFrames(mulaw: Uint8Array): PcmuAccessUnit[] {
  const out: PcmuAccessUnit[] = []
  for (let off = 0, idx = 0; off + FRAME_SAMPLES <= mulaw.length; off += FRAME_SAMPLES, idx++) {
    out.push({
      data: mulaw.slice(off, off + FRAME_SAMPLES),
      ptsMs: idx * FRAME_MS,
    })
  }
  return out
}

/**
 * Decode + resample one fragment's audio into PCMU access units. Returns []
 * when there is no usable audio stream (video-only fragment, or a codec ffmpeg
 * can't decode) — ffmpeg exits non-zero, which is tolerated as empty output.
 *
 * @param bytes - The full `.m4s` fragment.
 * @param ffmpegPath - The node's pinned ffmpeg (D540). Required: no PATH default.
 */
export async function demuxSegmentToPcmu(
  bytes: Uint8Array,
  ffmpegPath: string,
): Promise<PcmuAccessUnit[]> {
  const mulaw = await runFfmpegOnce({
    ffmpegPath,
    args: SEGMENT_AUDIO_FFMPEG_ARGS,
    input: bytes,
    // A video-only fragment makes ffmpeg exit non-zero (no audio stream to map);
    // treat that as "no audio", never a throw — audio is best-effort.
    tolerateNonZeroExit: true,
  })
  if (mulaw.length === 0) return []
  return sliceMuLawToPcmuFrames(mulaw)
}
