/**
 * Backup archive encryption — public key, streaming, chunked AEAD (D-backup
 * encryption, operator decision 2026-10-09).
 *
 * ## Why a public-key scheme
 *
 * Scheduled backups run with nobody present, so the hub must be able to
 * ENCRYPT on its own. With a symmetric key the hub would also hold what
 * DECRYPTS every archive it ever shipped — in its database, in the nightly
 * appdata tar, in any copy of the data volume — and the archives on SMB / S3
 * would be exactly as safe as the hub. Here the hub keeps only the PUBLIC key:
 * an attacker with the hub, its database or its volume backup still cannot
 * open an archive that already left. The operator keeps the secret key (shown
 * once at setup) and gives it back at restore time. It is independent of the
 * keychain master key, so a restore onto a fresh hub needs nothing from the
 * old one, and a keychain reset does not strand the backups.
 *
 * ## Format `x25519-hkdf-aes256gcm-stream-v1` (age's STREAM construction, AES-GCM)
 *
 *     header (69 bytes)
 *       magic "CSBKENC1" (8) | version 1 (1) | chunk size u32 BE (4)
 *       | recipient key id (8) | ephemeral X25519 public key (32) | salt (16)
 *     chunks
 *       AES-256-GCM(payloadKey, nonce, plaintext[≤ chunk]) ‖ tag(16)
 *
 * `payloadKey = HKDF-SHA256(X25519(ephemeral, recipient), salt,
 *  "camstack-backup-v1" ‖ header)` — the whole header is bound into the key,
 * so a changed byte in it fails the first chunk. The nonce is an 11-byte
 * big-endian chunk counter plus a final-chunk flag: a reordered, dropped or
 * appended chunk fails authentication, and an archive cut at a chunk boundary
 * is refused because its last chunk is not marked final. Every archive has a
 * final chunk (empty when the plaintext is a multiple of the chunk size).
 *
 * Memory is one chunk (64 KiB by default) per stream, whatever the archive
 * size. `scripts/ops/backup-decrypt.mjs` implements the same format with
 * nothing but Node, for a restore without a hub.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const BACKUP_ENCRYPTION_SCHEME = 'x25519-hkdf-aes256gcm-stream-v1'
export const ENCRYPTED_BACKUP_SUFFIX = '.csbk'

const MAGIC = Buffer.from('CSBKENC1', 'ascii')
const VERSION = 1
const KEY_ID_BYTES = 8
const SALT_BYTES = 16
const TAG_BYTES = 16
const INFO_LABEL = Buffer.from('camstack-backup-v1', 'ascii')
export const BACKUP_ENCRYPTION_HEADER_BYTES: number =
  MAGIC.length + 1 + 4 + KEY_ID_BYTES + 32 + SALT_BYTES
export const DEFAULT_BACKUP_CHUNK_BYTES: number = 64 * 1024
const MAX_CHUNK_BYTES = 16 * 1024 * 1024

const SECRET_PREFIX = 'camstack-backup-secret-v1:'
const PUBLIC_PREFIX = 'camstack-backup-public-v1:'
const CHECKSUM_BYTES = 4

// DER wrappers of a raw X25519 key (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

/** A key string that is not a backup key, or was mistyped. */
export class BackupKeyFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupKeyFormatError'
  }
}

/** The archive was encrypted to another backup key. */
export class BackupKeyMismatchError extends Error {
  constructor(
    readonly archiveKeyId: string,
    readonly givenKeyId: string,
  ) {
    super(
      `this backup was encrypted to backup key ${archiveKeyId}; the key given is ${givenKeyId}. ` +
        'Use the key that was current when the backup was made.',
    )
    this.name = 'BackupKeyMismatchError'
  }
}

/** The archive is damaged, truncated or tampered with. */
export class BackupDecryptError extends Error {
  constructor(message: string) {
    super(`encrypted backup is unreadable: ${message}`)
    this.name = 'BackupDecryptError'
  }
}

