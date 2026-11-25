import { describe, expect, it, vi } from 'vitest'
import { AmcrestCamera } from '../amcrest-camera.js'
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
    // Level is never in a Dahua Encode table: null, and not reported as missing.
    expect(facts.missing).toEqual([])
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

interface LoggedLine {
  readonly msg: string
  readonly opts: { tags?: unknown; meta?: Record<string, unknown> } | undefined
}

/** Drive the real `buildStreamCatalog` with a fake client, borrowing the prototype methods it uses. */
async function buildCatalog(getEncodeConfig: () => Promise<Map<string, string>>) {
  const info: LoggedLine[] = []
  const warn: LoggedLine[] = []
  const log = (into: LoggedLine[]) => (msg: string, opts?: LoggedLine['opts']) => {
    into.push({ msg, opts })
  }
  const subject = {
    id: 108,
    channel: 1,
    config: { get: (k: string) => (k === 'host' ? '192.0.2.10' : 'x') },
    published: new Map<string, unknown>(),
    ctx: { logger: { info: log(info), warn: log(warn), debug: vi.fn() } },
    ensureClient: () => ({ getEncodeConfig }),
    buildRtspUrl: (subtype: 0 | 1) =>
      AmcrestCamera.prototype['buildRtspUrl'].call(subject, subtype),
  }
  const catalog = await AmcrestCamera.prototype['buildStreamCatalog'].call(subject)
  return { catalog, info, warn }
}

describe('amcrest stream catalog logging (behavioural)', () => {
  it('logs one info line with every fact read per stream, tagged with the deviceId', async () => {
    const table = new Map<string, string>([
      ['MainFormat[0].Video.Compression', 'H.265'],
      ['MainFormat[0].Video.Profile', 'Main'],
      ['MainFormat[0].Video.Width', '2560'],
      ['MainFormat[0].Video.Height', '1440'],
      ['MainFormat[0].Video.FPS', '20'],
      ['MainFormat[0].Video.GOP', '40'],
      ['MainFormat[0].Video.BitRate', '4096'],
      ['ExtraFormat[0].Video.Compression', 'H.264'],
    ])
    const { catalog, info, warn } = await buildCatalog(async () => table)

    expect(warn).toEqual([])
    expect(info).toHaveLength(1)
    expect(info[0]?.opts?.tags).toEqual({ deviceId: 108 })
    const meta = info[0]?.opts?.meta as {
      main: { codecRaw: string; profile: string; gop: number; fps: number; missing: string[] }
      sub: { codecRaw: string; missing: string[] }
    }
    expect(meta.main).toMatchObject({
      codecRaw: 'H.265',
      profile: 'Main',
      gop: 40,
      fps: 20,
      missing: [],
    })
    expect(meta.sub.codecRaw).toBe('H.264')
    expect(meta.sub.missing.some((m) => m.startsWith('gop:'))).toBe(true)
    expect(catalog[0]).toMatchObject({ codec: 'h265', fps: 20 })
  })

  it('warns with the reason when the Encode read fails, URLs still served', async () => {
    const { catalog, info, warn } = await buildCatalog(async () => {
      throw new Error('digest auth 401')
    })

    expect(info).toEqual([])
    expect(warn).toHaveLength(1)
    expect(warn[0]?.opts?.tags).toEqual({ deviceId: 108 })
    expect(warn[0]?.opts?.meta).toEqual({ reason: 'digest auth 401' })
    expect(catalog.map((d) => d.camStreamId)).toEqual(['main', 'sub'])
    expect(catalog[0]?.codec).toBeUndefined()
  })
})
