/**
 * The live rule STATUS — the two derivations behind a rule card's second line.
 *
 * What is pinned:
 *  - the occupancy status joins TWO substrates and must not let either erase
 *    the other. The probe answers "what is the count", the watcher's confirmed
 *    row answers "since when" — and a camera with no snapshot must still report
 *    the `since` the watcher knows, or the card would say "unknown" about a
 *    condition that has been true for an hour.
 *  - the forward window scan is the mirror of `findLastClosedWindow` and the
 *    only answer to "when does this timelapse run next". Standing INSIDE a
 *    window it must report the NEXT one: "next: now" reads as a render that is
 *    owed and is not.
 */

import type { NcOccupancyCondition, NcSchedule } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcOccupancyProbe } from '../occupancy-dry-run.js'
import { type OccupancyStateRow, occupancyKey } from '../occupancy-watcher.js'
import { subjectFromOccupancyEvent } from '../rule-engine.js'
import { buildGroupedStatus, buildOccupancyStatus } from '../rule-status.js'
import { findNextWindowOpen } from '../timelapse/window-bounds.js'

const CAM = 102
const ZONE = 'z-park'

const condition: NcOccupancyCondition = {
  zoneId: ZONE,
  className: 'vehicle',
  op: '>=',
  count: 2,
  sustainSeconds: 15,
}

function confirmedRow(threshold: number, lastChangeAt: number): OccupancyStateRow {
  return {
    key: occupancyKey(CAM, ZONE, 'vehicle', threshold),
    deviceId: CAM,
    zoneId: ZONE,
    className: 'vehicle',
    threshold,
    confirmedCount: 2,
    occupied: true,
    lastChangeAt,
    updatedAt: lastChangeAt,
  }
}

function probed(count: number, occupied: boolean): NcOccupancyProbe {
  return {
    kind: 'probed',
    subject: subjectFromOccupancyEvent({
      deviceId: CAM,
      zoneId: ZONE,
      zoneName: 'Parking',
      className: 'vehicle',
      count,
      previousCount: count,
      occupied,
      threshold: 2,
      timestamp: 5_000,
    }),
    count,
    threshold: 2,
    zoneName: 'Parking',
    observedAt: 5_000,
  }
}

describe('buildOccupancyStatus', () => {
  it('reports the count, the level and WHEN it last changed', () => {
    const status = buildOccupancyStatus({
      deviceId: CAM,
      condition,
      probe: probed(2, true),
      confirmed: [confirmedRow(2, 1_000)],
      threshold: 2,
    })
    expect(status).toMatchObject({
      kind: 'occupancy',
      deviceId: CAM,
      scope: 'Parking',
      className: 'vehicle',
      threshold: 2,
      sustainSeconds: 15,
      count: 2,
      occupied: true,
      observedAt: 5_000,
      since: 1_000,
    })
  })

  it('joins the confirmed row on the THRESHOLD the condition keys on', () => {
    // A rule at `>= 2` and a rule at `>= 5` on the same zone are two keys, and
    // the watcher holds a row per key. Reading the wrong one would report
    // another rule's history as this rule's.
    const status = buildOccupancyStatus({
      deviceId: CAM,
      condition,
      probe: probed(2, true),
      confirmed: [confirmedRow(5, 9_999)],
      threshold: 2,
    })
    expect(status.since).toBeUndefined()
  })

  it('keeps `since` when the snapshot is unavailable — two substrates, not one', () => {
    const status = buildOccupancyStatus({
      deviceId: CAM,
      condition,
      probe: { kind: 'unavailable', reason: 'no-snapshot' },
      confirmed: [confirmedRow(2, 1_000)],
      threshold: 2,
    })
    expect(status.unavailable).toBe('no-snapshot')
    expect(status.count).toBeUndefined()
    expect(status.since).toBe(1_000)
  })

  it('carries the impossible-class warning verbatim', () => {
    const status = buildOccupancyStatus({
      deviceId: CAM,
      condition,
      probe: probed(0, false),
      confirmed: [],
      threshold: 2,
      warning: 'not a macro class',
    })
    expect(status.warning).toBe('not a macro class')
  })
})

