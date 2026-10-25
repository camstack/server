import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractZipArchive } from '../zip-extract.js'
import { buildZip } from './zip-fixture.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camstack-zip-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function extract(zip: Buffer): string {
  const archive = join(dir, 'a.zip')
  writeFileSync(archive, zip)
  const out = join(dir, 'out')
  extractZipArchive(archive, out)
  return out
}

describe('extractZipArchive', () => {
  it('extracts stored and deflated entries, directories included', () => {
    const big = Buffer.from('python '.repeat(5000))
    const out = extract(
      buildZip([
        { name: 'python-headless/' },
        { name: 'python-headless/bin/' },
        { name: 'python-headless/bin/python.exe', data: Buffer.from('MZ') },
        { name: 'python-headless/Lib/site.py', data: big, deflate: true },
      ]),
    )
    expect(readFileSync(join(out, 'python-headless/bin/python.exe'), 'utf8')).toBe('MZ')
    expect(readFileSync(join(out, 'python-headless/Lib/site.py')).equals(big)).toBe(true)
  })

  it('reads a flat archive (the ffmpeg build is two exes at the root)', () => {
    const out = extract(buildZip([{ name: 'ffmpeg.exe', data: Buffer.from('x') }]))
    expect(existsSync(join(out, 'ffmpeg.exe'))).toBe(true)
  })

  it('refuses an entry that climbs out of the target directory, writing nothing', () => {
    expect(() =>
      extract(buildZip([{ name: '..\\..\\evil.dll', data: Buffer.from('boom') }])),
    ).toThrow(/escapes the target/)
    expect(existsSync(join(dir, 'evil.dll'))).toBe(false)
  })

  it('refuses an absolute entry name', () => {
    expect(() => extract(buildZip([{ name: '/etc/evil', data: Buffer.from('x') }]))).toThrow(
      /escapes the target/,
    )
  })

  it('refuses an entry whose bytes do not match the recorded CRC', () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('hello') }])
    const dataAt = 30 + 'a.txt'.length
    zip[dataAt] = (zip[dataAt] ?? 0) ^ 0xff
    expect(() => extract(zip)).toThrow(/size\/CRC/)
  })

  it('says it is not a zip when it is not one', () => {
    expect(() => extract(Buffer.from('definitely not a zip archive at all'))).toThrow(/not a zip/)
  })
})