export interface BackupKeyPair {
  /** Shown ONCE to the operator; never stored on the hub. */
  readonly secretKey: string
  /** What the hub keeps to encrypt. */
  readonly publicKey: string
  /** 16 hex chars — names the key in the UI and in every archive header. */
  readonly keyId: string
}

function checksum(prefix: string, raw: Buffer): Buffer {
  return createHash('sha256').update(prefix).update(raw).digest().subarray(0, CHECKSUM_BYTES)
}

function encodeKey(prefix: string, raw: Buffer): string {
  return `${prefix}${Buffer.concat([raw, checksum(prefix, raw)]).toString('base64url')}`
}

function decodeKey(prefix: string, text: string, what: string): Buffer {
  const trimmed = text.trim()
  if (!trimmed.startsWith(prefix)) {
    throw new BackupKeyFormatError(`not a backup ${what} key (it must start with "${prefix}")`)
  }
  const bytes = Buffer.from(trimmed.slice(prefix.length), 'base64url')
  if (bytes.length !== 32 + CHECKSUM_BYTES) {
    throw new BackupKeyFormatError(`the backup ${what} key has the wrong length — copy it again`)
  }
  const raw = bytes.subarray(0, 32)
  if (!checksum(prefix, raw).equals(bytes.subarray(32))) {
    throw new BackupKeyFormatError(`the backup ${what} key does not check out — it was mistyped`)
  }
  return Buffer.from(raw)
}

function keyIdBytes(publicRaw: Buffer): Buffer {
  return createHash('sha256').update(publicRaw).digest().subarray(0, KEY_ID_BYTES)
}

function privateKeyObject(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' })
}

function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

function rawPublic(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length)
}

function rawPrivate(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length)
}

export function generateBackupKeyPair(): BackupKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const pub = rawPublic(publicKey)
  return {
    secretKey: encodeKey(SECRET_PREFIX, rawPrivate(privateKey)),
    publicKey: encodeKey(PUBLIC_PREFIX, pub),
    keyId: keyIdBytes(pub).toString('hex'),
  }
}

export interface ParsedPublicKey {
  readonly raw: Buffer
  readonly keyId: string
}

export interface ParsedSecretKey {
  readonly key: KeyObject
  readonly publicRaw: Buffer
  readonly keyId: string
}

export function parseBackupPublicKey(text: string): ParsedPublicKey {
  const raw = decodeKey(PUBLIC_PREFIX, text, 'public')
  return { raw, keyId: keyIdBytes(raw).toString('hex') }
}

export function parseBackupSecretKey(text: string): ParsedSecretKey {
  const raw = decodeKey(SECRET_PREFIX, text, 'secret')
  const key = privateKeyObject(raw)
  const publicRaw = rawPublic(createPublicKey(key))
  return { key, publicRaw, keyId: keyIdBytes(publicRaw).toString('hex') }
}

function payloadKey(shared: Buffer, salt: Buffer, header: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, salt, Buffer.concat([INFO_LABEL, header]), 32))
}

function nonceFor(counter: bigint, final: boolean): Buffer {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64BE(counter, 3)
  nonce[11] = final ? 1 : 0
  return nonce
}

function seal(key: Buffer, counter: bigint, final: boolean, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonceFor(counter, final))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()])
}

function open(key: Buffer, counter: bigint, final: boolean, sealed: Buffer): Buffer | null {
  if (sealed.length < TAG_BYTES) return null
  const decipher = createDecipheriv('aes-256-gcm', key, nonceFor(counter, final))
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
      decipher.final(),
    ])
  } catch {
    return null
  }
}

/** A growing byte queue that takes exact slices without re-concatenating everything. */
class ByteQueue {
  private parts: Buffer[] = []
  length = 0

  push(buf: Buffer): void {
    if (buf.length === 0) return
    this.parts.push(buf)
    this.length += buf.length
  }

