import { describe, expect, it } from 'vitest'
import {
  SUMMARY_THUMBNAIL_MIN_BYTES,
  filterSummaryCandidates,
  frameDedupeKey,
  pickSummaryMedia,
  type SummaryCandidate,
  type SummaryMediaRow,
  selectSummaryTiles,
} from '../summary-selection.js'

/**
 * A media index row.
 *
 * `sizeBytes` is REQUIRED here, with no default, on purpose: the ladder's
 * face-template floor reads exactly this field, and a fixture helper that
 * quietly supplied one would be the shape this repo has already been burned by
 * — a fake handing production the value production forgot to fetch.
 */
function row(
  mediaId: number,
  kind: string,
  timestamp: number,
  sizeBytes: number | null,
): SummaryMediaRow {
  return { mediaId, kind, timestamp, sizeBytes }
}

/** A real native-resolution subject crop: hundreds of KB, never a template. */
const CROP_BYTES = 240_000
/** A whole frame. */
const FRAME_BYTES = 1_800_000

function track(over: Partial<SummaryCandidate> & { trackId: string }): SummaryCandidate {
  return {
    deviceId: 636,
    className: 'person',
    firstSeen: 1_000,
    lastSeen: 5_000,
    zones: [],
    ...over,
  }
}

describe('filterSummaryCandidates', () => {
  it('keeps everything when the rule declares no filters', () => {
    const out = filterSummaryCandidates([track({ trackId: 'a' })], undefined)
    expect(out.kept).toHaveLength(1)
  })

  /**
   * The operator's report, verbatim: *"le ultime summaries includono ancora
   * tantissime track stazionarie"*. Since D161 a track promoted to the
   * stationary registry is PERSISTED rather than forgotten, so the car parked
   * in front of 102 now enters every window it overlaps.
   */
  describe('parked objects', () => {
    it('drops them by default, and COUNTS what it dropped', () => {
      const out = filterSummaryCandidates(
        [
          track({ trackId: 'passing' }),
          track({ trackId: 'parked-1', stationary: true }),
          track({ trackId: 'parked-2', stationary: true }),
        ],
        undefined,
      )
      expect(out.kept.map((t) => t.trackId)).toEqual(['passing'])
      expect(out.droppedStationary).toBe(2)
    })

    it('drops them on a rule that declares OTHER filters too', () => {
      const out = filterSummaryCandidates(
        [track({ trackId: 'passing' }), track({ trackId: 'parked', stationary: true })],
        { classes: ['person'] },
      )
      expect(out.kept.map((t) => t.trackId)).toEqual(['passing'])
      expect(out.droppedStationary).toBe(1)
      // The parked one is NOT also counted as a class drop — one candidate,
      // one reason, or the counts stop adding up to the scan.
      expect(out.droppedByClass).toBe(0)
    })

    it('keeps them when the rule asks for them', () => {
      const out = filterSummaryCandidates(
        [track({ trackId: 'passing' }), track({ trackId: 'parked', stationary: true })],
        { includeStationary: true },
      )
      expect(out.kept.map((t) => t.trackId)).toEqual(['passing', 'parked'])
      expect(out.droppedStationary).toBe(0)
    })

    it('treats an ABSENT marker as a passage — a legacy row is never hidden', () => {
      // Rows written before the `closedReason` column, and any hub whose table
      // never gained it, read `undefined`. Fail OPEN: showing a parked car once
      // more is recoverable, silently dropping a passage is not.
      const out = filterSummaryCandidates([track({ trackId: 'legacy' })], {
        includeStationary: false,
      })
      expect(out.kept.map((t) => t.trackId)).toEqual(['legacy'])
      expect(out.droppedStationary).toBe(0)
    })

    /**
     * The filter is only half the guarantee — what the operator actually sees
     * is the TILES, and the two functions have to be composed in this order to
     * produce them. Asserting on `kept` alone would go green on a producer that
     * selected first and filtered afterwards.
     *
     * The quota pass is what makes the order load-bearing: it guarantees EVERY
     * contributing camera its single best track, so a camera whose only
     * candidate is the parked car would be handed a tile for it — the car park
     * would be in the digest *because* the digest tries to be fair.
     */
    it('a promoted track never reaches the TILES, even as its camera’s only one', () => {
      const candidates = [
        track({ trackId: 'passing', deviceId: 101, importance: 0.6 }),
        // 102's whole contribution is a parked car, and it outranks everything.
        track({
          trackId: 'parked-102',
          deviceId: 102,
          importance: 0.99,
          stationary: true,
        }),
      ]
      const filtered = filterSummaryCandidates(candidates, undefined)
      const selection = selectSummaryTiles(filtered.kept, {
        maxTiles: 9,
        rank: 'importance',
      })

      expect(selection.tiles.map((t) => t.trackId)).toEqual(['passing'])
      expect(selection.tiles.some((t) => t.stationary === true)).toBe(false)
      // 102 contributed nothing that survived, so it is not a camera the quota
      // owes a tile to — it must not be reported as one it dropped either.
      expect(selection.camerasContributing).toBe(1)
      expect(filtered.droppedStationary).toBe(1)
    })

    it('the digest empties rather than showing a window that was ALL parked', () => {
      // The measured shape of the operator's complaint: since D161 a car park
      // fills the window with persisted rows. Ten parked cars is not ten tiles,
      // it is no digest — and the count is what says which.
      const candidates = Array.from({ length: 10 }, (_, i) =>
        track({ trackId: `parked-${i}`, deviceId: 102, stationary: true }),
      )
      const filtered = filterSummaryCandidates(candidates, {
        classes: ['vehicle', 'person'],
      })
      const selection = selectSummaryTiles(filtered.kept, {
        maxTiles: 9,
        rank: 'importance',
      })

      expect(selection.tiles).toHaveLength(0)
      expect(filtered.droppedStationary).toBe(10)
      // Not counted twice: the class filter never saw them.
      expect(filtered.droppedByClass).toBe(0)
    })

    it('includeStationary puts them back in the TILES, not just in kept', () => {
      // The negative control for the two above: remove the filter's stationary
      // pass and they go green off this one's behaviour.
      const candidates = [
        track({ trackId: 'passing', deviceId: 101, importance: 0.6 }),
        track({
          trackId: 'parked-102',
          deviceId: 102,
          importance: 0.99,
          stationary: true,
        }),
      ]
      const filtered = filterSummaryCandidates(candidates, {
        includeStationary: true,
      })
      const selection = selectSummaryTiles(filtered.kept, {
        maxTiles: 9,
        rank: 'importance',
      })

      expect(selection.tiles.map((t) => t.trackId).toSorted()).toEqual(['parked-102', 'passing'])
    })
  })

  /**
   * The operator's report: a nightly digest whose tiles are a parked car's
   * doorframe, a wall, a patch of grass. Measured on the live hub (device 102,
   * 2026-08-19 04:12): two rows, `closedReason` NULL so the parked pass cannot
   * see them, `importance` 0.045, dwell 53 ms, ONE thing in common with every
   * other row of that shape — the persisted trajectory holds fewer sightings
   * than the tracker needs to promote a candidate into a track at all.
   */
  describe('tracks the pipeline never promoted', () => {
    it('drops them by default, and COUNTS what it dropped', () => {
      const out = filterSummaryCandidates(
        [
          track({ trackId: 'passing', confirmed: true }),
          track({ trackId: 'phantom-1', confirmed: false }),
          track({ trackId: 'phantom-2', confirmed: false }),
        ],
        undefined,
      )
      expect(out.kept.map((t) => t.trackId)).toEqual(['passing'])
      expect(out.droppedUnconfirmed).toBe(2)
    })

    it('drops them on a rule that declares OTHER filters too', () => {
      const out = filterSummaryCandidates(
        [
          track({ trackId: 'passing', confirmed: true, importance: 0.6 }),
          track({ trackId: 'phantom', confirmed: false, importance: 0.6 }),
        ],
        { classes: ['person'], minImportance: 0.2 },
      )
      expect(out.kept.map((t) => t.trackId)).toEqual(['passing'])
      expect(out.droppedUnconfirmed).toBe(1)
      // One candidate, one reason — or the counts stop adding up to the scan.
      expect(out.droppedByClass).toBe(0)
      expect(out.droppedByImportance).toBe(0)
    })

    /**
     * The measured reason `minImportance` cannot be the gate: the static-track
     * gate that demotes a frozen subject needs TWO centroids
     * (`computeStaticTrackMetrics` returns undefined below that), so a row with
     * one recorded sighting is the one shape it is structurally blind to. On
     * the live hub 33 of 34 single-sighting rows score at or above 0.2.
     */
    it('drops a phantom whose importance sails past the rule floor', () => {
      const out = filterSummaryCandidates(
        [track({ trackId: 'never-promoted', confirmed: false, importance: 0.49 })],
        { minImportance: 0.2 },
      )
      expect(out.kept).toHaveLength(0)
      expect(out.droppedUnconfirmed).toBe(1)
      expect(out.droppedByImportance).toBe(0)
    })

    it('treats an ABSENT signal as promoted, and says how many it could not judge', () => {
      // A caller that predates the signal reads `undefined`. Fail OPEN and
      // COUNT: silently keeping is recoverable, silently dropping a passage is
      // not — and a gate that has quietly stopped seeing anything must not look
      // identical to a night with nothing to drop.
      const out = filterSummaryCandidates([track({ trackId: 'legacy' })], undefined)
      expect(out.kept.map((t) => t.trackId)).toEqual(['legacy'])
      expect(out.droppedUnconfirmed).toBe(0)
      expect(out.unknownConfirmation).toBe(1)
    })

    /**
     * Same load-bearing ordering as the parked pass, and for the same reason:
     * the quota hands EVERY contributing camera its single best track, so a
     * camera whose only candidate is a phantom would be given a tile for it —
     * the digest would show the wall *because* it tries to be fair.
     */
    it('an unpromoted track never reaches the TILES, even as its camera’s only one', () => {
      const candidates = [
        track({ trackId: 'passing', deviceId: 101, importance: 0.6, confirmed: true }),
        track({ trackId: 'phantom-102', deviceId: 102, importance: 0.99, confirmed: false }),
      ]
      const filtered = filterSummaryCandidates(candidates, undefined)
      const selection = selectSummaryTiles(filtered.kept, {
        maxTiles: 9,
        rank: 'importance',
      })

      expect(selection.tiles.map((t) => t.trackId)).toEqual(['passing'])
      expect(selection.tiles.some((t) => t.confirmed === false)).toBe(false)
      // 102 contributed nothing that survived, so it is neither a camera the
      // quota owes a tile to nor one it has to report as dropped.
      expect(selection.camerasContributing).toBe(1)
      expect(selection.camerasDropped).toBe(0)
    })

    it('a phantom that was ALSO parked is counted once, under the promotion gate', () => {
      const out = filterSummaryCandidates(
        [track({ trackId: 'both', confirmed: false, stationary: true })],
        undefined,
      )
      expect(out.kept).toHaveLength(0)
      expect(out.droppedUnconfirmed).toBe(1)
      expect(out.droppedStationary).toBe(0)
    })

    it('a promoted PARKED track is still dropped as parked', () => {
      const out = filterSummaryCandidates(
        [track({ trackId: 'parked', confirmed: true, stationary: true })],
        undefined,
      )
      expect(out.kept).toHaveLength(0)
      expect(out.droppedStationary).toBe(1)
      expect(out.droppedUnconfirmed).toBe(0)
    })
  })

  it('counts each drop reason apart', () => {
    const out = filterSummaryCandidates(
      [
        track({ trackId: 'a', className: 'car' }),
        track({ trackId: 'b', importance: 0.1 }),
        track({ trackId: 'c', importance: 0.9, firstSeen: 0, lastSeen: 500 }),
        track({ trackId: 'd', importance: 0.9 }),
      ],
      { classes: ['person'], minImportance: 0.5, minDwellSeconds: 2 },
    )
    expect(out.kept.map((t) => t.trackId)).toEqual(['d'])
    expect(out.droppedByClass).toBe(1)
    expect(out.droppedByImportance).toBe(1)
    expect(out.droppedByDwell).toBe(1)
  })

  it('matches on any accumulated class, not only the current one', () => {
    const out = filterSummaryCandidates(
      [track({ trackId: 'a', className: 'car', classes: ['person', 'car'] })],
      { classes: ['person'] },
    )
    expect(out.kept).toHaveLength(1)
  })

  it('classesExclude wins over classes', () => {
    const out = filterSummaryCandidates([track({ trackId: 'a' })], {
      classes: ['person'],
      classesExclude: ['person'],
    })
    expect(out.kept).toHaveLength(0)
  })

  describe('zones, scoped per camera', () => {
    const zoneA = 'zone-on-636'
    const zoneB = 'zone-on-637'
    const owner = (deviceId: number): readonly string[] =>
      deviceId === 636 ? [zoneA] : deviceId === 637 ? [zoneB] : []

    it('does not mute a camera that owns none of the rule zones', () => {
      // 1441 owns neither zone: the condition does not apply to it and its
      // track matches whole-frame. Without the scoping this drops forever.
      const out = filterSummaryCandidates(
        [track({ trackId: 'other-cam', deviceId: 1441, zones: [] })],
        { zones: [zoneA] },
        owner,
      )
      expect(out.kept.map((t) => t.trackId)).toEqual(['other-cam'])
    })

    it('still enforces the zone on the camera that OWNS it', () => {
      const out = filterSummaryCandidates(
        [
          track({ trackId: 'in', deviceId: 636, zones: [zoneA] }),
          track({ trackId: 'out', deviceId: 636, zones: [] }),
        ],
        { zones: [zoneA] },
        owner,
      )
      expect(out.kept.map((t) => t.trackId)).toEqual(['in'])
      expect(out.droppedByZone).toBe(1)
    })

    it('an ownership lookup that cannot answer keeps the FLAT behaviour', () => {
      // D49: the destructive direction (widening a scoped rule) needs a read
      // that actually succeeded. `undefined` changes nothing.
      const out = filterSummaryCandidates(
        [track({ trackId: 'x', deviceId: 1441, zones: [] })],
        { zones: [zoneA] },
        () => undefined,
      )
      expect(out.kept).toHaveLength(0)
      expect(out.droppedByZone).toBe(1)
    })
  })
})

