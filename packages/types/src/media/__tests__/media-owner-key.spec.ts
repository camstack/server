/**
 * The media key names its OWNER, and `event:` never did.
 *
 * ## The report
 *
 * 2026-09-12. D474 turned event ids into SQLite rowid aliases, so each of the
 * three event tables numbers its rows from 1. The media namespace, however, is
 * shared and addressed by owner. Measured on the live hub:
 *
 * ```
 * track:<uuid>:firstFrame                  191 361 rows
 * event:<uuid>:snapshot:<ts>               300 559
 * summary:sum-1436-...:keyFrame             27 377
 * face:face-<uuid>:crop:<ts>                 2 073
 * identity:<uuid>:crop:<ts>                    437
 * plate:plate-<uuid>:crop:<ts>                  47
 * ```
 *
 * Every prefix there is an owner TYPE - a table - except `event:`, which is
 * three tables wearing one name. That was harmless while ids were UUIDs,
 * because a UUID is unique across tables: `getTrackIdForEvent` resolves a media
 * key by PROBING the object-events table and reading a miss as "then it is not
 * an object event" - its docblock says so, naming motion and audio as the
 * misses it relies on. The resolver has exactly one caller, the event-media
 * track fallback, and the kind is NOT available there, because the key arrives
 * from a URL that carries only an id.
 *
 * With per-table integers, motion #5 and object #5 both exist, so `event:5`
 * probes object-events and HITS the wrong row. A miss that used to be reliable
 * becomes a wrong answer, and it surfaces as the wrong thumbnail rather than as
 * an error.
 *
 * ## The rule
 *
 * The owner type is the TABLE. `event` is replaced by `motion` / `object` /
 * `audio`, which keeps the one grammar every other owner already follows -
 * `<ownerType>:<ownerId>:<fileKind>[:<timestampMs>]` - instead of adding a
 * fifth segment for events alone. The kind then travels IN the key, the probe
 * has nothing left to guess, and ids stay small.
 *
 * Parsing goes through this codec and never through `split(':')[<n>]`. The
 * positional form is the same fragility in another shape: `StationarySection`
 * read `keyFrameMediaKey.split(':')[1]` for an owner id, which silently
 * becomes the event kind the moment a segment is inserted.
 */
import { describe, expect, it } from 'vitest'
import { type MediaOwnerKey, formatMediaOwnerKey, parseMediaOwnerKey } from '../media-owner-key.js'

describe('parseMediaOwnerKey - every shape that exists on the live hub', () => {
  it('reads a three-segment key, which has no timestamp', () => {
    expect(parseMediaOwnerKey('track:00002052-0578-40f9-8035-dc3f7bfdecf0:firstFrame')).toEqual({
      ownerType: 'track',
      ownerId: '00002052-0578-40f9-8035-dc3f7bfdecf0',
      fileKind: 'firstFrame',
    })
  })

  it('reads a four-segment key, whose last part is the timestamp', () => {
    expect(
      parseMediaOwnerKey('track:000c0e82-523b-480f-9303-9552c8422b4c:sceneFrame:1788455791086'),
    ).toEqual({
      ownerType: 'track',
      ownerId: '000c0e82-523b-480f-9303-9552c8422b4c',
      fileKind: 'sceneFrame',
      timestampMs: 1788455791086,
    })
  })

  it('keeps an owner id that carries its own dashes and prefix', () => {
    // The id contains digits and dashes that look like structure and are not.
    expect(parseMediaOwnerKey('mosaic:rule-7-1788714403437:mosaic:1788714403437')?.ownerId).toBe(
      'rule-7-1788714403437',
    )
    expect(
      parseMediaOwnerKey('plate:plate-07db5278-6710-45bf-872f-ab4a8a5e82e0:crop:1789136781168')
        ?.ownerId,
    ).toBe('plate-07db5278-6710-45bf-872f-ab4a8a5e82e0')
  })

  it('reads the three EVENT owner types, which replace `event`', () => {
    expect(parseMediaOwnerKey('motion:5:snapshot:1788363763546')).toEqual({
      ownerType: 'motion',
      ownerId: '5',
      fileKind: 'snapshot',
      timestampMs: 1788363763546,
    })
    expect(parseMediaOwnerKey('object:5:crop:1788363763546')?.ownerType).toBe('object')
    expect(parseMediaOwnerKey('audio:5:snapshot:1788363763546')?.ownerType).toBe('audio')
  })

  it('distinguishes motion #5 from object #5 - the whole point', () => {
    const motion = parseMediaOwnerKey('motion:5:snapshot:1')
    const object = parseMediaOwnerKey('object:5:snapshot:1')
    expect(motion?.ownerId).toBe(object?.ownerId)
    expect(motion?.ownerType).not.toBe(object?.ownerType)
  })
})

describe('parseMediaOwnerKey - a key it cannot read is null, never a guess', () => {
  // A decoder that throws would take out the whole media read path, and one
  // that guesses puts the wrong image on screen. Both are worse than null.
  it.each([
    [
      'the legacy ambiguous prefix',
      'event:0000005c-5bb0-45cc-8392-134b9c4acc5e:snapshot:1788363763546',
    ],
    ['an unknown owner type', 'sausage:5:crop:1'],
    ['too few segments', 'track:00002052'],
    ['too many segments', 'track:a:crop:1:2'],
    ['an empty owner id', 'track::crop'],
    ['a non-numeric timestamp', 'track:a:crop:later'],
    ['empty', ''],
  ])('returns null for %s', (_why, key) => {
    expect(parseMediaOwnerKey(key)).toBeNull()
  })

  it('never throws, whatever it is handed', () => {
    for (const junk of ['', ':::', 'motion:', ' ', 'a'.repeat(5000)]) {
      expect(() => parseMediaOwnerKey(junk)).not.toThrow()
    }
  })
})

describe('formatMediaOwnerKey', () => {
  it('round-trips every shape', () => {
    const keys: readonly MediaOwnerKey[] = [
      { ownerType: 'track', ownerId: 'abc', fileKind: 'firstFrame' },
      { ownerType: 'motion', ownerId: '5', fileKind: 'snapshot', timestampMs: 1788363763546 },
      { ownerType: 'object', ownerId: '10', fileKind: 'crop', timestampMs: 1 },
    ]
    for (const k of keys) {
      expect(parseMediaOwnerKey(formatMediaOwnerKey(k))).toEqual(k)
    }
  })

  it('accepts a numeric owner id, because an event id IS a number now (D474)', () => {
    expect(formatMediaOwnerKey({ ownerType: 'motion', ownerId: 5, fileKind: 'snapshot' })).toBe(
      'motion:5:snapshot',
    )
  })

  it('omits the timestamp segment when there is no timestamp', () => {
    expect(formatMediaOwnerKey({ ownerType: 'track', ownerId: 'a', fileKind: 'keyFrame' })).toBe(
      'track:a:keyFrame',
    )
  })
})
