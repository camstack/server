/**
 * A cheap stack sample of a node child that will not exit, taken just before the shell kills it, so
 * the next hang leaves a record of where it was stuck. macOS only (`/usr/bin/sample`, no new
 * dependency); a no-op elsewhere. The caller bounds how long it waits.
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'

export const SAMPLE_BIN = '/usr/bin/sample'
const SAMPLE_SECONDS = 2

export function sampleOutputPath(logDir: string, now: number): string {
  return path.join(logDir, `hang-${now}.txt`)
}

export function probeHungChild(
  pid: number | null,
  logDir: string,
  platform: NodeJS.Platform = process.platform,
  now: () => number = Date.now,
): Promise<void> {
  if (platform !== 'darwin' || pid === null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    try {
      const proc = spawn(
        SAMPLE_BIN,
        [String(pid), String(SAMPLE_SECONDS), '-file', sampleOutputPath(logDir, now())],
        { stdio: 'ignore' },
      )
      proc.once('error', () => resolve())
      proc.once('exit', () => resolve())
    } catch {
      resolve()
    }
  })
}
