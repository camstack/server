/**
 * A clip id is SELF-CONTAINED (D549 3): the source, the channel and the file
 * name travel inside it, so the thumbnail route, the playback route and the
 * collection dispatcher all resolve a clip without re-listing the camera.
 *
 * The dispatcher (D554 5) matches the LONGEST `source` that prefixes the id,
 * so `native:reolink:onboard` and `native:reolink:hub` must never be prefixes
 * of each other — that is asserted here rather than assumed.
 */
import { describe, expect, it } from 'vitest'
import {
  CLIP_SOURCE_ONBOARD,
  clipKeyFor,
  mintClipId,
  parseClipId,
  REOLINK_CLIP_SOURCES,
} from '../clips/clip-identity.js'

describe('clip identity', () => {
  it('round-trips a file name through the id', () => {
    const id = mintClipId({
      source: CLIP_SOURCE_ONBOARD,
      channel: 3,
      fileName:
        '/mnt/sda/U109527000HUBCHILD0-Camera N/RecS02_DST20260916_063000_063112_0_1E8480.mp4',
    })
    const parsed = parseClipId(id)
    expect(parsed).not.toBeNull()
    expect(parsed?.source).toBe(CLIP_SOURCE_ONBOARD)
    expect(parsed?.channel).toBe(3)
    expect(parsed?.fileName).toBe(
      '/mnt/sda/U109527000HUBCHILD0-Camera N/RecS02_DST20260916_063000_063112_0_1E8480.mp4',
    )
  })

  it('survives the characters a Reolink file name really carries', () => {
    // Slashes, spaces and a `+` all appear in the hub's `<Id>` paths; plain
    // base64 would hand `/` and `+` straight back into the URL path.
    const fileName = '/mnt/sda/U10X-Living room/Rec+S02_DST/20260916 063000.mp4'
    const id = mintClipId({ source: CLIP_SOURCE_ONBOARD, channel: 0, fileName })
    expect(id).not.toContain('/')
    expect(id).not.toContain('+')
    expect(parseClipId(id)?.fileName).toBe(fileName)
  })

  it('refuses an id another provider minted', () => {
    expect(parseClipId('analytics:100:200:evt-7')).toBeNull()
    expect(parseClipId('hksv:101:1789000000-3')).toBeNull()
    expect(parseClipId('')).toBeNull()
  })

  it('refuses an id whose channel is not a number', () => {
    expect(parseClipId(`${CLIP_SOURCE_ONBOARD}:x:QQ`)).toBeNull()
  })

  it('names exactly ONE Reolink source', () => {
    // The operator collapsed `onboard` and `hub` into one after the
    // measurement showed they are two views of ONE store, not two stores.
    // A second row would be a choice of API the operator had to understand.
    expect(REOLINK_CLIP_SOURCES).toEqual([CLIP_SOURCE_ONBOARD])
  })

  it('stamps every id with its own source prefix', () => {
    for (const source of REOLINK_CLIP_SOURCES) {
      const id = mintClipId({ source, channel: 0, fileName: 'a.mp4' })
      expect(id.startsWith(`${source}:`)).toBe(true)
    }
  })

  it('still refuses an id minted under the retired hub source', () => {
    // `native:reolink:hub` ids were never persisted anywhere, but an id that
    // names a source this provider no longer serves must be refused loudly
    // rather than routed by prefix luck.
    const id = `native:reolink:hub:0:${Buffer.from('a.mp4').toString('base64url')}`
    expect(parseClipId(id)).toBeNull()
  })

  it('derives a stable, path-safe cache key from the channel and file name', () => {
    const key = clipKeyFor(0, '/mnt/sda/U10X/RecS02.mp4')
    expect(key).toMatch(/^[0-9a-f]{40}$/)
    expect(clipKeyFor(0, '/mnt/sda/U10X/RecS02.mp4')).toBe(key)
    expect(clipKeyFor(1, '/mnt/sda/U10X/RecS02.mp4')).not.toBe(key)
  })
})

describe('clip identity — the events view', () => {
  it('distinguishes two events of ONE recording', () => {
    // Nothing MINTS a windowed id since D565 — the events view is no longer
    // the catalog. The round trip is kept because an id handed out while it
    // WAS must still parse, and because the event feed will mint one again.
    // 1–13 event windows per file were measured. Both rows play the same
    // file, and both must still be distinct rows: the collection merges on
    // `(startMs, endMs, id)` and a surface keys on `id`.
    const fileName = '/mnt/sda/U10X-Camera N/RecS02_a.mp4'
    const a = mintClipId({
      source: CLIP_SOURCE_ONBOARD,
      channel: 0,
      fileName,
      window: { startMs: 10, endMs: 22 },
    })
    const b = mintClipId({
      source: CLIP_SOURCE_ONBOARD,
      channel: 0,
      fileName,
      window: { startMs: 40, endMs: 52 },
    })
    expect(a).not.toBe(b)
    expect(parseClipId(a)?.fileName).toBe(fileName)
    expect(parseClipId(b)?.fileName).toBe(fileName)
    expect(parseClipId(a)?.window).toEqual({ startMs: 10, endMs: 22 })
  })

  it('leaves a windowless id exactly as it was', () => {
    // Every `onboard` id already minted keeps its shape — the suffix is added,
    // never required.
    const id = mintClipId({ source: CLIP_SOURCE_ONBOARD, channel: 0, fileName: 'a.mp4' })
    expect(id.split(':')).toHaveLength(5)
    expect(parseClipId(id)?.window).toBeUndefined()
  })

  it('round-trips an event that has NO file', () => {
    const id = mintClipId({ source: CLIP_SOURCE_ONBOARD, channel: 0, fileName: 'event:10-22' })
    expect(parseClipId(id)?.fileName).toBe('event:10-22')
  })

  it('refuses a window that is not two numbers', () => {
    const id = `${CLIP_SOURCE_ONBOARD}:0:${Buffer.from('a.mp4').toString('base64url')}:notawindow`
    expect(parseClipId(id)).toBeNull()
  })
})
