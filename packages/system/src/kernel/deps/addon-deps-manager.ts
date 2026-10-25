import { join } from 'node:path'
import * as fs from 'node:fs'
import type { IScopedLogger, IAddonDepsManager } from '@camstack/types'
import {
  declaresEdgetpuDelegate,
  ensureBinary,
  ensureEdgetpuDelegate,
  ensureFfmpeg,
  ensurePython,
  installPythonPackages,
  installPythonRequirements,
} from '@camstack/types/node'

/**
 * Canonical implementation of `IAddonDepsManager`, injected into every
 * addon context via `ctx.deps`. Wraps the binary/ffmpeg/python utilities
 * that live in `@camstack/types` behind the addon-safe interface — addons
 * never import `@camstack/types` directly for these utilities, which
 * keeps the `no-restricted-imports` lint boundary intact.
 *
 * History note: previously these utilities lived in `@camstack/system` and
 * had to be dynamically imported (kernel cannot static-import core
 * because core depends on kernel). They were lifted to `@camstack/types`
 * in 2026-05 specifically to break that cycle.
 *
 * Shared per-node store (2026-06): base binaries (Python, ffmpeg, downloaded
 * tools) are resolved into the NODE data dir (`CAMSTACK_DATA`), not the
 * per-addon dir. Every addon on a node reuses one copy instead of downloading
 * its own. Because addons run as separate processes that now share one deps
 * dir, resolution is guarded by a single-flight (in-process promise cache +
 * cross-process file lock) so a cold boot with several addons does not race to
 * download/extract the same binary concurrently.
 */

/** Resolve the node-wide data root (shared by all addon processes on a node). */
function resolveNodeRoot(): string {
  return process.env['CAMSTACK_DATA'] ?? process.env['CAMSTACK_DATA_DIR'] ?? 'camstack-data'
}

// In-process coalescing: concurrent calls in the SAME process for the same
// binary share one promise. Keyed by `<depsDir>::<name>`.
const inFlight = new Map<string, Promise<unknown>>()

const LOCK_STALE_MS = 10 * 60_000 // a download+pip install can legitimately take minutes
const LOCK_POLL_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Cross-process single-flight via an atomic lockfile. The holder runs `fn`;
 * other processes poll until the lock clears, then run `fn` themselves (which
 * is a no-op fast path once the binary exists — every ensure* util checks for
 * the resolved target first). A stale lock (older than LOCK_STALE_MS, e.g. a
 * crashed holder) is stolen.
 */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(join(lockPath, '..'), { recursive: true })
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      fs.closeSync(fd)
      break // acquired
    } catch {
      // Lock held — steal if stale, else wait and retry.
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs
        if (age > LOCK_STALE_MS) fs.rmSync(lockPath, { force: true })
        else await sleep(LOCK_POLL_MS)
      } catch {
        // Lock vanished between checks — retry acquisition immediately.
      }
    }
  }
  try {
    return await fn()
  } finally {
    fs.rmSync(lockPath, { force: true })
  }
}

/** Coalesce in-process + serialize cross-process for one binary id. */
function singleFlight<T>(depsDir: string, name: string, fn: () => Promise<T>): Promise<T> {
  const key = `${depsDir}::${name}`
  const existing = inFlight.get(key)
  if (existing) return existing as Promise<T>
  const lockPath = join(depsDir, '.locks', `${name}.lock`)
  const run = withFileLock(lockPath, fn).finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}

export class AddonDepsManager implements IAddonDepsManager {
  private readonly nodeRoot: string
  private readonly depsDir: string

  // `dataDir` is accepted for interface compatibility but binaries are shared
  // per node, so resolution roots at the node data dir, not this per-addon dir.
  constructor(
    _dataDir: string,
    private readonly logger: IScopedLogger,
  ) {
    this.nodeRoot = resolveNodeRoot()
    this.depsDir = join(this.nodeRoot, 'deps')
  }

  async ensureBinary(opts: {
    readonly name: string
    readonly downloadUrl: string
    readonly isArchive?: boolean
    readonly archiveFormat?: 'zip' | 'tar.gz' | 'tar.xz'
    readonly archiveInnerPath?: string
  }): Promise<string> {
    return singleFlight(this.depsDir, opts.name, () =>
      ensureBinary({
        name: opts.name,
        targetDir: this.depsDir,
        downloadUrl: opts.downloadUrl,
        logger: this.logger,
        isArchive: opts.isArchive,
        archiveFormat: opts.archiveFormat,
        archiveInnerPath: opts.archiveInnerPath,
      }),
    )
  }

  async ensureFfmpeg(): Promise<string> {
    return singleFlight(this.depsDir, 'ffmpeg', () => ensureFfmpeg(this.nodeRoot, this.logger))
  }

  async ensurePython(): Promise<string | null> {
    return singleFlight(this.depsDir, 'python', () => ensurePython(this.nodeRoot, this.logger))
  }

  async installPythonPackages(packages: readonly string[]): Promise<void> {
    const pythonPath = await this.ensurePython()
    if (!pythonPath) {
      throw new Error('Cannot install Python packages: Python is not available')
    }
    await singleFlight(this.depsDir, 'python-pip', () =>
      installPythonPackages(pythonPath, packages as string[], this.logger),
    )
  }

  async installPythonRequirements(requirementsFile: string): Promise<void> {
    const pythonPath = await this.ensurePython()
    if (!pythonPath) {
      throw new Error('Cannot install Python requirements: Python is not available')
    }
    await singleFlight(this.depsDir, 'python-pip', () =>
      installPythonRequirements(pythonPath, requirementsFile, this.logger),
    )
    await this.stageNativeDepsDeclaredBy(requirementsFile)
  }

  /**
   * The native library a requirements file says its packages need
   * (`# camstack-native-dep: edgetpu-delegate`), staged under this node's
   * deps dir. Runs on every call — not only the first pip install — so a
   * node whose pip marker predates the line still gets the library. A
   * platform without a build answers `unavailable` (logged, not thrown); a
   * failed or tampered download throws, and provisioning reports it.
   */
  private async stageNativeDepsDeclaredBy(requirementsFile: string): Promise<void> {
    if (!declaresEdgetpuDelegate(fs.readFileSync(requirementsFile, 'utf8'))) return
    await singleFlight(this.depsDir, 'edgetpu-delegate', () =>
      ensureEdgetpuDelegate(this.nodeRoot, this.logger),
    )
  }

  getDepsDir(): string {
    return this.depsDir
  }
}
