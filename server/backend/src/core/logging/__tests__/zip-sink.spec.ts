/**
 * ZipSink (planning#729): the log export's streamed single-entry ZIP. The
 * archive is read back through its central directory, the way an unzip tool
 * does, so a wrong offset, size or CRC fails here.
 */
import { EventEmitter } from 'node:events'
import * as zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { DownloadSink } from '../../../api/backup-download-pump.js'
import { ZipSink } from '../zip-sink.js'

class MemorySink implements DownloadSink {
  readonly chunks: Buffer[] = []
  readonly events = new EventEmitter()
  destroyed = false
  ended = false
  writableLength = 0
  constructor(private readonly accept: boolean) {}
  write(chunk: Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk))
    // A slow socket: it refuses the write now and drains a tick later.
    if (!this.accept) setImmediate(() => this.events.emit('drain'))
    return this.accept
  }
  end(): void {
    this.ended = true
    this.events.emit('ended')
  }
  destroy(): void {
    this.destroyed = true
  }
  on(event: 'drain' | 'close', listener: () => void): unknown {
    return this.events.on(event, listener)
  }
  off(event: 'drain' | 'close', listener: () => void): unknown {
    return this.events.off(event, listener)
  }
  bytes(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

function readBack(zip: Buffer): { name: string; data: Buffer; crc: number } {
  const eocd = zip.length - 22
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50)
  expect(zip.readUInt16LE(eocd + 10)).toBe(1)
  const dir = zip.readUInt32LE(eocd + 16)
  const compressed = zip.readUInt32LE(dir + 20)
  const nameLength = zip.readUInt16LE(dir + 28)
  const dataStart = 30 + nameLength
  // The descriptor sits right after the data, and repeats the central sizes.
  expect(zip.readUInt32LE(dataStart + compressed)).toBe(0x08074b50)
  expect(zip.readUInt32LE(dataStart + compressed + 8)).toBe(compressed)
  return {
    name: zip.subarray(dir + 46, dir + 46 + nameLength).toString('utf8'),
    data: zlib.inflateRawSync(zip.subarray(dataStart, dataStart + compressed)),
    crc: zip.readUInt32LE(dir + 16),
  }
}

async function ended(sink: MemorySink): Promise<void> {
  if (sink.ended) return
  await new Promise<void>((resolve) => sink.events.once('ended', resolve))
}

describe('ZipSink', () => {
  it('writes the lines as one deflated entry the central directory describes', async () => {
    const inner = new MemorySink(true)
    const zip = new ZipSink(inner, 'logs.ndjson', new Date(2026, 10, 25, 12, 0, 0))
    const text = Array.from({ length: 2000 }, (_, i) => `{"id":"${String(i)}"}\n`).join('')
    zip.write(Buffer.from(text, 'utf8'))
    zip.end()
    await ended(inner)
    const entry = readBack(inner.bytes())
    expect(entry.name).toBe('logs.ndjson')
    expect(entry.data.toString('utf8')).toBe(text)
    expect(entry.crc).toBe(zlib.crc32(Buffer.from(text, 'utf8')))
    expect(inner.bytes().length).toBeLessThan(text.length)
  })

  it('is a valid archive with an empty entry', async () => {
    const inner = new MemorySink(true)
    const zip = new ZipSink(inner, 'logs.ndjson', new Date())
    zip.end()
    await ended(inner)
    expect(readBack(inner.bytes()).data.length).toBe(0)
  })

  it('holds the compressed bytes while the socket is behind and loses none', async () => {
    const inner = new MemorySink(false)
    const zip = new ZipSink(inner, 'logs.ndjson', new Date())
    const text = 'x'.repeat(10) + '\n'
    for (let i = 0; i < 200; i += 1) zip.write(Buffer.from(text))
    zip.end()
    await ended(inner)
    expect(readBack(inner.bytes()).data.toString('utf8')).toBe(text.repeat(200))
  })

  it('reports the inner sink as destroyed and forwards destroy', () => {
    const inner = new MemorySink(true)
    const zip = new ZipSink(inner, 'logs.ndjson', new Date())
    zip.destroy(new Error('gone'))
    expect(inner.destroyed).toBe(true)
    expect(zip.destroyed).toBe(true)
  })
})
