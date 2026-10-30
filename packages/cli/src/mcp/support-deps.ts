/**
 * The side doors of the `support` toolset, injected so a test runs against a
 * fake `gh` and a fake clock. Production spawns the USER's own `gh` with an
 * argument array (never a shell) and adds nothing to its environment.
 */
import { execFile } from 'node:child_process'

export interface ProcessResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs `command` with `args`; never throws, a missing binary is code 127. */
export type ProcessRunner = (command: string, args: readonly string[]) => Promise<ProcessResult>

export interface SupportDeps {
  readonly runner: ProcessRunner
  readonly sleep: (ms: number) => Promise<void>
  /** How long a detection pool gets to come back between two benchmark models. */
  readonly recycleMs: number
}

const RUN_TIMEOUT_MS = 60_000

export const spawnRunner: ProcessRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: RUN_TIMEOUT_MS, maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        const code = typeof error.code === 'number' ? error.code : 127
        resolve({
          code,
          stdout,
          stderr: stderr === '' ? error.message : stderr,
        })
      },
    )
  })

export const defaultSupportDeps: SupportDeps = {
  runner: spawnRunner,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  recycleMs: 8_000,
}
