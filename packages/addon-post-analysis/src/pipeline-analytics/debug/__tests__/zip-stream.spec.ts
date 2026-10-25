/**
 * The ZIP writer is asserted against the SYSTEM `unzip` binary, not against my
 * reading of APPNOTE. A hand-rolled format writer that only its own parser can
 * read is not a format writer — and the central-directory offsets are exactly
 * the kind of detail that produces an archive which looks structurally fine and
 * fails in the operator's hands.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  crc32,
  toAsciiZipName,
  ZIP_MAX_BYTES,
  ZIP_MAX_ENTRIES,
  ZipStreamWriter,
  zipEntryFits,
} from '../zip-stream.js'

const MTIME = 1_700_000_000_000

async function buildArchive(files: readonly { name: string; body: Buffer }[]): Promise<Buffer> {
  const parts: Buffer[] = []
  const writer = new ZipStreamWriter(async (chunk) => {
    parts.push(chunk)
  })
  for (const f of files) await writer.add({ ...f, mtimeMs: MTIME })
  await writer.finish()
  return Buffer.concat(parts)
}

describe('zip-stream — the system unzip binary can read what we write', () => {
  it('lists every entry, with the names we gave them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camstack-zip-'))
    try {
      const archive = join(dir, 'out.zip')
      writeFileSync(
        archive,
        await buildArchive([
          { name: 'manifest.json', body: Buffer.from('{"tracks":1}') },
          { name: 'tracks/101/abc-123/keyFrame.jpg', body: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
        ]),
      )

      const listing = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })

      expect(listing.split('\n').filter(Boolean).toSorted()).toEqual([
        'manifest.json',
        'tracks/101/abc-123/keyFrame.jpg',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('extracts byte-identical contents, and unzip -t reports no CRC error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camstack-zip-'))
    try {
      const archive = join(dir, 'out.zip')
      // 700 bytes of a repeating pattern: a body that is not a round size, and
      // whose CRC a naive table would still get right only by luck.
      const body = Buffer.from(Array.from({ length: 700 }, (_, i) => (i * 7) % 251))
      const text = Buffer.from('a debug track that produced nothing\n', 'utf8')
      writeFileSync(
        archive,
        await buildArchive([
          { name: 'tracks/101/t/keyFrame.jpg', body },
          { name: 'tracks/101/t/notes.txt', body: text },
        ]),
      )

      // -t verifies every CRC. A wrong checksum fails HERE and nowhere else.
      const verify = execFileSync('unzip', ['-t', archive], { encoding: 'utf8' })
      expect(verify).toContain('No errors detected')

      execFileSync('unzip', ['-q', archive, '-d', dir])
      const out = readFileSync(join(dir, 'tracks/101/t/keyFrame.jpg'))
      expect(out.length).toBe(700)
      expect(out.equals(body)).toBe(true)
      expect(readFileSync(join(dir, 'tracks/101/t/notes.txt')).equals(text)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('emits the canonical 22-byte empty archive — the case of zero debug tracks', async () => {
    // Info-ZIP exits non-zero on an empty archive ("Empty zipfile"), which says
    // nothing about validity — so the assertion is the bytes themselves. This is
    // the ONE archive whose exact encoding is fully specified.
    const empty = await buildArchive([])
    expect(empty.length).toBe(22)
    expect(empty.toString('hex')).toBe('504b0506' + '00'.repeat(18))
  })

  it('folds a non-ASCII name to the ASCII one unzip actually produces', async () => {
    // Measured, not assumed: macOS ships Info-ZIP 6.00, which IGNORES the UTF-8
    // flag and re-encodes from CP437 — `persona-è` extracts as `persona-+¿`, and
    // on some names it refuses to create the file at all. So names are folded to
    // ASCII before they are written, and this pins that the folded name is what
    // lands on disk. Free text never enters a path anyway: the camera name is a
    // field of track.json.
    const dir = mkdtempSync(join(tmpdir(), 'camstack-zip-'))
    try {
      const archive = join(dir, 'utf8.zip')
      writeFileSync(
        archive,
        await buildArchive([{ name: 'tracks/101/t/persona-è.txt', body: Buffer.from('x') }]),
      )
      const listing = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
      expect(listing.trim()).toBe('tracks/101/t/persona-_.txt')

      execFileSync('unzip', ['-q', archive, '-d', join(dir, 'out')])
      expect(readdirSync(join(dir, 'out/tracks/101/t'))).toEqual(['persona-_.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('toAsciiZipName', () => {
  it('keeps a path the archive can already represent untouched', () => {
    expect(toAsciiZipName('tracks/101/a1b2-c3/keyFrame.jpg')).toBe(
      'tracks/101/a1b2-c3/keyFrame.jpg',
    )
  })

  it('replaces every byte outside the safe set, one for one', () => {
    expect(toAsciiZipName('a b/è.txt')).toBe('a_b/_.txt')
  })
})

describe('zip-stream — the ceilings it refuses to cross', () => {
  it('computes the CRC-32 the format specifies', () => {
    // The canonical IEEE check value for "123456789".
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })

  it('refuses an entry that would push the archive past the 32-bit ceiling', () => {
    const base = { offset: 0, entryIndex: 0, name: 'big.bin' }
    expect(zipEntryFits({ ...base, bodyLength: ZIP_MAX_BYTES })).toBe(false)
    // The exact boundary: header (30) + name (7) + body must be <= the ceiling.
    expect(zipEntryFits({ ...base, bodyLength: ZIP_MAX_BYTES - 37 })).toBe(true)
    expect(zipEntryFits({ ...base, bodyLength: ZIP_MAX_BYTES - 36 })).toBe(false)
  })

  it('refuses entry 65 536 — the central directory counts entries in 16 bits', () => {
    const base = { offset: 0, name: 'a.txt', bodyLength: 1 }
    expect(zipEntryFits({ ...base, entryIndex: ZIP_MAX_ENTRIES - 1 })).toBe(true)
    expect(zipEntryFits({ ...base, entryIndex: ZIP_MAX_ENTRIES })).toBe(false)
  })

  it('counts only the entries it accepted, and tracks the bytes it emitted', async () => {
    const chunks: Buffer[] = []
    const writer = new ZipStreamWriter(async (c) => {
      chunks.push(c)
    })
    await writer.add({ name: 'a.txt', body: Buffer.from('hello'), mtimeMs: MTIME })
    expect(writer.entryCount).toBe(1)
    // 30-byte header + 5-byte name + 5-byte body.
    expect(writer.bytesWritten).toBe(40)
    expect(Buffer.concat(chunks).length).toBe(40)
  })

  it('reports the entries it accepted, not the ones it was offered', async () => {
    const writer = new ZipStreamWriter(async () => {})
    expect(await writer.add({ name: 'a.txt', body: Buffer.from('a'), mtimeMs: MTIME })).toBe(true)
    expect(writer.entryCount).toBe(1)
  })
})
