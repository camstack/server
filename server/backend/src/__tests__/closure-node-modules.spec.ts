/**
 * Where the closure's own copy of an addon really is.
 *
 * `path.resolve(__dirname, '..', 'node_modules')` looked right and was not.
 * The launcher runs from `<root>/node_modules/@camstack/server/dist`, so one
 * level up is the server PACKAGE, and `<server>/node_modules` does not exist:
 * npm hoists every `@camstack/addon-*` to the top-level `node_modules`.
 *
 * The cost of that off-by-two was invisible. `planFirstBootAddons` read the
 * closure through this path, found nothing, and therefore computed
 * `twoVersions: false` for every package — so the drift report that was
 * supposed to name six stale addons printed "8 package(s), 0 to install" and
 * nothing else, on every boot, for a month. The observation was not merely
 * unused: its input was empty, which is why nobody ever acted on it.
 */
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveClosureNodeModules } from '../closure-node-modules.js'

describe('resolveClosureNodeModules', () => {
  it('finds the hoisted node_modules from the server package’s dist', () => {
    const root = join('/data', 'server-root', 'current', 'node_modules')
    expect(resolveClosureNodeModules(join(root, '@camstack', 'server', 'dist'))).toBe(root)
  })

  it('is not the server package’s own node_modules, which npm never creates', () => {
    const root = join('/data', 'server-root', 'current', 'node_modules')
    const wrong = join(root, '@camstack', 'server', 'node_modules')
    expect(resolveClosureNodeModules(join(root, '@camstack', 'server', 'dist'))).not.toBe(wrong)
  })

  it('works for a dev checkout laid out the same way', () => {
    const root = join('/repo', 'node_modules')
    expect(resolveClosureNodeModules(join(root, '@camstack', 'server', 'dist'))).toBe(root)
  })
})
