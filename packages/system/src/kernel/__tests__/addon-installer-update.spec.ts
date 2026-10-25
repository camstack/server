import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { AddonInstaller } from '../addon-installer.js'

/**
 * Tests for AddonInstaller.applyUpdate / rollbackAddon / clearBackup.
 *
 * We exercise the local-install path so the tests don't need a real
 * npm registry. We seed a fake "workspace" with two versions of a fake
 * addon and let the installer copy from there.
 */

interface SeedOpts {
  name: string
  version: string
  withCamstackAddon?: boolean
}

function seedWorkspacePackage(workspaceDir: string, opts: SeedOpts): string {
  // findLocalPackage strips '@camstack/' and looks for {short-name},
  // 'addon-{short-name}', or the full name under workspaceDir. We use
  // the short name here to make the test pass through findLocalPackage.
  const shortName = opts.name.replace('@camstack/', '')
  const dir = path.join(workspaceDir, shortName)
  fs.mkdirSync(dir, { recursive: true })

  // package.json
  const pkgJson: Record<string, unknown> = {
    name: opts.name,
    version: opts.version,
    main: 'dist/index.js',
  }
  if (opts.withCamstackAddon !== false) {
    pkgJson.camstack = {
      addons: [
        {
          id: shortName,
          name: opts.name,
          version: opts.version,
          entry: './dist/index.js',
        },
      ],
    }
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2))

  // Fake dist with a marker file containing the version (used by tests
  // to assert which version is currently installed)
  const distDir = path.join(dir, 'dist')
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(
    path.join(distDir, 'index.js'),
    `module.exports = { version: '${opts.version}' };\n`,
  )
  fs.writeFileSync(path.join(distDir, '.version'), opts.version)

  return dir
}

function readInstalledVersion(addonsDir: string, name: string): string | null {
  const versionFile = path.join(addonsDir, name, 'dist', '.version')
  if (!fs.existsSync(versionFile)) return null
  return fs.readFileSync(versionFile, 'utf-8').trim()
}

describe('AddonInstaller.applyUpdate', () => {
  let tmpRoot: string
  let workspaceDir: string
  let addonsDir: string
  let installer: AddonInstaller

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-update-'))
    workspaceDir = path.join(tmpRoot, 'workspace')
    addonsDir = path.join(tmpRoot, 'addons')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.mkdirSync(addonsDir, { recursive: true })

    // Seed workspace with v1 of a test addon
    seedWorkspacePackage(workspaceDir, {
      name: '@camstack/test-foo',
      version: '1.0.0',
    })

    installer = new AddonInstaller({
      addonsDir,
      workspacePackagesDir: workspaceDir,
      installSource: 'local',
    })

    // Initial install of v1
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: exercise the private installLocal install path directly
    await (
      installer as unknown as {
        installLocal: (pkg: string, sourceDir: string) => Promise<{ name: string; version: string }>
      }
    ).installLocal('@camstack/test-foo', path.join(workspaceDir, 'test-foo'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('updates an installed addon to a newer local version', async () => {
    expect(readInstalledVersion(addonsDir, '@camstack/test-foo')).toBe('1.0.0')

    // Bump workspace to v2
    fs.rmSync(path.join(workspaceDir, 'test-foo'), { recursive: true })
    seedWorkspacePackage(workspaceDir, {
      name: '@camstack/test-foo',
      version: '2.0.0',
    })

    const result = await installer.applyUpdate('@camstack/test-foo')
    expect(result.name).toBe('@camstack/test-foo')
    expect(result.version).toBe('2.0.0')
    expect(readInstalledVersion(addonsDir, '@camstack/test-foo')).toBe('2.0.0')

    // Backup directory exists with the old version
    expect(fs.existsSync(result.backupDir)).toBe(true)
    const backupVersionFile = path.join(result.backupDir, 'dist', '.version')
    expect(fs.readFileSync(backupVersionFile, 'utf-8').trim()).toBe('1.0.0')

    // Manifest reflects new version + backup pointer
    const entry = installer.manifest.get('@camstack/test-foo')
    expect(entry?.version).toBe('2.0.0')
    expect(entry?.lastBackupDir).toBe(result.backupDir)
  })

  it('refuses to update an addon that is not tracked', async () => {
    await expect(installer.applyUpdate('@test/never-installed')).rejects.toThrow(
      /not currently tracked/,
    )
  })

  it('refuses to update when install dir is gone', async () => {
    fs.rmSync(path.join(addonsDir, '@camstack', 'test-foo'), { recursive: true })
    await expect(installer.applyUpdate('@camstack/test-foo')).rejects.toThrow(
      /install dir.*missing/,
    )
  })

  it('rolls back to the previous version after install fails', async () => {
    expect(readInstalledVersion(addonsDir, '@camstack/test-foo')).toBe('1.0.0')

    // Force the install to fail by removing the workspace source entirely
    // — findLocalPackage returns null → applyUpdate throws.
    fs.rmSync(path.join(workspaceDir, 'test-foo'), { recursive: true })

    await expect(installer.applyUpdate('@camstack/test-foo')).rejects.toThrow(
      /Local source not found/,
    )

    // Old install restored from backup
    expect(readInstalledVersion(addonsDir, '@camstack/test-foo')).toBe('1.0.0')
    const entry = installer.manifest.get('@camstack/test-foo')
    expect(entry?.version).toBe('1.0.0')
    expect(entry?.lastBackupDir).toBeUndefined()
  })

  it('rollbackAddon() restores the backup from the previous update', async () => {
    fs.rmSync(path.join(workspaceDir, 'test-foo'), { recursive: true })
    seedWorkspacePackage(workspaceDir, {
      name: '@camstack/test-foo',
      version: '2.0.0',
    })
    await installer.applyUpdate('@camstack/test-foo')
    expect(readInstalledVersion(addonsDir, '@camstack/test-foo')).toBe('2.0.0')

    const restored = await installer.rollbackAddon('@camstack/test-foo')
    expect(restored).toBe('1.0.0')
    expect(readInstalledVersion(addonsDir, '@camstack/test-foo')).toBe('1.0.0')

    const entry = installer.manifest.get('@camstack/test-foo')
    expect(entry?.version).toBe('1.0.0')
    expect(entry?.lastBackupDir).toBeUndefined()
  })

  it('rollbackAddon() returns null when there is no backup', async () => {
    const restored = await installer.rollbackAddon('@camstack/test-foo')
    expect(restored).toBeNull()
  })

  it('clearBackup() drops the backup directory and clears the pointer', async () => {
    fs.rmSync(path.join(workspaceDir, 'test-foo'), { recursive: true })
    seedWorkspacePackage(workspaceDir, {
      name: '@camstack/test-foo',
      version: '2.0.0',
    })
    const { backupDir } = await installer.applyUpdate('@camstack/test-foo')
    expect(fs.existsSync(backupDir)).toBe(true)

    await installer.clearBackup('@camstack/test-foo')
    expect(fs.existsSync(backupDir)).toBe(false)
    expect(installer.manifest.get('@camstack/test-foo')?.lastBackupDir).toBeUndefined()
  })
})
