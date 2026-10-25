/**
 * The tar writer is asserted against the SYSTEM `tar` binary, not against my
 * reading of the ustar spec. A hand-rolled format writer that only its own
 * parser can read is not a format writer — and the checksum rule (the checksum
 * field is summed as eight spaces) is exactly the kind of detail that produces
 * an archive which looks structurally fine and fails in the operator's hands.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitUstarName, tarBlocks, tarNameTooLong, tarTrailer } from '../tar-stream.js'

function buildArchive(files: readonly { name: string; body: Buffer }[]): Buffer {
  const parts: Buffer[] = []
  for (const f of files) parts.push(...tarBlocks({ ...f, mtimeMs: 1_700_000_000_000 }))
  parts.push(tarTrailer())
  return Buffer.concat(parts)
}

describe('tar-stream — the system tar binary can read what we write', () => {
  it('lists every entry, with the names we gave them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camstack-tar-'))
    try {
      const archive = join(dir, 'out.tar')
      writeFileSync(
        archive,
        buildArchive([
          { name: 'manifest.json', body: Buffer.from('{"tracks":1}') },
          { name: 'tracks/101/abc-123/keyFrame.jpg', body: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
        ]),
      )

      const listing = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' })

      expect(listing.split('\n').filter(Boolean).toSorted()).toEqual([
        'manifest.json',
        'tracks/101/abc-123/keyFrame.jpg',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('extracts byte-identical contents — including a body that is not a block multiple', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camstack-tar-'))
    try {
      const archive = join(dir, 'out.tar')
      // 700 bytes: spans two blocks and needs padding, the case a naive writer
      // gets wrong and a 512-byte fixture would never catch.
      const body = Buffer.alloc(700, 0xab)
      writeFileSync(archive, buildArchive([{ name: 'tracks/101/t/keyFrame.jpg', body }]))

      execFileSync('tar', ['-xf', archive, '-C', dir])

      const out = readFileSync(join(dir, 'tracks/101/t/keyFrame.jpg'))
      expect(out.length).toBe(700)
      expect(out.equals(body)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('round-trips an empty file rather than emitting a malformed entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camstack-tar-'))
    try {
      const archive = join(dir, 'out.tar')
      writeFileSync(archive, buildArchive([{ name: 'empty.json', body: Buffer.alloc(0) }]))

      execFileSync('tar', ['-xf', archive, '-C', dir])

      expect(readFileSync(join(dir, 'empty.json')).length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes a long path through the ustar prefix split', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camstack-tar-'))
    try {
      const deep = `tracks/101/${'a'.repeat(60)}/${'b'.repeat(60)}/keyFrame.jpg`
      expect(deep.length).toBeGreaterThan(100)
      const archive = join(dir, 'out.tar')
      writeFileSync(archive, buildArchive([{ name: deep, body: Buffer.from('x') }]))

      const listing = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' })

      expect(listing.trim()).toBe(deep)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tar-stream — name representability is reported, never truncated', () => {
  it('accepts a name that fits the 100-byte field whole', () => {
    expect(splitUstarName('manifest.json')).toEqual({ prefix: '', name: 'manifest.json' })
  })

  it('splits on a separator, keeping the tail inside the name field', () => {
    const name = `tracks/101/${'a'.repeat(120)}/keyFrame.jpg`
    const split = splitUstarName(name)
    expect(split).not.toBeNull()
    expect(`${split?.prefix}/${split?.name}`).toBe(name)
  })

  it('reports a path with no representable split instead of silently truncating', () => {
    // One 300-character segment: no separator can make both halves fit.
    expect(tarNameTooLong(`tracks/${'a'.repeat(300)}.jpg`)).toBe(true)
  })
})
