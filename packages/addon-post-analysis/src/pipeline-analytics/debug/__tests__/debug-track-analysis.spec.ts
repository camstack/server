/**
 * The debug analysis, rule by rule.
 *
 * Two properties matter more than the individual codes:
 *
 *  1. **A healthy track is CLEAN.** A list that always has something in it is a
 *     list nobody reads, so the complete-track fixture asserts an empty array —
 *     not "no errors", empty.
 *  2. **A live track is not judged on what it has not finished doing.** Every
 *     closed-only rule is asserted twice: firing when closed, silent when open.
 */
import type { MediaFileInfo } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  analyseDebugTrack,
  buildDebugTrackReport,
  type DebugFindingCode,
  type DebugTrackFacts,
  type DebugTrackInventory,
  LONG_TRACK_MS,
  SHORT_TRACK_MS,
} from '../debug-track-analysis.js'
import { RAW_CLASS_STEP_ID } from '../../pipeline/label-utils.js'

const T0 = 1_700_000_000_000

let debugMediaId = 20_000

function media(kind: MediaFileInfo['kind'], atMs: number): MediaFileInfo {
  debugMediaId += 1
  const mediaId = debugMediaId
  return {
    mediaId,
    kind,
    sizeBytes: 1_000,
    timestamp: T0 + atMs,
    url: `/debug/m/${mediaId}`,
  }
}

/** A closed 30-second track that produced everything it should have. */
function healthyFacts(over: Partial<DebugTrackFacts> = {}): DebugTrackFacts {
  return {
    trackId: 'trk-1',
    deviceId: 101,
    className: 'person',
    label: 'person',
    labelScore: 0.87,
    firstSeen: T0,
    lastSeen: T0 + 30_000,
    active: false,
    positionCount: 42,
    snapshotCount: 3,
    importance: 0.7,
    bestEventId: 'evt-9',
    ...over,
  }
}

function healthyInventory(over: Partial<DebugTrackInventory> = {}): DebugTrackInventory {
  return {
    facts: healthyFacts(),
    media: [
      media('firstFrame', 0),
      media('keyFrame', 12_000),
      media('thumbnail', 12_000),
      media('crop', 12_000),
      media('snapshot', 20_000),
      media('lastFrame', 30_000),
    ],
    eventCount: 24,
    ...over,
  }
}

function codes(inventory: DebugTrackInventory): readonly DebugFindingCode[] {
  return analyseDebugTrack(inventory).map((f) => f.code)
}

describe('analyseDebugTrack — a complete track is clean', () => {
  it('reports NOTHING for a track that produced its whole media set', () => {
    expect(analyseDebugTrack(healthyInventory())).toEqual([])
  })
})

