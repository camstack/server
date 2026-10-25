/**
 * AddonInstaller.installFromTgz — robust eviction of the previous install dir.
 *
 * Regression guard for the shfs/FUSE deploy-gutting bug: a `camstack deploy`
 * of an addon whose live runner holds native prebuilds (`.node`/`.so`) open
 * cannot recursively `rm` the existing addon dir in place — FUSE returns
 * `ENOTEMPTY` on the held subdir, the rm throws BEFORE the new files are
 * written, and the addon dir is left GUTTED (only a partial `node_modules`),
 * with every subsequent deploy re-failing on the same stuck rm.
 *
 * `installFromTgz` must therefore evict the old dir by an atomic rename-aside
 * (the same idiom `applyUpdate`/`applyUpdateFromStaged` already use) rather
 * than an in-place recursive delete — a rename is a metadata op that succeeds
 * even while the old inodes are held open. Cleaning the aside copy is
 * best-effort: it may still hold open files until the old runner restarts, so
 * a failure to remove it must NOT fail the install.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddonInstaller } from '../addon-installer.js'

interface TgzManifest {
  readonly name: string
  readonly version: string
}

/** Build an npm-pack-layout tarball (`package/package.json` + `package/dist/`). */
function makeTgz(tmpRoot: string, manifest: TgzManifest): string {
  const stage = fs.mkdtempSync(path.join(tmpRoot, 'stage-'))
  const pkgDir = path.join(stage, 'package')
  const distDir = path.join(pkgDir, 'dist')
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        main: 'dist/index.js',
        camstack: {
          addons: [
            {
              id: manifest.name.replace('@camstack/', ''),
              name: manifest.name,
              version: manifest.version,
              entry: './dist/index.js',
            },
          ],
        },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(distDir, 'index.js'),
    `module.exports = { version: '${manifest.version}' };\n`,
  )
  const tgzPath = path.join(
    tmpRoot,
    `${manifest.name.replace('@camstack/', '')}-${manifest.version}.tgz`,
  )
  execFileSync('tar', ['-czf', tgzPath, '-C', stage, 'package'])
  return tgzPath
}

const PKG = '@camstack/test-pipe'

describe('AddonInstaller.installFromTgz — rename-aside eviction (FUSE held-open)', () => {
  let tmpRoot: string
  let addonsDir: string
  let installer: AddonInstaller

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-tgz-evict-'))
    addonsDir = path.join(tmpRoot, 'addons')
    fs.mkdirSync(addonsDir, { recursive: true })
    installer = new AddonInstaller({ addonsDir })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('redeploys over a previous install whose dir cannot be removed in place', async () => {
    // First install (v1) establishes the live addon dir.
    await installer.installFromTgz(makeTgz(tmpRoot, { name: PKG, version: '1.0.0' }))
    const targetDir = path.join(addonsDir, PKG)
    // Simulate a held-open native prebuild the old runner has loaded.
    const heldDir = path.join(targetDir, 'node_modules', '@seydx', 'node-av-linux-x64')
    fs.mkdirSync(heldDir, { recursive: true })
    fs.writeFileSync(path.join(heldDir, 'index.node'), 'ELF')

    // Make ANY recursive removal that touches the held-open inodes fail
    // exactly like shfs/FUSE does — both an in-place rm of the live dir AND
    // the rm of the renamed-aside copy (the old runner still holds the libs
    // open until it restarts post-install). The install must survive both:
    // the rename succeeds (metadata only), and the aside cleanup is
    // best-effort.
    const realRm = fs.promises.rm.bind(fs.promises)
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (p, opts) => {
      const resolved = path.resolve(String(p))
      const held =
        resolved === path.resolve(targetDir) ||
        resolved.startsWith(path.resolve(path.join(addonsDir, '.evicting')))
      if (held) {
        const err = new Error(
          `ENOTEMPTY: directory not empty, rmdir '${heldDir}'`,
        ) as NodeJS.ErrnoException
        err.code = 'ENOTEMPTY'
        throw err
      }
      return realRm(p, opts)
    })

    // Deploy v2 — must succeed despite the in-place delete being impossible.
    const result = await installer.installFromTgz(makeTgz(tmpRoot, { name: PKG, version: '2.0.0' }))

    expect(result).toEqual({ name: PKG, version: '2.0.0' })
    // The installed dir reflects the NEW version (not gutted, not stale).
    const installed = JSON.parse(
      fs.readFileSync(path.join(targetDir, 'package.json'), 'utf-8'),
    ) as { version: string }
    expect(installed.version).toBe('2.0.0')
    expect(fs.existsSync(path.join(targetDir, 'dist', 'index.js'))).toBe(true)
  })
})
