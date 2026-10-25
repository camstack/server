/**
 * Shrink a rendered export so `readExportBytes` can answer under
 * {@link RECORDING_EXPORT_MAX_READ_BYTES}.
 *
 * A ten-hour overnight timelapse with dense slowdown routinely lands at
 * 80–200 MB. The byte-read ceiling is the roomiest notifier cap (Telegram
 * 50 MB) AND the base64 envelope bound (D9/D18) — raising it would OOM the
 * hub and still be refused by the notifier. So the read shrinks, once, into
 * a temp file sized for delivery, and the original render stays on disk for
 * the authenticated tap-through.
 *
 * Pure argv builders here; the spawn and temp I/O are injected by the
 * provider so the suite never needs a real ffmpeg.
 */

/** CRF ladder tried until the output fits. Higher = smaller, uglier. */
export const EXPORT_SHRINK_CRF_LADDER = [28, 32, 36, 40] as const

export interface ShrinkArgsInput {
  readonly inputPath: string
  readonly outputPath: string
  readonly crf: number
}

/**
 * ffmpeg argv that re-encodes a rendered MP4 for notification delivery.
 *
 * - `libx264` + `veryfast`: the morning drain must not pin the hub the way
 *   the original night render did.
 * - `-an`: a timelapse has no audio worth keeping, and dropping it is free
 *   size.
 * - `640:-2`: notification phones; matching the band the cheapest profile
 *   already aims for.
 * - `+faststart`: the artifact plane serves the whole file; moov-first is
 *   what a phone needs to start playing before the download finishes.
 */
export function buildExportShrinkArgs(input: ShrinkArgsInput): readonly string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input.inputPath,
    '-vf',
    'scale=640:-2',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(input.crf),
    '-an',
    '-movflags',
    '+faststart',
    input.outputPath,
  ]
}

/**
 * Pick the next CRF to try, or `null` when the ladder is exhausted.
 *
 * @param attempted — CRFs already tried (may be empty).
 */
export function nextShrinkCrf(attempted: readonly number[]): number | null {
  for (const crf of EXPORT_SHRINK_CRF_LADDER) {
    if (!attempted.includes(crf)) return crf
  }
  return null
}

/**
 * The slice of a `ChildProcess` the shrink reads. `on` takes the generic
 * `(event: string, (...args: unknown[]) => void)` form: node's per-event
 * overloads cannot be assigned to a single signature whose event is a union,
 * so a narrower port refused `child_process.spawn` itself.
 */
export interface ShrinkProcess {
  readonly on: (event: string, listener: (...args: unknown[]) => void) => void
  readonly stderr?: {
    readonly on: (event: string, listener: (...args: unknown[]) => void) => void
  } | null
}

export interface ShrinkRunPorts {
  readonly resolveFfmpeg: () => Promise<string>
  readonly spawn: (command: string, args: readonly string[]) => ShrinkProcess
  readonly writePath: string
  readonly readFile: (path: string) => Promise<Buffer>
  readonly removeFile: (path: string) => Promise<void>
  readonly statBytes: (path: string) => Promise<number>
}

/**
 * Re-encode `inputPath` down the CRF ladder until the file is ≤ `maxBytes`.
 *
 * @returns the fitted buffer, or `null` when every rung still overflows (or
 *          ffmpeg refuses). Never throws — the caller treats `null` as "refuse
 *          the inline read", same as the historical oversized gate.
 */
export async function shrinkExportToBound(
  inputPath: string,
  maxBytes: number,
  ports: ShrinkRunPorts,
): Promise<Buffer | null> {
  const attempted: number[] = []
  for (;;) {
    const crf = nextShrinkCrf(attempted)
    if (crf === null) return null
    attempted.push(crf)
    const outPath = `${ports.writePath}.crf${String(crf)}.mp4`
    try {
      const ffmpeg = await ports.resolveFfmpeg()
      await runShrinkFfmpeg(
        ports.spawn,
        ffmpeg,
        buildExportShrinkArgs({
          inputPath,
          outputPath: outPath,
          crf,
        }),
      )
      const size = await ports.statBytes(outPath)
      if (size > maxBytes) {
        await ports.removeFile(outPath)
        continue
      }
      const buf = await ports.readFile(outPath)
      await ports.removeFile(outPath)
      return buf
    } catch {
      await ports.removeFile(outPath).catch(() => undefined)
      // A failed rung does not abort the ladder — a later CRF may still fit.
      continue
    }
  }
}

type ShrinkSpawn = ShrinkRunPorts['spawn']

function runShrinkFfmpeg(
  spawn: ShrinkSpawn,
  ffmpegPath: string,
  args: readonly string[],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, args)
    let stderr = ''
    proc.stderr?.on('data', (...emitted: unknown[]) => {
      const chunk = emitted[0]
      stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    })
    proc.on('error', (...emitted: unknown[]) => {
      const err = emitted[0]
      reject(err instanceof Error ? err : new Error(String(err)))
    })
    proc.on('close', (...emitted: unknown[]) => {
      const code = emitted[0]
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`export shrink ffmpeg exited ${String(code)}: ${stderr.slice(0, 400)}`))
    })
  })
}
