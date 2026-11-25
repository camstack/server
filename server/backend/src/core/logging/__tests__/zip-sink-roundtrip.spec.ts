/**
 * The hub's ZIP writer against the MCP's reader (planning#729): `ZipSink` output
 * is read back through `summarizeLogsExport({ zip: true })` from @camstack/develop,
 * so a format drift between the two fails here. The reader's own specs build
 * their archives by hand.
 */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { summarizeLogsExport } from '@camstack/develop'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DownloadSink } from '../../../api/backup-download-pump.js'
import { ZipSink } from '../zip-sink.js'

const NDJSON = `${[
  {
    timestamp: '2026-11-15T11:59:00.000Z',
    level: 'warn',
    tags: { addonId: 'cam-a', deviceId: '7' },
  },
  {
    timestamp: '2026-11-15T11:30:00.000Z',
    level: 'info',
    tags: { addonId: 'cam-a', deviceId: '7' },
  },
  {
    timestamp: '2026-11-15T10:00:00.000Z',
    level: 'info',
    tags: { addonId: 'cam-b', deviceId: '8' },
  },
]
  .map((o) => JSON.stringify(o))
  .join('\n')}\n`

async function realZip(text: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  const events = new EventEmitter()
  const sink: DownloadSink = {
    destroyed: false,
    writableLength: 0,
    write: (chunk) => {
      chunks.push(Buffer.from(chunk))
      return true
    },
    end: () => events.emit('ended'),
    destroy: () => undefined,
    on: (event, listener) => events.on(event, listener),
    off: (event, listener) => events.off(event, listener),
  }
  const zip = new ZipSink(sink, 'logs.ndjson', new Date())
  zip.write(Buffer.from(text, 'utf8'))
  zip.end()
  await new Promise<void>((resolve) => events.once('ended', resolve))
  return Buffer.concat(chunks)
}

describe('ZipSink output through the MCP reader', () => {
  let dir = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-roundtrip-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('summarises the lines inside the real archive', async () => {
    const file = path.join(dir, 'logs.zip')
    fs.writeFileSync(file, await realZip(NDJSON))
    const summary = await summarizeLogsExport(file, { zip: true })
    expect(summary).toMatchObject({ lines: 3, devices: { '7': 2, '8': 1 } })
  })

  it('fails, never hangs, when the archive data is cut short', async () => {
    const whole = await realZip(NDJSON)
    const eocd = whole.length - 22
    const directory = whole.readUInt32LE(eocd + 16)
    const dataStart = 30 + 'logs.ndjson'.length
    const half = whole.readUInt32LE(directory + 20) >> 1
    // Half of the compressed data, then a directory that says that is all there is.
    const central = Buffer.from(whole.subarray(directory, eocd))
    central.writeUInt32LE(half, 20)
    const end = Buffer.from(whole.subarray(eocd))
    end.writeUInt32LE(dataStart + half, 16)
    const file = path.join(dir, 'cut.zip')
    fs.writeFileSync(file, Buffer.concat([whole.subarray(0, dataStart + half), central, end]))
    await expect(summarizeLogsExport(file, { zip: true })).rejects.toThrow()
  })
})
