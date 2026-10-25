/**
 * The `event-media` plane path says WHAT it names, or it is refused (D482).
 *
 * The plane used to accept a bare id and work out what it was: a `:` in it
 * meant a MediaStore composite key, anything else meant an event id, and an
 * event id meant "probe motion, then object, then audio". Three guesses in one
 * path segment, and every one of them became wrong in turn:
 *
 *  - D474 made event ids numeric, so a bare number could be a media row's id
 *    OR an event id, with nothing to tell them apart;
 *  - D474 also made those ids per-table, so an event id named up to three
 *    rows and the probe picked whichever table answered first — measured on
 *    the live hub, 299 883 of 300 559 event-owned media rows are `motion`, so
 *    the probe answered `motion` every time an object id had a namesake.
 *
 * Two forms now, and both are explicit:
 *
 *     /m/<mediaId>                — one media row, by its own id
 *     /o/<ownerType>/<ownerId>    — the best media OF an owner
 *
 * The tests below are mostly about what is REFUSED. A parser that is merely
 * permissive re-opens the guessing: the value of this record is that an
 * ambiguous path 404s instead of rendering a picture from another night.
 */
import { describe, expect, it } from 'vitest'
import { eventMediaEtag, parseMediaAddress } from '../event-media-handler.js'

describe('the event-media plane address', () => {
  describe('the media-row form', () => {
    it('reads /m/<digits> as one media row', () => {
      expect(parseMediaAddress('/m/12345')).toEqual({ kind: 'row', mediaId: 12345 })
    })

    it('tolerates a leading slash or none', () => {
      expect(parseMediaAddress('m/7')).toEqual({ kind: 'row', mediaId: 7 })
      expect(parseMediaAddress('///m/7')).toEqual({ kind: 'row', mediaId: 7 })
    })

    it('refuses a NON-numeric media id rather than coercing it', () => {
      // `Number('')` and `Number(' ')` are both 0, and `/m/0` would be a
      // request for a row that cannot exist — a rowid starts at 1.
      for (const path of ['/m/', '/m/abc', '/m/ 1', '/m/1.5', '/m/-1', '/m/1e3']) {
        expect(parseMediaAddress(path), path).toBeNull()
      }
    })

    it('refuses a media id with anything after it', () => {
      expect(parseMediaAddress('/m/12/34')).toBeNull()
    })
  })

  describe('the owner form', () => {
    it('reads /o/<ownerType>/<ownerId>', () => {
      expect(parseMediaAddress('/o/object/101314')).toEqual({
        kind: 'owner',
        ownerType: 'object',
        ownerId: '101314',
      })
      expect(parseMediaAddress('/o/track/5f2b1c90-1111-4222-8333-444455556666')).toEqual({
        kind: 'owner',
        ownerType: 'track',
        ownerId: '5f2b1c90-1111-4222-8333-444455556666',
      })
    })

    it('reads an event-owner GENERATION suffix (D694)', () => {
      // Bare `/o/object/<id>` means "current holder"; the `/g/` form names
      // the camera and the event's own timestamp so a reused rowid cannot
      // serve another record's crop.
      expect(parseMediaAddress('/o/object/101314/g/104/1727800000000')).toEqual({
        kind: 'owner',
        ownerType: 'object',
        ownerId: '101314',
        generation: { deviceId: 104, recordAt: 1_727_800_000_000 },
      })
      expect(parseMediaAddress('/o/motion/7/g/1/9')).toEqual({
        kind: 'owner',
        ownerType: 'motion',
        ownerId: '7',
        generation: { deviceId: 1, recordAt: 9 },
      })
      expect(parseMediaAddress('/o/audio/3/g/101/100')).toEqual({
        kind: 'owner',
        ownerType: 'audio',
        ownerId: '3',
        generation: { deviceId: 101, recordAt: 100 },
      })
    })

    it('refuses a malformed generation suffix rather than swallowing it into the id', () => {
      // Event owner ids are decimal rowids. A trailing `/g/…` that is not
      // two digit runs would otherwise become part of the "whole remainder"
      // and silently address a different owner.
      for (const path of [
        '/o/object/101314/g/104',
        '/o/object/101314/g/104/abc',
        '/o/object/101314/g/x/1',
        '/o/object/101314/g/',
        '/o/object/not-digits/g/1/2',
      ]) {
        expect(parseMediaAddress(path), path).toBeNull()
      }
    })

    it('does NOT treat /g/ as generation on a non-event owner', () => {
      // A mosaic / track / face id may contain slashes; `/g/` there is part of
      // the owner id, not a generation (event tables only).
      expect(parseMediaAddress('/o/mosaic/a/g/1/2')).toEqual({
        kind: 'owner',
        ownerType: 'mosaic',
        ownerId: 'a/g/1/2',
      })
      expect(parseMediaAddress('/o/track/5f2b1c90-1111-4222-8333-444455556666/g/1/2')).toEqual({
        kind: 'owner',
        ownerType: 'track',
        ownerId: '5f2b1c90-1111-4222-8333-444455556666/g/1/2',
      })
    })

    it('keeps motion and object apart — the same number, two owners', () => {
      const motion = parseMediaAddress('/o/motion/101314')
      const object = parseMediaAddress('/o/object/101314')
      expect(motion).not.toEqual(object)
    })

    it('refuses an owner type the store does not declare', () => {
      // `event` in particular: it named three tables at once and was retired
      // by D476. A path that still asks for it must 404, not fall back.
      for (const path of ['/o/event/5', '/o/ghost/5', '/o/Track/5', '/o//5']) {
        expect(parseMediaAddress(path), path).toBeNull()
      }
    })

    it('refuses an owner type with no id', () => {
      expect(parseMediaAddress('/o/track')).toBeNull()
      expect(parseMediaAddress('/o/track/')).toBeNull()
    })

    it('takes the WHOLE remainder as the owner id', () => {
      // The hub's wildcard param is percent-decoded before the sub-path is
      // proxied, so a `%2F` inside an owner id arrives here as a real slash.
      // Re-cutting on it would silently address a different owner.
      expect(parseMediaAddress('/o/mosaic/rule-7-1788363763546')).toEqual({
        kind: 'owner',
        ownerType: 'mosaic',
        ownerId: 'rule-7-1788363763546',
      })
      expect(parseMediaAddress('/o/mosaic/a/b')).toEqual({
        kind: 'owner',
        ownerType: 'mosaic',
        ownerId: 'a/b',
      })
    })
  })

  describe('what is gone', () => {
    it('refuses a BARE id — the form that could not say what it named', () => {
      for (const path of ['/101314', '101314', '/5f2b1c90-1111-4222-8333-444455556666']) {
        expect(parseMediaAddress(path), path).toBeNull()
      }
    })

    it('refuses a legacy COMPOSITE key', () => {
      // The codec can still READ one (`parseMediaOwnerKey`) for as long as a
      // stored column carries one, but the plane no longer serves from it:
      // the key embedded the owner, which is the whole defect.
      for (const path of [
        '/motion:101314:snapshot:1788363763546',
        '/track:abc:keyFrame',
        '/m/motion:101314:snapshot',
      ]) {
        expect(parseMediaAddress(path), path).toBeNull()
      }
    })

    it('refuses an empty path', () => {
      expect(parseMediaAddress('')).toBeNull()
      expect(parseMediaAddress('/')).toBeNull()
    })
  })

  describe('the cache identity', () => {
    it('is the row id for the stored blob', () => {
      expect(eventMediaEtag({ bytes: new Uint8Array(), mediaId: 12345, kind: 'thumbnail' })).toBe(
        '"12345"',
      )
    })

    it('DIFFERS for a rendered variant of the same row', () => {
      const stored = eventMediaEtag({
        bytes: new Uint8Array(),
        mediaId: 12345,
        kind: 'keyFrame',
      })
      const thumb = eventMediaEtag({
        bytes: new Uint8Array(),
        mediaId: 12345,
        kind: 'keyFrame',
        variant: { kind: 'thumb', size: 160 },
      })
      const bigger = eventMediaEtag({
        bytes: new Uint8Array(),
        mediaId: 12345,
        kind: 'keyFrame',
        variant: { kind: 'thumb', size: 320 },
      })
      // One ETag for both would serve a 160px square to a client that asked
      // for the full frame, for a year (`immutable`).
      expect(new Set([stored, thumb, bigger]).size).toBe(3)
    })

    it('treats an explicit null variant as the stored blob', () => {
      expect(
        eventMediaEtag({
          bytes: new Uint8Array(),
          mediaId: 9,
          kind: 'snapshot',
          variant: null,
        }),
      ).toBe('"9"')
    })
  })
})