describe('analyseDebugTrack — missing media', () => {
  it('reports MEDIA_EVICTED_OR_NEVER, and only that, when there is no media at all', () => {
    const found = codes(healthyInventory({ media: [] }))
    expect(found).toContain('MEDIA_EVICTED_OR_NEVER')
    // The per-kind rules must NOT also fire: six codes for one cause is a list
    // that hides the cause.
    expect(found).not.toContain('MISSING_KEYFRAME')
    expect(found).not.toContain('MISSING_THUMBNAIL')
  })

  it('separates a row whose BLOB cannot be read from a track that has no rows', () => {
    // The state that made this rule necessary, on the hub, 2026-09-08: five
    // marked tracks reported six media rows each and served 404 for every one
    // of them. `listByOwner` and `getByKey` both drop a row whose blob read
    // throws, so the tab counted rows the viewer could never draw — and the
    // one code for "no media" never fired, because the rows were all there.
    const inv = healthyInventory({
      unreadableMedia: healthyInventory().media.map((m) => m.mediaId),
    })
    const found = codes(inv)
    expect(found).toContain('MEDIA_ROW_WITHOUT_BLOB')
    // NOT the eviction code: the rows exist, and telling an operator their
    // media was evicted when the bytes are still on the disk sends them to
    // retention settings for a problem that is in the index.
    expect(found).not.toContain('MEDIA_EVICTED_OR_NEVER')
  })

  it('says how many rows are unreadable, not merely that some are', () => {
    const all = healthyInventory().media
    const inv = healthyInventory({ unreadableMedia: [all[0]!.mediaId, all[1]!.mediaId] })
    const detail = analyseDebugTrack(inv).find((f) => f.code === 'MEDIA_ROW_WITHOUT_BLOB')?.detail
    expect(detail).toContain('2 of 6')
  })

  it('is silent when every row reads', () => {
    expect(codes(healthyInventory({ unreadableMedia: [] }))).toEqual([])
    // Absent means the caller did not probe — which must not read as "all fine"
    // NOR as a fault. No finding either way.
    expect(codes(healthyInventory())).toEqual([])
  })

  it('reports MISSING_KEYFRAME when every other kind landed', () => {
    const inv = healthyInventory({
      media: healthyInventory().media.filter((m) => m.kind !== 'keyFrame'),
    })
    expect(codes(inv)).toEqual(['MISSING_KEYFRAME'])
  })

  it('reports MISSING_FIRSTFRAME, MISSING_LASTFRAME and MISSING_THUMBNAIL independently', () => {
    const base = healthyInventory().media
    expect(codes(healthyInventory({ media: base.filter((m) => m.kind !== 'firstFrame') }))).toEqual(
      ['MISSING_FIRSTFRAME'],
    )
    expect(codes(healthyInventory({ media: base.filter((m) => m.kind !== 'lastFrame') }))).toEqual([
      'MISSING_LASTFRAME',
    ])
    expect(codes(healthyInventory({ media: base.filter((m) => m.kind !== 'thumbnail') }))).toEqual([
      'MISSING_THUMBNAIL',
    ])
  })

  /**
   * D400 re-scope. `MISSING_BEST_CROP` used to fire on ANY closed track owning
   * no crop, which is the normal shape — the detail plane does not run on most
   * tracks, so nothing was owed one. It reported on 10 of the 14 tracks in the
   * 2026-09-07 audit, including the two the audit found fully healthy
   * (`46d4e09f`, `5f5f0f6e`), and a finding that fires on healthy tracks means
   * nothing. It now names only the case it was meant to: a subject detail RAN
   * and nothing was cut for it.
   */
  describe('MISSING_BEST_CROP (re-scoped, D400)', () => {
    const noCrop = healthyInventory().media.filter((m) => m.kind !== 'crop')

    it('is SILENT on a healthy track that simply never ran a subject detail', () => {
      // The `46d4e09f` shape: a full media set, no face, no crop — and the
      // audit's verdict on it was BENIGN.
      expect(codes(healthyInventory({ media: noCrop }))).toEqual([])
    })

    it('fires when a face detail RAN and no crop of any kind was cut', () => {
      expect(
        codes(healthyInventory({ facts: healthyFacts({ hasFace: true }), media: noCrop })),
      ).toEqual(['MISSING_BEST_CROP'])
    })

    it('fires on the straight contradiction: a gallery face row with no crop at all', () => {
      const found = codes(
        healthyInventory({ facts: healthyFacts({ hasEmbeddedFace: true }), media: noCrop }),
      )
      expect(found).toEqual(['MISSING_BEST_CROP'])
    })

    it('a face crop is still a crop — the subject was cut, just at another tier', () => {
      expect(
        codes(
          healthyInventory({
            facts: healthyFacts({ hasFace: true }),
            media: [...noCrop, media('faceCrop', 12_000)],
          }),
        ),
      ).toEqual([])
    })

    it('treats an ABSENT hasFace as unknown, never as "a face ran"', () => {
      // Absent ≠ false, and absent ≠ true either: a row written before the
      // column must not start accusing the pipeline.
      expect(codes(healthyInventory({ facts: healthyFacts({}), media: noCrop }))).toEqual([])
    })
  })

  /**
   * D400 — the operator's two 102 notes are ONE failure, and the viewer renders
   * per KIND. `59bbae2b` ("niente primo e ultimo") and `a99af2f3` ("niente
   * ultimo") both lost their lastFrame BECAUSE the keyFrame never landed:
   * no keyFrame ⇒ no keyFrameSmall ⇒ no `copy` source for
   * `decideLastFramePromotion`. The findings still fire per kind — the media
   * really is absent — but each now carries its cause.
   */
  describe('the keyFrame cascade is named, not repeated (D400)', () => {
    /** The `59bbae2b` shape: a raster-tile thumbnail and nothing else. */
    const cascade = healthyInventory({
      facts: healthyFacts({
        trackId: '59bbae2b-2975-4d65-8dde-726c0ba523f2',
        deviceId: 102,
        className: 'vehicle',
        lastSeen: T0 + 1_140,
        previewMissReason: 'raster-tile tile=raster capture=thumbnail:native-missx2',
      }),
      media: [media('thumbnail', 500)],
    })

    it('says the missing lastFrame is a CONSEQUENCE of the missing keyFrame', () => {
      const detail = analyseDebugTrack(cascade).find((f) => f.code === 'MISSING_LASTFRAME')?.detail
      expect(detail).toContain('CONSEQUENCE')
      expect(detail).toContain('keyFrame')
    })

    it('does NOT blame the keyFrame when a snapshot existed to promote', () => {
      const withSnapshot = healthyInventory({
        media: [media('firstFrame', 0), media('thumbnail', 500), media('snapshot', 900)],
      })
      const detail = analyseDebugTrack(withSnapshot).find(
        (f) => f.code === 'MISSING_LASTFRAME',
      )?.detail
      expect(detail).not.toContain('CONSEQUENCE')
    })

    it('does NOT blame the keyFrame when a keyFrameSmall copy source DID exist', () => {
      const withCopySource = healthyInventory({
        media: [media('thumbnail', 500), media('keyFrame', 500), media('keyFrameSmall', 500)],
      })
      const detail = analyseDebugTrack(withCopySource).find(
        (f) => f.code === 'MISSING_LASTFRAME',
      )?.detail
      expect(detail).not.toContain('CONSEQUENCE')
      expect(codes(withCopySource)).not.toContain('MISSING_KEYFRAME')
    })

    it('names the same cause on the missing thumbnail', () => {
      const detail = analyseDebugTrack(healthyInventory({ media: [media('firstFrame', 0)] })).find(
        (f) => f.code === 'MISSING_THUMBNAIL',
      )?.detail
      expect(detail).toContain('keyFrame')
    })

    it('still reports each kind — the operator asked about each tile', () => {
      expect(codes(cascade)).toEqual(
        expect.arrayContaining(['MISSING_KEYFRAME', 'MISSING_FIRSTFRAME', 'MISSING_LASTFRAME']),
      )
    })
  })

  it('holds every per-kind rule off while the track is still open', () => {
    const inv = healthyInventory({
      facts: healthyFacts({ active: true }),
      media: [media('firstFrame', 0)],
    })
    const found = codes(inv)
    expect(found).not.toContain('MISSING_KEYFRAME')
    expect(found).not.toContain('MISSING_LASTFRAME')
    expect(found).not.toContain('MISSING_THUMBNAIL')
  })
})

