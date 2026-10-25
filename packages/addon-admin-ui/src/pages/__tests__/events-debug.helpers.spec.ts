/**
 * The Debug tab's narrowing layer.
 *
 * `addons.custom` is `z.unknown()` at the cap boundary, so everything the tab
 * renders has passed through these guards. Two behaviours matter beyond the
 * happy path:
 *
 *  - a reply that is NOT the promised shape yields `null`, so the tab can say it
 *    could not read it rather than rendering `undefined` into a badge;
 *  - an UNKNOWN finding code still renders. The addon deploys separately from
 *    this bundle, so it will ship a code this build has never heard of, and a
 *    new defect silently not appearing is the worst way to find that out.
 */
import { describe, expect, it } from 'vitest'
import { trackSelectionKey } from '../../components/detection-intelligence/key-events-merge'
import {
  debugExportUrl,
  debugSelectionKey,
  findingLabel,
  formatDuration,
  parseDebugAnalyze,
  parseDebugList,
  resolveSelection,
  sortFindings,
  worstSeverity,
} from '../events-debug.helpers'

const LIST_ITEM = {
  trackId: 'trk-1',
  deviceId: 101,
  className: 'person',
  label: 'postman',
  firstSeen: 1_700_000_000_000,
  lastSeen: 1_700_000_030_000,
  durationMs: 30_000,
  active: false,
}

const REPORT = {
  ...LIST_ITEM,
  positionCount: 12,
  mediaCount: 4,
  mediaKinds: ['keyFrame', 'thumbnail'],
  eventCount: 7,
  findings: [
    { code: 'MISSING_LASTFRAME', severity: 'warn', detail: 'No lastFrame for a closed track.' },
  ],
}

describe('parseDebugList', () => {
  it('narrows a well-formed reply', () => {
    const out = parseDebugList({ tracks: [LIST_ITEM], truncated: false })
    expect(out?.tracks[0]?.trackId).toBe('trk-1')
    expect(out?.tracks[0]?.label).toBe('postman')
    expect(out?.truncated).toBe(false)
  })

  it('accepts an item with no label', () => {
    const { label: _label, ...noLabel } = LIST_ITEM
    expect(
      parseDebugList({ tracks: [noLabel], truncated: false })?.tracks[0]?.label,
    ).toBeUndefined()
  })

  it('returns null for a reply that is not the promised shape', () => {
    expect(parseDebugList(null)).toBeNull()
    expect(parseDebugList({ tracks: [LIST_ITEM] })).toBeNull() // no `truncated`
    expect(parseDebugList({ tracks: 'nope', truncated: false })).toBeNull()
    expect(parseDebugList({ tracks: [{ trackId: 'x' }], truncated: false })).toBeNull()
  })

  it('rejects a numeric field that arrived as a string', () => {
    expect(
      parseDebugList({ tracks: [{ ...LIST_ITEM, deviceId: '101' }], truncated: false }),
    ).toBeNull()
  })
})

describe('parseDebugAnalyze', () => {
  it('narrows reports and the vanished ids', () => {
    const out = parseDebugAnalyze({ reports: [REPORT], vanished: ['gone'] })
    expect(out?.reports[0]?.findings[0]?.code).toBe('MISSING_LASTFRAME')
    expect(out?.reports[0]?.mediaKinds).toEqual(['keyFrame', 'thumbnail'])
    expect(out?.vanished).toEqual(['gone'])
  })

  it('drops ONE unreadable finding without discarding the row', () => {
    const out = parseDebugAnalyze({
      reports: [{ ...REPORT, findings: [REPORT.findings[0], { code: 'X' }] }],
      vanished: [],
    })
    expect(out?.reports[0]?.findings).toHaveLength(1)
  })

  it('returns null when a whole report is malformed', () => {
    expect(parseDebugAnalyze({ reports: [{ trackId: 'x' }], vanished: [] })).toBeNull()
    expect(parseDebugAnalyze({ reports: [REPORT] })).toBeNull()
  })
})

describe('findingLabel', () => {
  it('gives a known code its short label', () => {
    expect(findingLabel('MEDIA_EVICTED_OR_NEVER')).toBe('no media')
    expect(findingLabel('ZERO_POSITIONS')).toBe('no trajectory')
  })

  it('falls back to the code itself for one this build has never seen', () => {
    expect(findingLabel('SOME_FUTURE_CODE')).toBe('SOME_FUTURE_CODE')
  })
})

describe('sortFindings / worstSeverity', () => {
  const findings = [
    { code: 'LOW_BEST_SCORE', severity: 'info' as const, detail: '' },
    { code: 'ZERO_EVENTS', severity: 'error' as const, detail: '' },
    { code: 'MISSING_THUMBNAIL', severity: 'warn' as const, detail: '' },
    { code: 'MISSING_KEYFRAME', severity: 'error' as const, detail: '' },
  ]

  it('orders worst first, then alphabetically', () => {
    expect(sortFindings(findings).map((f) => f.code)).toEqual([
      'MISSING_KEYFRAME',
      'ZERO_EVENTS',
      'MISSING_THUMBNAIL',
      'LOW_BEST_SCORE',
    ])
  })

  it('reports the worst severity, and null for a clean track', () => {
    expect(worstSeverity(findings)).toBe('error')
    expect(worstSeverity([])).toBeNull()
  })
})

