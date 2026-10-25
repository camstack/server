/**
 * A zip extractor with no external binary behind it.
 *
 * Why it exists: on Windows there is no `unzip`, and the `tar` that is on PATH
 * is whichever the machine has (Git for Windows ships a GNU tar that cannot
 * read a zip). The two archives a Windows node downloads — the portable Python
 * and the ffmpeg build — are both zips, so the extraction is done here, with
 * `node:zlib`, instead of by a program the machine may not have.
 *
 * Scope is deliberately narrow: stored and deflated entries, no encryption, no
 * zip64. Both are refused by NAME rather than mis-read. Symlinks and unix modes
 * are not restored — POSIX hosts keep using `unzip`, which does.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_BYTES = 22
/** The end-of-central-directory record is within the last 22 + 65535 bytes. */
const EOCD_SEARCH_BYTES = EOCD_MIN_BYTES + 0xffff
const ZIP64_SENTINEL = 0xffffffff
const METHOD_STORED = 0
const METHOD_DEFLATE = 8
const FLAG_ENCRYPTED = 0x1

interface ZipEntry {
  readonly name: string
  readonly method: number
  readonly crc: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localHeaderOffset: number
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - EOCD_SEARCH_BYTES)
  for (let i = buf.length - EOCD_MIN_BYTES; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i
  }
  throw new Error('not a zip archive: no end-of-central-directory record')
}

function readEntries(buf: Buffer): readonly ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf)
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || offset === ZIP64_SENTINEL) {
    throw new Error('zip64 archives are not supported')
  }
  const entries: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt zip: bad central directory entry ${n}`)
    }
    const flags = buf.readUInt16LE(offset + 8)
    if ((flags & FLAG_ENCRYPTED) !== 0) throw new Error('encrypted zip entries are not supported')
    const compressedSize = buf.readUInt32LE(offset + 20)
    const uncompressedSize = buf.readUInt32LE(offset + 24)
    const localHeaderOffset = buf.readUInt32LE(offset + 42)
    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      throw new Error('zip64 entries are not supported')
    }
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    entries.push({
      name: buf.toString('utf8', offset + 46, offset + 46 + nameLength),
      method: buf.readUInt16LE(offset + 10),
      crc: buf.readUInt32LE(offset + 16),
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readEntryData(buf: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localHeaderOffset
  if (buf.readUInt32LE(at) !== LOCAL_SIGNATURE) {
    throw new Error(`corrupt zip: bad local header for ${entry.name}`)
  }
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
  const raw = buf.subarray(start, start + entry.compressedSize)
  let data: Buffer
  if (entry.method === METHOD_STORED) data = raw
  else if (entry.method === METHOD_DEFLATE) data = inflateRawSync(raw)
  else throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`)
  if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc) {
    throw new Error(`corrupt zip: ${entry.name} does not match its recorded size/CRC`)
  }
  return data
}

/**
 * Where an entry lands, or a refusal when its name climbs out of `destDir`
 * (a "zip slip": `..\..\evil.dll`, an absolute path, a drive letter).
 */
function targetPath(destDir: string, entryName: string): string {
  const root = resolve(destDir)
  const target = resolve(root, entryName.replace(/\\/g, '/'))
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`zip entry escapes the target directory: ${entryName}`)
  }
  return target
}

export function extractZipArchive(archivePath: string, destDir: string): void {
  const buf = readFileSync(archivePath)
  mkdirSync(destDir, { recursive: true })
  for (const entry of readEntries(buf)) {
    const target = targetPath(destDir, entry.name)
    if (entry.name.endsWith('/') || entry.name.endsWith('\\')) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readEntryData(buf, entry))
  }
}
