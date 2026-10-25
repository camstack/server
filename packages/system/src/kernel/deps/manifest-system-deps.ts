/**
 * Auto-install the host binaries declared in an addon's manifest
 * (`camstack.addons[].systemDependencies`) before `onInitialize()` runs.
 *
 * ── Why this is framework and not addon-local ──────────────────────────────
 * The Python precedent (`camstack.addons[].python.requirements` →
 * `installManifestPythonDeps`, called from the same place in
 * `addon-runner.ts`) already answers "this addon needs something installed,
 * satisfy it before its caps register". A binary is the same question with a
 * different package manager, so it gets the same mechanism rather than a
 * second one per addon — CLAUDE.md forbids a parallel answer where one exists,
 * and the next addon that needs `rclone` or `mediainfo` inherits this for
 * free instead of copying a startup routine.
 *
 * ── The four things this has to get right ──────────────────────────────────
 *  1. **Cheap on the common path.** The binary is probed first; the package
 *     manager is only invoked when it is genuinely absent. Runners respawn
 *     routinely (deploys, updates, crash recovery) and a network round-trip on
 *     every boot is a cost the Python mechanism does not impose either.
 *  2. **Runs every boot, not once.** The install lands INSIDE the container
 *     and is lost on every image update. That is expected. "Already
 *     installed" is a success, not an error.
 *  3. **Honest, not fatal.** A failure warns and returns. The addon still
 *     loads; the capability that wraps the binary is responsible for refusing
 *     loudly on its own surface. Aborting the runner here would take the
 *     addon's SIBLINGS down with it (they share `execution.group`).
 *  4. **Platform reality is stated, not assumed.** An unsupported host logs
 *     which manager it looked for and continues. Silence would read as
 *     "installed".
 *  5. **Apt is not the runner's.** Distro package managers need root. The
 *     runner and hub-main are uid 1001 (`gosu` in the entrypoint). Apt/apk/dnf
 *     go through `camstack-pkgd` (allowlisted). Brew stays in-process.
 *
 * Every branch that declines to install SAYS SO. A dependency step that
 * produced no line at all is indistinguishable from one that never ran, and
 * the failure it precedes ("smbclient: ENOENT") arrives minutes later in a
 * different addon's logs.
 */
import { execFile } from 'node:child_process'
import * as os from 'node:os'
import { promisify } from 'node:util'
import type { AddonDeclaration, AddonSystemDependency, IScopedLogger } from '@camstack/types'
import { decidePackageInstall } from './system-package-broker.js'
import type { PackageInstallRequest, PackageInstallResult } from './system-package-broker.js'
import { privilegedHelperAvailable, requestPrivilegedInstall } from './system-package-client.js'
import type { SystemPackageManager } from './system-package-allowlist.js'

export type { SystemPackageManager } from './system-package-allowlist.js'

const execFileAsync = promisify(execFile)

/** How long a single package-manager invocation may take. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000
/** How long the `command -v <binary>` presence probe may take. */
const PROBE_TIMEOUT_MS = 10_000

/**
 * One package-manager invocation, as `execFile(command, args)`. Expressed as
 * data so the strategy table stays readable and testable without spawning
 * anything.
 */
interface ManagerPlan {
  readonly manager: SystemPackageManager
  /** Commands run in order. A failing step aborts the remaining ones. */
  readonly steps: readonly (readonly [string, readonly string[]])[]
}

/** Test seams — production callers omit these. */
export interface InstallManifestSystemDepsOptions {
  readonly hasBinary?: (binary: string) => Promise<boolean>
  readonly detectManager?: () => Promise<SystemPackageManager | null>
  readonly run?: (command: string, args: readonly string[]) => Promise<void>
  readonly platform?: NodeJS.Platform
  readonly helperAvailable?: () => Promise<boolean>
  readonly requestInstall?: (req: PackageInstallRequest) => Promise<PackageInstallResult>
}

/**
 * Satisfy every `systemDependencies` entry the declaration carries.
 * Resolves regardless of outcome — see the docblock.
 */
