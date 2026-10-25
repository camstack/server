/**
 * The Linux GPU probe, forking only when there is something to fork.
 *
 * `nvidia-smi` was spawned on every sample — twelve times a minute from
 * hub-main — on a host with an Intel i915 and no NVIDIA driver. Each spawn
 * was a synchronous `fork()` of the largest process on the host (D441: p50
 * 91 ms at 5.8 GB RSS), and each one failed at `exec` and yielded `null`.
 * Twelve forks a minute bought nothing (D452).
 *
 * Whether the binary exists is a question `access(2)` answers on the libuv
 * pool without a fork. It is asked on EVERY call rather than latched: a handful
 * of `stat`s every five seconds costs nothing, and a latch is a second fact
 * about the host that can go stale — the same shape as the caches D224
 * forbids.
 */
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import type { MetricsGpuInfo } from '@camstack/types'

/** `access(path, X_OK)` — resolves when executable, rejects otherwise. */
export type AccessCheck = (path: string) => Promise<void>

const nodeAccessCheck: AccessCheck = (path) => access(path, fsConstants.X_OK)

/**
 * The first `PATH` entry under which `binary` is executable, or `null`.
 * An empty or missing `PATH` asks nothing.
 */
export async function findOnPath(
  binary: string,
  pathEnv: string | undefined,
  check: AccessCheck = nodeAccessCheck,
): Promise<string | null> {
  const dirs = (pathEnv ?? '').split(':').filter((dir) => dir.length > 0)
  for (const dir of dirs) {
    const candidate = `${dir}/${binary}`
    try {
      await check(candidate)
      return candidate
    } catch {
      // not here — the next entry may have it
    }
  }
  return null
}

/** The two impure steps, injectable. */
export interface NvidiaProbeDeps {
  readonly findOnPath: (binary: string) => Promise<string | null>
  readonly exec: (command: string, args: readonly string[]) => Promise<string>
}

const NVIDIA_SMI_ARGS: readonly string[] = [
  '--query-gpu=utilization.gpu,name,memory.used,memory.total,temperature.gpu',
  '--format=csv,noheader,nounits',
]

/**
 * `nvidia-smi`'s one-line CSV as a `MetricsGpuInfo`, or `null` when the
 * binary is absent, fails, or prints something else. Never throws.
 */
export async function readNvidiaGpu(deps: NvidiaProbeDeps): Promise<MetricsGpuInfo | null> {
  const binary = await deps.findOnPath('nvidia-smi')
  if (binary === null) return null
  let stdout: string
  try {
    stdout = await deps.exec(binary, NVIDIA_SMI_ARGS)
  } catch {
    return null
  }
  const parts = stdout
    .trim()
    .split(',')
    .map((s) => s.trim())
  if (parts.length < 5) return null
  return {
    utilization: parseInt(parts[0]!, 10) || 0,
    model: parts[1] ?? 'Unknown GPU',
    memoryUsedBytes: (parseInt(parts[2]!, 10) || 0) * 1024 * 1024,
    memoryTotalBytes: (parseInt(parts[3]!, 10) || 0) * 1024 * 1024,
    temperature: parseInt(parts[4]!, 10) || null,
  }
}
