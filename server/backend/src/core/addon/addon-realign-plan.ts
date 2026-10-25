/**
 * Which installed addon is STALE against the server closure, and which is a
 * deploy the operator meant.
 *
 * ## The gap this closes
 *
 * `<dataDir>/addons` is the only place an addon is ever loaded from — nothing
 * imports one from `@camstack/server`'s closure, on any role. So a server
 * update carries new addon versions into a directory that runs nothing, and
 * no channel brings them to the one that does. Measured on the hub on
 * 2026-09-17: six addons behind the closure, `addon-auth` by nineteen versions,
 * every one of them dating from the last time somebody ran `camstack deploy`.
 *
 * `planFirstBootAddons` was SUPPOSED to have computed this drift on every boot
 * for a month. It did not: it read the closure through
 * `<server>/node_modules`, a directory npm never creates, so every package came
 * back with no closure version and the report printed `8 package(s), 0 to
 * install` and nothing else. The observation was not merely unused — its input
 * was empty, which is exactly why nobody ever acted on it. A wrong path that
 * answers "nothing" is indistinguishable from a closure that carries nothing.
 * `resolveClosureNodeModules` is now the one place that path is spelled.
 *
 * Its `PlanMode` has an `'enforce'` arm — never used anywhere. This is that
 * arm's decision, written as a pure function so the judgement is assertable
 * without a disk.
 *
 * ## Why a version comparison is not enough
 *
 * All six stale copies carry `source: upload`: each WAS a deliberate deploy,
 * once. Neither provenance nor version number separates "stale" from "meant",
 * so the decision needs both gates:
 *
 *  1. the closure is **strictly** newer — never equal, because a `camstack
 *     deploy` from the workspace carries the published version number with
 *     different bytes, and overwriting that silently undoes the deploy;
 *  2. the installed copy was written **before** this closure landed. A deploy
 *     made after it is better informed than the closure whatever its number
 *     says — a workspace build often carries a LOWER version.
 *
 * A rollback, where an older closure sits under a newer installed copy, falls
 * out of gate 1 with nothing to do.
 *
 * An input we cannot measure is never folded into "old" (D393): an install with
 * no date cannot be SHOWN to be stale, and overwriting on an absent measurement
 * is exactly how a deliberate deploy gets destroyed. It is kept, and the reason
 * says why rather than going quiet.
 */
export interface RealignCandidate {
  readonly pkg: string
  readonly installedVersion: string
  /** `updatedAt` from the addon manifest, ms. `null` when unreadable. */
  readonly installedUpdatedAtMs: number | null
  /** The version this closure carries, or `null` when it carries none. */
  readonly closureVersion: string | null
  /** When this closure's copy landed on disk, ms. `null` when unreadable. */
  readonly closureLandedAtMs: number | null
}

export interface RealignDecision {
  readonly pkg: string
  readonly action: 'realign' | 'keep'
  readonly reason: string
}

/** `a` strictly newer than `b`, by numeric segments, missing segments as 0. */
function isStrictlyNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((p) => Number.parseInt(p, 10))
  const pb = b.split('.').map((p) => Number.parseInt(p, 10))
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    if (x !== y) return x > y
  }
  return false
}

export function planAddonRealignment(
  candidates: readonly RealignCandidate[],
): readonly RealignDecision[] {
  return candidates.map((c): RealignDecision => {
    if (c.closureVersion === null) {
      return { pkg: c.pkg, action: 'keep', reason: 'not carried by this closure' }
    }
    if (!isStrictlyNewer(c.closureVersion, c.installedVersion)) {
      return {
        pkg: c.pkg,
        action: 'keep',
        reason: `installed ${c.installedVersion}, closure ${c.closureVersion} — not strictly newer`,
      }
    }
    if (c.installedUpdatedAtMs === null || c.closureLandedAtMs === null) {
      return {
        pkg: c.pkg,
        action: 'keep',
        reason:
          'cannot date the install or the closure — an unknown is not evidence of being stale',
      }
    }
    if (c.installedUpdatedAtMs >= c.closureLandedAtMs) {
      return {
        pkg: c.pkg,
        action: 'keep',
        reason: `installed ${c.installedVersion} was deployed AFTER this closure landed — better informed than ${c.closureVersion}`,
      }
    }
    return {
      pkg: c.pkg,
      action: 'realign',
      reason: `installed ${c.installedVersion} predates this closure, which carries ${c.closureVersion}`,
    }
  })
}
