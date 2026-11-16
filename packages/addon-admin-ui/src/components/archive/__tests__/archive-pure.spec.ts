import type { HealthFinding, OpsLogEntry } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { filterActivity, findingItem, opsLogItem } from '../activity-feed'
import { daysUntilFull, growthPerDay, oldestFootage } from '../archive-numbers'
import { archiveRedirectFor } from '../archive-redirects'
import { buildCameraHealth, type HealthStatusFacts } from '../camera-health'
import { mergeCameraRows, summarizeCameraRows, type RowStatusFacts } from '../camera-rows'
import { clusterEvents } from '../event-clusters'

function finding(
  deviceId: number,
  severity: HealthFinding['severity'],
  kind: HealthFinding['kind'] = 'frames-shed',
): HealthFinding {
  return {
    id: `${kind}-${String(deviceId)}`,
    kind,
    severity,
    subject: { type: 'camera', deviceId },
    what: 'w',
    evidence: {},
    action: 'a',
  }
}

function status(deviceId: number, patch: Partial<RowStatusFacts> = {}): RowStatusFacts {
  return {
    deviceId,
    recording: { mode: 'continuous', active: true, storageBytes: 0 },
    switchedOff: [],
    degraded: [],
    ...patch,
  }
}

describe('archiveRedirectFor', () => {
  it('sends every old recordings tab to its Archive place', () => {
    expect(archiveRedirectFor('/recordings', '')).toBe('/archive')
    expect(archiveRedirectFor('/recordings', '?tab=storage')).toBe('/archive')
    expect(archiveRedirectFor('/recordings', '?tab=exports')).toBe('/library?tab=exports')
    expect(archiveRedirectFor('/recordings', '?tab=activity')).toBe('/archive#activity')
    expect(archiveRedirectFor('/recordings', '?tab=management')).toBe('/archive#tools')
    expect(archiveRedirectFor('/recordings', '?tab=unknown')).toBe('/archive')
  })
  it('redirects only the Library events tab', () => {
    expect(archiveRedirectFor('/library', '?tab=events')).toBe('/archive')
    expect(archiveRedirectFor('/library', '?tab=events&section=debug')).toBe('/archive')
    expect(archiveRedirectFor('/library', '?tab=events&section=retrain')).toBe('/addon/training')
    expect(archiveRedirectFor('/library', '?tab=people')).toBeNull()
    expect(archiveRedirectFor('/library', '')).toBeNull()
    expect(archiveRedirectFor('/live', '')).toBeNull()
  })
  it('sends a retired camera page to the Cameras section on that camera', () => {
    expect(archiveRedirectFor('/archive/101', '')).toBe('/archive?section=cameras&camera=101')
    expect(archiveRedirectFor('/archive/101/', '?section=space')).toBe(
      '/archive?section=cameras&camera=101&view=health',
    )
    expect(archiveRedirectFor('/archive/101', '?section=health')).toBe(
      '/archive?section=cameras&camera=101&view=health',
    )
    expect(archiveRedirectFor('/archive/101', '?section=settings')).toBe(
      '/archive?section=cameras&camera=101&view=settings',
    )
    expect(archiveRedirectFor('/archive/101', '?section=events')).toBe(
      '/archive?section=cameras&camera=101&view=review',
    )
    expect(archiveRedirectFor('/archive/101', '?section=review')).toBe(
      '/archive?section=cameras&camera=101&view=review',
    )
    expect(archiveRedirectFor('/archive/101', '?section=exports')).toBe(
      '/library?tab=exports&camera=101',
    )
    expect(archiveRedirectFor('/archive/101', '?section=unknown')).toBe(
      '/archive?section=cameras&camera=101',
    )
    expect(archiveRedirectFor('/archive', '?section=cameras')).toBeNull()
    expect(archiveRedirectFor('/archive/abc', '')).toBeNull()
  })
})

describe('mergeCameraRows', () => {
  const cameras = [
    { id: 1, name: 'Front' },
    { id: 2, name: 'Garage' },
    { id: 3, name: 'Yard' },
  ]
  it('merges footage, events, status and findings per camera', () => {
    const rows = mergeCameraRows({
      cameras,
      footage: [{ deviceId: 1, usedBytes: 500, oldestMs: 10 }],
      events: [{ deviceId: 1, rows: 7, bytes: 70 }],
      statuses: [status(1), status(2, { switchedOff: ['recording'] }), status(3)],
      findings: [finding(3, 'warning')],
    })
    expect(rows[0]).toMatchObject({
      footageBytes: 500,
      oldestMs: 10,
      eventRows: 7,
      state: 'recording',
    })
    expect(rows[1]).toMatchObject({ footageBytes: 0, eventRows: 0, state: 'off' })
    expect(rows[2]).toMatchObject({ state: 'degraded', warnings: 1 })
    expect(summarizeCameraRows(rows)).toEqual({
      recording: 1,
      degraded: 1,
      off: 1,
      unknown: 0,
      warnings: 1,
    })
  })
  it('keeps an unanswered read unknown, never 0, and an unread stage unknown, never off or fine', () => {
    const rows = mergeCameraRows({
      cameras,
      footage: null,
      events: null,
      statuses: [
        status(1, { degraded: [{ stage: 'recording', reason: 'timeout', elapsedMs: 1 }] }),
      ],
      findings: null,
    })
    expect(rows[0]).toMatchObject({ footageBytes: null, eventRows: null, state: 'unknown' })
    expect(rows[1]?.state).toBe('unknown')
  })
  it('does not count info findings or other cameras', () => {
    const rows = mergeCameraRows({
      cameras: [cameras[0] ?? { id: 1, name: 'Front' }],
      footage: [],
      events: [],
      statuses: [status(1)],
      findings: [finding(1, 'info'), finding(2, 'critical')],
    })
    expect(rows[0]).toMatchObject({ warnings: 0, state: 'recording' })
  })
})

