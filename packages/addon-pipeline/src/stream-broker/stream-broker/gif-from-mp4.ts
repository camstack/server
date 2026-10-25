/**
 * The notification GIF, rendered from THE SAME BYTES as the notification video.
 *
 * ## Why this exists at all, given the clip ring already made gifs
 *
 * It made them from a different source. The ring's renderer picks the CHEAPEST
 * assigned profile (`pickClipProfile`, cheapest-first), which on this fleet is
 * the 640×360 substream, and then scales it to 480 px at 5 fps at 2× speed.
 * Meanwhile the mp4 on the same notification came from the fMP4 seam: the
 * camera's own 1280×720 H.264, copied. One notification, two cameras' worth of
 * apparent quality, and — measured — two different WINDOWS: the ring covers
 * [event−3 s, event+5 s] and the on-demand seam covered [event+7 s, event+13 s]
 * ([D85](../../../../../docs/decisions/adr-0085.md)). The operator saw a gif
 * that wrapped the event and a video that started after it.
 *
 * So the gif is no longer *rendered*, it is *derived*: the same window, the same
 * fragments, the same pixels, decoded once more and quantised. Sharing the
 * source is not an optimisation here — it is the guarantee that the two
 * attachments on one notification show the same thing.
 *
 * ## The palette was never the problem, and it is worth writing down
 *
 * The obvious diagnosis for "the gif looks de-pixellated" is a missing
 * `palettegen`/`paletteuse` pair. It was not missing: the ring renderer has had
 * the `split` + `palettegen(stats_mode=diff)` + `paletteuse(bayer)` filter since
 * D32, and this module keeps exactly that filter because it is right. The
 * measured cause was upstream of the palette — a 640×360 low substream scaled
 * DOWN to 480 px. Feed the same filter a 720p copy at 640 px and the same
 * encoder produces a gif nobody calls pixellated.
 *
 * The `split` form is a single READ of the input, not a lesser two-pass: a true
 * two-pass rewinds the source, which a pipe cannot do, and the palette it would
 * compute is the same one.
 */
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process'

import { type IScopedLogger, gifFromMp4Args } from '@camstack/types'

// The chain and argv are shared with the notification centre's RECORDED derive
// (D682) and live in `@camstack/types`; re-exported so this module stays the
// broker's one import point.
export { gifDeriveSpeed, gifFilterComplex, gifFromMp4Args } from '@camstack/types'

/**
 * Long side of the gif.
 *
 * 640 rather than the ring's 480. Measured on a real 101 clip: 480 px/8 fps is
 * 195 KB and 640 px/8 fps is 324 KB — both far under any notifier's cap (the
 * smallest declared is pushover's 5 MiB), and the difference is the one an
 * operator actually notices on a phone.
 */
export const GIF_MAX_WIDTH = 640

/**
 * The gif's own PLAYBACK frame rate — how fast the finished gif runs, not how
 * many source frames go into it. The decimation that feeds it samples
 * `GIF_FPS / speed` frames out of each source second (see
 * {@link gifFilterComplex}), which is the only definition under which the
 * number stays meaningful once the gif is sped up.
 *
 * 12 rather than the real-time default's 8, chosen against {@link GIF_SPEED}:
 * at 4× a gif that PLAYS at 8 fps would sample 2 source frames a second and
 * read as the slideshow D91 set out to kill, while 12 samples 3 and still
 * carries fewer frames in total than the 8-at-real-time it replaces.
 */
export const GIF_FPS = 12

/**
 * How fast the notification gif plays, against real time. **4×** — the
 * operator's call: a gif on a lock screen is GLANCED at, and a ~12 s window
 * that takes 12 s to watch is not glanced at, it is skipped. At 4× that window
 * is over in ~3 s.
 *
 * This is the gif's rate ALONE. The mp4 beside it keeps `speed: 1`, because
 * real time is what lets the production COPY the camera's own H.264 instead of
 * re-encoding it (`clipCanCopy`, D91) — and an mp4 is scrubbed, not glanced at.
 * The two attachments still come out of ONE window of ONE rendition, which is
 * the guarantee D91 exists for; only the gif's timeline is compressed.
 */
