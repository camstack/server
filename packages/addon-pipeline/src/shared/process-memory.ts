/**
 * Read a child process's memory footprint for the pool memory watchdog.
 *
 * Linux (the fleet): parse `/proc/<pid>/status` — RSS, VmSize, VmHWM (peak
 * RSS ≈ getrusage maxrss), VmSwap and Threads in one 4 KB read, no exec.
 * macOS (dev only): `ps -o rss=` gives RSS alone; the extended fields read 0.
 *
 * Returns null when the pid is gone or unreadable — the CALLER logs the
 * dropped sample (a pool the watchdog silently stopped seeing is a bound
 * that silently stopped existing).
 *
 * The parse itself (`parseProcStatus`) lives in `@camstack/types` next to the
 * watchdog policy so it is unit-tested once and shared with
 * `addon-post-analysis`, which cannot import this addon. Only the `fs` read
 * lives here.
 */
import * as fs from 'node:fs'
import { execFile } from 'node:child_process'
import { parseProcStatus, type ProcMemory } from '@camstack/types'

const IS_LINUX = process.platform === 'linux'

export async function readProcessMemory(pid: number): Promise<ProcMemory | null> {
  if (IS_LINUX) {
    try {
      const text = await fs.promises.readFile(`/proc/${pid}/status`, 'utf8')
      return parseProcStatus(text)
    } catch {
      return null // pid exited between enumeration and read
    }
  }
  return readViaPs(pid)
}

function readViaPs(pid: number): Promise<ProcMemory | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null)
      const kb = Number(stdout.trim())
      if (!Number.isFinite(kb) || kb <= 0) return resolve(null)
      resolve({ rssBytes: kb * 1024, vmBytes: 0, hwmBytes: 0, swapBytes: 0, threads: 0 })
    })
  })
}
