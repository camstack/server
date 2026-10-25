/**
 * D897 — a rule's picture is ONE mode, and every stored rule maps onto it.
 *
 * The migration is pinned with a MARKED fixture: every non-picture field of
 * the legacy policy carries a distinctive value, and the test asserts each one
 * survived the fold — a mapping that rebuilt the policy from defaults would
 * pass a test that only looked at `image`.
 */
import { describe, expect, it } from 'vitest'
import {
  NcMediaPolicySchema,
  NcRuleSchema,
  type NcMediaPolicy,
} from '../../capabilities/notification-rules.cap.js'
import {
  imageModesForKind,
  type NcMediaRuleSubject,
  legacyImageMode,
  ncMediaPolicyError,
  normalizeNcMediaPolicy,
  resolveNcMediaImage,
} from '../media-image.js'

const DETECTION: NcMediaRuleSubject = { delivery: 'immediate', conditions: { classes: ['person'] } }
const ZONE_RULE: NcMediaRuleSubject = {
  delivery: 'immediate',
  conditions: { classes: ['person'], zones: { ids: ['zone-uscio'] } },
}
const SENSOR: NcMediaRuleSubject = { delivery: 'device-event', conditions: {} }
const SOUND: NcMediaRuleSubject = {
  delivery: 'immediate',
  conditions: { audio: { labels: ['dog_bark'], hitPercent: 60, samplingSeconds: 10 } },
}

/** Every field the fold must carry through untouched — each value a marker. */
const MARKERS = {
  gif: true,
  clip: true,
  clipPreRollSec: 7,
  clipPostRollSec: 11,
  clipSpeed: 3,
  profile: 'mid',
  linkedCameras: 'each',
} as const

describe('legacy media → one mode (D897 migration)', () => {
  it.each<[string, NcMediaPolicy, string]>([
    ['default best', { attach: 'best' }, 'crop'],
    ['best + cropped', { attach: 'best', frame: 'cropped' }, 'crop'],
    ['best-matching', { attach: 'best-matching' }, 'crop'],
    ['best + full', { attach: 'best', frame: 'full' }, 'clean'],
    ['best + boxed', { attach: 'best', frame: 'boxed' }, 'scene-boxes'],
    ['keyFrame', { attach: 'keyFrame' }, 'clean'],
    ['zoneCrop beats a boxed frame', { attach: 'best', frame: 'boxed', zoneCrop: true }, 'clean'],
    ['none', { attach: 'none', frame: 'boxed' }, 'none'],
  ])('%s', (_label, media, mode) => {
    expect(legacyImageMode(media)).toBe(mode)
  })

  it('folds the triple into `image` and keeps every other field (marked fixture)', () => {
    const folded = normalizeNcMediaPolicy({ attach: 'best', frame: 'boxed', ...MARKERS }, DETECTION)
    expect(folded).toEqual({ image: 'scene-boxes', ...MARKERS })
    expect(folded).not.toHaveProperty('attach')
    expect(folded).not.toHaveProperty('frame')
    expect(folded).not.toHaveProperty('zoneCrop')
  })

  it('a zone crop on a ZONE rule becomes the clean scene with the zone drawn', () => {
    expect(
      normalizeNcMediaPolicy({ attach: 'best', zoneCrop: true, gif: true }, ZONE_RULE),
    ).toEqual({
      image: 'clean',
      showTriggerZone: true,
      gif: true,
    })
  })

  it('a zone crop on a zone-LESS rule (which never cropped) becomes the clean scene, no flag', () => {
    expect(normalizeNcMediaPolicy({ attach: 'best', zoneCrop: true }, DETECTION)).toEqual({
      image: 'clean',
    })
  })

  it('a sensor rule keeps what it actually shipped — one clean snapshot — and its stored extras', () => {
    expect(normalizeNcMediaPolicy({ attach: 'best', frame: 'cropped', gif: true }, SENSOR)).toEqual(
      {
        image: 'clean',
        gif: true,
      },
    )
  })

  it('a sensor rule that stored `attach: none` keeps its snapshot — none was never honoured', () => {
    expect(normalizeNcMediaPolicy({ attach: 'none' }, SENSOR)).toEqual({ image: 'clean' })
  })

  it('a sound rule is never left on `crop`, which it cannot honour', () => {
    expect(normalizeNcMediaPolicy({ attach: 'best' }, SOUND)).toEqual({ image: 'clean' })
  })

  it('an explicit `image` wins over a stale triple', () => {
    expect(normalizeNcMediaPolicy({ image: 'scene-boxes', attach: 'keyFrame' }, DETECTION)).toEqual(
      {
        image: 'scene-boxes',
      },
    )
  })

  it('drops a `showTriggerZone` it cannot draw: no zone trigger, or a crop', () => {
    expect(normalizeNcMediaPolicy({ image: 'clean', showTriggerZone: true }, DETECTION)).toEqual({
      image: 'clean',
    })
    expect(normalizeNcMediaPolicy({ image: 'crop', showTriggerZone: true }, ZONE_RULE)).toEqual({
      image: 'crop',
    })
    expect(
      normalizeNcMediaPolicy({ image: 'scene-boxes', showTriggerZone: true }, ZONE_RULE),
    ).toEqual({ image: 'scene-boxes', showTriggerZone: true })
  })

  it('a rule parsed with no media at all reads as `crop` — the old default `best`', () => {
    const rule = NcRuleSchema.parse({
      id: 'r1',
      name: 'n',
      delivery: 'immediate',
      conditions: {},
      targets: [{ targetId: 't' }],
      createdBy: 'u',
      createdAt: 1,
      updatedAt: 1,
    })
    expect(resolveNcMediaImage(rule.media, 'detection')).toBe('crop')
  })

  it('the schema no longer materialises a default `attach` on a partial policy', () => {
    expect(NcMediaPolicySchema.parse({ image: 'clean' })).toEqual({ image: 'clean' })
  })
})

