/**
 * The encoded stream the `decode` measurement of the node benchmark offers
 * (D1078): built ON the node with its own ffmpeg, once per profile, cached
 * under `<dataDir>/bench/`.
 *
 * Why built here and not downloaded: a profile is a resolution × rate × codec,
 * the list will grow, and a 4K clip per profile per node is a download nobody
 * should wait for when the node can write one in under a minute. The picture
 * is the verified bench clip scaled to the profile when the node has it, and a
 * moving test pattern with noise otherwise — the DECODER's work is set by the
 * resolution, the bit rate and the coding tools, which are the same either way
 * (the cell records which one it was).
 *
 * Shape, chosen to look like a camera's main stream: constant-ish bit rate at
 * a camera's usual figure, one keyframe a second, no B-frames, parameter sets
 * with every keyframe, and an access-unit delimiter before every picture so
 * the file splits into pictures without parsing slices.
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { decodeProfileId, type NodeDecodeProfile } from '@camstack/types'
import { type AccessUnit, splitAccessUnits } from './annexb-access-units.js'

/** Seconds of stream the pacer loops. */
export const DECODE_SOURCE_SECONDS = 12
/** Bumped when the encode arguments change — a cached file of another shape is rebuilt. */
const DECODE_SOURCE_REVISION = 'v1'
const ENCODE_TIMEOUT_MS = 240_000

/** A camera's usual main-stream bit rate for a picture of `pixels`, per codec. */
function bitrateKbps(profile: NodeDecodeProfile): number {
  const megapixels = (profile.width * profile.height) / 1e6
  // 1080p H.264 ≈ 4 Mbit/s, 4K H.265 ≈ 6 Mbit/s — the defaults cameras ship with.
  const perMegapixel = profile.codec === 'h264' ? 2000 : 750
  return Math.max(500, Math.round((megapixels * perMegapixel) / 100) * 100)
}

/** The ffmpeg arguments that write the stream of `profile` to `outFile`. */
export function decodeSourceArgs(
  profile: NodeDecodeProfile,
  clipFile: string | null,
  outFile: string,
): string[] {
  const { width, height, fps, codec } = profile
  const kbps = bitrateKbps(profile)
  const input =
    clipFile === null
      ? ['-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`]
      : ['-stream_loop', '-1', '-i', clipFile]
  const filter =
    clipFile === null
      ? 'noise=alls=10:allf=t,format=yuv420p'
      : `fps=${fps},scale=${width}:${height}:flags=bilinear,format=yuv420p`
  const encoder =
    codec === 'h264'
      ? [
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-profile:v',
          'high',
          '-x264-params',
          `aud=1:keyint=${fps}:min-keyint=${fps}:scenecut=0`,
        ]
      : [
          '-c:v',
          'libx265',
          '-preset',
          'ultrafast',
          '-x265-params',
          `aud=1:keyint=${fps}:min-keyint=${fps}:scenecut=0:repeat-headers=1:log-level=error`,
        ]
  return [
    '-v',
    'error',
    '-y',
    ...input,
    '-t',
    String(DECODE_SOURCE_SECONDS),
    '-an',
    '-vf',
    filter,
    ...encoder,
    '-b:v',
    `${kbps}k`,
    '-maxrate',
    `${kbps}k`,
    '-bufsize',
    `${kbps * 2}k`,
    '-g',
    String(fps),
    '-bf',
    '0',
    '-f',
    codec === 'h264' ? 'h264' : 'hevc',
    outFile,
  ]
}

export interface FfmpegRunResult {
  readonly code: number | null
  readonly stderr: string
}

/** Run ffmpeg to completion (file out); killed past the timeout. */
export function runFfmpegToFile(bin: string, args: readonly string[]): Promise<FfmpegRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const stderr: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), ENCODE_TIMEOUT_MS)
    timer.unref?.()
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr: Buffer.concat(stderr).toString() })
    })
  })
}

export interface DecodeBenchSource {
  readonly profile: NodeDecodeProfile
  readonly accessUnits: readonly AccessUnit[]
  /** What the picture is: the verified bench clip, or the generated pattern. */
  readonly origin: 'bench-clip' | 'synthetic'
}

export type DecodeBenchSourceOutcome =
  | { readonly kind: 'ready'; readonly source: DecodeBenchSource }
  | { readonly kind: 'skipped'; readonly reason: string }

export interface DecodeSourceDeps {
  readonly dataDir: string
  readonly ensureFfmpeg: () => Promise<string>
  /** The verified bench clip on this node, or null when it has none. */
  readonly clipFile: () => Promise<string | null>
  readonly runFfmpeg: (bin: string, args: readonly string[]) => Promise<FfmpegRunResult>
  readonly log: (message: string, meta?: Record<string, unknown>) => void
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readUnits(
  file: string,
  profile: NodeDecodeProfile,
): Promise<readonly AccessUnit[] | null> {
  try {
    const units = splitAccessUnits(await fs.readFile(file), profile.codec)
    // At least a second of pictures, opening on a keyframe — else not a stream to pace.
    return units.length >= profile.fps && units[0]?.keyframe === true ? units : null
  } catch {
    return null
  }
}

/** The stream of `profile`, from the cache or encoded now; a reason when it cannot be had. */
export async function ensureDecodeBenchSource(
  deps: DecodeSourceDeps,
  profile: NodeDecodeProfile,
): Promise<DecodeBenchSourceOutcome> {
  const clipFile = await deps.clipFile().catch(() => null)
  const origin = clipFile === null ? 'synthetic' : 'bench-clip'
  const dir = path.join(deps.dataDir, 'bench')
  const ext = profile.codec === 'h264' ? 'h264' : 'hevc'
  const file = path.join(
    dir,
    `decode-${decodeProfileId(profile)}-${origin}-${DECODE_SOURCE_REVISION}.${ext}`,
  )
  const cached = await readUnits(file, profile)
  if (cached !== null) return { kind: 'ready', source: { profile, accessUnits: cached, origin } }

  let ffmpeg: string
  try {
    ffmpeg = await deps.ensureFfmpeg()
  } catch (err) {
    return {
      kind: 'skipped',
      reason: `no ffmpeg on this node: ${message(err)}`,
    }
  }
  await fs.mkdir(dir, { recursive: true })
  const staged = `${file}.encoding`
  const startedAt = Date.now()
  try {
    const run = await deps.runFfmpeg(ffmpeg, decodeSourceArgs(profile, clipFile, staged))
    if (run.code !== 0) {
      return {
        kind: 'skipped',
        reason: `ffmpeg could not encode the stream (exit ${run.code}): ${run.stderr.trim().slice(0, 200)}`,
      }
    }
    const units = await readUnits(staged, profile)
    if (units === null) {
      return {
        kind: 'skipped',
        reason: 'the encoded stream has no access-unit delimiters or no opening keyframe',
      }
    }
    await fs.rename(staged, file)
    deps.log('node bench: decode stream encoded', {
      profile: decodeProfileId(profile),
      origin,
      pictures: units.length,
      encodeMs: Date.now() - startedAt,
    })
    return { kind: 'ready', source: { profile, accessUnits: units, origin } }
  } catch (err) {
    return {
      kind: 'skipped',
      reason: `ffmpeg could not be run: ${message(err)}`,
    }
  } finally {
    await fs.rm(staged, { force: true })
  }
}
