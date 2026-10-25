import { register } from 'node:module'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Register the ESM resolver hook so this runner's addon imports of the
 * host-provided packages (@camstack/system, @camstack/types, …) resolve from
 * `frameworkDir/node_modules` instead of failing to walk up from the addon's
 * isolated `/data/addons/<addon>` folder. No-op in dev (frameworkDir unset),
 * where workspace symlinks already resolve the framework.
 */
export function registerFrameworkResolver(frameworkDir: string | undefined): void {
  if (!frameworkDir) return
  const hookUrl = pathToFileURL(path.join(__dirname, 'framework-resolver-hook.mjs'))
  register(hookUrl, {
    parentURL: pathToFileURL(`${__dirname}/`).href,
    data: { frameworkDir },
  })
}
