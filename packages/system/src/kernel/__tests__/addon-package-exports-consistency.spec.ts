/**
 * Addon `package.json` exports consistency.
 *
 * Regression coverage for the pipeline-analytics silent-miss on
 * 2026-04-22: the addon's scaffolding had `"type": "module"` in
 * package.json, which inverts tsup's output extensions (ESM → .js,
 * CJS → .cjs). The `exports` block still pointed at `./dist/index.mjs`
 * (ESM under the standard convention) and `./dist/index.js` (CJS),
 * so Node's resolver looked for `.mjs` files that tsup never emitted
 * → the addon loader's `import()` call silently failed and the addon
 * never registered its provider.
 *
 * The invariant: for every workspace addon under `packages/`, the
 * filenames referenced by its `exports` block must match the
 * filenames tsup produces for its declared `type` field.
 *
 *   type unset / "commonjs"  → CJS=.js, ESM=.mjs
 *   type === "module"        → ESM=.js, CJS=.cjs
 *
 * This test walks every workspace package, reads its package.json,
 * and verifies the `exports[".].{import,require,types}` fields point
 * at the extensions tsup would emit given the declared `type`.
 *
 * NOTE: we don't require the files to EXIST at test time (dist/ may
 * be cleaned in CI). We check the string contract only.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

interface PkgExports {
  readonly '.'?: {
    readonly types?: string
    readonly import?: string
    readonly require?: string
  }
}

interface PackageJson {
  readonly name?: string
  readonly type?: 'module' | 'commonjs'
  readonly main?: string
  readonly module?: string
  readonly types?: string
  readonly keywords?: readonly string[]
  readonly exports?: PkgExports
}

function repoRoot(): string {
  // this file lives at packages/system/src/kernel/__tests__/… — five ../ up
  return path.resolve(__dirname, '..', '..', '..', '..', '..')
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}

function expectedExtensions(pkg: PackageJson): { esm: string; cjs: string } {
  // tsup with `format: ['cjs', 'esm']` chooses extensions based on
  // the package's `type` field:
  //   type: "module"     → ESM=.js, CJS=.cjs
  //   type: "commonjs"   → ESM=.mjs, CJS=.js
  //   type: absent       → treated as "commonjs"
  if (pkg.type === 'module') return { esm: '.js', cjs: '.cjs' }
  return { esm: '.mjs', cjs: '.js' }
}

function listWorkspaceAddons(): Array<{ name: string; pkg: PackageJson; pkgPath: string }> {
  const packagesDir = path.join(repoRoot(), 'packages')
  const out: Array<{ name: string; pkg: PackageJson; pkgPath: string }> = []
  for (const entry of fs.readdirSync(packagesDir)) {
    const pkgJsonPath = path.join(packagesDir, entry, 'package.json')
    if (!fs.existsSync(pkgJsonPath)) continue
    const pkg = readJson<PackageJson>(pkgJsonPath)
    // Only addon packages — the ones with a camstack-addon keyword AND
    // an `exports['.']` entry. Skip internal libs that expose a
    // different shape (e.g. kernel exposes process-runner separately).
    if (!pkg.name) continue
    if (!pkg.keywords?.includes('camstack-addon')) continue
    if (!pkg.exports?.['.']) continue
    out.push({ name: pkg.name, pkg, pkgPath: pkgJsonPath })
  }
  return out
}

describe('addon package.json exports match tsup output extensions', () => {
  const addons = listWorkspaceAddons()

  it('has at least one addon to check (smoke)', () => {
    expect(addons.length).toBeGreaterThan(0)
  })

  for (const { name, pkg } of addons) {
    it(`${name}: exports.import matches expected ESM extension for type=${pkg.type ?? 'commonjs'}`, () => {
      const { esm } = expectedExtensions(pkg)
      const importPath = pkg.exports?.['.']?.import
      expect(importPath, `${name}: missing exports["."].import`).toBeDefined()
      expect(
        importPath!.endsWith(esm),
        `${name}: exports["."].import is "${importPath}" but should end with "${esm}" (type=${pkg.type ?? 'commonjs'})`,
      ).toBe(true)
    })

    it(`${name}: exports.require matches expected CJS extension for type=${pkg.type ?? 'commonjs'}`, () => {
      const { cjs } = expectedExtensions(pkg)
      const requirePath = pkg.exports?.['.']?.require
      expect(requirePath, `${name}: missing exports["."].require`).toBeDefined()
      expect(
        requirePath!.endsWith(cjs),
        `${name}: exports["."].require is "${requirePath}" but should end with "${cjs}" (type=${pkg.type ?? 'commonjs'})`,
      ).toBe(true)
    })

    it(`${name}: main matches expected CJS extension`, () => {
      const { cjs } = expectedExtensions(pkg)
      if (!pkg.main) return // optional
      expect(
        pkg.main.endsWith(cjs),
        `${name}: main is "${pkg.main}" but should end with "${cjs}" (type=${pkg.type ?? 'commonjs'})`,
      ).toBe(true)
    })

    it(`${name}: module matches expected ESM extension`, () => {
      const { esm } = expectedExtensions(pkg)
      if (!pkg.module) return // optional
      expect(
        pkg.module.endsWith(esm),
        `${name}: module is "${pkg.module}" but should end with "${esm}" (type=${pkg.type ?? 'commonjs'})`,
      ).toBe(true)
    })
  }
})