  take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n)
    let filled = 0
    while (filled < n) {
      const head = this.parts[0]
      if (head === undefined) throw new Error('ByteQueue underflow')
      const need = n - filled
      if (head.length <= need) {
        head.copy(out, filled)
        filled += head.length
        this.parts.shift()
      } else {
        head.copy(out, filled, 0, need)
        this.parts[0] = head.subarray(need)
        filled += need
      }
    }
    this.length -= n
    return out
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  if (typeof chunk === 'string') return Buffer.from(chunk)
  throw new TypeError('backup encryption: a stream chunk must be bytes')
}

/** Encrypt a byte stream to the holder of `publicKey`'s secret key. */
export function createBackupEncryptStream(
  publicKey: string,
  opts?: { readonly chunkBytes?: number },
): Transform {
  const recipient = parseBackupPublicKey(publicKey)
  const chunkBytes = opts?.chunkBytes ?? DEFAULT_BACKUP_CHUNK_BYTES
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) {
    throw new RangeError(`backup encryption: chunk size ${chunkBytes} is out of range`)
  }
  const ephemeral = generateKeyPairSync('x25519')
  const salt = randomBytes(SALT_BYTES)
  const sizeField = Buffer.alloc(4)
  sizeField.writeUInt32BE(chunkBytes)
  const header = Buffer.concat([
    MAGIC,
    Buffer.from([VERSION]),
    sizeField,
    keyIdBytes(recipient.raw),
    rawPublic(ephemeral.publicKey),
    salt,
  ])
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: publicKeyObject(recipient.raw),
  })
  const key = payloadKey(shared, salt, header)
  const queue = new ByteQueue()
  let counter = 0n
  let headerSent = false

  const sendHeader = (stream: Transform): void => {
    if (headerSent) return
    headerSent = true
    stream.push(header)
  }

  return new Transform({
    transform(chunk: unknown, _enc, callback: TransformCallback) {
      try {
        sendHeader(this)
        queue.push(toBuffer(chunk))
        // Strictly MORE than a chunk: the last full chunk may be the final one.
        while (queue.length > chunkBytes) {
          this.push(seal(key, counter, false, queue.take(chunkBytes)))
          counter += 1n
        }
        callback()
      } catch (err: unknown) {
        callback(err instanceof Error ? err : new Error(String(err)))
      }
    },
    flush(callback: TransformCallback) {
      try {
        sendHeader(this)
        this.push(seal(key, counter, true, queue.take(queue.length)))
        callback()
      } catch (err: unknown) {
        callback(err instanceof Error ? err : new Error(String(err)))
      }
    },
  })
}

interface ParsedHeader {
  readonly chunkBytes: number
  readonly keyId: string
  readonly ephemeral: Buffer
  readonly salt: Buffer
}

function parseHeader(header: Buffer): ParsedHeader | null {
  if (header.length < BACKUP_ENCRYPTION_HEADER_BYTES) return null
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) return null
  let at = MAGIC.length
  const version = header[at]
  at += 1
  if (version !== VERSION) {
    throw new BackupDecryptError(`format version ${String(version)} is not supported`)
  }
  const chunkBytes = header.readUInt32BE(at)
  at += 4
  if (chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) {
    throw new BackupDecryptError('the header names an impossible chunk size')
  }
  const keyId = header.subarray(at, at + KEY_ID_BYTES).toString('hex')
  at += KEY_ID_BYTES
  const ephemeral = Buffer.from(header.subarray(at, at + 32))
  at += 32
  const salt = Buffer.from(header.subarray(at, at + SALT_BYTES))
  return { chunkBytes, keyId, ephemeral, salt }
}

