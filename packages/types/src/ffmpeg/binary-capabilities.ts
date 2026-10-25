/**
 * What an ffmpeg binary can actually DO, asked of the binary itself.
 *
 * ## The failure this exists to end
 *
 * `ensureFfmpeg` prefers a downloaded STATIC build over the system one, and a
 * static build is compiled for portability: no vendor libraries, no VAAPI, no
 * QSV. On a machine with a working Intel iGPU that is precisely backwards, and
 * the symptom does not say so. Measured on the hub, 2026-09-18:
 *
 * ```
 * /data/deps/ffmpeg   7.0.2 johnvansickle static   hwaccels: vdpau
 * /usr/bin/ffmpeg     6.1.1 Ubuntu, in the image   hwaccels: vdpau cuda vaapi qsv drm opencl vulkan
 * ```
 *
 * Every consumer that went through `ensureFfmpeg` — the broker's egress and
 * derived transcodes, the WebRTC transcode leg, the camera grid — asked for
 * `-hwaccel vaapi`, got `Device creation failed: -12`, and fell back to
 * software. `-12` is what fftools prints when `av_hwdevice_ctx_alloc` returns
 * NULL because the type is not in the build: the NAME parses, so the request
 * looks valid and the device simply cannot exist. It reads as a resource
 * problem and is a build property.
 *
 * ## Why asking the kernel was not enough
 *
 * The existing hardware resolver answers from `/dev/dri` presence. That is a
 * correct description of the NODE, and it is what `node-av` needs — the
 * detection workers were on VAAPI the whole time. It says nothing about the
 * separate binary a child will be spawned with, and it was being read as
 * though it did.
 *
 * So: two questions, two answers. What does this node HAVE (the resolver), and
 * what can this BINARY use (here). A backend needs both.
 */
import { execFile } from 'node:child_process'

/** What one ffmpeg binary reports about itself. */
export interface FfmpegBinaryCapabilities {
  readonly path: string
  /** First line of `-version`, for the log that names the choice. */
  readonly version: string
  /** Names from `-hwaccels`, e.g. `vaapi`, `qsv`, `videotoolbox`. */
  readonly hwaccels: ReadonlySet<string>
  /** Encoder names from `-encoders`, e.g. `h264_vaapi`, `h264_videotoolbox`. */
  readonly encoders: ReadonlySet<string>
}

/** How long a probe may take before the binary counts as unusable. */
const PROBE_TIMEOUT_MS = 5_000

function run(path: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve) => {
    execFile(path, [...args], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      // A probe that fails is not an error to propagate: it answers "this
      // binary can do nothing", which is a usable fact and the safe direction
      // to be wrong in.
      resolve(error ? '' : stdout)
    })
  })
}

/**
 * `-hwaccels` prints a header line and then one name per line. Anything with a
 * space in it is prose, not a name.
 */
function parseNames(output: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.includes(' ')) continue
    names.add(line)
  }
  return names
}

/**
 * `-encoders` prints a LEGEND and then a table, separated by a dashed line:
 *
 * ```
 * Encoders:
 *  V..... = Video
 *  .F.... = Frame-level multithreading
 *  ------
 *  V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)
 * ```
 *
 * The legend rows have the SAME leading flag shape as the table rows, so a
 * pattern alone matches ` V..... = Video` and yields `=` as an encoder name.
 * Verified against the hub's own output on 2026-09-18, which is how that was
 * caught. So the separator is the parser's state: nothing counts before it.
 */
function parseEncoders(output: string): ReadonlySet<string> {
  const names = new Set<string>()
  let inTable = false
  for (const raw of output.split('\n')) {
    if (!inTable) {
      if (raw.trim().startsWith('---')) inTable = true
      continue
    }
    const match = /^\s[VAS][.F][.S][.X][.B][.D]\s+(\S+)/.exec(raw)
    if (match?.[1] !== undefined) names.add(match[1])
  }
  return names
}

/**
 * Turn three raw outputs into capabilities. Separated from the spawning so the
 * parsers can be held against what ffmpeg REALLY prints — which is how the
 * legend rows were caught being read as encoder names.
 */
export function parseFfmpegCapabilities(
  path: string,
  versionOut: string,
  hwaccelOut: string,
  encoderOut: string,
): FfmpegBinaryCapabilities {
  return {
    path,
    version: versionOut.split('\n')[0]?.trim() ?? '',
    hwaccels: parseNames(hwaccelOut),
    encoders: parseEncoders(encoderOut),
  }
}

/** Ask one binary what it can do. Never throws — an unusable binary answers empty. */
export async function probeFfmpegBinary(path: string): Promise<FfmpegBinaryCapabilities> {
  const [versionOut, hwaccelOut, encoderOut] = await Promise.all([
    run(path, ['-hide_banner', '-version']),
    run(path, ['-hide_banner', '-hwaccels']),
    run(path, ['-hide_banner', '-encoders']),
  ])
  return parseFfmpegCapabilities(path, versionOut, hwaccelOut, encoderOut)
}

/**
 * Pick the binary that can serve this node's hardware.
 *
 * `wanted` is what the NODE has, from the hardware resolver — the order it is
 * given in is the order of preference. A candidate that offers any of them
 * wins, earliest-wanted first; among equals the earliest CANDIDATE wins, so a
 * caller states its own precedence by the order it passes them in.
 *
 * With nothing wanted, or nothing offering anything, the first candidate wins:
 * a node with no hardware has no reason to prefer one binary over another, and
 * "the first one" is the caller's existing precedence, unchanged.
 */
export function pickCapableBinary(
  candidates: readonly FfmpegBinaryCapabilities[],
  wanted: readonly string[],
): FfmpegBinaryCapabilities | null {
  if (candidates.length === 0) return null
  for (const backend of wanted) {
    const match = candidates.find((candidate) => candidate.hwaccels.has(backend))
    if (match !== undefined) return match
  }
  return candidates[0] ?? null
}
