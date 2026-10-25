/**
 * ffmpeg-run-once — spawn ffmpeg for ONE batch conversion: feed an in-memory
 * input buffer on stdin, collect the whole stdout, resolve when the process
 * exits. Used by the recorded-playback demuxers (`segment-demux`,
 * `segment-audio`) which turn a single self-contained `.m4s` fragment into
 * Annex-B / µ-law bytes in a crash-isolated subprocess (replacing the old
 * in-process `node-av` binding).
 *
 * Unlike the live streaming sessions (`decoder-ffmpeg`, `audio-codec-ffmpeg`)
 * this is fire-once: there is no persistent stdin feed. stdin is written and
 * closed up-front so ffmpeg reads the whole fragment, transcodes, flushes, and
 * exits; we buffer stdout and resolve with it.
 *
 * The kill sequence copies the CORRECTED gating from `decoder-ffmpeg`/
 * `audio-codec-ffmpeg`: SIGTERM then escalated SIGKILL gated on
 * `exitCode === null && signalCode === null` (NOT on `child.killed`, which Node
 * sets true after ANY kill() so `!child.killed` never fires → leaked ffmpeg).
 */
import { spawn } from 'node:child_process'
import { errMsg } from '@camstack/types'

/** Hard ceiling for one fragment conversion; a ~4 s GOP transcodes in well
 *  under this even on a slow agent. Prevents a wedged ffmpeg from leaking. */
const RUN_TIMEOUT_MS = 8000
/** Grace period between SIGTERM and the escalated SIGKILL. */
const KILL_GRACE_MS = 500

export interface RunFfmpegOnceOptions {
  readonly ffmpegPath: string
  readonly args: readonly string[]
  /** The full input fed on stdin (e.g. one `.m4s` fragment). */
  readonly input: Uint8Array
  /**
   * When true, a non-zero exit / signal resolves with whatever stdout was
   * collected instead of rejecting. Audio demux is best-effort (a fragment may
   * legitimately have no audio, making ffmpeg exit non-zero) — video demux
   * rejects so the feeder can surface the failure.
   */
  readonly tolerateNonZeroExit?: boolean
}

/**
 * Run ffmpeg once over `input` and resolve with the collected stdout bytes.
 *
 * @throws If ffmpeg cannot be spawned, times out, or exits non-zero (unless
 *   `tolerateNonZeroExit` is set).
 */
export function runFfmpegOnce(options: RunFfmpegOnceOptions): Promise<Buffer> {
  const { ffmpegPath, args, input, tolerateNonZeroExit = false } = options
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const stderrTail: string[] = []
    let settled = false

    const child = (() => {
      try {
        return spawn(ffmpegPath, [...args])
      } catch (err) {
        reject(new Error(`ffmpeg spawn failed: ${errMsg(err)}`))
        return null
      }
    })()
    if (child === null) return

    const timer = setTimeout(() => {
      if (settled) return
      settle(() => reject(new Error('ffmpeg-run-once: timed out')))
      kill()
    }, RUN_TIMEOUT_MS)
    timer.unref?.()

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const kill = (): void => {
      try {
        child.kill('SIGTERM')
      } catch {
        // already dead
      }
      const t = setTimeout(() => {
        // Gate on the process actually still running — NOT on child.killed.
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL')
          } catch {
            // already dead
          }
        }
      }, KILL_GRACE_MS)
      t.unref?.()
    }

    child.stdin?.on('error', () => {
      // EPIPE if ffmpeg exits before consuming all stdin — harmless; the exit
      // handler owns the outcome.
    })
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (line) {
        stderrTail.push(line)
        if (stderrTail.length > 8) stderrTail.shift()
      }
    })
    child.on('error', (err) => {
      settle(() => reject(new Error(`ffmpeg process error: ${err.message}`)))
    })
    child.on('exit', (code, signal) => {
      const stdout = Buffer.concat(chunks)
      if (code === 0 || tolerateNonZeroExit) {
        settle(() => resolve(stdout))
        return
      }
      settle(() =>
        reject(
          new Error(
            `ffmpeg exited code=${code} signal=${signal}: ${stderrTail.join(' | ') || '(no stderr)'}`,
          ),
        ),
      )
    })

    // Feed the whole fragment, then close stdin so ffmpeg drains and exits.
    try {
      child.stdin?.write(Buffer.from(input.buffer, input.byteOffset, input.byteLength))
      child.stdin?.end()
    } catch {
      // stdin closed early (child already gone) — the exit handler settles.
    }
  })
}
