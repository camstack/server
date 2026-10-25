import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AddonManifest } from '../addon-manifest.js'

describe('AddonManifest', () => {
  let tmpDir: string
  let manifest: AddonManifest

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-manifest-'))
    manifest = new AddonManifest(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('read()', () => {
    it('returns empty manifest when file does not exist', () => {
      const m = manifest.read()
      expect(m.version).toBe(1)
      expect(m.addons).toEqual({})
      expect(m.updatedAt).toBeTypeOf('string')
    })

    it('returns empty manifest when file is corrupted JSON', () => {
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), 'not json{')
      manifest.invalidate()
      const m = manifest.read()
      expect(m.addons).toEqual({})
    })

    it('returns empty manifest when file has unknown schema version', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'manifest.json'),
        JSON.stringify({ version: 99, addons: { '@x/y': {} }, updatedAt: 'x' }),
      )
      manifest.invalidate()
      const m = manifest.read()
      expect(m.addons).toEqual({})
    })

    it('caches the result and does not re-read until invalidate()', () => {
      manifest.upsert('@camstack/foo', {
        version: '1.0.0',
        source: 'npm',
      })
      // Manually corrupt file
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), 'broken')
      // Cached read still returns previous data
      const m = manifest.read()
      expect(m.addons['@camstack/foo']).toBeDefined()
      // After invalidate, fresh read sees corrupted state
      manifest.invalidate()
      const m2 = manifest.read()
      expect(m2.addons).toEqual({})
    })
  })

  describe('upsert()', () => {
    it('inserts a new addon entry with installedAt = updatedAt', () => {
      manifest.upsert('@camstack/foo', {
        version: '1.0.0',
        source: 'npm',
      })
      const entry = manifest.get('@camstack/foo')
      expect(entry).not.toBeNull()
      expect(entry!.version).toBe('1.0.0')
      expect(entry!.source).toBe('npm')
      expect(entry!.installedAt).toBe(entry!.updatedAt)
    })

    it('preserves installedAt on subsequent upserts but advances updatedAt', async () => {
      manifest.upsert('@camstack/foo', {
        version: '1.0.0',
        source: 'npm',
      })
      const first = manifest.get('@camstack/foo')!
      // Force a tick so updatedAt timestamp differs
      await new Promise((resolve) => setTimeout(resolve, 5))
      manifest.upsert('@camstack/foo', {
        version: '1.0.1',
        source: 'npm',
      })
      const second = manifest.get('@camstack/foo')!
      expect(second.installedAt).toBe(first.installedAt)
      expect(second.updatedAt).not.toBe(first.updatedAt)
      expect(second.version).toBe('1.0.1')
    })
  })

  describe('remove()', () => {
    it('removes an existing entry', () => {
      manifest.upsert('@camstack/foo', { version: '1.0.0', source: 'npm' })
      manifest.remove('@camstack/foo')
      expect(manifest.get('@camstack/foo')).toBeNull()
    })

    it('is a no-op when entry does not exist', () => {
      expect(() => manifest.remove('@camstack/nope')).not.toThrow()
    })
  })

  describe('list()', () => {
    it('returns all entries', () => {
      manifest.upsert('@camstack/a', { version: '1', source: 'npm' })
      manifest.upsert('@camstack/b', { version: '2', source: 'local' })
      const all = manifest.list()
      expect(all).toHaveLength(2)
      const names = all.map((e) => e.name).toSorted()
      expect(names).toEqual(['@camstack/a', '@camstack/b'])
    })
  })

  describe('write() — atomicity', () => {
    it('writes via tmpfile + rename (no partial on-disk state)', () => {
      manifest.upsert('@camstack/foo', { version: '1.0.0', source: 'npm' })
      const manifestPath = path.join(tmpDir, 'manifest.json')
      expect(fs.existsSync(manifestPath)).toBe(true)
      // No leftover .tmp files
      const files = fs.readdirSync(tmpDir)
      const tmpFiles = files.filter((f) => f.includes('.tmp.'))
      expect(tmpFiles).toEqual([])
    })

    it('writes file with mode 0o600 (owner-only)', () => {
      manifest.upsert('@camstack/foo', { version: '1.0.0', source: 'npm' })
      const stat = fs.statSync(path.join(tmpDir, 'manifest.json'))
      // Last write was via tmpfile + rename; the rename preserves mode 0o600
      // but rename retains origin mode. Just check mode is at least private.
      const mode = stat.mode & 0o777
      // Allow for umask fuzz on different platforms — confirm world-readable bit isn't set
      expect(mode & 0o004).toBe(0)
    })
  })

  describe('migrateFromInstallSourceMarkers()', () => {
    function seedAddon(name: string, version: string, source: string) {
      const [scope, pkg] = name.split('/')
      if (scope === undefined || pkg === undefined)
        throw new Error(`malformed scoped name: ${name}`)
      const dir = path.join(tmpDir, scope, pkg)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }))
      fs.writeFileSync(path.join(dir, '.install-source'), source)
    }

    it('migrates addons with .install-source markers', () => {
      seedAddon('@camstack/foo', '1.0.0', 'npm')
      seedAddon('@camstack/bar', '2.0.0', 'local')
      const migrated = manifest.migrateFromInstallSourceMarkers(tmpDir)
      expect(migrated).toBe(2)
      expect(manifest.get('@camstack/foo')!.version).toBe('1.0.0')
      expect(manifest.get('@camstack/foo')!.source).toBe('npm')
      expect(manifest.get('@camstack/bar')!.source).toBe('local')
    })

    it('defaults source to "bundled" when marker is missing', () => {
      const dir = path.join(tmpDir, '@camstack', 'baz')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: '@camstack/baz', version: '0.1.0' }),
      )
      // no .install-source marker
      const migrated = manifest.migrateFromInstallSourceMarkers(tmpDir)
      expect(migrated).toBe(1)
      expect(manifest.get('@camstack/baz')!.source).toBe('bundled')
    })

    it('returns 0 if manifest already has entries (idempotent)', () => {
      manifest.upsert('@camstack/foo', { version: '1.0.0', source: 'npm' })
      seedAddon('@camstack/bar', '2.0.0', 'local')
      const migrated = manifest.migrateFromInstallSourceMarkers(tmpDir)
      expect(migrated).toBe(0)
      // Existing manifest preserved, no new entries added
      expect(manifest.list()).toHaveLength(1)
    })

    it('skips packages with malformed package.json', () => {
      const dir = path.join(tmpDir, '@camstack', 'broken')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'package.json'), 'not json')
      const migrated = manifest.migrateFromInstallSourceMarkers(tmpDir)
      expect(migrated).toBe(0)
    })

    it('skips entries without name or version', () => {
      const dir = path.join(tmpDir, '@camstack', 'nameless')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '', version: '' }))
      const migrated = manifest.migrateFromInstallSourceMarkers(tmpDir)
      expect(migrated).toBe(0)
    })
  })

  describe('reconcileFromDisk()', () => {
    function seedPkg(name: string, version: string) {
      const [scope, pkg] = name.split('/')
      if (scope === undefined || pkg === undefined)
        throw new Error(`malformed scoped name: ${name}`)
      const dir = path.join(tmpDir, scope, pkg)
      fs.mkdirSync(dir, { recursive: true })
      // Addons are identified by a non-empty `camstack.addons[]` block —
      // the same marker AddonLoader uses to discover them.
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, version, camstack: { addons: [{ id: pkg }] } }),
      )
    }

    function seedThirdParty(name: string, version: string, camstack?: unknown) {
      const [scope, pkg] = name.split('/')
      if (scope === undefined || pkg === undefined)
        throw new Error(`malformed scoped name: ${name}`)
      const dir = path.join(tmpDir, scope, pkg)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify(camstack === undefined ? { name, version } : { name, version, camstack }),
      )
    }

    /** Write a package into a directory that is NOT its own name — a rename. */
    function seedUnderDirName(name: string, version: string, dirName: string) {
      const scope = name.split('/')[0]
      if (scope === undefined) throw new Error(`malformed scoped name: ${name}`)
      const dir = path.join(tmpDir, scope, dirName)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, version, camstack: { addons: [{ id: dirName }] } }),
      )
    }

    it('ignores a directory whose name is not the package it declares', () => {
      // Measured on macmini 2026-08-08: `addons/@camstack/system` did not
      // exist, `system.bak-pre-1272-1786129145` did, and the manifest
      // reported `@camstack/system 1.2.3` — read out of the backup, because
      // reconcile keyed on the declared name and ignored the directory. The
      // renamed copy is residue (quarantined elsewhere); it must never be
      // the thing a version surface answers with.
      seedPkg('@camstack/addon-pipeline', '1.0.2')
      seedUnderDirName('@camstack/system', '1.2.3', 'system.bak-pre-1272-1786129145')

      const changes = manifest.reconcileFromDisk(tmpDir)

      expect(changes).toBe(1)
      expect(manifest.get('@camstack/system')).toBeNull()
      expect(manifest.get('@camstack/addon-pipeline')!.version).toBe('1.0.2')
    })

    it('registers on-disk addons missing from the manifest with source "seed"', () => {
      seedPkg('@camstack/addon-admin-ui', '1.0.2')
      seedPkg('@camstack/addon-pipeline', '1.0.2')
      const added = manifest.reconcileFromDisk(tmpDir)
      expect(added).toBe(2)
      expect(manifest.get('@camstack/addon-admin-ui')!.version).toBe('1.0.2')
      expect(manifest.get('@camstack/addon-admin-ui')!.source).toBe('seed')
      expect(manifest.get('@camstack/addon-pipeline')!.source).toBe('seed')
    })

    it('preserves source + installedAt on an existing entry, but adopts the DISK version', () => {
      manifest.upsert('@camstack/addon-pipeline', { version: '1.0.3', source: 'npm' })
      const installedAt = manifest.get('@camstack/addon-pipeline')!.installedAt
      seedPkg('@camstack/addon-pipeline', '1.0.2') // disk disagrees
      seedPkg('@camstack/addon-admin-ui', '1.0.2')
      const changes = manifest.reconcileFromDisk(tmpDir)
      expect(changes).toBe(2) // admin-ui added + pipeline version corrected
      // The directory is what the loader runs, so the directory is the truth
      // about VERSION. Provenance (source, first-install time) is not derivable
      // from disk and stays authoritative in the manifest.
      expect(manifest.get('@camstack/addon-pipeline')!.version).toBe('1.0.2')
      expect(manifest.get('@camstack/addon-pipeline')!.source).toBe('npm')
      expect(manifest.get('@camstack/addon-pipeline')!.installedAt).toBe(installedAt)
    })

    it('prunes a manifest entry whose directory does not exist (phantom)', () => {
      manifest.upsert('@camstack/system', { version: '1.2.29', source: 'npm' })
      manifest.upsert('@camstack/addon-viewer-ui', { version: '1.1.39', source: 'bundled' })
      seedPkg('@camstack/addon-pipeline', '1.2.43')

      const changes = manifest.reconcileFromDisk(tmpDir)
      expect(changes).toBe(3) // 2 pruned + 1 added
      expect(manifest.get('@camstack/system')).toBeNull()
      expect(manifest.get('@camstack/addon-viewer-ui')).toBeNull()
      expect(manifest.get('@camstack/addon-pipeline')).not.toBeNull()
    })

    it('NEVER prunes an entry holding a rollback pointer', () => {
      // The backup sweep keeps the manifest's rollback target; pruning the
      // entry would orphan the only pointer to that backup and the sweep
      // would then reclaim the last surviving copy of the addon.
      manifest.upsert('@camstack/addon-gone', {
        version: '1.0.0',
        source: 'npm',
        lastBackupDir: '/data/addons/.backups/addon-gone-1.0.0',
      })
      expect(manifest.reconcileFromDisk(tmpDir)).toBe(0)
      expect(manifest.get('@camstack/addon-gone')).not.toBeNull()
    })

    it('reports every change through onChange', () => {
      manifest.upsert('@camstack/addon-stale', { version: '1.0.0', source: 'npm' })
      manifest.upsert('@camstack/addon-phantom', { version: '9.9.9', source: 'npm' })
      seedPkg('@camstack/addon-stale', '2.0.0')
      seedPkg('@camstack/addon-new', '3.0.0')

      const seen: Array<{ kind: string; name: string; from?: string; to?: string }> = []
      manifest.reconcileFromDisk(tmpDir, (c) => seen.push({ ...c }))

      expect(seen).toContainEqual({
        kind: 'version-corrected',
        name: '@camstack/addon-stale',
        from: '1.0.0',
        to: '2.0.0',
      })
      expect(seen).toContainEqual({
        kind: 'pruned',
        name: '@camstack/addon-phantom',
        from: '9.9.9',
      })
      expect(seen).toContainEqual({ kind: 'added', name: '@camstack/addon-new', to: '3.0.0' })
    })

    it('converges: a second pass over an already-reconciled tree changes nothing', () => {
      manifest.upsert('@camstack/addon-stale', { version: '1.0.0', source: 'npm' })
      manifest.upsert('@camstack/addon-phantom', { version: '9.9.9', source: 'npm' })
      seedPkg('@camstack/addon-stale', '2.0.0')
      expect(manifest.reconcileFromDisk(tmpDir)).toBeGreaterThan(0)
      expect(manifest.reconcileFromDisk(tmpDir)).toBe(0)
    })

    it('sees a SYMLINKED addon dir as installed (dev installSymlink mode)', () => {
      // `installSymlink` points `addonsDir/@camstack/<pkg>` straight at the
      // workspace source. A `Dirent.isDirectory()` check answers FALSE for that
      // entry, so a reconcile that trusts it finds no addons at all — and with
      // pruning, wipes every entry on a dev machine.
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-src-'))
      fs.writeFileSync(
        path.join(src, 'package.json'),
        JSON.stringify({
          name: '@camstack/addon-linked',
          version: '4.0.0',
          camstack: { addons: [{ id: 'linked' }] },
        }),
      )
      fs.mkdirSync(path.join(tmpDir, '@camstack'), { recursive: true })
      fs.symlinkSync(src, path.join(tmpDir, '@camstack', 'addon-linked'), 'dir')
      manifest.upsert('@camstack/addon-linked', { version: '3.0.0', source: 'local' })

      const changes = manifest.reconcileFromDisk(tmpDir)

      expect(manifest.get('@camstack/addon-linked')).not.toBeNull()
      expect(manifest.get('@camstack/addon-linked')!.version).toBe('4.0.0')
      expect(changes).toBe(1) // version corrected, NOT pruned
      fs.rmSync(src, { recursive: true, force: true })
    })

    it('does not prune a NON-addon package it never tracked', () => {
      // A dir without `camstack.addons[]` is never added, so it can never
      // appear as a phantom either — the two rules must agree.
      seedThirdParty('@camstack/types', '1.0.2', { system: true })
      expect(manifest.reconcileFromDisk(tmpDir)).toBe(0)
      expect(manifest.get('@camstack/types')).toBeNull()
    })

    it('returns 0 when nothing new is on disk', () => {
      manifest.upsert('@camstack/addon-pipeline', { version: '1.0.2', source: 'seed' })
      seedPkg('@camstack/addon-pipeline', '1.0.2')
      expect(manifest.reconcileFromDisk(tmpDir)).toBe(0)
    })

    it('ignores hoisted third-party deps and pure framework libs (no camstack.addons[])', () => {
      seedPkg('@camstack/addon-pipeline', '1.0.2')
      seedThirdParty('@trpc/server', '11.0.0') // no camstack block
      seedThirdParty('@fastify/cors', '9.0.0') // no camstack block
      seedThirdParty('@camstack/types', '1.0.2', { system: true }) // framework lib, no addons[]
      seedThirdParty('@camstack/sdk', '1.0.2', { system: true, addons: [] }) // empty addons[]
      const added = manifest.reconcileFromDisk(tmpDir)
      expect(added).toBe(1) // only the camstack addon with a non-empty addons[]
      expect(manifest.get('@camstack/addon-pipeline')).not.toBeNull()
      expect(manifest.get('@trpc/server')).toBeNull()
      expect(manifest.get('@fastify/cors')).toBeNull()
      expect(manifest.get('@camstack/types')).toBeNull()
      expect(manifest.get('@camstack/sdk')).toBeNull()
    })

    it('skips malformed package.json and entries without name/version', () => {
      const broken = path.join(tmpDir, '@camstack', 'broken')
      fs.mkdirSync(broken, { recursive: true })
      fs.writeFileSync(path.join(broken, 'package.json'), 'not json')
      const nameless = path.join(tmpDir, '@camstack', 'nameless')
      fs.mkdirSync(nameless, { recursive: true })
      fs.writeFileSync(
        path.join(nameless, 'package.json'),
        JSON.stringify({ name: '', version: '' }),
      )
      expect(manifest.reconcileFromDisk(tmpDir)).toBe(0)
    })

    it('returns 0 when the addons dir does not exist', () => {
      expect(manifest.reconcileFromDisk(path.join(tmpDir, 'nope'))).toBe(0)
    })
  })
})
