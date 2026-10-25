/**
 * One bounded ffmpeg, killed at its deadline. Shared by the two per-clip passes
 * the tee owns — the still and the faststart remux.
 *
 * Bounded and killed, not merely awaited: an ffmpeg that never exits on a clip
 * it cannot parse would hold a process PER CLIP on a hub that already runs a
 * permanent prebuffer per recorded camera. Extracted rather than written twice
 * because the deadline is the part that matters, and a second copy of it is a
 * second place for it to be forgotten.
 *
 * The runner is a SEAM, never a verdict: it reports how the process ended and
 * nothing about whether the output is any good. Every caller here vouches by
 * looking at the file, because "exited 0 and wrote nothing usable" is the
 * failure shape this repo has shipped twice.
 */
import type { spawn as nodeSpawn } from 'node:child_process'
import type { PinnedFfmpegResolver } from '@camstack/types'

/** How one bounded ffmpeg ended. Three distinct operator actions, never one. */
export interface ClipFfmpegRun {
  readonly code: number | null
  readonly timedOut: boolean
  readonly spawnFailed: boolean
  readonly stderr: string
}

export type ClipFfmpegRunner = (args: readonly string[]) => Promise<ClipFfmpegRun>

export interface BoundedFfmpegRunnerInput {
  /** The node's pinned ffmpeg (D540). A rejection is `spawnFailed` — the
   *  callers' `ffmpeg-missing` — never a PATH lookup. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  readonly spawnFn: typeof nodeSpawn
  readonly timeoutMs: number
}

export function createBoundedFfmpegRunner(input: BoundedFfmpegRunnerInput): ClipFfmpegRunner {
  return async (args) => {
    let ffmpegBinaryPath: string
    try {
      ffmpegBinaryPath = await input.resolveFfmpeg()
    } catch (err: unknown) {
      return {
        code: null,
        timedOut: false,
        spawnFailed: true,
        stderr: `no pinned ffmpeg on this node: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    return await new Promise<ClipFfmpegRun>((resolve) => {
      let settled = false
      const finish = (run: ClipFfmpegRun): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(run)
      }
      const child = input.spawnFn(ffmpegBinaryPath, [...args], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 2_000) stderr += chunk.toString('utf8')
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ code: null, timedOut: true, spawnFailed: false, stderr })
      }, input.timeoutMs)
      timer.unref?.()
      child.on('error', (err: Error) => {
        finish({ code: null, timedOut: false, spawnFailed: true, stderr: err.message })
      })
      child.on('close', (code) => {
        finish({ code, timedOut: false, spawnFailed: false, stderr })
      })
    })
  }
}
