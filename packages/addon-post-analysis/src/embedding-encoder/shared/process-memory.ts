/**
 * Read a child process's memory footprint for the pool memory watchdog.
 *
 * Deliberate twin of `packages/addon-pipeline/src/shared/process-memory.ts`:
 * addons must not import each other, and `@camstack/system` stays EXTERNAL in
 * addon bundles (a symbol added there would be missing at runtime until the
 * next framework train). The pure parse (`parseProcStatus`) and the whole
 * watchdog policy live once in `@camstack/types` (inlined at build time);
 * only this thin `fs`/`ps` read is duplicated.
 *
 * Linux (the fleet): `/proc/<pid>/status` — RSS, VmSize, VmHWM (peak RSS ≈
 * getrusage maxrss), VmSwap, Threads in one read. macOS (dev): `ps -o rss=`
 * gives RSS alone. Returns null when the pid is gone — the CALLER logs the
 * dropped sample.
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
