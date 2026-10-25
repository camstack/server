/**
 * Backup archive encryption (operator decision 2026-10-09): a public-key
 * scheme, streaming, chunked AEAD.
 *
 * The hub holds only the PUBLIC key, so a scheduled backup encrypts without
 * anyone present and the hub cannot decrypt its own archives; the operator
 * keeps the secret key and gives it back at restore time. The format must
 * stream (hub archives are ~1.3 GB), and every way an archive can be damaged
 * — a flipped byte, a cut-off tail, a swapped header, the wrong key — must
 * fail loudly, never yield a silently different tar.
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BACKUP_ENCRYPTION_HEADER_BYTES,
  BackupDecryptError,
  BackupKeyFormatError,
  BackupKeyMismatchError,
  createBackupDecryptStream,
  createBackupEncryptStream,
  decryptBackupFile,
  encryptBackupFile,
  generateBackupKeyPair,
  parseBackupPublicKey,
  parseBackupSecretKey,
  readBackupEncryptionHeader,
} from '../backup-encryption.js'

let dir: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'backup-enc-'))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

function pattern(size: number, seed = 7): Buffer {
  const out = Buffer.alloc(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = x & 0xff
  }
  return out
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of stream) parts.push(Buffer.from(part as Uint8Array))
  return Buffer.concat(parts)
}

/** Feed `data` in small, uneven pieces — the way a gzip stream delivers. */
function feed(data: Buffer, piece = 7_919): Readable {
  const pieces: Buffer[] = []
  for (let i = 0; i < data.length; i += piece) pieces.push(data.subarray(i, i + piece))
  return Readable.from(pieces)
}

async function roundTrip(data: Buffer, chunkBytes: number): Promise<Buffer> {
  const keys = generateBackupKeyPair()
  const sealed = await collect(
    feed(data).pipe(createBackupEncryptStream(keys.publicKey, { chunkBytes })),
  )
  return collect(feed(sealed, 4_093).pipe(createBackupDecryptStream(keys.secretKey)))
}

describe('backup keys', () => {
  it('a generated pair: the secret key derives the public key and the same key id', () => {
    const keys = generateBackupKeyPair()
    expect(keys.secretKey).toMatch(/^camstack-backup-secret-v1:/)
    expect(keys.publicKey).toMatch(/^camstack-backup-public-v1:/)
    expect(keys.keyId).toMatch(/^[0-9a-f]{16}$/)
    expect(parseBackupSecretKey(keys.secretKey).keyId).toBe(keys.keyId)
    expect(parseBackupPublicKey(keys.publicKey).keyId).toBe(keys.keyId)
    expect(parseBackupSecretKey(` ${keys.secretKey}\n`).keyId).toBe(keys.keyId)
  })

  it('a mistyped key is refused by its checksum, not used', () => {
    const keys = generateBackupKeyPair()
    const body = keys.secretKey.split(':')[1] ?? ''
    const flipped = `${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}`
    expect(() => parseBackupSecretKey(`camstack-backup-secret-v1:${flipped}`)).toThrow(
      BackupKeyFormatError,
    )
    expect(() => parseBackupSecretKey(keys.publicKey)).toThrow(BackupKeyFormatError)
    expect(() => parseBackupPublicKey(keys.secretKey)).toThrow(BackupKeyFormatError)
    expect(() => parseBackupSecretKey('nonsense')).toThrow(BackupKeyFormatError)
  })

  it('two pairs never share a key id', () => {
    expect(generateBackupKeyPair().keyId).not.toBe(generateBackupKeyPair().keyId)
  })
})

