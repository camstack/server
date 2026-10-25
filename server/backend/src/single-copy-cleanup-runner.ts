/**
 * The one adapter that runs the post-boot single-copy sweep on BOTH roles.
 *
 * Operator, 2026-08-13: *"l'agente deve essere identico all'hub"* [the agent must be identical to the hub]. Two code
 * paths that must agree get one implementation — the hub calls this after its
 * boot-health confirmation, the agent after its first acked `registerNode`, and
 * neither owns a private idea of what may be deleted.
 *
 * Everything decidable lives in `single-copy-cleanup.ts` and is pure. This file
 * only reads the real world: the active-root env, where `@camstack/system`
 * actually resolved, the effective `NODE_PATH`, and the disk.
 *
 * It never throws. A sweep that fails leaves a node with an extra directory; a
 * sweep that ends a process is an outage, and the copies it removes exist
 * precisely because a node once could not boot.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { CleanupResult } from './single-copy-cleanup.js'
import {
  discoverRedundantCopies,
  executeSingleCopyCleanup,
  formatCleanupPlan,
  isCleanupEnabled,
  planSingleCopyCleanup,
} from './single-copy-cleanup.js'

export interface CleanupRunnerOptions {
  readonly dataDir: string
  /** `CAMSTACK_ADDONS_DIR` — the ONE directory the loader reads. */
  readonly addonRoot: string
  /** One line per event. The caller decides whether that is a logger or console. */
  readonly log: (line: string) => void
}

const EMPTY_RESULT: CleanupResult = { removed: [], failed: [], refused: true }

/**
 * Discover, plan, report, sweep. Called only from a point where the role has
 * already confirmed its boot healthy — that confirmation IS the gate, and it is
 * re-stated as `bootHealthy: true` here so the pure planner can be exercised
 * from both sides in a test.
 */
export async function runSingleCopyCleanup(opts: CleanupRunnerOptions): Promise<CleanupResult> {
  try {
    if (!isCleanupEnabled(process.env)) {
      opts.log('single-copy cleanup disabled by CAMSTACK_SINGLE_COPY_CLEANUP — nothing removed')
      return EMPTY_RESULT
    }

    const candidates = discoverRedundantCopies(
      {
        dataDir: opts.dataDir,
        addonRoot: opts.addonRoot,
        closureProvides: (pkg) => {
          try {
            require.resolve(`${pkg}/package.json`)
            return true
          } catch {
            return false
          }
        },
      },
      {
        exists: (p) => fs.existsSync(p),
        readVersion: (dir) => readVersion(dir),
      },
    )

    const plan = planSingleCopyCleanup({
      activeRoot: process.env['CAMSTACK_SERVER_ACTIVE_ROOT'] ?? null,
      closureResolvedFrom: resolveSystemPath(),
      bootHealthy: true,
      nodePathEntries: (process.env['NODE_PATH'] ?? '')
        .split(process.platform === 'win32' ? ';' : ':')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      candidates,
    })

    for (const line of formatCleanupPlan(plan)) opts.log(line)
    return await executeSingleCopyCleanup(
      plan,
      {
        exists: (p) => fs.existsSync(p),
        rename: (from, to) => fs.renameSync(from, to),
        remove: async (p) => {
          await fs.promises.rm(p, { recursive: true, force: true })
        },
      },
      opts.log,
    )
  } catch (err) {
    opts.log(
      `single-copy cleanup failed: ${err instanceof Error ? err.message : String(err)} — nothing was removed`,
    )
    return EMPTY_RESULT
  }
}

/** Where this process actually resolved `@camstack/system`, or `null`. */
function resolveSystemPath(): string | null {
  try {
    return require.resolve('@camstack/system/package.json')
  } catch {
    return null
  }
}

function readVersion(packageDir: string): string | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8'))
    const version =
      typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}
