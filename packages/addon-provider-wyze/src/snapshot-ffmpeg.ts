/**
 * Decode a raw Annex-B keyframe (H264 or H265) into a single JPEG via
 * ffmpeg. The Wyze lib's `grabKeyframe()` yields raw Annex-B IDR bytes;
 * we pipe them through ffmpeg's image2 muxer to get a JPEG.
 *
 * Pure module: takes a `spawn`-like factory so the ffmpeg invocation is
 * unit-testable and the addon can inject a resolved binary path.
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export type SpawnLike = (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams

export interface KeyframeToJpegOptions {
  /** The lib's `videoType` — selects the ffmpeg `-f` demuxer. */
  readonly videoType: 'H264' | 'H265'
  /** The node's pinned ffmpeg (D540). Required: there is no PATH default. */
  readonly ffmpegPath: string
  /** Hard cap before the child is killed. */
  readonly timeoutMs?: number
  /** Injectable for tests; defaults to node's `spawn`. */
  readonly spawnFn?: SpawnLike
}

/**
 * The ffmpeg input demuxer for a Wyze `videoType`. H265 Annex-B uses the
 * `hevc` demuxer; H264 uses `h264`.
 */
export function ffmpegInputFormat(videoType: 'H264' | 'H265'): 'h264' | 'hevc' {
  return videoType === 'H265' ? 'hevc' : 'h264'
}

/** Build the ffmpeg argument vector for a one-frame JPEG transcode. */
export function buildKeyframeJpegArgs(videoType: 'H264' | 'H265'): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    ffmpegInputFormat(videoType),
    '-i',
    'pipe:0',
    '-frames:v',
    '1',
    '-q:v',
    '2',
    '-f',
    'image2',
    'pipe:1',
  ]
}

/**
 * Transcode a raw Annex-B keyframe to a JPEG buffer. Rejects on a
 * non-zero ffmpeg exit, an empty output, or timeout.
 */
export async function keyframeToJpeg(annexB: Buffer, opts: KeyframeToJpegOptions): Promise<Buffer> {
  const spawnFn = opts.spawnFn ?? spawn
  const ffmpegPath = opts.ffmpegPath
  const timeoutMs = opts.timeoutMs ?? 8000
  const args = buildKeyframeJpegArgs(opts.videoType)

  return new Promise<Buffer>((resolve, reject) => {
    const proc = spawnFn(ffmpegPath, args)
    const chunks: Buffer[] = []
    const stderr: string[] = []
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      reject(new Error(`ffmpeg snapshot timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    proc.stdout.on('data', (d: Buffer) => chunks.push(d))
    proc.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))
    proc.on('error', (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const out = Buffer.concat(chunks)
      if (code === 0 && out.length > 0) {
        resolve(out)
        return
      }
      reject(
        new Error(
          `ffmpeg snapshot failed (exit ${code ?? 'null'}, ${out.length} bytes): ${stderr.join('').slice(0, 200)}`,
        ),
      )
    })

    proc.stdin.on('error', () => {
      /* EPIPE if ffmpeg exits early — the close handler reports the real error */
    })
    proc.stdin.write(annexB)
    proc.stdin.end()
  })
}