describe('analyseDebugTrack — the track substance', () => {
  it('reports SHORT_TRACK below the floor, and carries the measured duration', () => {
    const inv = healthyInventory({
      facts: healthyFacts({ lastSeen: T0 + SHORT_TRACK_MS - 1 }),
    })
    const found = analyseDebugTrack(inv).find((f) => f.code === 'SHORT_TRACK')
    expect(found).toBeDefined()
    expect(found?.detail).toContain(String(SHORT_TRACK_MS - 1))
  })

  it('does not report SHORT_TRACK exactly at the floor', () => {
    const inv = healthyInventory({ facts: healthyFacts({ lastSeen: T0 + SHORT_TRACK_MS }) })
    expect(codes(inv)).not.toContain('SHORT_TRACK')
  })

  it('reports ZERO_EVENTS and ZERO_POSITIONS', () => {
    expect(codes(healthyInventory({ eventCount: 0 }))).toContain('ZERO_EVENTS')
    expect(codes(healthyInventory({ facts: healthyFacts({ positionCount: 0 }) }))).toContain(
      'ZERO_POSITIONS',
    )
  })

  it('reports NO_PERIODIC_SNAPSHOTS on a long track with neither a snapshot row nor media', () => {
    const inv = healthyInventory({
      facts: healthyFacts({ lastSeen: T0 + LONG_TRACK_MS, snapshotCount: 0 }),
      media: healthyInventory().media.filter((m) => m.kind !== 'snapshot'),
    })
    expect(codes(inv)).toContain('NO_PERIODIC_SNAPSHOTS')
  })

  it('does not report NO_PERIODIC_SNAPSHOTS on a SHORT track — none was expected', () => {
    const inv = healthyInventory({
      facts: healthyFacts({ lastSeen: T0 + LONG_TRACK_MS - 1, snapshotCount: 0 }),
      media: healthyInventory().media.filter((m) => m.kind !== 'snapshot'),
    })
    expect(codes(inv)).not.toContain('NO_PERIODIC_SNAPSHOTS')
  })
})

/**
 * "Ultimo frame prima del primo" — filed by hand, three times, on device 3829
 * (2026-09-08). The check is one comparison the analysis never made, so the
 * operator had to notice a first/last inversion by eye and tick a box.
 */
