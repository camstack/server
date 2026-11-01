import * as path from 'node:path'

/**
 * The framework's node_modules path to prepend to NODE_PATH so the CJS hub
 * resolves @camstack/server/system (+ hoisted server deps) from /data/framework.
 * CJS honors NODE_PATH (unlike ESM `import`, which is why addons use the
 * resolver hook instead). Empty when unset or absent.
 */
export function frameworkNodePaths(
  frameworkDir: string | undefined,
  exists: (p: string) => boolean,
): string[] {
  if (!frameworkDir) return []
  const nm = path.join(frameworkDir, 'node_modules')
  return exists(nm) ? [nm] : []
}

/**
 * Whether the starter's active single copy carries the framework, i.e. its
 * `@camstack/server` ships `./system` (D989). The launcher points
 * CAMSTACK_FRAMEWORK_DIR (and so NODE_PATH and the runners' resolver) at the
 * active root only when this holds; a check on the retired standalone
 * package left the hub's CJS addon loads with no framework on their path.
 */
export function isActiveFrameworkRoot(
  activeRoot: string | undefined,
  exists: (p: string) => boolean,
): boolean {
  if (!activeRoot) return false
  return exists(
    path.join(activeRoot, 'node_modules', '@camstack', 'server', 'system', 'package.json'),
  )
}

/**
 * NODE_PATH with the active closure's paths FIRST. CJS tries NODE_PATH entries
 * in order, so an inherited entry (an image's `/data/framework/node_modules`)
 * placed ahead would serve its stale `@camstack/types` to every hub-loaded
 * addon — benchmark failed on .50 with `customAction is not a function`.
 * Duplicates keep their first position.
 */
export function composeNodePath(
  inherited: string | undefined,
  preferred: readonly string[],
  sep: string,
): string {
  const inheritedEntries = (inherited ?? '').split(sep).filter((p) => p.length > 0)
  return [...new Set([...preferred, ...inheritedEntries])].join(sep)
}
