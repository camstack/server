/**
 * OUR row of the `recording` device collection (D625).
 *
 * Three things are worth pinning here and nothing else is:
 *
 *  1. **The source id is the reserved one.** It is the picker's DEFAULT, made
 *     structural rather than a sort order. A row that spelled anything else
 *     would leave every surface needing a `?? sources[0]`.
 *  2. **A read that FAILED says so.** `read: 'unreadable'` on the singular
 *     answers, never an empty range list, because a half-converted fleet makes
 *     "nobody looked" common for the length of a deploy and an empty bar is
 *     indistinguishable from a camera with no footage (D393).
 *  3. **A branch that produces no media names why.** `getPlayback` answers
 *     `{ kind: 'none', reason }`, never an `hls` arm with a null URL the player
 *     would fail on silently (D391).
 *
 * Every refusal carries `tags: { deviceId }` — a rollout fault is asked per
 * camera or it cannot be asked at all.
 */
import { recordingsLocationOfMode } from '../roots.js'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { RECORDING_SOURCE_CAMSTACK } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RecordingIndex } from '../../recording-index.js'
import type { SegmentStore } from '../../segment-store.js'
import type { Range, SegmentRow } from '../../types.js'
import type { RecordingConfigsState } from '../config-store.js'
import type { CalendarIndexLike, RecordingProviderDeps } from '../recording-provider.js'
import { buildRecordingSourceProvider } from '../recording-source-provider.js'

const DEVICE = 101
const DAY = Date.UTC(2026, 5, 15, 8, 0, 0)
const WINDOW = { fromMs: Date.UTC(2026, 5, 1), toMs: Date.UTC(2026, 5, 30) }
/** The pin the dispatcher narrows on: an ADDON id, not the source id. */
const OURS = { provider: 'recorder' } as const

interface Warning {
  readonly message: string
  readonly deviceId: unknown
}

function makeLogger(warnings: Warning[]): IScopedLogger {
  const log: IScopedLogger = {
    debug: (): void => undefined,
    info: (): void => undefined,
    error: (): void => undefined,
    warn: (message: string, extras?: LogExtras): void => {
      warnings.push({ message, deviceId: extras?.tags?.['deviceId'] })
    },
    child: (): IScopedLogger => log,
    withTags: (): IScopedLogger => log,
  }
  return log
}

function seg(over: Partial<SegmentRow> = {}): SegmentRow {
  return {
    deviceId: DEVICE,
    profile: 'mid',
    startMs: DAY,
    durMs: 4_000,
    bytes: 2_048,
    path: '101/mid/2026/06/15/08/seg.m4s',
    locationId: 'loc-a',
    ...over,
  }
}

/** A calendar that answers, or one that throws for every read. */
function calendar(opts: {
  readonly throws?: boolean
  readonly ranges?: readonly Range[]
}): CalendarIndexLike {
  const guard = (): void => {
    if (opts.throws === true) throw new Error('calendar rung unavailable')
  }
  const ranges = opts.ranges ?? []
  return {
    localDays: async (): Promise<number[]> => {
      guard()
      return ranges.map((r) => r.startMs)
    },
    dayRanges: async (): Promise<Range[]> => {
      guard()
      return [...ranges]
    },
    rangesIn: async (): Promise<Range[]> => {
      guard()
      return [...ranges]
    },
    availabilityProfileFor: async (): Promise<string | null> => {
      guard()
      return ranges.length > 0 ? 'mid' : null
    },
    servedProfileFor: async (): Promise<string | null> => {
      guard()
      return ranges.length > 0 ? 'mid' : null
    },
    profilesWithFootageFor: async (): Promise<readonly string[]> => {
      guard()
      return ranges.length > 0 ? ['mid'] : []
    },
  }
}

function harness(opts: { segments?: readonly SegmentRow[]; calendar?: CalendarIndexLike } = {}): {
  readonly deps: RecordingProviderDeps
  readonly warnings: Warning[]
} {
  const index = new RecordingIndex()
  for (const s of opts.segments ?? []) index.addSegment(s)
  const warnings: Warning[] = []
  const locations = [
    recordingsLocationOfMode({ id: 'loc-a', type: 'recordings', root: '/recordings/a' }, 'active'),
  ]
  const deps: RecordingProviderDeps = {
    index,
    // Documented type boundary: this spec drives the READ methods only, and
    // they never touch the segment store. A fake with methods on it would be a
    // fake that could answer something production never asked it.
    segmentStore: {} as unknown as SegmentStore,
    nodeId: 'node-1',
    logger: makeLogger(warnings),
    configStore: {} as unknown as RecordingConfigsState,
    locations: () => locations,
    refreshLocations: async () => locations,
    capacity: async () => ({ availableBytes: null, totalBytes: null }),
    hydrateDevice: async () => {},
    dataDir: '/data',
    playbackBaseUrl: () => null,
    ...(opts.calendar ? { calendar: opts.calendar } : {}),
  }
  return { deps, warnings }
}