describe('streaming AEAD', () => {
  it.each([
    ['empty', 0],
    ['one byte', 1],
    ['less than a chunk', 1_000],
    ['exactly one chunk', 4_096],
    ['exactly three chunks', 3 * 4_096],
    ['many chunks and a tail', 50 * 4_096 + 123],
  ])('round-trips %s', async (_name, size) => {
    const data = pattern(size)
    expect((await roundTrip(data, 4_096)).equals(data)).toBe(true)
  })

  it('the ciphertext is not the plaintext and carries no plaintext run', async () => {
    const keys = generateBackupKeyPair()
    const marker = Buffer.from('HAP-PAIRING-SECRET-0123456789')
    const data = Buffer.concat([pattern(10_000), marker, pattern(10_000, 3)])
    const sealed = await collect(feed(data).pipe(createBackupEncryptStream(keys.publicKey)))
    expect(sealed.includes(marker)).toBe(false)
    expect(sealed.length).toBeGreaterThan(data.length)
  })

  it('the wrong key is refused by key id, naming both', async () => {
    const a = generateBackupKeyPair()
    const b = generateBackupKeyPair()
    const sealed = await collect(feed(pattern(5_000)).pipe(createBackupEncryptStream(a.publicKey)))
    const err = await collect(feed(sealed).pipe(createBackupDecryptStream(b.secretKey))).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(BackupKeyMismatchError)
    expect(String(err)).toContain(a.keyId)
    expect(String(err)).toContain(b.keyId)
  })

  it('a flipped ciphertext byte fails authentication', async () => {
    const keys = generateBackupKeyPair()
    const sealed = await collect(
      feed(pattern(20_000)).pipe(createBackupEncryptStream(keys.publicKey, { chunkBytes: 4_096 })),
    )
    const damaged = Buffer.from(sealed)
    const at = BACKUP_ENCRYPTION_HEADER_BYTES + 5_000
    damaged[at] = (damaged[at] ?? 0) ^ 0x01
    await expect(
      collect(feed(damaged).pipe(createBackupDecryptStream(keys.secretKey))),
    ).rejects.toBeInstanceOf(BackupDecryptError)
  })

  it('a flipped header byte fails (the header is bound into the key)', async () => {
    const keys = generateBackupKeyPair()
    const sealed = await collect(
      feed(pattern(2_000)).pipe(createBackupEncryptStream(keys.publicKey)),
    )
    const damaged = Buffer.from(sealed)
    const at = BACKUP_ENCRYPTION_HEADER_BYTES - 3 // inside the salt
    damaged[at] = (damaged[at] ?? 0) ^ 0x80
    await expect(
      collect(feed(damaged).pipe(createBackupDecryptStream(keys.secretKey))),
    ).rejects.toBeInstanceOf(BackupDecryptError)
  })

  it('a cut-off archive is refused — at a chunk boundary as much as mid-chunk', async () => {
    const keys = generateBackupKeyPair()
    const chunk = 4_096
    const sealed = await collect(
      feed(pattern(5 * chunk + 10)).pipe(
        createBackupEncryptStream(keys.publicKey, { chunkBytes: chunk }),
      ),
    )
    const sealedChunk = chunk + 16
    const atBoundary = sealed.subarray(0, BACKUP_ENCRYPTION_HEADER_BYTES + 3 * sealedChunk)
    const midChunk = sealed.subarray(0, sealed.length - 7)
    for (const cut of [atBoundary, midChunk]) {
      await expect(
        collect(feed(cut).pipe(createBackupDecryptStream(keys.secretKey))),
      ).rejects.toBeInstanceOf(BackupDecryptError)
    }
  })

  it('a chunk moved out of order fails', async () => {
    const keys = generateBackupKeyPair()
    const chunk = 4_096
    const sealed = await collect(
      feed(pattern(4 * chunk + 10)).pipe(
        createBackupEncryptStream(keys.publicKey, { chunkBytes: chunk }),
      ),
    )
    const h = BACKUP_ENCRYPTION_HEADER_BYTES
    const s = chunk + 16
    const swapped = Buffer.concat([
      sealed.subarray(0, h),
      sealed.subarray(h + s, h + 2 * s),
      sealed.subarray(h, h + s),
      sealed.subarray(h + 2 * s),
    ])
    await expect(
      collect(feed(swapped).pipe(createBackupDecryptStream(keys.secretKey))),
    ).rejects.toBeInstanceOf(BackupDecryptError)
  })
})

describe('files', () => {
  it('encrypt → header → decrypt, file to file, over several MB with the default chunk', async () => {
    const keys = generateBackupKeyPair()
    const plain = path.join(dir, 'archive.tar.gz')
    const sealed = path.join(dir, 'archive.tar.gz.csbk')
    const back = path.join(dir, 'restored.tar.gz')
    const data = pattern(3 * 1024 * 1024 + 17)
    await fsp.writeFile(plain, data)

    await encryptBackupFile(plain, sealed, keys.publicKey)
    expect(await readBackupEncryptionHeader(sealed)).toEqual({ keyId: keys.keyId })
    expect(await readBackupEncryptionHeader(plain)).toBeNull()

    await decryptBackupFile(sealed, back, keys.secretKey)
    expect((await fsp.readFile(back)).equals(data)).toBe(true)
  })

  it('a failed decryption leaves no partial plaintext behind', async () => {
    const a = generateBackupKeyPair()
    const b = generateBackupKeyPair()
    const plain = path.join(dir, 'a.tar.gz')
    const sealed = path.join(dir, 'a.csbk')
    const back = path.join(dir, 'out.tar.gz')
    await fsp.writeFile(plain, pattern(100_000))
    await encryptBackupFile(plain, sealed, a.publicKey)
    await expect(decryptBackupFile(sealed, back, b.secretKey)).rejects.toBeInstanceOf(
      BackupKeyMismatchError,
    )
    expect(fs.existsSync(back)).toBe(false)
  })

  it('streams: memory stays bounded by the chunk, not the archive', async () => {
    const keys = generateBackupKeyPair()
    const src = path.join(dir, 'big.bin')
    const sealed = path.join(dir, 'big.csbk')
    const sizeMb = 24
    const block = pattern(1024 * 1024)
    const out = fs.createWriteStream(src)
    for (let i = 0; i < sizeMb; i++) out.write(block)
    await new Promise<void>((r) => out.end(r))
    const before = process.memoryUsage().arrayBuffers
    await pipeline(
      fs.createReadStream(src),
      createBackupEncryptStream(keys.publicKey),
      fs.createWriteStream(sealed),
    )
    const grown = process.memoryUsage().arrayBuffers - before
    // Bound is "not the whole archive in RAM", not a tight V8 accounting of
    // every ArrayBuffer that happens to be live after encrypt. Under parallel
    // nx on a busy CI host (run 38144796440) growth was ~33 MB for a 24 MB
    // file — still far below loading the archive whole. Allow one extra MB of
    // AEAD/chunk overhead per MB of payload.
    expect(grown).toBeLessThan(sizeMb * 1024 * 1024 * 2)
    expect((await fsp.stat(sealed)).size).toBeGreaterThan(sizeMb * 1024 * 1024)
  })
})
