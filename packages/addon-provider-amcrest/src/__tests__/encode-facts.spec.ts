import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readEncodeFacts } from '../encode-facts.js'

const P = 'MainFormat[0]'

function table(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries).map(([k, v]) => [`${P}.Video.${k}`, v]))
}

describe('readEncodeFacts — every stream fact as read, never defaulted (planning#727)', () => {
  it('reads codec, profile, resolution, fps, GOP and bitrate', () => {
    const facts = readEncodeFacts(
      table({
        Compression: 'H.265',
        Profile: 'Main',
        Width: '2560',
        Height: '1440',
        FPS: '20',
        GOP: '40',
        BitRate: '4096',
      }),
      P,
    )
    expect(facts).toMatchObject({
      codecRaw: 'H.265',
      profile: 'Main',
      width: 2560,
      height: 1440,
      fps: 20,
      gop: 40,
      bitrateKbps: 4096,
      level: null,
    })
    // Level is never in a Dahua Encode table: reported absent, with the reason.
    expect(facts.missing).toEqual([
      `level: ${P}.Video.Level absent or unparsable in the Encode table`,
    ])
  })

  it('names each fact the table did not carry, with the key, and never invents a value', () => {
    const facts = readEncodeFacts(table({ Compression: 'H.264', Width: 'abc' }), P)
    expect(facts.width).toBeNull()
    expect(facts.fps).toBeNull()
    expect(facts.gop).toBeNull()
    expect(facts.missing).toEqual(
      expect.arrayContaining([
        expect.stringContaining('width: MainFormat[0].Video.Width'),
        expect.stringContaining('gop: MainFormat[0].Video.GOP'),
        expect.stringContaining('bitrateKbps: MainFormat[0].Video.BitRate'),
      ]),
    )
  })
})

describe('amcrest stream catalog logging', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(resolve(here, '../amcrest-camera.ts'), 'utf8')
  const body = source.slice(source.indexOf('private async buildStreamCatalog'))

  it('logs the encode facts at info and a read failure at warn, both tagged with the deviceId', () => {
    expect(body).toMatch(
      /logger\.info\('amcrest: stream catalog encode facts',\s*\{\s*tags: \{ deviceId: this\.id \}/,
    )
    expect(body).toMatch(
      /logger\.warn\(\s*'amcrest: stream-catalog encode read failed[^']*',\s*\{\s*tags: \{ deviceId: this\.id \}/,
    )
    expect(body).not.toMatch(/logger\.debug\('amcrest: stream-catalog encode enrichment failed/)
  })
})
