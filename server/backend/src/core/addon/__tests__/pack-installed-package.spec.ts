/**
 * The back-fill must ship the bytes the HUB RUNS, not the registry's build of
 * the same version string.
 *
 * 2026-08-07: `@camstack/addon-pipeline@1.2.43` existed as two different
 * bundles — the one deployed from the workspace and the one published to npm.
 * The back-fill packed `npm pack <name>@<version>`, so every deploy to
 * agent-a was overwritten ~1.5s later by the published build. Identical
 * name, identical version, different code, no error anywhere: it presented as
 * "the agent's dist keeps the previous bundle" and cost a day.
 *
 * `packInstalledPackage` reads the hub's installed dir. This test pins that it
 * returns THAT content (a marker the registry copy could never contain) and
 * that it returns null — deferring to the registry — when the hub has no copy.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AddonPackageService } from '../addon-package.service.js'

const MARKER = 'only-the-hub-copy-has-this'

let root: string
let previousData: string | undefined
let previousAddonsDir: string | undefined

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-installed-'))
  const addonsDir = path.join(root, 'addons')
  const pkgDir = path.join(addonsDir, '@camstack', 'addon-fake')
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@camstack/addon-fake', version: '1.2.43', files: ['dist'] }),
  )
  fs.writeFileSync(path.join(pkgDir, 'dist', 'index.mjs'), `export const marker = '${MARKER}'\n`)
  previousData = process.env['CAMSTACK_DATA']
  previousAddonsDir = process.env['CAMSTACK_ADDONS_DIR']
  process.env['CAMSTACK_DATA'] = root
  process.env['CAMSTACK_ADDONS_DIR'] = addonsDir
})

afterEach(() => {
  if (previousData === undefined) delete process.env['CAMSTACK_DATA']
  else process.env['CAMSTACK_DATA'] = previousData
  if (previousAddonsDir === undefined) delete process.env['CAMSTACK_ADDONS_DIR']
  else process.env['CAMSTACK_ADDONS_DIR'] = previousAddonsDir
  fs.rmSync(root, { recursive: true, force: true })
})

function makeService(): AddonPackageService {
  // The back-fill only needs the packing surface; the service's other
  // collaborators are not touched on this path.
  return Object.create(AddonPackageService.prototype) as AddonPackageService
}

describe('AddonPackageService.packInstalledPackage', () => {
  it("packs the hub's installed bytes, not a registry build of the same version", async () => {
    const packed = await makeService().packInstalledPackage('@camstack/addon-fake')
    expect(packed).not.toBeNull()
    expect(packed?.version).toBe('1.2.43')

    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-installed-out-'))
    const tgz = path.join(extractDir, 'p.tgz')
    fs.writeFileSync(tgz, packed?.buffer ?? Buffer.alloc(0))
    execFileSync('tar', ['-xzf', tgz, '-C', extractDir])
    const shipped = fs.readFileSync(path.join(extractDir, 'package', 'dist', 'index.mjs'), 'utf-8')
    fs.rmSync(extractDir, { recursive: true, force: true })

    expect(shipped).toContain(MARKER)
  }, 60_000)

  it('returns null when the hub has no installed copy — the registry is then the only source', async () => {
    expect(await makeService().packInstalledPackage('@camstack/addon-not-here')).toBeNull()
  })
})
