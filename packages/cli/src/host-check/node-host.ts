/**
 * The real host behind `HostFs`: plain reads of /sys, /dev, /proc and /etc,
 * every failure answered as "absent". `nvidia-smi -L` runs only when it is on
 * PATH and is bounded; its output never leaves this machine.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import type { HostPlatform } from './host-check.js'
import type { HostFs } from './probe.js'
import type { HostFacts } from './sizing.js'

const NVIDIA_SMI_TIMEOUT_MS = 3_000
const MAX_TEXT_BYTES = 256 * 1024

export const nodeHostFs: HostFs = {
  listDir(path) {
    try {
      return fs.readdirSync(path)
    } catch {
      return []
    }
  },
  readText(path) {
    try {
      const text = fs.readFileSync(path, 'utf8')
      return text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text
    } catch {
      return null
    }
  },
  exists(path) {
    return fs.existsSync(path)
  },
}

/** `nvidia-smi -L`, or null when it is missing, fails or times out. */
export function readNvidiaSmi(): string | null {
  const run = spawnSync('nvidia-smi', ['-L'], {
    encoding: 'utf8',
    timeout: NVIDIA_SMI_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return run.status === 0 && typeof run.stdout === 'string' ? run.stdout : null
}

export function currentPlatform(): HostPlatform {
  const p = process.platform
  return p === 'linux' || p === 'darwin' || p === 'win32' ? p : 'other'
}

const GB = 1024 ** 3

/**
 * Memory, cores and free space of this machine. Each read stands alone: one
 * that fails is `null`, and the others still answer.
 */
export function readHostFacts(diskPath: string | null): HostFacts {
  const cpus = os.cpus()
  const total = os.totalmem()
  let diskFreeGb: number | null = null
  if (diskPath !== null) {
    try {
      const stat = fs.statfsSync(diskPath)
      diskFreeGb = Math.round((stat.bavail * stat.bsize) / GB)
    } catch {
      diskFreeGb = null
    }
  }
  return {
    cpuModel: cpus[0]?.model ?? null,
    ramGb: total > 0 ? Math.round((total / GB) * 10) / 10 : null,
    cores: cpus.length > 0 ? cpus.length : null,
    diskFreeGb,
    diskPath,
  }
}