describe('debugExportUrl', () => {
  it('asks for every camera when no filter is set', () => {
    expect(debugExportUrl([])).toBe('/addon/pipeline-analytics/debug-export')
  })

  it('carries the selected cameras', () => {
    expect(debugExportUrl([101, 102])).toBe(
      '/addon/pipeline-analytics/debug-export?deviceIds=101,102',
    )
  })
})

describe('formatDuration', () => {
  it('reads a short track to a tenth of a second', () => {
    expect(formatDuration(1_500)).toBe('1.5s')
  })

  it('rounds to whole seconds, then to minutes', () => {
    expect(formatDuration(42_400)).toBe('42s')
    expect(formatDuration(187_000)).toBe('3m 07s')
  })
})

/**
 * The `TrackSubject` mirrors the parse layer materialises.
 *
 * They exist so the shared `EventCard` / `EventDetailPanel` can be handed a
 * debug row directly. The defaults are the honest reading of "the addon told us
 * nothing" \u2014 an unscored track is 0 (no badge), no best event is empty (no
 * tile) \u2014 never an invented value.
 */
describe('the subject fields a debug row carries', () => {
  it('mirrors firstSeen/durationMs onto timestamp/windowMs and marks the row debug', () => {
    const out = parseDebugList({ truncated: false, tracks: [LIST_ITEM] })
    const row = out?.tracks[0]
    expect(row?.timestamp).toBe(LIST_ITEM.firstSeen)
    expect(row?.windowMs).toBe(LIST_ITEM.durationMs)
    expect(row?.debug).toBe(true)
  })

  it('defaults an unreported score to 0 and an unreported best event to empty', () => {
    const out = parseDebugList({ truncated: false, tracks: [LIST_ITEM] })
    expect(out?.tracks[0]?.importance).toBe(0)
    expect(out?.tracks[0]?.bestEventId).toBe('')
  })

  it('carries importance, bestEventId, subLabel and the flags when they ARE reported', () => {
    const out = parseDebugList({
      truncated: false,
      tracks: [
        {
          ...LIST_ITEM,
          importance: 0.62,
          bestEventId: 'evt-9',
          subLabel: 'Turdus migratorius',
          markForTrain: true,
          favourited: false,
          previewMissReason: 'no-key-frame tile=standin',
        },
      ],
    })
    const row = out?.tracks[0]
    expect(row?.importance).toBe(0.62)
    expect(row?.bestEventId).toBe('evt-9')
    expect(row?.subLabel).toBe('Turdus migratorius')
    expect(row?.markForTrain).toBe(true)
    expect(row?.favourited).toBe(false)
    expect(row?.previewMissReason).toBe('no-key-frame tile=standin')
  })
})

describe('the tile provenance on a report', () => {
  function analyze(provenance: unknown) {
    return parseDebugAnalyze({
      reports: [
        {
          ...LIST_ITEM,
          mediaCount: 1,
          mediaKinds: ['thumbnail'],
          eventCount: 1,
          positionCount: 1,
          findings: [],
          thumbnailProvenance: provenance,
        },
      ],
      vanished: [],
    })
  }

  it('carries a known rank through', () => {
    expect(analyze('standin')?.reports[0]?.thumbnailProvenance).toBe('standin')
  })

  it('drops an UNRECOGNISED rank rather than badging a word it cannot check', () => {
    // Assert the report survived FIRST \u2014 "the field is absent" is also true
    // of a reply the parser rejected outright.
    const out = analyze('holographic')
    expect(out?.reports).toHaveLength(1)
    expect(out?.reports[0]?.thumbnailProvenance).toBeUndefined()
  })
})

describe('the selection key', () => {
  it('is byte-identical to the events feed\u2019s \u2014 one idiom, two screens', () => {
    // `trackId` is a per-camera counter: `track-158` exists on every camera, so
    // a bare-id selection un-marks the wrong camera's track.
    expect(debugSelectionKey(101, 'track-158')).toBe(trackSelectionKey(101, 'track-158'))
    expect(debugSelectionKey(101, 'track-158')).not.toBe(debugSelectionKey(102, 'track-158'))
  })

  it('resolves a selection to its targets, deduped, in list order', () => {
    const tracks = parseDebugList({
      truncated: false,
      tracks: [
        LIST_ITEM,
        { ...LIST_ITEM, trackId: 'track-158', deviceId: 102 },
        { ...LIST_ITEM, trackId: 'track-158', deviceId: 101 },
      ],
    })?.tracks
    expect(tracks).toHaveLength(3)
    const selected = new Set([debugSelectionKey(102, 'track-158')])
    expect(resolveSelection(tracks ?? [], selected)).toEqual([
      { deviceId: 102, trackId: 'track-158' },
    ])
  })

  it('selects nothing when nothing is ticked', () => {
    const tracks = parseDebugList({ truncated: false, tracks: [LIST_ITEM] })?.tracks
    expect(tracks).toHaveLength(1)
    expect(resolveSelection(tracks ?? [], new Set())).toEqual([])
  })
})

describe('the new finding labels', () => {
  it('names the two provenance findings in the operator\u2019s words', () => {
    expect(findingLabel('BEST_SHOT_STANDIN')).toBe('stand-in best shot')
    expect(findingLabel('BEST_SHOT_RASTER')).toBe('low-res best shot')
  })
})
