/**
 * Encrypted backup → restore, end to end (operator decision 2026-10-09).
 *
 * Real files throughout: the archive the hub builds (`SystemBackupService`,
 * encrypted to a backup public key), the bytes a destination would hold, the
 * hub-side preparation the restore dialog triggers (`prepareRestoreArchive`,
 * with the operator's secret key), the restore marker, and the SAME
 * `applyPendingRestore` the launcher runs before any runner. Then the offline
 * path: `scripts/ops/backup-decrypt.mjs` opens a hub-built archive with no hub
 * — the disaster-recovery route, and the check that the two implementations
 * of the format agree.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import {
  BackupKeyRequiredError,
  generateBackupKeyPair,
  prepareRestoreArchive,
  readBackupEncryptionHeader,
  SystemBackupService,
} from '@camstack/system'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPendingRestore } from '../pending-restore.js'

const DECRYPT_SCRIPT = path.resolve(__dirname, '../../../../scripts/ops/backup-decrypt.mjs')

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

const FILES: Record<string, string> = {
  'config.yaml': 'keychain:\n  keyFile: /keys/keychain.key\n',
  'addons-data/export-hap/persist/AccessoryInfo.0E1F.json': '{"LTSK":"hap-pairing-secret"}',
  'addons-data/matter-broker/fabric.json': '{"operationalKey":"matter-fabric-secret"}',
  'addons-data/tailscale/tailscaled.state': 'tailscaled-node-key-secret',
  'tls/key.pem': 'tls-private-key-secret',
}
const LOCATIONS = ['config.yaml', 'addons-data', 'tls']

let root = ''
let dataDir = ''
let staging = ''
let share = ''

function writeTree(): void {
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dataDir, rel), content)
  }
}

/** What a disaster leaves: the pairing state gone, the config rewritten. */
function damageTree(): void {
  fs.rmSync(path.join(dataDir, 'addons-data'), { recursive: true, force: true })
  fs.writeFileSync(path.join(dataDir, 'config.yaml'), 'fresh: true\n')
  fs.rmSync(path.join(dataDir, 'tls'), { recursive: true, force: true })
}

