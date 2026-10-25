/**
 * AddonInstaller.installFromTgz — STAGED UNPACK + ATOMIC RENAME (no wedge).
 *
 * Regression guard for the shfs/FUSE deploy WEDGE: the old path extracted to
 * /tmp then `fs.promises.cp`'d the (large) dist ACROSS to the FUSE `/data/addons`
 * mount file-by-file on the Node main process. That recursive copy saturated the
 * libuv threadpool + disk IO so hard it starved the whole host — HTTP listener
 * wedged, SSH/web/docker unreachable, kernel RCU stall warnings on the console.
 *
 * The fix: extract the tgz DIRECTLY into a staging dir on the SAME FUSE mount via
 * the `tar` subprocess (heavy IO off the event loop), build it in place, then
 * swap it in with a single ATOMIC RENAME — no main-thread file copy at all. This
 * test asserts the install performs NO `fs.promises.cp` and still lands dist +
 * extra `files` dirs, and that a redeploy swaps atomically.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddonInstaller } from '../addon-installer.js'

const PKG = '@camstack/test-pipe'

/** npm-pack-layout tgz with dist/ + a python/ extra `files` dir. */
function makeTgz(tmpRoot: string, version: string): string {
  const stage = fs.mkdtempSync(path.join(tmpRoot, 'stage-'))
  const pkgDir = path.join(stage, 'package')
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
  fs.mkdirSync(path.join(pkgDir, 'python'), { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: PKG,
        version,
        main: 'dist/index.js',
        files: ['dist', 'python'],
        camstack: {
          addons: [{ id: 'test-pipe', name: PKG, version, entry: './dist/index.js' }],
        },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(pkgDir, 'dist', 'index.js'),
    `module.exports={version:'${version}'};\n`,
  )
  fs.writeFileSync(path.join(pkgDir, 'python', 'run.py'), 'print("ok")\n')
  const tgz = path.join(tmpRoot, `test-pipe-${version}.tgz`)
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'package'])
  return tgz
}

describe('installFromTgz — staged unpack + atomic rename', () => {
  let tmpRoot: string
  let addonsDir: string
  let installer: AddonInstaller

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-tgz-staged-'))
    addonsDir = path.join(tmpRoot, 'addons')
    fs.mkdirSync(addonsDir, { recursive: true })
    installer = new AddonInstaller({ addonsDir })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('lands dist + extra `files` dirs with NO main-thread recursive copy (swaps via rename)', async () => {
    const cpSpy = vi.spyOn(fs.promises, 'cp')
    const renameSpy = vi.spyOn(fs.promises, 'rename')

    const result = await installer.installFromTgz(makeTgz(tmpRoot, '1.0.0'))
    expect(result).toEqual({ name: PKG, version: '1.0.0' })

    const targetDir = path.join(addonsDir, PKG)
    // dist AND the extra python/ dir landed (they rode along in the rename).
    expect(fs.existsSync(path.join(targetDir, 'dist', 'index.js'))).toBe(true)
    expect(fs.existsSync(path.join(targetDir, 'python', 'run.py'))).toBe(true)

    // THE FIX: no `fs.promises.cp` (the file-by-file copy that wedged the host).
    expect(cpSpy).not.toHaveBeenCalled()
    // Swapped in via an atomic rename instead.
    expect(renameSpy).toHaveBeenCalled()

    // Staging tree is cleaned up — no `install-*` residue left behind.
    const stagingRoot = path.join(addonsDir, '.staging')
    const residue = fs.existsSync(stagingRoot)
      ? fs.readdirSync(stagingRoot).filter((e) => e.startsWith('install-'))
      : []
    expect(residue).toEqual([])
  })

  it('a redeploy over an existing install swaps atomically (no cp, dist replaced)', async () => {
    await installer.installFromTgz(makeTgz(tmpRoot, '1.0.0'))

    const cpSpy = vi.spyOn(fs.promises, 'cp')
    const result = await installer.installFromTgz(makeTgz(tmpRoot, '2.0.0'))
    expect(result.version).toBe('2.0.0')

    const targetDir = path.join(addonsDir, PKG)
    const pj = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf-8')) as {
      version: string
    }
    expect(pj.version).toBe('2.0.0')
    expect(fs.existsSync(path.join(targetDir, 'python', 'run.py'))).toBe(true)
    expect(cpSpy).not.toHaveBeenCalled()
  })
})
