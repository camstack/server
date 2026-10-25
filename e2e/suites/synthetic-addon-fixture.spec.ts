/**
 * synthetic-addon fixture smoke test.
 *
 * Phase 3 of the addon CLI-vs-npm test suite. Verifies the synthetic
 * addon builder produces a structurally valid package directory:
 *
 *   - package.json includes the camstack.addons[] manifest the kernel
 *     reads (loader's `toAddonPackageManifest`).
 *   - dist/addon.js exports a class whose prototype has `initialize`
 *     (kernel's `isAddonConstructor` check) and tags its own
 *     `LOADED_VERSION` so multi-source races can be diagnosed.
 *   - Two builds with different `version` produce two distinct manifest
 *     entries / runtime tags — required for the version-conflict
 *     scenarios in Phase 4+.
 *
 * Not gated by CAMSTACK_E2E_LIVE — the builder is pure file I/O; no
 * subprocess, no network. Lives in `suites/` only because that's where
 * the harness's vitest pool config picks it up.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildSyntheticAddon } from '../fixtures/synthetic-addon.ts'

interface FixtureAddonClass {
  readonly LOADED_VERSION: string
  new (): { initialize(): Promise<unknown[]>; stop(): Promise<void> }
}

interface SyntheticAddonModule {
  readonly default?: FixtureAddonClass
}

async function importSyntheticAddon(entryPath: string): Promise<FixtureAddonClass> {
  // Dynamic `import()` is necessarily typed as `any` upstream; we narrow
  // at the boundary instead of casting at each access site.
  const mod = (await import(entryPath)) as SyntheticAddonModule
  if (!mod.default) throw new Error(`No default export from ${entryPath}`)
  return mod.default
}

describe('synthetic-addon fixture', () => {
  const dirsToCleanup: string[] = []
  afterEach(() => {
    for (const d of dirsToCleanup.splice(0)) {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true })
    }
  })

  it('writes a valid package.json with the camstack.addons manifest', () => {
    const a = buildSyntheticAddon({ version: '1.0.0' })
    dirsToCleanup.push(a.dir)

    const pkg = JSON.parse(readFileSync(join(a.dir, 'package.json'), 'utf-8')) as {
      name: string
      version: string
      camstack: { addons: Array<{ id: string; entry: string }> }
    }
    expect(pkg.name).toBe(a.name)
    expect(pkg.version).toBe('1.0.0')
    expect(pkg.camstack.addons).toHaveLength(1)
    expect(pkg.camstack.addons[0]?.id).toBe(a.addonId)
    expect(pkg.camstack.addons[0]?.entry).toBe('./dist/addon.js')
  })

  it('writes dist/addon.js with a kernel-loadable class', async () => {
    const a = buildSyntheticAddon({ version: '2.0.0' })
    dirsToCleanup.push(a.dir)

    const entryPath = join(a.dir, 'dist', 'addon.js')
    expect(existsSync(entryPath)).toBe(true)

    // The kernel's resolveAddonClass probe asserts `prototype.initialize`
    // exists — instantiating + invoking initialize() exercises the same
    // contract from the consumer side, so any builder regression (e.g.
    // accidentally swapping CJS for ESM exports) trips this spec
    // instead of cascading into a real install scenario.
    const AddonClass = await importSyntheticAddon(entryPath)
    expect(typeof AddonClass).toBe('function')

    const instance = new AddonClass()
    expect(typeof instance.initialize).toBe('function')
    const result = await instance.initialize()
    expect(result).toEqual([])
  })

  it('tags each build with LOADED_VERSION so multi-source races can be diagnosed', async () => {
    const a = buildSyntheticAddon({ version: '3.7.0' })
    dirsToCleanup.push(a.dir)

    const AddonClass = await importSyntheticAddon(join(a.dir, 'dist', 'addon.js'))
    expect(AddonClass.LOADED_VERSION).toBe('3.7.0')
  })

  it('allows scoped-name override so multiple fixtures can coexist in one verdaccio', () => {
    const a = buildSyntheticAddon({ name: '@camstack/e2e-fixture-alpha', version: '1.0.0' })
    const b = buildSyntheticAddon({ name: '@camstack/e2e-fixture-beta', version: '1.0.0' })
    dirsToCleanup.push(a.dir, b.dir)

    const pkgA = JSON.parse(readFileSync(join(a.dir, 'package.json'), 'utf-8')) as { name: string }
    const pkgB = JSON.parse(readFileSync(join(b.dir, 'package.json'), 'utf-8')) as { name: string }
    expect(pkgA.name).toBe('@camstack/e2e-fixture-alpha')
    expect(pkgB.name).toBe('@camstack/e2e-fixture-beta')
  })
})
