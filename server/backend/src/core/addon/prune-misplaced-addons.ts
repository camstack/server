/**
 * prune-misplaced-addons — remove an installed addon that can never run here.
 *
 * ## The state this exists to clear
 *
 * `@camstack/addon-agent-ui` declares `execution.placement: 'agent-only'`, and
 * both hub-side load paths honour that: `addon-registry.service.ts` skips it at
 * boot and after an install. `selectHubBootstrapPackages` also subtracts it, so
 * a hub does not install it any more.
 *
 * None of that removes the copy an OLDER build already put on disk. On the live
 * hub `/data/addons/@camstack/addon-agent-ui` is dated 2026-07-22 — eleven days
 * before this was looked at. The loader skips it, so it never initialises, so
 * the fleet UI shows it as **failed**, forever, on a node where it is not
 * supposed to exist. An operator cannot tell that apart from an addon that is
 * genuinely broken, which is the real cost: a permanent red entry teaches
 * people to ignore red entries.
 *
 * Fixing the installer was necessary and not sufficient — the previous fix
 * assumed no leftovers. This closes it.
 *
 * ## Why deleting is the right move
 *
 * An `agent-only` addon on a hub has no dormant use: it cannot be enabled, it
 * cannot be reached, and keeping it costs a false failure. The directory is
 * reinstallable from npm at any time, so removal is not destructive in the way
 * deleting DATA would be. Anything outside `<dataDir>/addons/@camstack/` is
 * refused outright.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** One installed addon considered for pruning. */
export interface InstalledAddonDir {
  /** Package name, e.g. `@camstack/addon-agent-ui`. */
  readonly packageName: string
  /** Absolute directory it is installed in. */
  readonly dir: string
  /** Resolved placement from its manifest. */
  readonly placement: string
}

export interface PruneDecision {
  readonly packageName: string
  readonly dir: string
  readonly reason: string
}

/**
 * Decide what to prune for a node in `role`. Pure — the decision is the part
 * worth testing, and it must never depend on a filesystem to be checked.
 *
 * Only the unambiguous direction is pruned: an `agent-only` addon on a hub. The
 * mirror case (`hub-only` on an agent) is deliberately NOT handled here — an
 * agent seeds its addon set from the hub's closure and a `hub-only` entry there
 * is expected to be inert, so pruning it would fight the seeding rather than
 * fix anything.
 */
export function decidePrune(
  installed: readonly InstalledAddonDir[],
  role: 'hub' | 'agent',
): readonly PruneDecision[] {
  if (role !== 'hub') return []
  return installed
    .filter((a) => a.placement === 'agent-only')
    .map((a) => ({
      packageName: a.packageName,
      dir: a.dir,
      reason: 'agent-only addon installed on the hub — it can never load here',
    }))
}

/** Guard: only ever remove something under `<dataDir>/addons/@camstack/`. */
export function isPrunableDir(dir: string, addonsRoot: string): boolean {
  const rel = path.relative(addonsRoot, dir)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
  // Exactly one level below the scope directory — never a nested path.
  return rel.split(path.sep).filter(Boolean).length === 1
}

export interface PruneLogger {
  readonly info: (msg: string, meta?: Record<string, unknown>) => void
  readonly warn: (msg: string, meta?: Record<string, unknown>) => void
}

/**
 * Apply the decisions. Returns what was actually removed.
 *
 * A failure to remove one entry never aborts the rest and never throws into
 * boot: the worst case is the pre-existing state — a stale entry showing as
 * failed — which is exactly what we are trying to improve, not a reason to
 * refuse to start.
 */
export function prunePlacementLeftovers(
  decisions: readonly PruneDecision[],
  addonsRoot: string,
  logger: PruneLogger,
  rm: (dir: string) => void = (dir) => fs.rmSync(dir, { recursive: true, force: true }),
): readonly string[] {
  const removed: string[] = []
  for (const d of decisions) {
    if (!isPrunableDir(d.dir, addonsRoot)) {
      logger.warn('refusing to prune a path outside the addon scope', {
        packageName: d.packageName,
        dir: d.dir,
        addonsRoot,
      })
      continue
    }
    try {
      rm(d.dir)
      removed.push(d.packageName)
      // Say it out loud: a directory disappearing at boot must never be
      // something the operator discovers by noticing it is gone.
      logger.info('pruned a misplaced addon', {
        packageName: d.packageName,
        dir: d.dir,
        reason: d.reason,
      })
    } catch (err) {
      logger.warn('could not prune a misplaced addon', {
        packageName: d.packageName,
        dir: d.dir,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return removed
}