describe('analyseDebugTrack — the firstFrame is not first', () => {
  it('reports FIRSTFRAME_AFTER_LASTFRAME when the primo tile post-dates the ultimo tile', () => {
    // 7628b19d: lastFrame copied from keyFrameSmall at birth, firstFrame landed
    // 260 ms later on the frame the confirmation gate released the birth on.
    const inv = healthyInventory({
      media: [
        ...healthyInventory().media.filter(
          (m) => m.kind !== 'firstFrame' && m.kind !== 'lastFrame',
        ),
        media('lastFrame', 1_000),
        media('firstFrame', 1_260),
      ],
    })
    const found = analyseDebugTrack(inv).find((f) => f.code === 'FIRSTFRAME_AFTER_LASTFRAME')
    expect(found?.severity).toBe('error')
    expect(found?.detail).toContain('260')
  })

  it('reports FIRSTFRAME_AFTER_TRACK_END when the primo tile post-dates lastSeen', () => {
    // d035f251: the deferred birth confirmed on a COASTED frame 451 ms after
    // the track's last observation, so the tile shows a scene the subject had
    // already left.
    const inv = healthyInventory({
      facts: healthyFacts({ lastSeen: T0 + 30_000 }),
      media: [
        ...healthyInventory().media.filter((m) => m.kind !== 'firstFrame'),
        media('firstFrame', 30_451),
      ],
    })
    const found = analyseDebugTrack(inv).find((f) => f.code === 'FIRSTFRAME_AFTER_TRACK_END')
    expect(found?.severity).toBe('error')
    expect(found?.detail).toContain('451')
  })

  it('reports BOTH on the d035f251 shape, where the tile is late against each', () => {
    const inv = healthyInventory({
      media: [
        ...healthyInventory().media.filter(
          (m) => m.kind !== 'firstFrame' && m.kind !== 'lastFrame',
        ),
        media('lastFrame', 326),
        media('firstFrame', 30_451),
      ],
    })
    const found = codes(inv)
    expect(found).toContain('FIRSTFRAME_AFTER_LASTFRAME')
    expect(found).toContain('FIRSTFRAME_AFTER_TRACK_END')
  })

  it('says nothing about a COLLAPSED pair — one honest frame in both slots', () => {
    const inv = healthyInventory({
      media: [
        ...healthyInventory().media.filter(
          (m) => m.kind !== 'firstFrame' && m.kind !== 'lastFrame',
        ),
        media('lastFrame', 800),
        media('firstFrame', 800),
      ],
    })
    expect(codes(inv)).not.toContain('FIRSTFRAME_AFTER_LASTFRAME')
  })

  it('says nothing on the healthy track', () => {
    const found = codes(healthyInventory())
    expect(found).not.toContain('FIRSTFRAME_AFTER_LASTFRAME')
    expect(found).not.toContain('FIRSTFRAME_AFTER_TRACK_END')
  })

  it('holds the track-end rule off while the track is still OPEN', () => {
    // A live track's `lastSeen` is a moving target, so a media instant a few
    // ms past it is the normal race, not a defect.
    const inv = healthyInventory({
      facts: healthyFacts({ active: true, lastSeen: T0 + 30_000 }),
      media: [
        ...healthyInventory().media.filter((m) => m.kind !== 'firstFrame'),
        media('firstFrame', 30_451),
      ],
    })
    expect(codes(inv)).not.toContain('FIRSTFRAME_AFTER_TRACK_END')
  })

  it('reports the media inversion even while the track is OPEN — it can never be right', () => {
    const inv = healthyInventory({
      facts: healthyFacts({ active: true }),
      media: [
        ...healthyInventory().media.filter(
          (m) => m.kind !== 'firstFrame' && m.kind !== 'lastFrame',
        ),
        media('lastFrame', 1_000),
        media('firstFrame', 1_260),
      ],
    })
    expect(codes(inv)).toContain('FIRSTFRAME_AFTER_LASTFRAME')
  })
})

