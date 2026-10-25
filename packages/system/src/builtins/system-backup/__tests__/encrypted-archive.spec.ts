/**
 * An encrypted system archive: the bytes that leave the hub are ciphertext
 * from the first byte, and the secret key gives back exactly the archive a
 * plain run would have built — config.yaml, the library-owned files under
 * addons-data (HAP pairing, Matter fabric, tailscaled state) and tls.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BACKUP_ENCRYPTION_SCHEME,
  decryptBackupFile,
  generateBackupKeyPair,
  readBackupEncryptionHeader,
} from '../backup-encryption.js'
import { SystemBackupService } from '../system-backup.service.js'

const noopLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
  withTags: () => noopLogger,
}

const FILES: Record<string, string> = {
  'config.yaml': 'keychain:\n  keyFile: /keys/keychain.key\n',
  'addons-data/export-hap/persist/AccessoryInfo.0E1F.json':
    '{"pairedClients":{"LTPK":"hap-pairing-secret"}}',
  'addons-data/matter-broker/fabric/fabric.json': '{"operationalKey":"matter-fabric-secret"}',
  'addons-data/tailscale/tailscaled.state': 'tailscaled-node-key-secret',
  'tls/key.pem': '-----BEGIN PRIVATE KEY-----\ntls-private-key-secret\n',
}

let root: string
let dataDir: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-enc-archive-'))
  dataDir = path.join(root, 'data')
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dataDir, rel), content)
  }
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('createArchive with encryptTo', () => {
  it('writes ciphertext only, and the secret key restores every file byte for byte', async () => {
    const keys = generateBackupKeyPair()
    const service = new SystemBackupService(dataDir, noopLogger)
    const archivePath = path.join(root, 'staging', `a.tar.gz.csbk`)

    const result = await service.createArchive({
      archivePath,
      locations: ['config.yaml', 'addons-data', 'tls'],
      encryptTo: keys.publicKey,
    })

    expect(result.encryption).toEqual({ scheme: BACKUP_ENCRYPTION_SCHEME, keyId: keys.keyId })
    expect(await readBackupEncryptionHeader(archivePath)).toEqual({ keyId: keys.keyId })
    expect(result.sizeBytes).toBe(fs.statSync(archivePath).size)
    const sealed = fs.readFileSync(archivePath)
    for (const secret of ['hap-pairing-secret', 'matter-fabric-secret', 'tls-private-key-secret']) {
      expect(sealed.includes(Buffer.from(secret))).toBe(false)
    }
    // Not even a gzip stream: the destination learns nothing from the bytes.
    expect(sealed[0] === 0x1f && sealed[1] === 0x8b).toBe(false)

    const plain = path.join(root, 'restored.tar.gz')
    await decryptBackupFile(archivePath, plain, keys.secretKey)
    const out = path.join(root, 'out')
    fs.mkdirSync(out)
    await tar.extract({ file: plain, cwd: out })
    for (const [rel, content] of Object.entries(FILES)) {
      expect(fs.readFileSync(path.join(out, rel), 'utf8')).toBe(content)
    }
  })

  it('without encryptTo the archive is the plain tar.gz it always was', async () => {
    const service = new SystemBackupService(dataDir, noopLogger)
    const archivePath = path.join(root, 'plain.tar.gz')
    const result = await service.createArchive({ archivePath, locations: ['config.yaml'] })
    expect(result.encryption).toBeUndefined()
    const bytes = fs.readFileSync(archivePath)
    expect(bytes[0]).toBe(0x1f)
    expect(bytes[1]).toBe(0x8b)
    expect(await readBackupEncryptionHeader(archivePath)).toBeNull()
  })

  it('a malformed public key fails the build before anything is written', async () => {
    const service = new SystemBackupService(dataDir, noopLogger)
    const archivePath = path.join(root, 'bad.tar.gz.csbk')
    await expect(
      service.createArchive({ archivePath, locations: ['config.yaml'], encryptTo: 'nope' }),
    ).rejects.toThrow(/backup public key/)
    expect(fs.existsSync(archivePath)).toBe(false)
  })
})