describe('what a rule may be saved with (D897 guard predicate)', () => {
  it('refuses showTriggerZone on a rule whose trigger is not a zone', () => {
    expect(ncMediaPolicyError({ image: 'clean', showTriggerZone: true }, DETECTION)).toMatch(
      /showTriggerZone needs a rule triggered by a zone/,
    )
    expect(ncMediaPolicyError({ image: 'clean', showTriggerZone: true }, ZONE_RULE)).toBeNull()
  })

  it('an occupancy zone is a zone trigger', () => {
    const occupancy: NcMediaRuleSubject = {
      delivery: 'device-event',
      conditions: {
        occupancy: {
          zoneId: 'bay-1',
          className: 'vehicle',
          op: 'became-free',
          count: 1,
          sustainSeconds: 29,
        },
      },
    }
    expect(ncMediaPolicyError({ image: 'clean', showTriggerZone: true }, occupancy)).toBeNull()
  })

  it('refuses a crop on a sound rule, accepts it on a detection rule', () => {
    expect(ncMediaPolicyError({ image: 'crop' }, SOUND)).toMatch(/not available for a sound rule/)
    expect(ncMediaPolicyError({ image: 'crop' }, DETECTION)).toBeNull()
  })

  it('offers every mode to detection AND sensor rules, no crop to a sound, nothing to a system rule', () => {
    expect(imageModesForKind('detection')).toEqual(['scene-boxes', 'crop', 'clean', 'none'])
    expect(imageModesForKind('sensor')).toEqual(['scene-boxes', 'crop', 'clean', 'none'])
    expect(imageModesForKind('sound')).toEqual(['scene-boxes', 'clean', 'none'])
    expect(imageModesForKind('system')).toEqual([])
  })
})

describe('showSubjectPath — the twin of showTriggerZone', () => {
  it('the schema accepts the flag and defaults it to absent (OFF)', () => {
    expect(NcMediaPolicySchema.parse({ image: 'crop', showSubjectPath: true })).toEqual({
      image: 'crop',
      showSubjectPath: true,
    })
    expect(NcMediaPolicySchema.parse({ image: 'crop' }).showSubjectPath).toBeUndefined()
  })

  it('survives normalisation on every picture a subject is drawn on, a crop included', () => {
    for (const image of ['scene-boxes', 'crop', 'clean'] as const) {
      expect(normalizeNcMediaPolicy({ image, showSubjectPath: true }, DETECTION)).toEqual({
        image,
        showSubjectPath: true,
      })
    }
    expect(normalizeNcMediaPolicy({ image: 'clean', showSubjectPath: true }, SENSOR)).toEqual({
      image: 'clean',
      showSubjectPath: true,
    })
  })

  it('is dropped where nothing can be drawn: no picture, or a subject with no track (a sound)', () => {
    expect(normalizeNcMediaPolicy({ image: 'none', showSubjectPath: true }, DETECTION)).toEqual({
      image: 'none',
    })
    expect(normalizeNcMediaPolicy({ image: 'clean', showSubjectPath: true }, SOUND)).toEqual({
      image: 'clean',
    })
  })

  it('is refused on save for a rule whose subject has no path, accepted on a detection rule', () => {
    expect(ncMediaPolicyError({ image: 'clean', showSubjectPath: true }, SOUND)).toMatch(
      /showSubjectPath needs a rule whose subject is a tracked object/,
    )
    expect(ncMediaPolicyError({ image: 'crop', showSubjectPath: true }, DETECTION)).toBeNull()
  })
})