describe('analyseDebugTrack — the softer signals', () => {
  it('reports LASTFRAME_STALE when the last frame lags the track end', () => {
    const inv = healthyInventory({
      media: [
        ...healthyInventory().media.filter((m) => m.kind !== 'lastFrame'),
        media('lastFrame', 25_000),
      ],
    })
    const found = analyseDebugTrack(inv).find((f) => f.code === 'LASTFRAME_STALE')
    expect(found?.detail).toContain('5000')
  })

  it('reports MEDIA_STOPPED_EARLY when media covers under half a long track', () => {
    const inv = healthyInventory({
      media: [
        media('firstFrame', 0),
        media('keyFrame', 1_000),
        media('thumbnail', 1_000),
        media('crop', 1_000),
        media('snapshot', 2_000),
        media('lastFrame', 3_000),
      ],
    })
    const found = analyseDebugTrack(inv).find((f) => f.code === 'MEDIA_STOPPED_EARLY')
    expect(found?.detail).toContain('10%')
  })

  it('reports NO_BEST_EVENT and LOW_BEST_SCORE as info, not error', () => {
    const inv = healthyInventory({
      facts: healthyFacts({ bestEventId: undefined, labelScore: 0.31 }),
    })
    const found = analyseDebugTrack(inv)
    expect(found.find((f) => f.code === 'NO_BEST_EVENT')?.severity).toBe('info')
    expect(found.find((f) => f.code === 'LOW_BEST_SCORE')?.severity).toBe('info')
    expect(found.find((f) => f.code === 'LOW_BEST_SCORE')?.detail).toContain('0.31')
  })

  // A raw-class label carries `score: 0` BY CONSTRUCTION (`RAW_CLASS_STEP_ID`
  // in label-utils: "it IS the detection, so it inherits the detection's
  // standing rather than inventing a confidence"). Reporting that as a weak
  // label tells the operator a classifier was unsure when no classifier ever
  // answered — two different defects with two different fixes. Ten of the
  // eighteen tracks the operator flagged carried exactly this.
  it('calls an unscored raw-class label UNSCORED_LABEL, not LOW_BEST_SCORE', () => {
    const inv = healthyInventory({
      facts: healthyFacts({ labelScore: 0, labelStepId: RAW_CLASS_STEP_ID }),
    })
    const found = analyseDebugTrack(inv)
    expect(found.find((f) => f.code === 'LOW_BEST_SCORE')).toBeUndefined()
    const unscored = found.find((f) => f.code === 'UNSCORED_LABEL')
    expect(unscored?.severity).toBe('info')
    expect(unscored?.detail).toContain('raw class')
  })

  // D715: a linked label is the root detector standing in for a step. At
  // score 0 it is the fallback nothing scored over; at a score it is the
  // DETECTION's confidence — no classifier threshold had any part in it.
  it('calls a score-0 linked label UNSCORED_LABEL and names the step it stands in for', () => {
    const inv = healthyInventory({
      facts: healthyFacts({ labelScore: 0, labelStepId: 'detector-link:animal-classifier' }),
    })
    const found = analyseDebugTrack(inv)
    expect(found.find((f) => f.code === 'LOW_BEST_SCORE')).toBeUndefined()
    expect(found.find((f) => f.code === 'UNSCORED_LABEL')?.detail).toContain(
      'linked label for animal-classifier',
    )
  })

  it("calls a weak authoritative linked label the DETECTION's confidence", () => {
    const inv = healthyInventory({
      facts: healthyFacts({ labelScore: 0.31, labelStepId: 'detector-link:vehicle-classifier' }),
    })
    const detail = analyseDebugTrack(inv).find((f) => f.code === 'LOW_BEST_SCORE')?.detail
    expect(detail).toContain("DETECTION's confidence")
    expect(detail).toContain('vehicle-classifier')
  })

  it('still calls a SCORED zero a low score', () => {
    const inv = healthyInventory({
      facts: healthyFacts({ labelScore: 0, labelStepId: 'animal-classifier' }),
    })
    const found = analyseDebugTrack(inv)
    expect(found.find((f) => f.code === 'UNSCORED_LABEL')).toBeUndefined()
    expect(found.find((f) => f.code === 'LOW_BEST_SCORE')?.detail).toContain('0.00')
  })
})

describe('buildDebugTrackReport', () => {
  it('carries the duration, the distinct kinds and the findings', () => {
    const report = buildDebugTrackReport(healthyInventory())
    expect(report.durationMs).toBe(30_000)
    expect(report.mediaKinds).toEqual([
      'crop',
      'firstFrame',
      'keyFrame',
      'lastFrame',
      'snapshot',
      'thumbnail',
    ])
    expect(report.findings).toEqual([])
    expect(report.eventCount).toBe(24)
  })

  it('reads a clock that went backwards as a zero duration, never a negative one', () => {
    const report = buildDebugTrackReport(
      healthyInventory({ facts: healthyFacts({ lastSeen: T0 - 5_000 }) }),
    )
    expect(report.durationMs).toBe(0)
  })
})