export const GIF_SPEED = 4

/** A derive that has not finished by now will not finish inside the drain. */
const GIF_RENDER_TIMEOUT_MS = 20_000

export interface GifFromMp4Input {
  /** A playable mp4 — `init` + fragments from the seam, or the ring's own
   *  fragmented output. Both are streamable, which is what lets this read from
   *  a pipe instead of a temp file. */
  readonly mp4: Uint8Array
  readonly maxWidth?: number
  readonly fps?: number
  readonly speed?: number
  /** The node's pinned ffmpeg (D540). Required — there is no PATH default. */
  readonly ffmpegPath: string
  readonly spawnFn: typeof nodeSpawn
  readonly logger?: IScopedLogger
  /** Log lines about a device carry the device. Always. */
  readonly deviceId: number
}

/**
 * Derive the gif. `null` on every failure — a notification that lost its gif is
 * a notification, and one that failed is not.
 *
 * The child is guaranteed dead before this settles: these run on every
 * notification that asks for a gif, and a leaked ffmpeg accumulates on the node
 * until somebody notices the host is slow.
 */
export async function gifFromMp4(input: GifFromMp4Input): Promise<Uint8Array | null> {
  const args = gifFromMp4Args({
    maxWidth: input.maxWidth ?? GIF_MAX_WIDTH,
    fps: input.fps ?? GIF_FPS,
    speed: input.speed ?? GIF_SPEED,
  })
  const startedAt = Date.now()
  try {
    const bytes = await runGif(input, args)
    input.logger?.info('nc gif: derived from the notification video', {
      tags: { deviceId: input.deviceId },
      meta: {
        sourceBytes: input.mp4.length,
        gifBytes: bytes.length,
        width: input.maxWidth ?? GIF_MAX_WIDTH,
        fps: input.fps ?? GIF_FPS,
        // The rate applied HERE, on top of whatever the mp4 already carried —
        // "why is this gif 3 s long" is answered off this line or not at all.
        speed: input.speed ?? GIF_SPEED,
        encodeMs: Date.now() - startedAt,
      },
    })
    return bytes
  } catch (err) {
    // A branch that drops work says so — a notification arriving without the
    // gif it was configured for must never be silent.
    input.logger?.warn('nc gif: the derive failed — this notification ships without a gif', {
      tags: { deviceId: input.deviceId },
      meta: {
        sourceBytes: input.mp4.length,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return null
  }
}

function runGif(input: GifFromMp4Input, args: readonly string[]): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const proc: ChildProcess = input.spawnFn(input.ffmpegPath, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let stderrTail = ''
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const settle = (err: Error | null, out?: Uint8Array): void => {
      if (done) return
      done = true
      if (timer !== null) clearTimeout(timer)
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
      try {
        proc.stdout?.removeAllListeners()
        proc.stderr?.removeAllListeners()
        proc.stdin?.destroy()
      } catch {
        /* nothing to detach */
      }
      if (err !== null) reject(err)
      else resolve(out ?? new Uint8Array(0))
    }

    timer = setTimeout(() => settle(new Error('gif derive timed out')), GIF_RENDER_TIMEOUT_MS)
    timer.unref?.()
    proc.stdout?.on('data', (c: Buffer) => chunks.push(c))
    proc.stderr?.on('data', (c: Buffer) => {
      stderrTail = (stderrTail + c.toString()).slice(-400)
    })
    proc.on('error', (err: unknown) => settle(err instanceof Error ? err : new Error(String(err))))
    proc.on('close', (code: number | null) => {
      if (code !== 0) {
        settle(new Error(`ffmpeg gif derive exited ${code}: ${stderrTail}`))
        return
      }
      const out = Buffer.concat(chunks)
      if (out.byteLength === 0) {
        settle(new Error('gif derive produced no bytes'))
        return
      }
      const bytes = new Uint8Array(out.byteLength)
      bytes.set(out)
      settle(null, bytes)
    })

    proc.stdin?.on('error', () => {})
    proc.stdin?.write(Buffer.from(input.mp4))
    proc.stdin?.end()
  })
}