describe('buildCameraHealth', () => {
  const full: HealthStatusFacts = {
    recording: { mode: 'events', active: true, storageBytes: 0 },
    motion: { enabled: true, fps: 5 },
    detection: null,
    switchedOff: ['object-detection'],
    degraded: [],
  }
  it('reports a switched-off function off, not broken, and a missing block unknown', () => {
    const h = buildCameraHealth(full, [finding(1, 'critical', 'frames-shed')])
    const by = Object.fromEntries(h.map((x) => [x.fn, x.state]))
    expect(by).toMatchObject({ recording: 'ok', motion: 'ok', detection: 'off' })
    expect(buildCameraHealth(undefined, []).every((x) => x.state === 'unknown')).toBe(true)
  })
  it('puts a finding on the function it concerns', () => {
    const h = buildCameraHealth({ ...full, switchedOff: [] }, [
      finding(1, 'warning', 'motion-without-detections'),
    ])
    expect(h.find((x) => x.fn === 'motion')?.state).toBe('warning')
    expect(h.find((x) => x.fn === 'detection')?.state).toBe('unknown')
  })
})

describe('clusterEvents', () => {
  it('groups events within the gap, newest cluster first', () => {
    const min = 60_000
    const events = [0, 1, 2, 30, 31, 90].map((m) => ({ startMs: m * min }))
    const clusters = clusterEvents(events, (e) => e.startMs, 5 * min)
    expect(clusters.map((c) => c.events.length)).toEqual([1, 2, 3])
    expect(clusters[0]?.fromMs).toBe(90 * min)
    expect(clusters[2]).toMatchObject({ fromMs: 0, toMs: 2 * min })
  })
  it('returns no clusters for no events', () => {
    expect(clusterEvents([], (e: { startMs: number }) => e.startMs)).toEqual([])
  })
})

describe('archive numbers', () => {
  const DAY = 86_400_000
  it('derives growth only from at least a day of history', () => {
    expect(growthPerDay({ footageBytes: 600, oldestMs: 0, nowMs: 3 * DAY })).toBe(200)
    expect(growthPerDay({ footageBytes: 600, oldestMs: 0, nowMs: DAY / 2 })).toBeNull()
    expect(growthPerDay({ footageBytes: null, oldestMs: 0, nowMs: 3 * DAY })).toBeNull()
    expect(growthPerDay({ footageBytes: 0, oldestMs: 0, nowMs: 3 * DAY })).toBe(0)
  })
  it('never invents days of history from an unknown or nil rate', () => {
    expect(daysUntilFull(1000, 100)).toBe(10)
    expect(daysUntilFull(null, 100)).toBeNull()
    expect(daysUntilFull(1000, 0)).toBeNull()
    expect(daysUntilFull(1000, null)).toBeNull()
  })
  it('picks the oldest known footage', () => {
    expect(oldestFootage([{ oldestMs: 50 }, { oldestMs: null }, { oldestMs: 20 }])).toBe(20)
    expect(oldestFootage([{ oldestMs: null }])).toBeNull()
  })
})

describe('activity feed', () => {
  const op: OpsLogEntry = {
    id: 'a',
    at: 100,
    domain: 'recording',
    op: 'prune',
    reason: 'retention',
    deviceId: 1,
    nodeId: 'hub',
    itemsAffected: 1,
    bytesReclaimed: 0,
    detail: null,
    actor: 'system',
  }
  it('merges operations and findings newest first and filters by camera, function and severity', () => {
    const items = [
      opsLogItem(op),
      opsLogItem({ ...op, id: 'b', at: 300, deviceId: 2, domain: 'events' }),
      findingItem(finding(1, 'critical', 'motion-without-detections'), 200),
    ]
    expect(
      filterActivity(items, { deviceId: null, fn: null, minSeverity: null }).map((i) => i.at),
    ).toEqual([300, 200, 100])
    expect(filterActivity(items, { deviceId: 1, fn: null, minSeverity: null })).toHaveLength(2)
    expect(filterActivity(items, { deviceId: null, fn: 'motion', minSeverity: null })).toHaveLength(
      1,
    )
    expect(
      filterActivity(items, { deviceId: null, fn: null, minSeverity: 'warning' }).map(
        (i) => i.source,
      ),
    ).toEqual(['finding'])
  })
})
