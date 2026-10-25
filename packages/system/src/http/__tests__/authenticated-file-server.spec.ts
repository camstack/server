import { describe, it, expect } from 'vitest'
import {
  parseTokenizedUrl,
  resolveFilePath,
  contentTypeFor,
  parseRangeHeader,
} from '../authenticated-file-server.js'

describe('parseTokenizedUrl', () => {
  it('splits <prefix><token>/<rel> into token + rel', () => {
    expect(parseTokenizedUrl('/rec/', '/rec/tok123/7/master.m3u8')).toEqual({
      token: 'tok123',
      rel: '7/master.m3u8',
    })
    expect(
      parseTokenizedUrl('/rec/', '/rec/tok123/7/low/continuous/2026/06/10/16/123-4000.m4s'),
    ).toEqual({ token: 'tok123', rel: '7/low/continuous/2026/06/10/16/123-4000.m4s' })
  })

  it('url-decodes the rel path', () => {
    expect(parseTokenizedUrl('/rec/', '/rec/tok/7/low%2Em3u8')).toEqual({
      token: 'tok',
      rel: '7/low.m3u8',
    })
  })

  it('honours a different prefix', () => {
    expect(parseTokenizedUrl('/scrub/', '/scrub/tok/9/frames.idx')).toEqual({
      token: 'tok',
      rel: '9/frames.idx',
    })
    expect(parseTokenizedUrl('/scrub/', '/rec/tok/9/x')).toBeNull()
  })

  it('rejects urls outside the prefix or missing token/rel', () => {
    expect(parseTokenizedUrl('/rec/', '/etc/passwd')).toBeNull()
    expect(parseTokenizedUrl('/rec/', '/rec/onlytoken')).toBeNull()
    expect(parseTokenizedUrl('/rec/', '/rec/tok/')).toBeNull()
  })
})

describe('resolveFilePath', () => {
  const roots = ['/data/recordings']

  it('resolves a rel path to a candidate per root', () => {
    expect(resolveFilePath(roots, '7/master.m3u8')).toEqual({
      candidates: ['/data/recordings/7/master.m3u8'],
    })
    expect(resolveFilePath(['/a/rec', '/b/rec'], '7/x.m4s')).toEqual({
      candidates: ['/a/rec/7/x.m4s', '/b/rec/7/x.m4s'],
    })
  })

  it('rejects a path that escapes every root (traversal)', () => {
    expect(resolveFilePath(roots, '../../etc/passwd')).toEqual({ error: 'forbidden' })
    expect(resolveFilePath(roots, '7/../../../secret')).toEqual({ error: 'forbidden' })
    expect(resolveFilePath(['/a', '/b'], '7/x.m4s')).toEqual({
      candidates: ['/a/7/x.m4s', '/b/7/x.m4s'],
    })
  })

  it('rejects an empty rel path', () => {
    expect(resolveFilePath(roots, '')).toEqual({ error: 'forbidden' })
  })
})

describe('contentTypeFor', () => {
  it('maps media file extensions, with overrides', () => {
    expect(contentTypeFor('/x/master.m3u8')).toBe('application/vnd.apple.mpegurl')
    expect(contentTypeFor('/x/123-4000.m4s')).toBe('video/mp4')
    expect(contentTypeFor('/x/init.mp4')).toBe('video/mp4')
    expect(contentTypeFor('/x/frames.idx')).toBe('application/octet-stream')
    expect(contentTypeFor('/x/whatever.bin')).toBe('application/octet-stream')
    expect(contentTypeFor('/x/a.json', { '.json': 'application/json' })).toBe('application/json')
  })
})

describe('parseRangeHeader', () => {
  it('parses bounded / open / suffix ranges', () => {
    expect(parseRangeHeader('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 })
    expect(parseRangeHeader('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRangeHeader('bytes=-200', 1000)).toEqual({ start: 800, end: 999 })
  })
  it('returns null for missing/invalid/unsatisfiable ranges', () => {
    expect(parseRangeHeader(undefined, 1000)).toBeNull()
    expect(parseRangeHeader('bytes=abc', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=2000-3000', 1000)).toBeNull()
  })
})
