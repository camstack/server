import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { AddonInstaller } from '../addon-installer.js'

/**
 * Tests for AddonInstaller.applyUpdateFromStaged — the fast swap-from-staged
 * path that skips npm and atomically moves a pre-validated staged directory
 * into the addons dir.
 */

const PKG = '@camstack/addon-x'

describe('AddonInstaller.applyUpdateFromStaged', () => {
  let tmpRoot: string
  let addonsDir: string
  let stagingDir: string
  let installer: AddonInstaller

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-staged-'))
    addonsDir = path.join(tmpRoot, 'addons')
    stagingDir = path.join(tmpRoot, 'staging')
    fs.mkdirSync(addonsDir, { recursive: true })
    fs.mkdirSync(stagingDir, { recursive: true })

    // Seed an existing v1.0.0 install so the manifest is populated
    const curDir = path.join(addonsDir, PKG)
    fs.mkdirSync(curDir, { recursive: true })
    const distDir = path.join(curDir, 'dist')
    fs.mkdirSync(distDir, { recursive: true })
    fs.writeFileSync(
      path.join(curDir, 'package.json'),
      JSON.stringify({ name: PKG, version: '1.0.0' }),
    )
    fs.writeFileSync(path.join(distDir, '.version'), '1.0.0')

    installer = new AddonInstaller({ addonsDir })
    // Seed manifest so the package is "tracked" (mirrors what installLocal does)
    installer.manifest.upsert(PKG, { version: '1.0.0', source: 'npm' })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('swaps the staged dir into place (no npm) and records a backup', async () => {
    // Prepare staged v1.0.1 with a marker file to verify the swap
    const staged = path.join(stagingDir, PKG)
    fs.mkdirSync(staged, { recursive: true })
    fs.writeFileSync(
      path.join(staged, 'package.json'),
      JSON.stringify({ name: PKG, version: '1.0.1' }),
    )
    fs.writeFileSync(path.join(staged, 'marker.txt'), 'NEW')

    const res = await installer.applyUpdateFromStaged(PKG, '1.0.1', staged)

    expect(res.version).toBe('1.0.1')
    // New code is in place
    expect(fs.readFileSync(path.join(addonsDir, PKG, 'marker.txt'), 'utf-8')).toBe('NEW')
    // Old version backed up
    expect(fs.existsSync(res.backupDir)).toBe(true)
    // Staged directory was consumed (moved, not copied)
    expect(fs.existsSync(staged)).toBe(false)
  })

  it('records the backup pointer in the manifest', async () => {
    const staged = path.join(stagingDir, PKG)
    fs.mkdirSync(staged, { recursive: true })
    fs.writeFileSync(
      path.join(staged, 'package.json'),
      JSON.stringify({ name: PKG, version: '1.0.1' }),
    )

    const res = await installer.applyUpdateFromStaged(PKG, '1.0.1', staged)

    const entry = installer.manifest.get(PKG)
    expect(entry?.version).toBe('1.0.1')
    expect(entry?.lastBackupDir).toBe(res.backupDir)
    expect(entry?.source).toBe('npm') // preserves source from previous entry
  })

  it('refuses to update a package that is not tracked in manifest', async () => {
    const staged = path.join(stagingDir, 'not-tracked')
    fs.mkdirSync(staged, { recursive: true })
    await expect(
      installer.applyUpdateFromStaged('@camstack/addon-never', '1.0.0', staged),
    ).rejects.toThrow(/not currently tracked/)
  })

  it('refuses to update when the install dir is gone', async () => {
    fs.rmSync(path.join(addonsDir, PKG), { recursive: true, force: true })
    const staged = path.join(stagingDir, PKG)
    fs.mkdirSync(staged, { recursive: true })
    await expect(installer.applyUpdateFromStaged(PKG, '1.0.1', staged)).rejects.toThrow(
      /install dir.*missing/,
    )
  })

  it('restores the backup and rethrows when the swap fails', async () => {
    // Simulate a swap failure: stagedPath does not exist → renameSync throws
    const nonExistentStaged = path.join(stagingDir, 'ghost', PKG)

    await expect(installer.applyUpdateFromStaged(PKG, '1.0.1', nonExistentStaged)).rejects.toThrow()

    // Old install restored
    expect(fs.existsSync(path.join(addonsDir, PKG))).toBe(true)
    const entry = installer.manifest.get(PKG)
    expect(entry?.version).toBe('1.0.0')
    expect(entry?.lastBackupDir).toBeUndefined()
  })
})
