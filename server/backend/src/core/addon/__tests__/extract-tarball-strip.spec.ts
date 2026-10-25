/**
 * Regression test for C1: extractTarball must strip the npm `package/` prefix.
 *
 * npm tarballs nest everything under `package/`. Without `--strip-components=1`
 * the extract lands files at `destDir/package/package.json` rather than
 * `destDir/package.json`, causing `StagingArea.fetchAndStage` to throw ENOENT
 * on every real addon update.
 *
 * This test builds a real gzipped tarball with the npm layout, calls the real
 * `extractTgzStripped` helper (the same code path as `extractTarball`), and
 * asserts the package.json ends up at the correct location.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, afterEach } from 'vitest'
import { extractTgzStripped } from '../addon-package.service.js'

const tmpDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Build a minimal npm-layout tarball:
 *   package/package.json
 *   package/dist/x.js
 *
 * Returns the tarball as a Buffer.
 */
function buildNpmTarball(): Buffer {
  const srcDir = makeTempDir()
  const pkgDir = path.join(srcDir, 'package')
  const distDir = path.join(pkgDir, 'dist')
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@camstack/test-addon', version: '1.2.3' }),
  )
  fs.writeFileSync(path.join(distDir, 'x.js'), '"use strict"; exports.ok = true;\n')

  const tgzPath = path.join(srcDir, 'test.tgz')
  execFileSync('tar', ['-czf', tgzPath, '-C', srcDir, 'package'], { timeout: 10_000 })
  return fs.readFileSync(tgzPath)
}

describe('extractTgzStripped', () => {
  it('strips the npm package/ prefix so package.json lands at destDir root (C1 regression)', async () => {
    const tgz = buildNpmTarball()
    const destDir = makeTempDir()

    // RED guard: without --strip-components=1 this would land at
    // destDir/package/package.json. The fix must make it land at destDir/package.json.
    await extractTgzStripped(tgz, destDir)

    expect(fs.existsSync(path.join(destDir, 'package.json')), 'package.json at root').toBe(true)
    expect(
      fs.existsSync(path.join(destDir, 'package', 'package.json')),
      'package.json NOT inside package/ subdir',
    ).toBe(false)
  })

  it('strips the npm package/ prefix so dist/x.js lands at destDir/dist/x.js', async () => {
    const tgz = buildNpmTarball()
    const destDir = makeTempDir()

    await extractTgzStripped(tgz, destDir)

    expect(fs.existsSync(path.join(destDir, 'dist', 'x.js')), 'dist/x.js at root').toBe(true)
    expect(
      fs.existsSync(path.join(destDir, 'package', 'dist', 'x.js')),
      'dist/x.js NOT inside package/ subdir',
    ).toBe(false)
  })

  it('places the correct content in the extracted package.json', async () => {
    const tgz = buildNpmTarball()
    const destDir = makeTempDir()

    await extractTgzStripped(tgz, destDir)

    const manifest = JSON.parse(fs.readFileSync(path.join(destDir, 'package.json'), 'utf-8')) as {
      name?: string
      version?: string
    }
    expect(manifest.name).toBe('@camstack/test-addon')
    expect(manifest.version).toBe('1.2.3')
  })
})
