/**
 * `timeline_audit` (#444): per-event media presence with a reason, recording
 * coverage vs event spans, a per-camera summary and a paged failing list.
 * The fake hub only answers what the real read path asks for.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { OpsHub } from '../ops/hub.js'
import {
  gapsWithEvents,
  judgeCoverage,
  mediaProblem,
  mergeIntervals,
  timelineAudit,
} from '../ops/timeline-audit.js'

const NOW = 1_800_000_000_000
const MIN = 60_000

const CursorInput = z.object({ cursor: z.string().optional() })
const TrackInput = z.object({ trackId: z.string() })

const ProblemSchema = z.object({
  kind: z.string(),
  missing: z.array(z.string()).optional(),
  reason: z.string(),
})
const AuditOutSchema = z.object({
  cameras: z.array(
    z.object({
      events: z.number(),
      open: z.number().optional(),
      eventsTruncated: z.boolean().optional(),
      media: z.record(z.string(), z.unknown()).optional(),
      recording: z.record(z.string(), z.unknown()),
      failingEvents: z.number().optional(),
    }),
  ),
  failing: z.object({
    total: z.number(),
    returned: z.number().optional(),
    nextOffset: z.number().nullable(),
    events: z.array(z.object({ fullTrackId: z.string(), problems: z.array(ProblemSchema) })),
  }),
})

async function audit(
  hub: OpsHub,
  args: Parameters<typeof timelineAudit>[1],
): Promise<z.infer<typeof AuditOutSchema>> {
  return AuditOutSchema.parse(await timelineAudit(hub, args, NOW))
}

interface Track {
  trackId: string
  deviceId: number
  className: string
  source: string
  firstSeen: number
  lastSeen: number
  state: string
  active: boolean
}

function track(id: string, ageMin: number, durMin: number, extra: Partial<Track> = {}): Track {
  return {
    trackId: id,
    deviceId: 7,
    className: 'person',
    source: 'video',
    firstSeen: NOW - ageMin * MIN,
    lastSeen: NOW - (ageMin - durMin) * MIN,
    state: 'ended',
    active: false,
    ...extra,
  }
}

const MEDIA: Record<string, string[] | Error> = {
  'full-track-00000': ['thumbnail', 'keyFrame', 'firstFrame', 'lastFrame'],
  'nolast-track-0000': ['thumbnail', 'firstFrame'],
  'zero-track-000000': [],
  'broken-track-0000': new Error('boom'),
}

function fakeHub(opts: { recordingRead?: 'read' | 'unreadable' } = {}): OpsHub & {
  calls: { path: string; input: unknown }[]
} {
  const calls: { path: string; input: unknown }[] = []
  const tracks = [
    track('full-track-00000', 100, 1),
    track('nolast-track-0000', 65, 1),
    track('zero-track-000000', 60, 1),
    track('broken-track-0000', 40, 1),
    track('open-track-00000', 10, 2, { active: true }),
    track('synth-track-0000', 50, 1, { source: 'synthetic' }),
  ]
  return {
    server: 'https://hub.example.test',
    tier: 'admin',
    source: 'session',
    adminHint: null,
    calls,
    async query(path, input) {
      calls.push({ path, input })
      if (path === 'pipelineAnalytics.listRecentTracks') {
        // two pages of three, to prove the cursor is followed
        const cursor = CursorInput.parse(input).cursor
        return cursor === undefined
          ? { tracks: tracks.slice(0, 3), nextCursor: 'c1' }
          : { tracks: tracks.slice(3), nextCursor: null }
      }
      if (path === 'pipelineAnalytics.listTrackMedia') {
        const id = TrackInput.parse(input).trackId
        const kinds = MEDIA[id]
        if (kinds instanceof Error) throw kinds
        return (kinds ?? []).map((kind, i) => ({
          mediaId: i,
          kind,
          sizeBytes: 100,
          timestamp: NOW,
        }))
      }
      if (path === 'recording.listSources') {
        return [{ source: 'camstack', addonId: 'recorder', label: 'CamStack' }]
      }
      if (path === 'recording.getAvailability') {
        return {
          deviceId: 7,
          read: opts.recordingRead ?? 'read',
          // footage from 110 to 70 min ago, then 50 to 0 min ago: a 20 min gap holding two events
          ranges: [
            {
              profile: 'high',
              startMs: NOW - 110 * MIN,
              endMs: NOW - 70 * MIN,
            },
            { profile: 'high', startMs: NOW - 50 * MIN, endMs: NOW },
          ],
          profilesWithFootage: ['high'],
        }
      }
      throw new Error(`unexpected query ${path}`)
    },
    async download() {
      throw new Error('no download')
    },
  }
}

describe('pure coverage and media rules', () => {
  it('merges touching intervals', () => {
    expect(
      mergeIntervals([
        { start: 10, end: 20 },
        { start: 0, end: 10 },
        { start: 30, end: 40 },
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 40 },
    ])
  })

  it('names why a span is not covered', () => {
    const ranges = [{ start: 100_000, end: 200_000 }]
    expect(judgeCoverage({ start: 120_000, end: 130_000 }, ranges)).toEqual({
      covered: true,
    })
    expect(judgeCoverage({ start: 10_000, end: 20_000 }, ranges)).toMatchObject({
      reason: 'before-first-segment',
    })
    expect(judgeCoverage({ start: 300_000, end: 310_000 }, ranges)).toMatchObject({
      reason: 'after-last-segment',
    })
    expect(judgeCoverage({ start: 190_000, end: 260_000 }, ranges)).toMatchObject({
      reason: 'gap',
    })
    expect(judgeCoverage({ start: 1, end: 5_000 }, [])).toMatchObject({
      reason: 'no-recording-at-all',
    })
  })

  it('reports only gaps that hold an event and are long enough', () => {
    const ranges = [
      { start: 0, end: 100 },
      { start: 1_000, end: 2_000 },
      { start: 5_000, end: 6_000 },
    ]
    const gaps = gapsWithEvents(ranges, [{ start: 500, end: 600 }], 500)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ start: 100, end: 1_000, events: 1 })
  })

  it('distinguishes zero media, a missing kind, an empty row and an unreadable index', () => {
    const req = ['thumbnail', 'firstFrame', 'lastFrame'] as const
    expect(mediaProblem({ kinds: new Set(), empty: new Set() }, req)).toMatchObject({
      reason: expect.stringContaining('zero media'),
    })
    expect(
      mediaProblem({ kinds: new Set(['thumbnail', 'firstFrame']), empty: new Set() }, req),
    ).toMatchObject({
      missing: ['lastFrame'],
      reason: expect.stringContaining('never captured'),
    })
    expect(mediaProblem({ kinds: new Set(req), empty: new Set(['thumbnail']) }, req)).toMatchObject(
      {
        missing: ['thumbnail'],
        reason: expect.stringContaining('0 bytes'),
      },
    )
    expect(mediaProblem({ kinds: null, empty: new Set() }, req)).toMatchObject({
      kind: 'media-unreadable',
    })
    expect(mediaProblem({ kinds: new Set(req), empty: new Set() }, req)).toBeNull()
  })
})

describe('timelineAudit', () => {
  it('summarises a camera and lists the failing events with kind and reason', async () => {
    const hub = fakeHub()
    const out = await audit(hub, { deviceIds: [7], days: 1 })
    const cam = out.cameras[0]!
    // synthetic excluded, both cursor pages followed
    expect(cam.events).toBe(5)
    expect(cam.open).toBe(1)
    expect(cam.media).toMatchObject({
      checked: 4,
      unreadable: 1,
      completePct: 33.3,
    })
    expect(cam.recording).toMatchObject({
      read: true,
      eventsCovered: 3,
      eventsUncovered: 2,
    })
    expect(cam.recording['gapsWithEvents']).toHaveLength(1)
    const byId = Object.fromEntries(out.failing.events.map((e) => [e.fullTrackId, e.problems]))
    expect(byId['nolast-track-0000']).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'media', missing: ['lastFrame'] })]),
    )
    expect(byId['zero-track-000000']?.some((p) => p.reason.includes('zero media'))).toBe(true)
    expect(byId['broken-track-0000']?.some((p) => p.kind === 'media-unreadable')).toBe(true)
    // the 65 min and 60 min events fall in the 20 min recording gap
    expect(
      byId['nolast-track-0000']?.some((p) => p.kind === 'recording' && p.reason === 'gap'),
    ).toBe(true)
    expect(byId['full-track-00000']).toBeUndefined()
    expect(hub.calls.filter((c) => c.path === 'pipelineAnalytics.listTrackMedia')).toHaveLength(4)
  })

  it('pages the failing list', async () => {
    const hub = fakeHub()
    const first = await audit(hub, { deviceIds: [7], limit: 1 })
    expect(first.failing.returned).toBe(1)
    expect(first.failing.nextOffset).toBe(1)
    const last = await audit(hub, { deviceIds: [7], limit: 1, offset: first.failing.total - 1 })
    expect(last.failing.nextOffset).toBeNull()
  })

  it('says coverage is unknown, not zero, when the recorder is unreadable', async () => {
    const out = await audit(fakeHub({ recordingRead: 'unreadable' }), { deviceIds: [7] })
    expect(out.cameras[0]?.recording).toMatchObject({ read: false })
    expect(out.failing.events.flatMap((e) => e.problems).some((p) => p.kind === 'recording')).toBe(
      false,
    )
  })

  it('bounds the events read per camera', async () => {
    const hub = fakeHub()
    const out = await audit(hub, { deviceIds: [7], maxEventsPerCamera: 3 })
    expect(out.cameras[0]).toMatchObject({ events: 3, eventsTruncated: true })
  })

  it('reads the media index with a small concurrency limit, not one by one or all at once', async () => {
    const base = fakeHub()
    let inFlight = 0
    let peak = 0
    const hub: OpsHub = {
      ...base,
      async query(path, input) {
        if (path !== 'pipelineAnalytics.listTrackMedia') return base.query(path, input)
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        try {
          return await base.query(path, input)
        } finally {
          inFlight -= 1
        }
      },
    }
    await audit(hub, { deviceIds: [7], days: 1 })
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
  })
})
