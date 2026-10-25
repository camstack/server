/**
 * AddonInstaller — installSource='symlink' coverage.
 *
 * The symlink mode (dev-only) points `data/addons/<pkg>` directly at
 * the workspace source dir. A workspace rebuild is then visible at the
 * next addon load without re-copying.
 *
 * Lives alongside `addon-installer-update.spec.ts` which exercises the
 * `'local'` (copy) path. Together they cover both branches of
 * `installLocal`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { AddonInstaller } from '../addon-installer.js'

function seedWorkspacePackage(
  workspaceDir: string,
  opts: { name: string; version: string },
): string {
  const shortName = opts.name.replace('@camstack/', '')
  const dir = path.join(workspaceDir, shortName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: opts.name,
        version: opts.version,
        main: 'dist/index.js',
        camstack: {
          addons: [
            {
              id: shortName,
              name: opts.name,
              version: opts.version,
              entry: './dist/index.js',
            },
          ],
        },
      },
      null,
      2,
    ),
  )
  const distDir = path.join(dir, 'dist')
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(
    path.join(distDir, 'index.js'),
    `module.exports = { version: '${opts.version}' };\n`,
  )
  fs.writeFileSync(path.join(distDir, '.version'), opts.version)
  return dir
}

describe("AddonInstaller installSource='symlink'", () => {
  let tmpRoot: string
  let workspaceDir: string
  let addonsDir: string
  let installer: AddonInstaller

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-symlink-'))
    workspaceDir = path.join(tmpRoot, 'workspace')
    addonsDir = path.join(tmpRoot, 'addons')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.mkdirSync(addonsDir, { recursive: true })

    seedWorkspacePackage(workspaceDir, {
      name: '@camstack/test-symlink',
      version: '1.0.0',
    })

    installer = new AddonInstaller({
      addonsDir,
      workspacePackagesDir: workspaceDir,
      installSource: 'symlink',
    })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('creates a directory symlink instead of copying dist/', async () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: exercise the private installLocal install path directly
    await (
      installer as unknown as {
        installLocal: (pkg: string, sourceDir: string) => Promise<{ name: string; version: string }>
      }
    ).installLocal('@camstack/test-symlink', path.join(workspaceDir, 'test-symlink'))

    const target = path.join(addonsDir, '@camstack/test-symlink')
    const stat = fs.lstatSync(target)
    expect(stat.isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(target)).toBe(path.join(workspaceDir, 'test-symlink'))
  })

  it('reflects workspace dist edits without reinstall', async () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: exercise the private installLocal install path directly
    await (
      installer as unknown as {
        installLocal: (pkg: string, sourceDir: string) => Promise<{ name: string; version: string }>
      }
    ).installLocal('@camstack/test-symlink', path.join(workspaceDir, 'test-symlink'))

    // Mutate the workspace dist directly.
    const versionFile = path.join(workspaceDir, 'test-symlink/dist/.version')
    fs.writeFileSync(versionFile, '1.0.1')

    // Read through the symlinked addons path — should see the new bytes.
    const throughSymlink = fs.readFileSync(
      path.join(addonsDir, '@camstack/test-symlink/dist/.version'),
      'utf-8',
    )
    expect(throughSymlink.trim()).toBe('1.0.1')
  })

  it('replaces an existing addon dir on re-install', async () => {
    // First install — leaves a normal dir behind (pretend a previous
    // copy-mode install). Then symlink mode replaces it cleanly.
    const target = path.join(addonsDir, '@camstack/test-symlink')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'stale.txt'), 'pre-existing')

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: exercise the private installLocal install path directly
    await (
      installer as unknown as {
        installLocal: (pkg: string, sourceDir: string) => Promise<{ name: string; version: string }>
      }
    ).installLocal('@camstack/test-symlink', path.join(workspaceDir, 'test-symlink'))

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(target, 'stale.txt'))).toBe(false)
  })

  it('exposes installSource on the installer instance for caller introspection', () => {
    expect(installer.installSource).toBe('symlink')
  })
})
