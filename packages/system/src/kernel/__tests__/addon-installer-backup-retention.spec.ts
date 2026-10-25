import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { AddonInstaller } from '../addon-installer.js'

/**
 * Retention of `{addonsDir}/.backups/` — the pre-update rollback copies.
 *
 * `applyUpdate` renames the live install aside into
 * `.backups/{pkg}/{ts}/` and records `lastBackupDir`. Nothing used to
 * reclaim those copies: a second update overwrote `lastBackupDir` with a
 * NEW path, leaving the previous backup on disk with no pointer to it —
 * unreachable by `rollbackAddon`, invisible to `clearBackup`, and
 * permanent. Measured on the live hub: 814 MiB in `.backups`, 796 MiB of
 * which was two 398 MiB copies of a single addon.
 *
 * The contract these tests pin:
 *   - at most ONE backup per addon survives an update (the newest);
 *   - a successful update drops it entirely (`clearBackup`);
 *   - `clearBackup` NEVER throws — an undeleted backup is a disk-space
 *     problem, a throw after a successful update is an outage;
 *   - nothing outside `.backups/` can ever be deleted through these paths;
 *   - the boot sweep is bounded and never removes the last surviving copy
 *     of an addon whose live install dir is missing (crash mid-update).
 */

interface SeedOpts {
  readonly name: string
  readonly version: string
}

function seedWorkspacePackage(workspaceDir: string, opts: SeedOpts): string {
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
            { id: shortName, name: opts.name, version: opts.version, entry: './dist/index.js' },
          ],
        },
      },
      null,
      2,
    ),
  )
  const distDir = path.join(dir, 'dist')
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(path.join(distDir, 'index.js'), `module.exports={version:'${opts.version}'};\n`)
  fs.writeFileSync(path.join(distDir, '.version'), opts.version)
  return dir
}

const PKG = '@camstack/test-foo'

