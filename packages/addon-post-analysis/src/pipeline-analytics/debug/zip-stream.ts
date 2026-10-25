/**
 * A minimal STORE-only ZIP writer — enough to emit a debug bundle entry by
 * entry, without ever holding the archive in memory.
 *
 * ## Why hand-rolled, and why ZIP rather than the tar next door
 *
 * The archive the operator asked for is a ZIP, because it is the format that
 * opens with a double click on every desktop they use; the training exports use
 * ustar and that stays as it is. Both are hand-written here for the same two
 * reasons the {@link ../training-export/tar-stream.js tar writer} records:
 *
 *  1. **A dependency would not arrive.** A hub addon is deployed as its built
 *     `dist/` and carries ZERO `node_modules` of its own — adding `yazl` or
 *     `archiver` to `package.json` gets a module that is missing at runtime on
 *     the node that actually runs the code. The only libraries an addon can rely
 *     on are Node's builtins and what its bundler inlines.
 *  2. **Nothing to compress.** Every payload is JPEG or MP4, already compressed.
 *     STORE (method 0) spends no CPU on the hub's one thread for a percent or
 *     two, and — unlike DEFLATE — the entry's size and CRC are known before the
 *     header is written, so no data descriptors and no seeking back: the writer
 *     is append-only and therefore streamable.
 *
 * So: STORE-only ZIP, which is a 30-byte local header + verbatim body per entry
 * plus a central directory at the end, fully specified (APPNOTE 6.3.x), and
 * asserted against the system `unzip` binary in the spec next door rather than
 * against my reading of the format.
 *
 * ## What this deliberately does NOT do
 *
 * No ZIP64. The classic record set addresses 4 GiB and 65 535 entries, and this
 * archive is a hand-marked debug set — tens of tracks, not a dataset.
 * {@link ZipStreamWriter.fits} reports an entry that would cross either ceiling
 * so the caller can skip it and SAY it skipped it, rather than emitting an
 * archive with a wrapped offset that reads as corrupt.
 *
 * ## Entry names are ASCII, by construction
 *
 * The writer sets the UTF-8 name flag (bit 11) because that is what the format
 * says, but **it cannot be relied on**: the `unzip` shipped on macOS is Info-ZIP
 * 6.00, which ignores the flag and re-encodes the name from CP437 — `persona-è`
 * comes out of it as `persona-+¿`, and on a case where the mangled bytes are not
 * valid for the filesystem it refuses to extract the entry at all. Measured, not
 * assumed; the spec next door pins it.
 *
 * So {@link toAsciiZipName} is applied to every path, and — more importantly —
 * no free text goes into a path in the first place: an entry is addressed by
 * `deviceId` and `trackId`, and the camera name lives INSIDE `track.json` where
 * its encoding is JSON's problem and not the archive's.
 */

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
/** Bit 11 — the entry name is UTF-8. */
const FLAG_UTF8 = 0x0800
/** STORE. */
const METHOD_STORE = 0
/** PKZIP 2.0, the floor for STORE + UTF-8 names. */
const VERSION = 20

/** The classic (non-ZIP64) ceilings. Crossing either needs ZIP64; we refuse. */
export const ZIP_MAX_BYTES = 0xffffffff
export const ZIP_MAX_ENTRIES = 0xffff

/** One file in the archive. */
export interface ZipEntry {
  /** Path inside the archive, `/`-separated, no leading slash. */
  readonly name: string
  readonly body: Buffer
  /** Modification time in ms since epoch. */
  readonly mtimeMs: number
}

/** What the writer must remember about an entry to emit the central directory. */
interface ZipDirEntry {
  readonly nameBytes: Buffer
  readonly crc: number
  readonly size: number
  readonly offset: number
  readonly dosTime: number
  readonly dosDate: number
}

const CRC_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/**
 * Reduce a path to the ASCII set every ZIP reader agrees on.
 *
 * Anything outside `[A-Za-z0-9._-]` (and the `/` separator) becomes `_`. Not a
 * transliteration: a name that survives Info-ZIP's CP437 pass unchanged is the
 * only name this archive can promise, and a lossy-but-stable mapping is better
 * than a pretty one that a reader mangles differently from the manifest.
 */
export function toAsciiZipName(name: string): string {
  return name.replace(/[^A-Za-z0-9._/-]/g, '_')
}

/** CRC-32 (IEEE 802.3), the checksum every ZIP entry header carries. */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * MS-DOS date/time, the only timestamp a classic ZIP record carries.
 *
 * Two-second resolution and an epoch of 1980 — a date before that is clamped
 * rather than allowed to write a negative year field, which some readers show as
 * 2107 and others reject outright.
 */
