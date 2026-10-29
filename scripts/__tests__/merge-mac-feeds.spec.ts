import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no declaration file
import { feedArches, mergeFeeds, missingArches } from '../ci/merge-mac-feeds.mjs'

/** Each mac leg writes a feed that lists only its own arch (electron-builder). */
function feed(arch: string, opts: { version?: string } = {}): string {
  const v = opts.version ?? '0.1.1'
  return [
    `version: ${v}`,
    'files:',
    `  - url: CamStack-${v}-${arch}.zip`,
    `    sha512: zip-${arch}`,
    '    size: 100',
    `  - url: CamStack-${v}-${arch}.dmg`,
    `    sha512: dmg-${arch}`,
    '    size: 200',
    `path: CamStack-${v}-${arch}.zip`,
    `sha512: zip-${arch}`,
    `releaseDate: '2026-10-29T10:00:00.000Z'`,
    '',
  ].join('\n')
}

const urls = (text: string): string[] => [...text.matchAll(/url:\s*([^\s,}]+)/g)].map((m) => m[1])

describe('merge-mac-feeds', () => {
  it('two single-arch feeds merge into four files, header from the first leg', () => {
    const merged: string = mergeFeeds([feed('x64'), feed('arm64')])
    expect(urls(merged)).toEqual([
      'CamStack-0.1.1-x64.zip',
      'CamStack-0.1.1-x64.dmg',
      'CamStack-0.1.1-arm64.zip',
      'CamStack-0.1.1-arm64.dmg',
    ])
    expect(merged).toContain('path: CamStack-0.1.1-x64.zip')
    expect(merged).toContain('sha512: zip-x64\nreleaseDate')
    expect(merged.match(/^path:/gm)).toHaveLength(1)
    expect([...feedArches(merged)].sort()).toEqual(['arm64', 'x64'])
  })

  it('deduplicates an identical url', () => {
    const merged: string = mergeFeeds([feed('x64'), feed('x64'), feed('arm64')])
    expect(urls(merged)).toHaveLength(4)
  })

  it('passes a single feed through unchanged', () => {
    const one = feed('arm64')
    expect(mergeFeeds([one])).toBe(one)
  })

  it('refuses mismatched versions', () => {
    expect(() => mergeFeeds([feed('x64'), feed('arm64', { version: '0.1.2' })])).toThrow(/version/i)
  })

  it('reads flow-style items of a hand-repaired feed', () => {
    const repaired =
      'version: 0.1.1\nfiles:\n  - {url: CamStack-0.1.1-x64.zip, sha512: a, size: 1}\npath: CamStack-0.1.1-x64.zip\nsha512: a\n'
    expect(mergeFeeds([repaired, feed('arm64')])).toContain('{url: CamStack-0.1.1-x64.zip')
  })

  it('reports an expected arch the feed lacks', () => {
    expect(missingArches(feed('x64'), ['x64', 'arm64'])).toEqual(['arm64'])
    expect(missingArches(mergeFeeds([feed('x64'), feed('arm64')]), ['x64', 'arm64'])).toEqual([])
  })
})
