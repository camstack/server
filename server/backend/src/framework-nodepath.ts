import * as path from 'node:path'

/**
 * The framework's node_modules path to prepend to NODE_PATH so the CJS hub
 * resolves @camstack/system (+ hoisted server deps) from /data/framework.
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