function dosDateTime(mtimeMs: number): { readonly time: number; readonly date: number } {
  const d = new Date(mtimeMs)
  const year = Math.max(1980, d.getFullYear())
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/**
 * The 30-byte local header + name for one stored file.
 *
 * Sizes and CRC are written into the header itself (never a trailing data
 * descriptor) — STORE knows both before the body moves, and a header that tells
 * the truth is what lets a reader index the archive without scanning it.
 */
function zipLocalHeader(entry: ZipEntry, crc: number, nameBytes: Buffer): Buffer {
  const head = Buffer.alloc(30)
  const { time, date } = dosDateTime(entry.mtimeMs)
  head.writeUInt32LE(LOCAL_SIG, 0)
  head.writeUInt16LE(VERSION, 4)
  head.writeUInt16LE(FLAG_UTF8, 6)
  head.writeUInt16LE(METHOD_STORE, 8)
  head.writeUInt16LE(time, 10)
  head.writeUInt16LE(date, 12)
  head.writeUInt32LE(crc, 14)
  head.writeUInt32LE(entry.body.length, 18) // compressed == uncompressed
  head.writeUInt32LE(entry.body.length, 22)
  head.writeUInt16LE(nameBytes.length, 26)
  head.writeUInt16LE(0, 28) // no extra field
  return Buffer.concat([head, nameBytes])
}

function centralHeader(entry: ZipDirEntry): Buffer {
  const head = Buffer.alloc(46)
  head.writeUInt32LE(CENTRAL_SIG, 0)
  head.writeUInt16LE(VERSION, 4) // version made by
  head.writeUInt16LE(VERSION, 6) // version needed
  head.writeUInt16LE(FLAG_UTF8, 8)
  head.writeUInt16LE(METHOD_STORE, 10)
  head.writeUInt16LE(entry.dosTime, 12)
  head.writeUInt16LE(entry.dosDate, 14)
  head.writeUInt32LE(entry.crc, 16)
  head.writeUInt32LE(entry.size, 20)
  head.writeUInt32LE(entry.size, 24)
  head.writeUInt16LE(entry.nameBytes.length, 28)
  head.writeUInt16LE(0, 30) // extra
  head.writeUInt16LE(0, 32) // comment
  head.writeUInt16LE(0, 34) // disk number start
  head.writeUInt16LE(0, 36) // internal attributes
  head.writeUInt32LE(0, 38) // external attributes
  head.writeUInt32LE(entry.offset, 42)
  return Buffer.concat([head, entry.nameBytes])
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4) // this disk
  eocd.writeUInt16LE(0, 6) // disk with the central directory
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(size, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // no archive comment
  return eocd
}

/** What the ceiling check needs to know — a LENGTH, never the bytes themselves. */
export interface ZipFitQuery {
  /** Bytes already emitted, central directory excluded. */
  readonly offset: number
  /** How many entries the archive already holds. */
  readonly entryIndex: number
  readonly name: string
  readonly bodyLength: number
}

/**
 * True when one more entry still fits inside the classic (non-ZIP64) ceilings.
 *
 * Pure, and asked with a length rather than a Buffer, so the 4 GiB boundary can
 * be tested without allocating 4 GiB — the guard whose failure mode (a wrapped
 * 32-bit offset, producing an archive that looks complete and unpacks as
 * garbage) is precisely the one a test must be able to reach.
 */
export function zipEntryFits(query: ZipFitQuery): boolean {
  if (query.entryIndex >= ZIP_MAX_ENTRIES) return false
  const nameLen = toAsciiZipName(query.name).length
  return query.offset + 30 + nameLen + query.bodyLength <= ZIP_MAX_BYTES
}

/**
 * An append-only ZIP writer.
 *
 * The caller supplies `write` — the real `res.write`, awaited, so backpressure
 * is the socket's. The writer holds only the central directory (one small record
 * per entry), never a body: {@link add} takes one file at a time and forgets it.
 */
export class ZipStreamWriter {
  private readonly entries: ZipDirEntry[] = []
  private offset = 0

  constructor(private readonly write: (chunk: Buffer) => Promise<void>) {}

  /** Entries accepted so far — what the manifest should claim, not what was asked. */
  get entryCount(): number {
    return this.entries.length
  }

  /** Bytes emitted so far, central directory excluded. */
  get bytesWritten(): number {
    return this.offset
  }

  /**
   * True when this entry still fits inside the classic ZIP ceilings.
   *
   * Checked BEFORE the header goes out, because a 32-bit offset that wraps
   * produces an archive that looks complete and unpacks as garbage — the failure
   * this writer most needs to make impossible.
   */
  fits(entry: ZipEntry): boolean {
    return zipEntryFits({
      offset: this.offset,
      entryIndex: this.entries.length,
      name: entry.name,
      bodyLength: entry.body.length,
    })
  }

  /** Append one stored file. Returns false (and writes nothing) when it does not fit. */
  async add(entry: ZipEntry): Promise<boolean> {
    if (!this.fits(entry)) return false
    const nameBytes = Buffer.from(toAsciiZipName(entry.name), 'ascii')
    const crc = crc32(entry.body)
    const { time, date } = dosDateTime(entry.mtimeMs)
    const header = zipLocalHeader(entry, crc, nameBytes)
    this.entries.push({
      nameBytes,
      crc,
      size: entry.body.length,
      offset: this.offset,
      dosTime: time,
      dosDate: date,
    })
    await this.write(header)
    await this.write(entry.body)
    this.offset += header.length + entry.body.length
    return true
  }

  /** Write the central directory + EOCD. The archive is unreadable without it. */
  async finish(): Promise<void> {
    const start = this.offset
    let size = 0
    for (const entry of this.entries) {
      const block = centralHeader(entry)
      await this.write(block)
      size += block.length
    }
    await this.write(endOfCentralDirectory(this.entries.length, size, start))
    this.offset = start + size + 22
  }
}
