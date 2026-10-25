/**
 * The directory holding the closure's own copy of each `@camstack` package.
 *
 * The launcher runs from `<root>/node_modules/@camstack/server/dist`. Every
 * addon the server declares is HOISTED to that top-level `node_modules`, not
 * nested under the server package — npm does not create
 * `<server>/node_modules` at all.
 *
 * This existed inline as `path.resolve(__dirname, '..', 'node_modules')`, which
 * is the server package's own directory plus a `node_modules` that is never
 * there. It read as plausible and returned a path that does not exist, so
 * every closure version came back absent: the first-boot plan then computed
 * `twoVersions: false` for everything and printed "8 package(s), 0 to install"
 * on every boot for a month while six addons sat up to nineteen versions
 * behind. A wrong path that answers "nothing" is indistinguishable from a
 * closure that carries nothing, which is why it survived.
 */
import * as path from 'node:path'

/** @param serverDistDir typically `__dirname` of the launcher. */
export function resolveClosureNodeModules(serverDistDir: string): string {
  // dist → server → @camstack → node_modules
  return path.resolve(serverDistDir, '..', '..', '..')
}
