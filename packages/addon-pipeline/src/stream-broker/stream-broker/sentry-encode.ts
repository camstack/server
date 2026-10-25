/**
 * ONE short-lived ffmpeg turns the sentry's picture into ONE Annex-B IDR.
 *
 * ── Why one encode and not a continuous child ─────────────────────────────
 * The obvious shape is `-loop 1 -framerate 1` and let ffmpeg emit the picture
 * for as long as the camera is waking. That is a resident child per sleeping
 * camera, for the whole wake, to redraw a picture that changes at most hourly.
 * So the child encodes exactly ONE frame (`-frames:v 1`) and exits, the caller
 * caches the bytes, and {@link SentryPump} re-emits them. A new encode
 * happens only when the picture changes.
 *
 * ── Why every frame carries its own parameter sets ────────────────────────
 * The pump re-emits ONE access unit at 1 fps, so a consumer that attaches on
 * tick 4 sees its first packet with nothing before it. `-g 1` plus
 * `repeat-headers=1` makes that packet a complete IDR with SPS/PPS (or
 * VPS/SPS/PPS) inline, so it decodes within a second of attaching instead of
 * waiting for a keyframe that will never come.
 *
 * ── Why the geometry comes from the plan and nowhere else ─────────────────
 * `planPrestream` refuses a camera whose geometry nobody has probed, precisely
 * so this file never has a default to fall back on. `stream-broker.ts` records
 * what a wrong one does: a fixed 1280x720 placeholder SPS in front of a
 * camera's real IDR froze Chrome's decoder on the last synthetic frame until
 * the viewer was recreated by hand. Hence `scale` mode `exact`, the plan's
 * numbers, and the plan's codec.
 *
 * ── Why no text is drawn here ─────────────────────────────────────────────
 * D118: the hub carries two ffmpeg builds and only one has libfreetype, so
 * `drawtext` is forbidden. The picture arrives already composed — sharp + an
 * inline SVG, the house pattern from `snapshot-courtesy.ts`.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { buildFfmpegArgs, errMsg, type FfmpegInvocation, type IScopedLogger } from '@camstack/types'
import type { SentryPlan } from './sentry-plan.js'

/**
 * Bound on the encode. A single 4 MP still on `ultrafast` is milliseconds; a
 * child that has not answered in this long is hung, and the sentry would
 * otherwise hold a promise open for the rest of the process's life.
 */
const SENTRY_ENCODE_TIMEOUT_MS = 10_000

/** Grace before escalating SIGTERM → SIGKILL on a child that will not go. */
const KILL_GRACE_MS = 500

/** x264/x265 params shared by both codecs: one-frame GOP, headers on it. */
const STILL_ENCODER_PARAMS = 'keyint=1:repeat-headers=1'

export interface SentryEncodeOptions {
  readonly ffmpegPath: string
  readonly plan: SentryPlan
  /** The composed picture, JPEG. */
  readonly jpeg: Buffer
  readonly logger?: IScopedLogger
  /** Numeric device id, for `tags.deviceId` on every line. */
  readonly deviceId?: number
  /** Injectable spawn for tests. */
  readonly spawnFn?: typeof spawn
}

/**
 * The argv. PURE, so the two properties that matter — the geometry is the
 * plan's, and the frame is a self-contained IDR — are assertable without a
 * binary.
 */
export function buildPrestreamEncodeArgs(plan: SentryPlan): string[] {
  const h265 = plan.codec === 'h265'
  const invocation: FfmpegInvocation = {
    logLevel: 'error',
    decodeHwAccel: null,
    input: {
      url: 'pipe:0',
      // INPUT options, strictly before `-i`: after it ffmpeg accepts them and
      // silently ignores them (the rule `buildInputArgs` exists to enforce).
      extraArgs: ['-f', 'image2pipe', '-framerate', '1'],
    },
    video: {
      kind: 'encode',
      encoder: h265 ? 'libx265' : 'libx264',
      // `exact`, never `fit`: a still that is letterboxed to a different size
      // than the camera's real stream injects a different SPS, which is the
      // failure this whole path is shaped around.
      scale: { mode: 'exact', width: plan.width, height: plan.height },
      preset: 'ultrafast',
      // `stillimage` is an x264 tune; x265 has no equivalent and would reject
      // the flag outright.
      ...(h265 ? {} : { tune: 'stillimage' }),
      pixelFormat: 'yuv420p',
      fps: 1,
      gopFrames: 1,
      bf: 0,
    },
    audio: { kind: 'none' },
    // A single still on `ultrafast`. More threads buy nothing and this runs on
    // a node that may be encoding several real streams.
    threadCount: 1,
    outputArgs: ['-frames:v', '1', h265 ? '-x265-params' : '-x264-params', STILL_ENCODER_PARAMS],
    sink: { kind: 'stdout', container: h265 ? 'hevc' : 'h264' },
  }
  return buildFfmpegArgs(invocation)
}

/**
 * Run the encode. Resolves with the Annex-B bytes, rejects with a named reason
 * — the caller turns a rejection into a refusal log and no sentry, which is
 * the same outcome as a black screen and never worse than one.
 */
export function encodePrestreamIdr(options: SentryEncodeOptions): Promise<Buffer> {
  const args = buildPrestreamEncodeArgs(options.plan)
  const spawnFn = options.spawnFn ?? spawn
  const tags = options.deviceId === undefined ? {} : { tags: { deviceId: options.deviceId } }

  return new Promise<Buffer>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnFn(options.ffmpegPath, args)
    } catch (err) {
      reject(new Error(`sentry encode could not spawn ffmpeg: ${errMsg(err)}`))
      return
    }

    const chunks: Buffer[] = []
    let stderrTail = ''
    let settled = false

    const finish = (outcome: { readonly bytes: Buffer } | { readonly error: Error }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if ('error' in outcome) reject(outcome.error)
      else resolve(outcome.bytes)
    }

    const timer = setTimeout(() => {
      killChild(child)
      finish({
        error: new Error(`sentry encode timed out after ${String(SENTRY_ENCODE_TIMEOUT_MS)} ms`),
      })
    }, SENTRY_ENCODE_TIMEOUT_MS)
    // A hung encode must not keep the runner alive.
    timer.unref?.()

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2048)
    })
    child.stdin?.on('error', () => {
      // EPIPE when the child dies before the picture is written — the exit
      // handler below is the one that reports it.
    })
    child.on('error', (err: Error) => {
      finish({ error: new Error(`sentry encode failed: ${err.message}`) })
    })
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        finish({
          error: new Error(
            `sentry encode exited ${String(code ?? signal)}: ${stderrTail.trim() || 'no stderr'}`,
          ),
        })
        return
      }
      const bytes = Buffer.concat(chunks)
      if (bytes.length === 0) {
        finish({ error: new Error('sentry encode produced no bytes') })
        return
      }
      options.logger?.debug('sentry: picture encoded', {
        ...tags,
        meta: {
          codec: options.plan.codec,
          width: options.plan.width,
          height: options.plan.height,
          bytes: bytes.length,
        },
      })
      finish({ bytes })
    })

    child.stdin?.end(options.jpeg)
  })
}

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const grace = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, KILL_GRACE_MS)
  grace.unref?.()
}