describe('selectSummaryTiles — the per-camera quota', () => {
  it('gives every contributing camera a tile before ranking takes the rest', () => {
    // A busy camera with the six best tracks, and two quiet cameras with one
    // weak track each. Pure ranking would show only the busy one.
    const busy = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65].map((importance, i) =>
      track({
        trackId: `busy-${i}`,
        deviceId: 636,
        importance,
        firstSeen: 1_000 + i,
      }),
    )
    const quiet = [
      track({
        trackId: 'q637',
        deviceId: 637,
        importance: 0.2,
        firstSeen: 2_000,
      }),
      track({
        trackId: 'q1441',
        deviceId: 1441,
        importance: 0.1,
        firstSeen: 3_000,
      }),
    ]
    const out = selectSummaryTiles([...busy, ...quiet], {
      maxTiles: 4,
      rank: 'importance',
    })
    const devices = new Set(out.tiles.map((t) => t.deviceId))
    expect(devices).toEqual(new Set([636, 637, 1441]))
    expect(out.tiles).toHaveLength(4)
    expect(out.camerasContributing).toBe(3)
    expect(out.camerasDropped).toBe(0)
    expect(out.overflow).toBe(4)
  })

  it('NEUTRALISED QUOTA: pure ranking would starve the quiet cameras', () => {
    // The same input, ranked without the quota — the assertion that proves the
    // test above is testing the quota and not the sort.
    const busy = [0.9, 0.85, 0.8, 0.75].map((importance, i) =>
      track({ trackId: `busy-${i}`, deviceId: 636, importance }),
    )
    const quiet = [track({ trackId: 'q637', deviceId: 637, importance: 0.2 })]
    const rankedOnly = [...busy, ...quiet]
      .toSorted((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
      .slice(0, 4)
    expect(new Set(rankedOnly.map((t) => t.deviceId))).toEqual(new Set([636]))
  })

  it('reports the cameras the quota could not serve', () => {
    const candidates = [636, 637, 1441, 101].map((deviceId) =>
      track({
        trackId: `t-${deviceId}`,
        deviceId,
        importance: deviceId / 2000,
      }),
    )
    const out = selectSummaryTiles(candidates, {
      maxTiles: 2,
      rank: 'importance',
    })
    expect(out.tiles).toHaveLength(2)
    expect(out.camerasContributing).toBe(4)
    expect(out.camerasDropped).toBe(2)
  })

  it('orders the tiles chronologically, whatever the rank was', () => {
    const out = selectSummaryTiles(
      [
        track({ trackId: 'late', firstSeen: 9_000, importance: 0.9 }),
        track({
          trackId: 'early',
          deviceId: 637,
          firstSeen: 1_000,
          importance: 0.1,
        }),
      ],
      { maxTiles: 9, rank: 'importance' },
    )
    expect(out.tiles.map((t) => t.trackId)).toEqual(['early', 'late'])
  })

  it('is reproducible across ties — a retry must deliver the same mosaic', () => {
    const candidates = ['c', 'a', 'b'].map((id) =>
      track({ trackId: id, deviceId: 636, importance: 0.5, firstSeen: 1_000 }),
    )
    const first = selectSummaryTiles(candidates, {
      maxTiles: 2,
      rank: 'importance',
    })
    const second = selectSummaryTiles(candidates.toReversed(), {
      maxTiles: 2,
      rank: 'importance',
    })
    expect(first.tiles.map((t) => t.trackId)).toEqual(second.tiles.map((t) => t.trackId))
  })

  it('ranks by recency and by dwell when asked', () => {
    const candidates = [
      track({ trackId: 'long', deviceId: 636, firstSeen: 0, lastSeen: 60_000 }),
      track({
        trackId: 'recent',
        deviceId: 636,
        firstSeen: 90_000,
        lastSeen: 91_000,
      }),
    ]
    expect(selectSummaryTiles(candidates, { maxTiles: 1, rank: 'recency' }).tiles[0]?.trackId).toBe(
      'recent',
    )
    expect(selectSummaryTiles(candidates, { maxTiles: 1, rank: 'dwell' }).tiles[0]?.trackId).toBe(
      'long',
    )
  })
})

describe('pickSummaryMedia', () => {
  it('ignores a rung the ladder no longer names — the deleted group pointers', () => {
    // `groupCrop` / `nativeFrame` left the ladder with the group entity
    // (2026-09-01). A stale row still wearing one of those kinds must be
    // invisible, never a tile.
    expect(
      pickSummaryMedia([row(1, 'nativeFrame', 1000, null), row(2, 'groupCrop', 1000, null)], 1000),
    ).toBeNull()
  })

  // ── THE REGRESSION (160200681, 2026-08-24 → 2026-08-27) ─────────────
  //
  // The port answers with TRACK rows. If the ladder starts at `keyFrame`,
  // every digest tile is a whole frame. Measured on 60 real tracks
  // (101/102, 24 h): 52 carry a crop, and 11 carry a crop and NO whole-scene
  // rung at all — those 11 were dropped entirely.
  it('prefers the TRACK subject crop over the whole frame — the digest is subjects', () => {
    const picked = pickSummaryMedia(
      [
        row(10, 'keyFrame', 1_000, FRAME_BYTES),
        row(11, 'keyFrameSmall', 1_000, 140_000),
        row(12, 'fullFrame', 1_000, FRAME_BYTES),
        row(13, 'thumbnail', 1_000, CROP_BYTES),
      ],
      1_000,
    )
    expect(picked?.mediaId).toBe(13)
  })

  it('takes the thumbnailSmall downscale before any whole frame', () => {
    const picked = pickSummaryMedia(
      [row(20, 'keyFrame', 1_000, FRAME_BYTES), row(21, 'thumbnailSmall', 1_000, 30_000)],
      1_000,
    )
    expect(picked?.mediaId).toBe(21)
  })

  it('serves the 11-in-60 track that has a crop and NO whole-scene rung', () => {
    const picked = pickSummaryMedia([row(22, 'thumbnail', 1_000, CROP_BYTES)], 1_000)
    expect(picked?.mediaId).toBe(22)
  })

  it('KEEPS the whole-frame fallback for the 2-in-60 track with a frame and no crop', () => {
    const picked = pickSummaryMedia(
      [row(23, 'plateCrop', 100, 8_000), row(24, 'keyFrame', 100, FRAME_BYTES)],
      100,
    )
    expect(picked?.mediaId).toBe(24)
  })

  // ── THE FACE-TEMPLATE DEFENCE ───────────────────────────────────────
  //
  // `copyFaceCropIfTrackHasNoThumbnail` writes the ArcFace 112×112 alignment
  // template under `kind: 'thumbnail'`. Measured: 3 of 52 thumbnails (5.8%)
  // are 3–10 KB templates. Without the floor they would be delivered as
  // digest tiles — faces, in a digest of passages.
  it('DESCENDS past a thumbnail too small to be a crop — that is a face template', () => {
    const picked = pickSummaryMedia(
      [row(30, 'thumbnail', 1_000, 7_400), row(31, 'keyFrame', 1_000, FRAME_BYTES)],
      1_000,
    )
    expect(picked?.mediaId).toBe(31)
  })

  it('descends all the way to null when the ONLY thumbnail is a template', () => {
    expect(pickSummaryMedia([row(32, 'thumbnail', 1_000, 3_100)], 1_000)).toBeNull()
  })

  it('takes the real crop over a template sitting on the same rung', () => {
    const picked = pickSummaryMedia(
      [
        row(33, 'thumbnail', 1_000, 5_000),
        row(34, 'thumbnail', 1_400, CROP_BYTES),
        row(35, 'keyFrame', 1_000, FRAME_BYTES),
      ],
      1_000,
    )
    // Even though the template is CLOSER to the peak: the floor runs before
    // the closest-to-peak reduction, so a template can never win a rung.
    expect(picked?.mediaId).toBe(34)
  })

  it('the floor is exclusive at the boundary and inclusive one byte above', () => {
    expect(
      pickSummaryMedia([row(36, 'thumbnail', 0, SUMMARY_THUMBNAIL_MIN_BYTES - 1)], 0),
    ).toBeNull()
    expect(
      pickSummaryMedia([row(37, 'thumbnail', 0, SUMMARY_THUMBNAIL_MIN_BYTES)], 0)?.mediaId,
    ).toBe(37)
  })

  it('applies the floor ONLY to the rung the template lands on', () => {
    // A legitimately tiny downscale or a small whole frame is not a template
    // and must not be demoted — only `thumbnail` is the kind the face copy
    // writes, so only `thumbnail` is gated.
    expect(pickSummaryMedia([row(38, 'thumbnailSmall', 0, 4_000)], 0)?.mediaId).toBe(38)
    expect(pickSummaryMedia([row(39, 'keyFrame', 0, 4_000)], 0)?.mediaId).toBe(39)
  })

  it('an UNKNOWN size never demotes a row — only a size the index reported', () => {
    expect(pickSummaryMedia([row(40, 'thumbnail', 0, null)], 0)?.mediaId).toBe(40)
  })

  it('never picks a plate crop or a face crop', () => {
    expect(
      pickSummaryMedia([row(41, 'plateCrop', 1000, 9_000), row(42, 'faceCrop', 1000, 6_000)], 1000),
    ).toBeNull()
  })

  it('prefers a native keyFrame over the downscaled and fullFrame variants', () => {
    const picked = pickSummaryMedia(
      [
        row(43, 'fullFrame', 1000, FRAME_BYTES),
        row(44, 'keyFrameSmall', 1000, 140_000),
        row(45, 'keyFrame', 1000, FRAME_BYTES),
      ],
      1000,
    )
    expect(picked?.mediaId).toBe(45)
  })

  it('NEVER picks a boxed frame, whatever else is missing', () => {
    const picked = pickSummaryMedia(
      [row(46, 'fullFrameBoxed', 100, FRAME_BYTES), row(47, 'firstFrame', 100, FRAME_BYTES)],
      100,
    )
    expect(picked).toBeNull()
  })

  it('within a rung takes the row closest to the peak', () => {
    const picked = pickSummaryMedia(
      [
        row(48, 'keyFrame', 1_000, FRAME_BYTES),
        row(49, 'keyFrame', 5_000, FRAME_BYTES),
        row(50, 'keyFrame', 9_000, FRAME_BYTES),
      ],
      5_200,
    )
    expect(picked?.mediaId).toBe(49)
  })

  it('answers null for a track with no usable media', () => {
    expect(pickSummaryMedia([], 0)).toBeNull()
  })
})

describe('frameDedupeKey', () => {
  it('collapses the same camera and the same wall-clock second', () => {
    expect(frameDedupeKey(102, 1_000)).toBe(frameDedupeKey(102, 1_999))
    expect(frameDedupeKey(102, 1_000)).not.toBe(frameDedupeKey(102, 2_000))
    expect(frameDedupeKey(101, 1_000)).not.toBe(frameDedupeKey(102, 1_000))
  })
})
