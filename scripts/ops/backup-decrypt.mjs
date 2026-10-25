#!/usr/bin/env node
// OFFLINE, OPERATOR-RUN: decrypt an encrypted CamStack system backup without a
// hub — the disaster-recovery path when there is no running hub to restore
// through (a dead machine, a fresh host before CamStack is installed).
//
//   node scripts/ops/backup-decrypt.mjs <archive.tar.gz.csbk> <out.tar.gz> --key-file <file>
//   node scripts/ops/backup-decrypt.mjs <archive.tar.gz.csbk> <out.tar.gz> < keyfile
//
// The backup SECRET key (`camstack-backup-secret-v1:…`, shown once when
// encryption was set up on the Backup page) is read from --key-file or stdin —
// never from an argument or an environment variable, so it lands in no shell
// history and no process list. It is never printed. The output is the plain
// `.tar.gz` (0600) the hub would have extracted; `tar -xzf out.tar.gz -C
// <data dir>` restores it by hand.
//
// Format `x25519-hkdf-aes256gcm-stream-v1` — the same as
// packages/system/src/builtins/system-backup/backup-encryption.ts (kept in step
// by server/backend/src/__tests__/encrypted-backup-restore.spec.ts, which
// decrypts a hub-built archive with this script). Node ≥ 18, no dependencies.
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from 'node:crypto'
import * as fs from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAGIC = Buffer.from('CSBKENC1', 'ascii')
const HEADER_BYTES = 8 + 1 + 4 + 8 + 32 + 16
const TAG_BYTES = 16
const SECRET_PREFIX = 'camstack-backup-secret-v1:'
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const INFO_LABEL = Buffer.from('camstack-backup-v1', 'ascii')

function fail(message) {
  process.stderr.write(`backup-decrypt: ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const positional = []
  let keyFile = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--key-file') keyFile = argv[++i] ?? null
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write(
        'usage: backup-decrypt.mjs <archive.csbk> <out.tar.gz> [--key-file <file>]  (else the key is read from stdin)\n',
      )
      process.exit(0)
    } else positional.push(argv[i])
  }
  if (positional.length !== 2) fail('expected <archive> <out.tar.gz> (see --help)')
  return { input: positional[0], output: positional[1], keyFile }
}

async function readKeyText(keyFile) {
  if (keyFile !== null) return fs.readFileSync(keyFile, 'utf8')
  if (process.stdin.isTTY) fail('give the key with --key-file, or pipe it on stdin')
  const parts = []
  for await (const part of process.stdin) parts.push(part)
  return Buffer.concat(parts).toString('utf8')
}

function parseSecretKey(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith(SECRET_PREFIX))
    fail(`not a backup secret key (it must start with "${SECRET_PREFIX}")`)
  const bytes = Buffer.from(trimmed.slice(SECRET_PREFIX.length), 'base64url')
  if (bytes.length !== 36) fail('the backup secret key has the wrong length — copy it again')
  const raw = bytes.subarray(0, 32)
  const sum = createHash('sha256').update(SECRET_PREFIX).update(raw).digest().subarray(0, 4)
  if (!sum.equals(bytes.subarray(32)))
    fail('the backup secret key does not check out — it was mistyped')
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  })
  const publicRaw = createPublicKey(key)
    .export({ format: 'der', type: 'spki' })
    .subarray(SPKI_PREFIX.length)
  const keyId = createHash('sha256').update(publicRaw).digest().subarray(0, 8).toString('hex')
  return { key, keyId }
}

function nonceFor(counter, final) {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64BE(counter, 3)
  nonce[11] = final ? 1 : 0
  return nonce
}

function decryptStream(recipient) {
  let pending = Buffer.alloc(0)
  let key = null
  let sealedChunk = 0
  let counter = 0n
  const openHeader = () => {
    const header = pending.subarray(0, HEADER_BYTES)
    pending = pending.subarray(HEADER_BYTES)
    if (!header.subarray(0, 8).equals(MAGIC))
      throw new Error('this is not an encrypted CamStack backup')
    if (header[8] !== 1) throw new Error(`format version ${header[8]} is not supported`)
    const chunkBytes = header.readUInt32BE(9)
    const keyId = header.subarray(13, 21).toString('hex')
    if (keyId !== recipient.keyId) {
      throw new Error(
        `this backup was encrypted to backup key ${keyId}; the key given is ${recipient.keyId}`,
      )
    }
    const ephemeral = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, header.subarray(21, 53)]),
      format: 'der',
      type: 'spki',
    })
    const salt = header.subarray(53, 69)
    const shared = diffieHellman({ privateKey: recipient.key, publicKey: ephemeral })
    key = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.concat([INFO_LABEL, header]), 32))
    sealedChunk = chunkBytes + TAG_BYTES
  }
  const openChunk = (stream, sealed, final) => {
    const decipher = createDecipheriv('aes-256-gcm', key, nonceFor(counter, final))
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
    let plain
    try {
      plain = Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
        decipher.final(),
      ])
    } catch {
      throw new Error(
        `chunk ${counter} failed authentication — the archive is truncated, damaged or tampered with`,
      )
    }
    counter += 1n
    if (plain.length > 0) stream.push(plain)
  }
  return new Transform({
    transform(chunk, _enc, callback) {
      try {
        pending = Buffer.concat([pending, chunk])
        if (key === null) {
          if (pending.length < HEADER_BYTES) return callback()
          openHeader()
        }
        while (pending.length > sealedChunk) {
          openChunk(this, pending.subarray(0, sealedChunk), false)
          pending = pending.subarray(sealedChunk)
        }
        callback()
      } catch (err) {
        callback(err)
      }
    },
    flush(callback) {
      try {
        if (key === null) {
          if (pending.length < HEADER_BYTES)
            throw new Error('the archive ends before its header does')
          openHeader()
        }
        if (pending.length < TAG_BYTES)
          throw new Error('the archive ends without its final chunk — it is truncated')
        openChunk(this, pending, true)
        callback()
      } catch (err) {
        callback(err)
      }
    },
  })
}

const { input, output, keyFile } = parseArgs(process.argv.slice(2))
const recipient = parseSecretKey(await readKeyText(keyFile))
try {
  await pipeline(
    fs.createReadStream(input),
    decryptStream(recipient),
    fs.createWriteStream(output, { mode: 0o600 }),
  )
} catch (err) {
  fs.rmSync(output, { force: true })
  fail(err instanceof Error ? err.message : String(err))
}
process.stdout.write(`decrypted ${input} → ${output} (backup key ${recipient.keyId})\n`)