describe('findNextWindowOpen', () => {
  /** Every day, 22:00 → 23:00 UTC. */
  const nightly: NcSchedule = {
    windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 22 * 60, endMinute: 23 * 60 }],
    timezone: 'UTC',
  }
  const DAY = 86_400_000

  it('reports tonight’s opening from the afternoon', () => {
    const noon = Date.UTC(2026, 7, 14, 12, 0, 0)
    const next = findNextWindowOpen({ schedule: nightly, nowMs: noon, lookaheadMs: 2 * DAY })
    expect(next).not.toBeNull()
    expect(new Date(next?.startMs ?? 0).getUTCHours()).toBe(22)
    expect(new Date(next?.endMs ?? 0).getUTCHours()).toBe(23)
  })

  it('reports TOMORROW’s opening while standing inside tonight’s window', () => {
    const inside = Date.UTC(2026, 7, 14, 22, 30, 0)
    const next = findNextWindowOpen({ schedule: nightly, nowMs: inside, lookaheadMs: 2 * DAY })
    expect(next).not.toBeNull()
    expect(next?.startMs ?? 0).toBeGreaterThan(inside + 20 * 3_600_000)
  })

  it('reports the DAILY reopen of a full-day window (the end minute is exclusive)', () => {
    // Worth pinning rather than glossing: `endMinute` is EXCLUSIVE, so a
    // 00:00→23:59 window is inactive for one minute a day and therefore has a
    // real opening. A status that claimed "never runs again" for it would be
    // wrong about the commonest way an operator writes "all day".
    const allDay: NcSchedule = {
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1439 }],
      timezone: 'UTC',
    }
    const next = findNextWindowOpen({
      schedule: allDay,
      nowMs: Date.UTC(2026, 7, 14, 12, 0, 0),
      lookaheadMs: 2 * DAY,
    })
    expect(next).not.toBeNull()
    expect(new Date(next?.startMs ?? 0).getUTCHours()).toBe(0)
  })

  it('returns null for a genuinely always-active schedule — it never opens', () => {
    // An inverted window that matches nothing: active at every instant.
    const always: NcSchedule = {
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 0 }],
      timezone: 'UTC',
      invert: true,
    }
    const next = findNextWindowOpen({
      schedule: always,
      nowMs: Date.UTC(2026, 7, 14, 12, 0, 0),
      lookaheadMs: 2 * DAY,
    })
    expect(next).toBeNull()
  })

  it('returns null when nothing opens inside the horizon', () => {
    // Sundays only, asked on a Monday with a two-day horizon.
    const sundays: NcSchedule = {
      windows: [{ days: [0], startMinute: 60, endMinute: 120 }],
      timezone: 'UTC',
    }
    const monday = Date.UTC(2026, 7, 10, 12, 0, 0)
    expect(
      findNextWindowOpen({ schedule: sundays, nowMs: monday, lookaheadMs: 2 * DAY }),
    ).toBeNull()
  })
})

describe('buildGroupedStatus (D692)', () => {
  const member = (trackId: string, final: boolean) => ({ trackId, final })

  it('reports each open window with its members, what is pending and when it closes at the latest', () => {
    const status = buildGroupedStatus({
      groupingSec: 20,
      windows: [
        {
          key: 'w1',
          deviceId: CAM,
          openedAt: 1_000,
          deadlineAt: 21_000,
          members: [member('a', true), member('b', false), member('c', false)],
        },
      ],
    })
    expect(status).toEqual({
      kind: 'grouped',
      groupingSec: 20,
      openWindows: [
        {
          deviceId: CAM,
          windowKey: 'w1',
          openedAt: 1_000,
          closesAt: 21_000,
          members: 3,
          pending: 2,
        },
      ],
    })
  })

  it('no open window is an empty list — still a grouped answer', () => {
    expect(buildGroupedStatus({ groupingSec: 30, windows: [] })).toEqual({
      kind: 'grouped',
      groupingSec: 30,
      openWindows: [],
    })
  })
})
