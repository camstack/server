/**
 * Which directories the agent scans for addons — decided as pure data.
 *
 * ── The single-copy collapse, finally on the agent ─────────────────────────
 * The hub stopped loading framework builtins from a physical
 * `<addonsDir>/@camstack/system` on 2026-07-18: it loads them from the ACTIVE
 * CLOSURE it is itself running (`addon-registry.service.ts`, `loadFromAddonDir`
 * on the closure dir, then `loadFromDirectory(addonsDir, ['@camstack/system'])`
 * so the copy is skipped). The reason is in that file's comment — *"that copy
 * drifted because no update channel refreshed it"*.
 *
 * The agent never got the change, and drifted exactly as predicted. Measured
 * 2026-08-11: agent-a carried `@camstack/system@1.2.61` and macmini
 * `1.2.62` in their addon roots while both ran a `1.2.78` closure. Nothing
 * refreshed them, because `seedBuiltinsFromClosure` (now deleted) only wrote
 * the copy when it was ABSENT — a self-heal that guaranteed a copy existed and
 * never that it was current. It also contradicted
 * `AddonInstaller.shouldSkipClosureProvidedSeed`, which already refused to
 * plant that copy for this very reason.
 *
 * ── Why the skip is correctness, not tidiness ──────────────────────────────
 * `AddonLoader` keys its map on `declaration.id`, so loading the closure AND a
 * stale copy through one loader is not a duplicate — it is LAST-LOAD-WINS. The
 * builtins a node runs would depend on directory iteration order. The copy must
 * be skipped, not merely deprioritized.
 *
 * ── The fallback ──────────────────────────────────────────────────────────
 * If the closure cannot be resolved, the copy is NOT skipped and the node boots
 * from it. In a running agent this is near-impossible — `agent/main.ts`
 * statically imports `@camstack/system`, so if the process exists the walk-up
 * resolves — but a node with neither source must fail through the D87 guard
 * (`assertRequiredInfraResolved`, which names every missing required cap),
 * never through a silent "no addon packages found" early return.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** The framework builtins package. Loaded from the closure, never from a copy. */
export const BUILTINS_PACKAGE = '@camstack/system'

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every installed addon package under `addonsDir`, minus `skipPackages`.
 *
 * Matching mirrors `AddonLoader.loadFromDirectory`'s skip list exactly —
 * `<scope>/<name>` for a scoped directory, the bare name for a flat one — so
 * the hub and the agent exclude the same thing given the same list.
 */
export function resolveAddonPackageDirs(
  addonsDir: string,
  skipPackages: readonly string[] = [],
): string[] {
  const dirs: string[] = []
  if (!fs.existsSync(addonsDir)) return dirs
  const skip = new Set(skipPackages)

  for (const name of fs.readdirSync(addonsDir)) {
    const full = path.join(addonsDir, name)
    if (name.startsWith('@') && isDir(full)) {
      // Scoped packages: @camstack/addon-xyz
      for (const sub of fs.readdirSync(full)) {
        const subFull = path.join(full, sub)
        if (skip.has(`${name}/${sub}`)) continue
        if (isDir(subFull) && fs.existsSync(path.join(subFull, 'package.json'))) {
          dirs.push(subFull)
        }
      }
    } else if (isDir(full) && fs.existsSync(path.join(full, 'package.json'))) {
      if (skip.has(name)) continue
      dirs.push(full)
    }
  }

  return dirs
}

/**
 * The ordered directory list `bootCoreAddons` loads, closure first.
 *
 * `closureSystemDir` is `resolveHubClosurePackageDir(BUILTINS_PACKAGE)` — null
 * only when the builtins are not resolvable from the running closure at all.
 */
export function planAgentAddonScan(
  addonsDir: string,
  closureSystemDir: string | null,
): readonly string[] {
  if (closureSystemDir === null) {
    // No closure copy: fall back to whatever is on disk, including the
    // addon-root builtins, rather than booting with no infra at all.
    return resolveAddonPackageDirs(addonsDir)
  }
  return [closureSystemDir, ...resolveAddonPackageDirs(addonsDir, [BUILTINS_PACKAGE])]
}
