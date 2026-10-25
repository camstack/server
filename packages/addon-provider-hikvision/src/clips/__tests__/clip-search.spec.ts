/**
 * `ContentMgmt/search`, against the camera's OWN answers.
 *
 * Both fixtures are verbatim bodies from 1436 on 2026-09-22 — the empty one
 * from a window in 2020, the populated one from a 48-hour window with
 * `maxResults: 6`. Nothing here is hand-written XML, because two of the three
 * rules this parser exists for are things the hardware does that its own
 * specification says it does not.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildClipSearchBody, clipSearchIsComplete, parseClipSearchPage } from '../clip-search.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const noMatches = readFileSync(join(FIXTURES, 'search-no-matches.xml'), 'utf8')
const page = readFileSync(join(FIXTURES, 'search-page-more.xml'), 'utf8')

describe('parseClipSearchPage', () => {
  it('reads NO MATCHES as an empty answer, although responseStatus says true', () => {
    // The specification and every OSS client say `responseStatus` is `false`
    // here. This camera says `true`. A parser written to the documentation
    // turns a genuinely empty day into a failure.
    expect(noMatches).toContain('<responseStatus>true</responseStatus>')
    expect(noMatches).toContain('<responseStatusStrg>NO MATCHES</responseStatusStrg>')
    const parsed = parseClipSearchPage(noMatches)
    expect(parsed.status).toBe('no-matches')
    expect(parsed.items).toEqual([])
    expect(parsed.pageSize).toBe(0)
    expect(clipSearchIsComplete(parsed)).toBe(true)
  })

  it('treats the empty <matchList> as real, not as a body it could not read', () => {
    expect(noMatches).toMatch(/<matchList>\s*<\/matchList>/)
    expect(parseClipSearchPage(noMatches).status).not.toBe('unknown')
  })

  it('reads numOfMatches as THIS page and MORE as "ask again"', () => {
    const parsed = parseClipSearchPage(page)
    // Asked for 6; the camera answered 6 and said MORE. A caller that read
    // this as a total would answer with the OLDEST six rows and nothing since.
    expect(parsed.pageSize).toBe(6)
    expect(parsed.items).toHaveLength(6)
    expect(parsed.status).toBe('more')
    expect(clipSearchIsComplete(parsed)).toBe(false)
  })

  it('answers oldest-first, exactly as the camera ordered them', () => {
    const starts = parseClipSearchPage(page).items.map((item) => item.startMs)
    expect(starts).toEqual([...starts].toSorted((a, b) => a - b))
  })

  it('takes the playback handle whole, with its name and its size', () => {
    const first = parseClipSearchPage(page).items[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    expect(first.playbackPath.startsWith('/Streaming/tracks/101/?starttime=')).toBe(true)
    // `&amp;` in the XML is `&` on the wire — a handle that kept the entity
    // addresses no recording at all.
    expect(first.playbackPath).toContain('&endtime=')
    expect(first.playbackPath).not.toContain('&amp;')
    expect(first.fileName).toMatch(/^ch\d+_\d+$/)
    expect(first.sizeBytes).toBeGreaterThan(0)
    expect(first.trackId).toBe(101)
  })

  it('keeps what the camera CLAIMED the codec is, and nothing decodes from it', () => {
    const first = parseClipSearchPage(page).items[0]
    // Measured: the SDP of the very same media says H265/90000, the RTP
    // payloads carry a VPS, and ffprobe says hevc. The claim is carried so it
    // can be disbelieved, never so it can be used.
    expect(first?.declaredCodec).toBe('H.264-BP')
  })

  it('carries the camera’s own record types, unmapped', () => {
    const types = parseClipSearchPage(page).items.flatMap((item) => item.recordTypes)
    expect(types.length).toBeGreaterThan(0)
    expect(types).toContain('motion')
  })

  it('answers `unknown` for a body it could not read, never an empty page', () => {
    // "the camera said nothing we understand" and "the camera has nothing"
    // are different facts, and only one of them may be shown as an empty day.
    const parsed = parseClipSearchPage('<html>404 not found</html>')
    expect(parsed.status).toBe('unknown')
    expect(parsed.items).toEqual([])
  })
})

describe('buildClipSearchBody', () => {
  it('sends the vendor’s own misspelling of the cursor', () => {
    const body = buildClipSearchBody({
      searchId: '{ABC}',
      trackId: 101,
      sinceMs: Date.UTC(2026, 8, 21, 18, 33, 21),
      untilMs: Date.UTC(2026, 8, 22, 18, 33, 21),
      maxResults: 40,
      position: 80,
    })
    expect(body).toContain('<searchResultPostion>80</searchResultPostion>')
    expect(body).toContain('<trackID>101</trackID>')
    // UTC, seconds, no milliseconds — the shape the camera answers with.
    expect(body).toContain('<startTime>2026-09-21T18:33:21Z</startTime>')
    expect(body).toContain('<endTime>2026-09-22T18:33:21Z</endTime>')
  })
})