describe('AddonInstaller — .backups retention', () => {
  let tmpRoot: string
  let workspaceDir: string
  let addonsDir: string
  let backupsRoot: string
  let installer: AddonInstaller

  const installedVersion = (): string | null => {
    const f = path.join(addonsDir, PKG, 'dist', '.version')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim() : null
  }

  const listBackups = (): string[] => {
    const dir = path.join(backupsRoot, PKG)
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
  }

  /** Bump the workspace source to `version` so the next update installs it. */
  const bumpWorkspace = (version: string): void => {
    fs.rmSync(path.join(workspaceDir, 'test-foo'), { recursive: true, force: true })
    seedWorkspacePackage(workspaceDir, { name: PKG, version })
  }

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-backup-retention-'))
    workspaceDir = path.join(tmpRoot, 'workspace')
    addonsDir = path.join(tmpRoot, 'addons')
    backupsRoot = path.join(addonsDir, '.backups')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.mkdirSync(addonsDir, { recursive: true })

    seedWorkspacePackage(workspaceDir, { name: PKG, version: '1.0.0' })
    installer = new AddonInstaller({
      addonsDir,
      workspacePackagesDir: workspaceDir,
      installSource: 'local',
    })
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: drive the private local-install path so no registry is needed
    await (
      installer as unknown as {
        installLocal: (pkg: string, sourceDir: string) => Promise<{ name: string; version: string }>
      }
    ).installLocal(PKG, path.join(workspaceDir, 'test-foo'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  // ── The leak ─────────────────────────────────────────────────────────────

  it('keeps at most one backup per addon across successive updates', async () => {
    bumpWorkspace('2.0.0')
    const first = await installer.applyUpdate(PKG)
    bumpWorkspace('3.0.0')
    const second = await installer.applyUpdate(PKG)

    expect(installedVersion()).toBe('3.0.0')
    // The v1 backup from the FIRST update is unreachable the moment
    // `lastBackupDir` moved to the second — it must not survive.
    expect(fs.existsSync(first.backupDir)).toBe(false)
    expect(fs.existsSync(second.backupDir)).toBe(true)
    expect(listBackups()).toHaveLength(1)
    expect(installer.manifest.get(PKG)?.lastBackupDir).toBe(second.backupDir)
  })

  // ── Success ⇒ backup removed + pointer cleared ────────────────────────────

  it('clearBackup() removes the directory and clears lastBackupDir', async () => {
    bumpWorkspace('2.0.0')
    const { backupDir } = await installer.applyUpdate(PKG)
    expect(fs.existsSync(backupDir)).toBe(true)

    await installer.clearBackup(PKG)

    expect(fs.existsSync(backupDir)).toBe(false)
    expect(installer.manifest.get(PKG)?.lastBackupDir).toBeUndefined()
    // The live install is untouched.
    expect(installedVersion()).toBe('2.0.0')
  })

  // ── Failure ⇒ backup retained, rollback still works ──────────────────────

  it('retains the backup when the update is not confirmed, and rollbackAddon() still restores it', async () => {
    bumpWorkspace('2.0.0')
    const { backupDir } = await installer.applyUpdate(PKG)

    // Caller's health check failed — clearBackup is NOT called.
    expect(fs.existsSync(backupDir)).toBe(true)
    expect(installer.manifest.get(PKG)?.lastBackupDir).toBe(backupDir)

    const restored = await installer.rollbackAddon(PKG)
    expect(restored).toBe('1.0.0')
    expect(installedVersion()).toBe('1.0.0')
    expect(installer.manifest.get(PKG)?.lastBackupDir).toBeUndefined()
    expect(fs.existsSync(backupDir)).toBe(false)
  })

  // ── Cleanup error ⇒ never fails the update ───────────────────────────────

  it('clearBackup() never throws when the removal fails, and still clears the pointer', async () => {
    bumpWorkspace('2.0.0')
    const { backupDir } = await installer.applyUpdate(PKG)

    const rmSpy = vi
      .spyOn(fs.promises, 'rm')
      .mockRejectedValueOnce(
        Object.assign(new Error('ENOTEMPTY: held open'), { code: 'ENOTEMPTY' }),
      )

    await expect(installer.clearBackup(PKG)).resolves.toBeUndefined()
    expect(rmSpy).toHaveBeenCalled()
    // The pointer is dropped even though the bytes are still there — the
    // boot sweep reclaims the residue; a stale pointer would make
    // `rollbackAddon` restore a half-deleted tree.
    expect(installer.manifest.get(PKG)?.lastBackupDir).toBeUndefined()
    expect(backupDir.startsWith(backupsRoot)).toBe(true)
  })

  // ── Path safety ──────────────────────────────────────────────────────────

  it('refuses to delete a lastBackupDir that points outside .backups/', async () => {
    const precious = path.join(tmpRoot, 'precious')
    fs.mkdirSync(precious, { recursive: true })
    fs.writeFileSync(path.join(precious, 'keep.txt'), 'do not delete me')

    installer.manifest.upsert(PKG, {
      version: '1.0.0',
      source: 'local',
      lastBackupDir: precious,
    })

    await installer.clearBackup(PKG)

    expect(fs.existsSync(path.join(precious, 'keep.txt'))).toBe(true)
    expect(installer.manifest.get(PKG)?.lastBackupDir).toBeUndefined()
  })

  it('refuses a lastBackupDir that escapes .backups/ via ..', async () => {
    const live = path.join(addonsDir, PKG)
    installer.manifest.upsert(PKG, {
      version: '1.0.0',
      source: 'local',
      lastBackupDir: path.join(backupsRoot, '..', '@camstack', 'test-foo'),
    })

    await installer.clearBackup(PKG)

    expect(fs.existsSync(live)).toBe(true)
    expect(installedVersion()).toBe('1.0.0')
  })

  it('the sweep never removes anything outside .backups/', async () => {
    const sibling = path.join(addonsDir, '.evicting')
    fs.mkdirSync(sibling, { recursive: true })
    fs.writeFileSync(path.join(sibling, 'residue'), 'x')

    fs.mkdirSync(path.join(backupsRoot, PKG, '2026-01-01T00-00-00-000Z'), { recursive: true })
    const result = await installer.sweepBackups()

    expect(fs.existsSync(path.join(sibling, 'residue'))).toBe(true)
    expect(fs.existsSync(path.join(addonsDir, PKG, 'package.json'))).toBe(true)
    for (const removed of result.removed) {
      expect(removed.startsWith(backupsRoot + path.sep)).toBe(true)
    }
  })

  // ── Boot sweep ───────────────────────────────────────────────────────────

  it('sweeps every backup the manifest does not point at, keeping the rollback target', async () => {
    bumpWorkspace('2.0.0')
    const { backupDir } = await installer.applyUpdate(PKG)

    // Simulate orphans left by pre-fix updates.
    const orphanA = path.join(backupsRoot, PKG, '2026-01-01T00-00-00-000Z')
    const orphanB = path.join(backupsRoot, PKG, '2026-02-02T00-00-00-000Z')
    fs.mkdirSync(orphanA, { recursive: true })
    fs.mkdirSync(orphanB, { recursive: true })
    fs.writeFileSync(path.join(orphanA, 'big.bin'), 'x'.repeat(1024))

    const result = await installer.sweepBackups()

    expect(fs.existsSync(orphanA)).toBe(false)
    expect(fs.existsSync(orphanB)).toBe(false)
    expect(fs.existsSync(backupDir)).toBe(true)
    expect(result.kept).toContain(backupDir)
    expect(listBackups()).toHaveLength(1)
  })

  it('sweeps ALL backups for an addon with no rollback pointer, and drops the empty dirs', async () => {
    const orphan = path.join(backupsRoot, PKG, '2026-01-01T00-00-00-000Z')
    fs.mkdirSync(orphan, { recursive: true })
    fs.writeFileSync(path.join(orphan, 'big.bin'), 'x'.repeat(1024))
    expect(installer.manifest.get(PKG)?.lastBackupDir).toBeUndefined()

    const result = await installer.sweepBackups()

    expect(fs.existsSync(orphan)).toBe(false)
    expect(result.removed).toContain(orphan)
    // The now-empty package + scope dirs go too.
    expect(fs.existsSync(path.join(backupsRoot, PKG))).toBe(false)
  })

  it('keeps the newest backup when the live install dir is missing (crash mid-update)', async () => {
    // `applyUpdate` renames the live dir aside FIRST and only records
    // `lastBackupDir` after the install succeeds. A crash in that window
    // leaves the backup as the ONLY copy of the addon — the sweep must
    // never reclaim it.
    const older = path.join(backupsRoot, PKG, '2026-01-01T00-00-00-000Z')
    const newest = path.join(backupsRoot, PKG, '2026-03-03T00-00-00-000Z')
    fs.mkdirSync(older, { recursive: true })
    fs.mkdirSync(newest, { recursive: true })
    fs.rmSync(path.join(addonsDir, PKG), { recursive: true, force: true })

    const result = await installer.sweepBackups()

    expect(fs.existsSync(newest)).toBe(true)
    expect(fs.existsSync(older)).toBe(false)
    expect(result.kept).toContain(newest)
  })

  it('is a no-op when .backups/ does not exist', async () => {
    expect(fs.existsSync(backupsRoot)).toBe(false)
    const result = await installer.sweepBackups()
    expect(result.removed).toEqual([])
    expect(result.kept).toEqual([])
  })
})