describe('buildRecordingSourceProvider — listSources', () => {
  it('answers exactly one row, under the RESERVED id', async () => {
    const { deps } = harness({
      segments: [seg()],
      calendar: calendar({ ranges: [{ startMs: DAY, endMs: DAY + 4_000 }] }),
    })
    const rows = await buildRecordingSourceProvider(deps).listSources({ deviceId: DEVICE })

    expect(rows).toHaveLength(1)
    // The picker's default IS this value. A row spelling anything else would
    // leave every surface needing a first-row fallback.
    expect(rows[0]?.source).toBe(RECORDING_SOURCE_CAMSTACK)
    expect(rows[0]?.availability.state).toBe('ok')
  })

  it('says `index-empty` only when the CALENDAR says the archive holds nothing', async () => {
    const { deps } = harness({ calendar: calendar({ ranges: [] }) })
    const rows = await buildRecordingSourceProvider(deps).listSources({ deviceId: DEVICE })

    expect(rows[0]?.availability.state).toBe('index-empty')
  })

  it('does NOT claim `index-empty` off the resident index when there is no calendar', async () => {
    // `deps.index` answers about what is RESIDENT, not what EXISTS (D295):
    // reading emptiness out of it is how 1.9 TB once reported 60.5 GB. With no
    // calendar rung the source makes no claim and the coverage read speaks.
    const { deps } = harness()
    const rows = await buildRecordingSourceProvider(deps).listSources({ deviceId: DEVICE })

    expect(rows[0]?.availability.state).toBe('ok')
  })

  it('says `unreachable`, with the reason, when the archive could not be asked', async () => {
    const { deps, warnings } = harness({ calendar: calendar({ throws: true }) })
    const rows = await buildRecordingSourceProvider(deps).listSources({ deviceId: DEVICE })

    // NOT `index-empty`: "nobody could look" and "there is nothing here" are
    // different claims and the picker draws them differently.
    expect(rows[0]?.availability.state).toBe('unreachable')
    expect(rows[0]?.availability.reason).toContain('calendar rung unavailable')
    expect(warnings.map((w) => w.deviceId)).toEqual([DEVICE])
  })
})

describe('buildRecordingSourceProvider — a read that failed is never an empty answer', () => {
  it('marks availability `unreadable` and tags the camera', async () => {
    const { deps, warnings } = harness({ calendar: calendar({ throws: true }) })
    const answer = await buildRecordingSourceProvider(deps).getAvailability({
      deviceId: DEVICE,
      ...OURS,
      ...WINDOW,
    })

    expect(answer.read).toBe('unreadable')
    expect(answer.ranges).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.deviceId).toBe(DEVICE)
  })

  it('marks days `unreadable` and tags the camera', async () => {
    const { deps, warnings } = harness({ calendar: calendar({ throws: true }) })
    const answer = await buildRecordingSourceProvider(deps).getDaysWithRecordings({
      deviceId: DEVICE,
      ...OURS,
      ...WINDOW,
      tzOffsetMinutes: 0,
    })

    expect(answer.read).toBe('unreadable')
    expect(answer.days).toEqual([])
    expect(warnings[0]?.deviceId).toBe(DEVICE)
  })

  it('marks a SUCCESSFUL empty answer `read` — emptiness is then a claim', async () => {
    const { deps, warnings } = harness()
    const answer = await buildRecordingSourceProvider(deps).getAvailability({
      deviceId: DEVICE,
      ...OURS,
      ...WINDOW,
    })

    expect(answer.read).toBe('read')
    expect(answer.ranges).toEqual([])
    expect(warnings).toHaveLength(0)
  })
})

describe('buildRecordingSourceProvider — getPlayback names why it produced nothing', () => {
  it('answers `none` with a reason when no footage covers the window', async () => {
    const { deps } = harness()
    const playback = await buildRecordingSourceProvider(deps).getPlayback({
      deviceId: DEVICE,
      ...OURS,
      ...WINDOW,
    })

    // Never an `hls` arm carrying a null URL: a branch that produces no media
    // names the reason, or the operator files it as a broken player (D391).
    expect(playback.kind).toBe('none')
    expect(playback.kind === 'none' && playback.reason.length).toBeGreaterThan(0)
  })
})
