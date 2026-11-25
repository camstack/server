/**
 * A single-entry ZIP archive written as a stream (planning#729): the log export's
 * "Export as ZIP". It is a {@link DownloadSink}, so the export's writer pushes
 * NDJSON into it unchanged and the compressed archive goes out the real
 * response, at the pace that response takes it.
 *
 * Layout: local header (sizes deferred to a data descriptor, general-purpose
 * bit 3), the DEFLATE stream, the data descriptor, one central directory entry,
 * the end record. Classic ZIP, no ZIP64: an entry past 4 GiB is refused by
 * destroying the response, never written as a corrupt archive.
 */
import { EventEmitter } from 'node:events'
import * as zlib from 'node:zlib'
import type { DownloadSink } from '../../api/backup-download-pump.js'

const LOCAL_SIGNATURE = 0x04034b50
const DESCRIPTOR_SIGNATURE = 0x08074b50
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50
const VERSION_NEEDED = 20
/** Bit 3: sizes follow the data. Bit 11: the name is UTF-8. */
const FLAGS = 0x0008 | 0x0800
const METHOD_DEFLATE = 8
const ZIP_MAX_BYTES = 0xffffffff
const LOCAL_HEADER_BYTES = 30

interface DosStamp {
  readonly time: number
  readonly date: number
}

function dosStamp(at: Date): DosStamp {
  const year = Math.max(at.getFullYear(), 1980)
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  }
}

export class ZipSink implements DownloadSink {
  private readonly events = new EventEmitter()
  private readonly deflate = zlib.createDeflateRaw()
  private readonly nameBytes: Buffer
  private readonly stamp: DosStamp
  private crc = 0
  private uncompressed = 0
  private compressed = 0
  private innerFull = false
  private releaseHold: (() => void) | null = null

  constructor(
    private readonly inner: DownloadSink,
    entryName: string,
    at: Date,
  ) {
    this.nameBytes = Buffer.from(entryName, 'utf8')
    this.stamp = dosStamp(at)
    this.inner.write(this.localHeader())
    this.deflate.on('data', (chunk: Buffer) => {
      this.compressed += chunk.byteLength
      if (!this.inner.write(chunk)) this.holdForInner()
    })
    this.deflate.on('drain', () => this.events.emit('drain'))
    this.deflate.on('end', () => this.finish())
    this.deflate.on('error', (err) => this.inner.destroy(err))
    // The client left: stop compressing and drop the drain listener on the closed socket.
    this.inner.on('close', () => {
      this.releaseHold?.()
      this.deflate.destroy()
    })
  }

  get destroyed(): boolean {
    return this.inner.destroyed
  }

  get writableLength(): number {
    return this.inner.writableLength + this.deflate.writableLength
  }

  write(chunk: Uint8Array): boolean {
    this.crc = zlib.crc32(chunk, this.crc)
    this.uncompressed += chunk.byteLength
    if (this.uncompressed > ZIP_MAX_BYTES) {
      this.destroy(new Error('log export: the ZIP entry passed 4 GiB'))
      return false
    }
    return this.deflate.write(chunk) && !this.innerFull
  }

  end(): void {
    this.deflate.end()
  }

  destroy(error?: Error): void {
    this.deflate.destroy()
    this.inner.destroy(error)
  }

  on(event: 'drain' | 'close', listener: () => void): unknown {
    if (event === 'close') return this.inner.on('close', listener)
    return this.events.on('drain', listener)
  }

  off(event: 'drain' | 'close', listener: () => void): unknown {
    if (event === 'close') return this.inner.off('close', listener)
    return this.events.off('drain', listener)
  }

  /** The socket is behind: stop pulling compressed bytes until it drains. */
  private holdForInner(): void {
    this.innerFull = true
    this.deflate.pause()
    const release = (): void => {
      this.inner.off('drain', resume)
      this.releaseHold = null
    }
    const resume = (): void => {
      release()
      this.innerFull = false
      this.deflate.resume()
      this.events.emit('drain')
    }
    this.releaseHold = release
    this.inner.on('drain', resume)
  }

  private localHeader(): Buffer {
    const header = Buffer.alloc(LOCAL_HEADER_BYTES)
    header.writeUInt32LE(LOCAL_SIGNATURE, 0)
    header.writeUInt16LE(VERSION_NEEDED, 4)
    header.writeUInt16LE(FLAGS, 6)
    header.writeUInt16LE(METHOD_DEFLATE, 8)
    header.writeUInt16LE(this.stamp.time, 10)
    header.writeUInt16LE(this.stamp.date, 12)
    header.writeUInt16LE(this.nameBytes.byteLength, 26)
    return Buffer.concat([header, this.nameBytes])
  }

  private finish(): void {
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0)
    descriptor.writeUInt32LE(this.crc, 4)
    descriptor.writeUInt32LE(this.compressed, 8)
    descriptor.writeUInt32LE(this.uncompressed, 12)

    // Extra, comment, disk, attributes and the local header offset (0) stay zero.
    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    central.writeUInt16LE(VERSION_NEEDED, 4)
    central.writeUInt16LE(VERSION_NEEDED, 6)
    central.writeUInt16LE(FLAGS, 8)
    central.writeUInt16LE(METHOD_DEFLATE, 10)
    central.writeUInt16LE(this.stamp.time, 12)
    central.writeUInt16LE(this.stamp.date, 14)
    central.writeUInt32LE(this.crc, 16)
    central.writeUInt32LE(this.compressed, 20)
    central.writeUInt32LE(this.uncompressed, 24)
    central.writeUInt16LE(this.nameBytes.byteLength, 28)
    const directory = Buffer.concat([central, this.nameBytes])

    const end = Buffer.alloc(22)
    end.writeUInt32LE(END_SIGNATURE, 0)
    end.writeUInt16LE(1, 8)
    end.writeUInt16LE(1, 10)
    end.writeUInt32LE(directory.byteLength, 12)
    end.writeUInt32LE(
      LOCAL_HEADER_BYTES + this.nameBytes.byteLength + this.compressed + descriptor.byteLength,
      16,
    )

    this.inner.write(Buffer.concat([descriptor, directory, end]))
    this.inner.end()
  }
}