/** Decrypt a stream produced by {@link createBackupEncryptStream}. */
export function createBackupDecryptStream(secretKey: string): Transform {
  const recipient = parseBackupSecretKey(secretKey)
  const queue = new ByteQueue()
  let key: Buffer | null = null
  let sealedChunk = 0
  let counter = 0n

  const openHeader = (): void => {
    const header = queue.take(BACKUP_ENCRYPTION_HEADER_BYTES)
    const parsed = parseHeader(header)
    if (parsed === null) throw new BackupDecryptError('this is not an encrypted CamStack backup')
    if (parsed.keyId !== recipient.keyId) {
      throw new BackupKeyMismatchError(parsed.keyId, recipient.keyId)
    }
    const shared = diffieHellman({
      privateKey: recipient.key,
      publicKey: publicKeyObject(parsed.ephemeral),
    })
    key = payloadKey(shared, parsed.salt, header)
    sealedChunk = parsed.chunkBytes + TAG_BYTES
  }

  const openChunk = (stream: Transform, sealed: Buffer, final: boolean): void => {
    if (key === null) throw new BackupDecryptError('no header')
    const plain = open(key, counter, final, sealed)
    if (plain === null) {
      throw new BackupDecryptError(
        final
          ? `the last chunk (${counter}) failed authentication — the archive is truncated, damaged or tampered with`
          : `chunk ${counter} failed authentication — the archive is damaged or tampered with`,
      )
    }
    counter += 1n
    if (plain.length > 0) stream.push(plain)
  }

  return new Transform({
    transform(chunk: unknown, _enc, callback: TransformCallback) {
      try {
        queue.push(toBuffer(chunk))
        if (key === null) {
          if (queue.length < BACKUP_ENCRYPTION_HEADER_BYTES) return callback()
          openHeader()
        }
        while (queue.length > sealedChunk) openChunk(this, queue.take(sealedChunk), false)
        callback()
      } catch (err: unknown) {
        callback(err instanceof Error ? err : new Error(String(err)))
      }
    },
    flush(callback: TransformCallback) {
      try {
        if (key === null) {
          if (queue.length < BACKUP_ENCRYPTION_HEADER_BYTES) {
            throw new BackupDecryptError('the archive ends before its header does')
          }
          openHeader()
        }
        if (queue.length < TAG_BYTES) {
          throw new BackupDecryptError('the archive ends without its final chunk — it is truncated')
        }
        openChunk(this, queue.take(queue.length), true)
        callback()
      } catch (err: unknown) {
        callback(err instanceof Error ? err : new Error(String(err)))
      }
    },
  })
}

/** The key id an encrypted archive names, or `null` for a plain (pre-encryption) archive. */
export async function readBackupEncryptionHeader(
  file: string,
): Promise<{ readonly keyId: string } | null> {
  const handle = await fsp.open(file, 'r')
  try {
    const header = Buffer.alloc(BACKUP_ENCRYPTION_HEADER_BYTES)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead < MAGIC.length || !header.subarray(0, MAGIC.length).equals(MAGIC)) return null
    const parsed = parseHeader(header.subarray(0, bytesRead))
    if (parsed === null) throw new BackupDecryptError('the header is cut short')
    return { keyId: parsed.keyId }
  } finally {
    await handle.close()
  }
}

/** File → file. Used by tests and the offline path; the hub streams in its pipeline. */
export async function encryptBackupFile(
  input: string,
  output: string,
  publicKey: string,
): Promise<void> {
  await pipeline(
    fs.createReadStream(input),
    createBackupEncryptStream(publicKey),
    fs.createWriteStream(output, { mode: 0o600 }),
  )
}

/**
 * File → file. A failure of any kind removes the partial output: a restore
 * must never find half a tar where the archive should be.
 */
export async function decryptBackupFile(
  input: string,
  output: string,
  secretKey: string,
): Promise<void> {
  const decrypt = createBackupDecryptStream(secretKey)
  try {
    await pipeline(
      fs.createReadStream(input),
      decrypt,
      fs.createWriteStream(output, { mode: 0o600 }),
    )
  } catch (err: unknown) {
    await fsp.rm(output, { force: true }).catch(() => undefined)
    throw err
  }
}
