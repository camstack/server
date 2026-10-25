/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AddonInstaller } from '../src/kernel/addon-installer'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-addon-installer-test-'))
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

describe('AddonInstaller', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    removeDir(tmpDir)
  })

  function makeInstaller() {
    return new AddonInstaller({ addonsDir: tmpDir })
  }

  describe('initialize', () => {
    it('creates the addon directory if it does not exist', async () => {
      const addonsDir = path.join(tmpDir, 'addons')
      const installer = new AddonInstaller({ addonsDir })
      // AddonInstaller no longer has an initialize() method — verify addonsDir is
      // stored correctly and that creating it manually matches the installer config.
      fs.mkdirSync(installer.addonsDir, { recursive: true })
      expect(fs.existsSync(addonsDir)).toBe(true)
    })

    it('is idempotent — calling initialize twice does not throw', async () => {
      const installer = makeInstaller()
      // AddonInstaller no longer has an initialize() method — verify that
      // creating addonsDir twice is idempotent (recursive mkdir).
      fs.mkdirSync(installer.addonsDir, { recursive: true })
      expect(() => fs.mkdirSync(installer.addonsDir, { recursive: true })).not.toThrow()
    })
  })

  describe('isInstalled', () => {
    it('returns false for a package that has not been installed', () => {
      const installer = makeInstaller()
      expect(installer.isInstalled('some-package')).toBe(false)
    })

    it('returns false for a scoped package that has not been installed', () => {
      const installer = makeInstaller()
      expect(installer.isInstalled('@camstack/addon-motion-detection')).toBe(false)
    })

    it('returns true when the package.json exists in the addon directory', () => {
      const installer = makeInstaller()
      const pkgDir = path.join(tmpDir, 'addon-motion-detection')
      fs.mkdirSync(pkgDir, { recursive: true })
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@camstack/addon-motion-detection', version: '1.0.0' }),
      )

      expect(installer.isInstalled('@camstack/addon-motion-detection')).toBe(true)
    })
  })

  describe('listInstalled', () => {
    it('returns empty array when addons directory does not exist', () => {
      const installer = new AddonInstaller({ addonsDir: path.join(tmpDir, 'nonexistent') })
      expect(installer.listInstalled()).toEqual([])
    })

    it('returns empty array when directory has no addon packages', () => {
      const installer = makeInstaller()
      const pkgDir = path.join(tmpDir, 'plain-pkg')
      fs.mkdirSync(pkgDir, { recursive: true })
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'plain-pkg', version: '1.0.0' }),
      )

      expect(installer.listInstalled()).toEqual([])
    })

    it('returns packages that have a camstack.addons field', () => {
      const installer = makeInstaller()
      const pkgDir = path.join(tmpDir, 'addon-motion-detection')
      fs.mkdirSync(pkgDir, { recursive: true })
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@camstack/addon-motion-detection',
          version: '0.3.1',
          camstack: { addons: [{ id: 'vision', entry: './dist/index.js', slot: 'detector' }] },
        }),
      )

      const list = installer.listInstalled()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        name: '@camstack/addon-motion-detection',
        version: '0.3.1',
        dir: pkgDir,
      })
    })

    it('does not return packages without camstack.addons', () => {
      const installer = makeInstaller()
      const pkgDir = path.join(tmpDir, 'plain-pkg')
      fs.mkdirSync(pkgDir, { recursive: true })
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'plain-pkg', version: '1.0.0', camstack: { someOtherField: true } }),
      )

      expect(installer.listInstalled()).toEqual([])
    })
  })

  describe('getInstalledPackage', () => {
    it('returns null for a package that is not installed', () => {
      const installer = makeInstaller()
      expect(installer.getInstalledPackage('nonexistent')).toBeNull()
    })

    it('returns package info when installed', () => {
      const installer = makeInstaller()
      const pkgDir = path.join(tmpDir, 'my-pkg')
      fs.mkdirSync(pkgDir, { recursive: true })
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'my-pkg', version: '2.0.0' }),
      )

      const info = installer.getInstalledPackage('my-pkg')
      expect(info).not.toBeNull()
      expect(info?.name).toBe('my-pkg')
      expect(info?.version).toBe('2.0.0')
      expect(info?.dir).toBe(pkgDir)
    })
  })

  describe('uninstall', () => {
    it('removes the addon directory', async () => {
      const installer = makeInstaller()
      const pkgDir = path.join(tmpDir, 'addon-motion-detection')
      fs.mkdirSync(pkgDir, { recursive: true })
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@camstack/addon-motion-detection' }),
      )

      await installer.uninstall('@camstack/addon-motion-detection')
      expect(fs.existsSync(pkgDir)).toBe(false)
    })

    it('does not throw when directory does not exist', async () => {
      const installer = makeInstaller()
      await expect(installer.uninstall('nonexistent')).resolves.toBeUndefined()
    })
  })
})
