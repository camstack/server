/**
 * The real host behind `HostFs`: plain reads of /sys, /dev, /proc and /etc,
 * every failure answered as "absent". `nvidia-smi -L` runs only when it is on
 * PATH and is bounded; its output never leaves this machine.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import type { HostPlatform } from './host-check.js'
import type { HostFs } from './probe.js'

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