export async function installManifestSystemDeps(
  declaration: AddonDeclaration,
  logger: IScopedLogger,
  options: InstallManifestSystemDepsOptions = {},
): Promise<void> {
  const deps = declaration.systemDependencies
  if (!deps || deps.length === 0) return

  const hasBinary = options.hasBinary ?? defaultHasBinary
  const detectManager = options.detectManager ?? defaultDetectManager
  const run = options.run ?? defaultRun
  const platform = options.platform ?? process.platform
  const helperAvailable = options.helperAvailable ?? (async () => privilegedHelperAvailable())
  const requestInstall = options.requestInstall ?? ((req) => requestPrivilegedInstall(req))

  for (const dep of deps) {
    try {
      await satisfyOne(
        dep,
        declaration.id,
        { hasBinary, detectManager, run, platform, helperAvailable, requestInstall },
        logger,
      )
    } catch (err) {
      // Unreachable in principle — `satisfyOne` swallows its own failures —
      // but a throw here would abort the sibling addons in this runner.
      logger.warn('system dependency step failed', {
        meta: {
          addonId: declaration.id,
          binary: dep.binary,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }
}

interface Runtime {
  readonly hasBinary: (binary: string) => Promise<boolean>
  readonly detectManager: () => Promise<SystemPackageManager | null>
  readonly run: (command: string, args: readonly string[]) => Promise<void>
  readonly platform: NodeJS.Platform
  readonly helperAvailable: () => Promise<boolean>
  readonly requestInstall: (req: PackageInstallRequest) => Promise<PackageInstallResult>
}

async function satisfyOne(
  dep: AddonSystemDependency,
  addonId: string,
  rt: Runtime,
  logger: IScopedLogger,
): Promise<void> {
  if (await rt.hasBinary(dep.binary)) {
    logger.debug('system dependency already present', {
      meta: { addonId, binary: dep.binary },
    })
    return
  }

  const manager = await rt.detectManager()
  if (manager === null) {
    logger.warn('system dependency missing and no supported package manager on this host', {
      meta: {
        addonId,
        binary: dep.binary,
        platform: rt.platform,
        ...(dep.reason !== undefined ? { reason: dep.reason } : {}),
      },
    })
    return
  }

  const packageName = dep.packages[manager]
  if (packageName === undefined || packageName.length === 0) {
    logger.warn('system dependency missing and the addon declares no package for this manager', {
      meta: {
        addonId,
        binary: dep.binary,
        manager,
        ...(dep.reason !== undefined ? { reason: dep.reason } : {}),
      },
    })
    return
  }

  const helperUp = await rt.helperAvailable()
  const decision = decidePackageInstall({
    manager,
    packageName,
    helperAvailable: helperUp,
  })
  if (decision.kind === 'refuse') {
    const message =
      decision.reason === 'helper-unavailable'
        ? 'system dependency missing and the privileged helper is not running — apt cannot run as uid 1001'
        : 'system dependency missing and the package is not on the helper allowlist'
    logger.warn(message, {
      meta: {
        addonId,
        binary: dep.binary,
        manager,
        package: packageName,
        reason: decision.reason,
        ...(dep.reason !== undefined ? { reason: dep.reason } : {}),
      },
    })
    return
  }

  logger.info('installing system dependency', {
    meta: { addonId, binary: dep.binary, manager, package: packageName, via: decision.kind },
  })
  try {
    if (decision.kind === 'helper') {
      const result = await rt.requestInstall({
        addonId,
        binary: dep.binary,
        manager,
        packageName,
      })
      if (!result.ok) {
        throw new Error(result.error ?? 'privileged helper refused')
      }
    } else {
      const plan = planFor(manager, packageName)
      for (const [command, args] of plan.steps) await rt.run(command, args)
    }
  } catch (err) {
    logger.warn('system dependency install failed — the addon loads, its capability must refuse', {
      meta: {
        addonId,
        binary: dep.binary,
        manager,
        package: packageName,
        error: err instanceof Error ? err.message : String(err),
        ...(dep.reason !== undefined ? { reason: dep.reason } : {}),
      },
    })
    return
  }

  // The install "succeeding" is not the claim that matters — the binary
  // resolving is. A package manager that exits 0 having installed a package
  // that ships the binary under another name would otherwise be reported as a
  // success and rediscovered at first use.
  if (!(await rt.hasBinary(dep.binary))) {
    logger.warn('system dependency installed but the binary still does not resolve', {
      meta: { addonId, binary: dep.binary, manager, package: packageName },
    })
    return
  }
  logger.info('system dependency installed', {
    meta: { addonId, binary: dep.binary, manager, package: packageName },
  })
}

function planFor(manager: SystemPackageManager, packageName: string): ManagerPlan {
  switch (manager) {
    case 'apt':
      return {
        manager,
        steps: [
          ['apt-get', ['update']],
          ['apt-get', ['install', '-y', '--no-install-recommends', packageName]],
        ],
      }
    case 'apk':
      return { manager, steps: [['apk', ['add', '--no-cache', packageName]]] }
    case 'dnf':
      return { manager, steps: [['dnf', ['install', '-y', packageName]]] }
    case 'brew':
      return { manager, steps: [['brew', ['install', packageName]]] }
  }
}

async function defaultHasBinary(binary: string): Promise<boolean> {
  try {
    await execFileAsync('command', ['-v', binary], {
      timeout: PROBE_TIMEOUT_MS,
      shell: process.platform === 'win32' ? false : '/bin/sh',
    })
    return true
  } catch {
    return false
  }
}

async function defaultDetectManager(): Promise<SystemPackageManager | null> {
  // Order matters only in that a host with two managers should get the native
  // one: brew is probed last so a Linuxbrew install never shadows apt.
  const candidates: readonly SystemPackageManager[] =
    os.platform() === 'darwin' ? ['brew'] : ['apt', 'apk', 'dnf', 'brew']
  for (const candidate of candidates) {
    const probe = candidate === 'apt' ? 'apt-get' : candidate
    if (await defaultHasBinary(probe)) return candidate
  }
  return null
}

async function defaultRun(command: string, args: readonly string[]): Promise<void> {
  await execFileAsync(command, [...args], { timeout: INSTALL_TIMEOUT_MS })
}
