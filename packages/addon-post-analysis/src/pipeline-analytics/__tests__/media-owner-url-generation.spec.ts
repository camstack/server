/**
 * mediaOwnerUrl mints the generation suffix for event owners (D694).
 *
 * Bare `/o/<type>/<id>` still means "current holder"; new emitters that know
 * the event's camera and timestamp MUST pass generation so a reused rowid
 * cannot resolve another record's crop.
 */
import { describe, expect, it } from 'vitest'
import { mediaFileUrl, mediaOwnerUrl } from '../media-file-url.js'

const PREFIX = '/addon/pipeline-analytics/event-media'

describe('mediaOwnerUrl (D694 generation)', () => {
  it('mints a bare owner path when generation is omitted', () => {
    expect(mediaOwnerUrl(PREFIX, 'object', '101314')).toBe(`${PREFIX}/o/object/101314`)
    expect(mediaOwnerUrl(PREFIX, 'track', 'abc-uuid')).toBe(`${PREFIX}/o/track/abc-uuid`)
  })

  it('appends /g/<deviceId>/<recordAt> for an event owner', () => {
    expect(
      mediaOwnerUrl(PREFIX, 'object', '101314', { deviceId: 104, recordAt: 1_727_800_000_000 }),
    ).toBe(`${PREFIX}/o/object/101314/g/104/1727800000000`)
    expect(mediaOwnerUrl(PREFIX, 'motion', '7', { deviceId: 1, recordAt: 9 })).toBe(
      `${PREFIX}/o/motion/7/g/1/9`,
    )
    expect(mediaOwnerUrl(PREFIX, 'audio', '3', { deviceId: 101, recordAt: 100 })).toBe(
      `${PREFIX}/o/audio/3/g/101/100`,
    )
  })

  it('ignores generation on a non-event owner — a track id is random', () => {
    expect(mediaOwnerUrl(PREFIX, 'track', 'abc-uuid', { deviceId: 104, recordAt: 1 })).toBe(
      `${PREFIX}/o/track/abc-uuid`,
    )
  })

  it('encodes the owner id so a slash cannot re-cut the path', () => {
    expect(mediaOwnerUrl(PREFIX, 'mosaic', 'a/b')).toBe(`${PREFIX}/o/mosaic/a%2Fb`)
  })

  it('keeps media-row addresses on /m/<id>', () => {
    expect(mediaFileUrl(PREFIX, 7701)).toBe(`${PREFIX}/m/7701`)
  })
})