function expectTreeRestored(): void {
  for (const [rel, content] of Object.entries(FILES)) {
    expect(fs.readFileSync(path.join(dataDir, rel), 'utf8')).toBe(content)
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-enc-restore-'))
  dataDir = path.join(root, 'data')
  staging = path.join(root, 'data', 'backup-staging')
  share = path.join(root, 'smb-share')
  fs.mkdirSync(staging, { recursive: true })
  fs.mkdirSync(share, { recursive: true })
  writeTree()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('encrypted backup → boot-time restore', () => {
  it('a hub-built encrypted archive restores every file through the launcher, with the secret key', async () => {
    const keys = generateBackupKeyPair()
    const service = new SystemBackupService(dataDir, quiet)
    const built = path.join(staging, 'a.tar.gz.csbk')
    await service.createArchive({
      archivePath: built,
      locations: LOCATIONS,
      encryptTo: keys.publicKey,
    })
    // The destination holds exactly these bytes — ciphertext.
    const onShare = path.join(share, 'a.tar.gz.csbk')
    fs.copyFileSync(built, onShare)
    fs.rmSync(built)
    const sealed = fs.readFileSync(onShare)
    for (const secret of Object.values(FILES))
      expect(sealed.includes(Buffer.from(secret))).toBe(false)

    damageTree()

    // Restore dialog: download, decrypt with the operator's key, mark.
    const downloaded = path.join(staging, 'restore-a.download')
    fs.copyFileSync(onShare, downloaded)
    const target = path.join(staging, 'restore-a.tar.gz')
    const prepared = await prepareRestoreArchive({ downloaded, target, secretKey: keys.secretKey })
    expect(prepared).toEqual({ encrypted: true, keyId: keys.keyId })
    service.scheduleRestoreMarker({ archivePath: target, source: 'a' })

    // Next boot: the launcher.
    await applyPendingRestore(dataDir, () => undefined)

    expectTreeRestored()
    expect(fs.existsSync(path.join(dataDir, '.pending-restore.json'))).toBe(false)
  })

  it('without the key nothing is scheduled and the data dir is untouched', async () => {
    const keys = generateBackupKeyPair()
    const service = new SystemBackupService(dataDir, quiet)
    const built = path.join(share, 'b.tar.gz.csbk')
    await service.createArchive({
      archivePath: built,
      locations: LOCATIONS,
      encryptTo: keys.publicKey,
    })
    damageTree()
    const downloaded = path.join(staging, 'restore-b.download')
    fs.copyFileSync(built, downloaded)
    await expect(
      prepareRestoreArchive({ downloaded, target: path.join(staging, 'restore-b.tar.gz') }),
    ).rejects.toBeInstanceOf(BackupKeyRequiredError)
    await applyPendingRestore(dataDir, () => undefined)
    expect(fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf8')).toBe('fresh: true\n')
  })

  it('an unencrypted archive (made before encryption) still restores without a key', async () => {
    const service = new SystemBackupService(dataDir, quiet)
    const built = path.join(share, 'c.tar.gz')
    await service.createArchive({ archivePath: built, locations: LOCATIONS })
    expect(await readBackupEncryptionHeader(built)).toBeNull()
    damageTree()
    const downloaded = path.join(staging, 'restore-c.download')
    fs.copyFileSync(built, downloaded)
    const target = path.join(staging, 'restore-c.tar.gz')
    expect(await prepareRestoreArchive({ downloaded, target })).toEqual({ encrypted: false })
    service.scheduleRestoreMarker({ archivePath: target, source: 'c' })
    await applyPendingRestore(dataDir, () => undefined)
    expectTreeRestored()
  })
})

describe('scripts/ops/backup-decrypt.mjs — restore with no hub', () => {
  it('decrypts a hub-built archive to the same tar.gz the hub produces; the key is read from a file', async () => {
    const keys = generateBackupKeyPair()
    const service = new SystemBackupService(dataDir, quiet)
    const built = path.join(share, 'd.tar.gz.csbk')
    await service.createArchive({
      archivePath: built,
      locations: LOCATIONS,
      encryptTo: keys.publicKey,
    })

    const keyFile = path.join(root, 'backup.key')
    fs.writeFileSync(keyFile, `${keys.secretKey}\n`, { mode: 0o600 })
    const offline = path.join(root, 'offline.tar.gz')
    const stdout = execFileSync(
      process.execPath,
      [DECRYPT_SCRIPT, built, offline, '--key-file', keyFile],
      {
        encoding: 'utf8',
      },
    )
    expect(stdout).toContain(keys.keyId)
    expect(stdout).not.toContain(keys.secretKey.split(':')[1] ?? '')

    const hubSide = path.join(root, 'hub.tar.gz')
    const downloaded = path.join(root, 'd.download')
    fs.copyFileSync(built, downloaded)
    await prepareRestoreArchive({ downloaded, target: hubSide, secretKey: keys.secretKey })
    expect(fs.readFileSync(offline).equals(fs.readFileSync(hubSide))).toBe(true)
  })

  it('the wrong key fails, names both key ids, and leaves no output', async () => {
    const keys = generateBackupKeyPair()
    const other = generateBackupKeyPair()
    const service = new SystemBackupService(dataDir, quiet)
    const built = path.join(share, 'e.tar.gz.csbk')
    await service.createArchive({
      archivePath: built,
      locations: ['config.yaml'],
      encryptTo: keys.publicKey,
    })
    const keyFile = path.join(root, 'other.key')
    fs.writeFileSync(keyFile, other.secretKey, { mode: 0o600 })
    const out = path.join(root, 'nope.tar.gz')
    let stderr = ''
    try {
      execFileSync(process.execPath, [DECRYPT_SCRIPT, built, out, '--key-file', keyFile], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err: unknown) {
      stderr = String(Reflect.get(Object(err), 'stderr') ?? '')
    }
    expect(stderr).toContain(keys.keyId)
    expect(stderr).toContain(other.keyId)
    expect(fs.existsSync(out)).toBe(false)
  })
})
