/**
 * "Vorrei che nelle notifiche ricevo il momento in cui l'occupancy cambia." [I would like the notifications to give me the moment when the occupancy changes.]
 *
 * ## What was wrong
 *
 * An occupancy notification was anchored on `subject.timestamp`, which is when
 * the watcher CONCLUDED the change — never when it happened. A departure is
 * confirmed by an independent read (D279) and on an on-motion camera the
 * confirming evidence only arrives with the periodic parked-object recheck
 * (300 s), on top of the rule's `sustainSeconds`. Measured on device 102 the
 * conclusion ran 6–10 minutes behind the car, so the "posto libero" clip showed
 * an empty space with nothing leaving it.
 *
 * ## What these tests pin
 *
 * 1. The edge dates itself: `observedAt` is the last confirmation of the PARKED
 *    members that vanished on the departing read — the last instant anyone can
 *    honestly point at — and failing that the departing read's own snapshot
 *    `ts`. `timestamp` keeps its exact old meaning beside it.
 * 2. UNKNOWN STAYS UNKNOWN. A snapshot that can date nothing yields no
 *    `observedAt`, and nothing downstream turns that into "now": the anchor
 *    falls back to the conclusion instant and SAYS so on a warn line.
 * 3. The footage cut is centred on the observed moment
 *    (`NcEventMediaRequest.aroundMs`), which is the whole point — that is the
 *    one place a notification chooses which seconds it is about.
 */

import type { CameraOccupancySnapshot, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher, type NcSendInput } from '../dispatcher.js'
import { anchorFellBack, mediaAnchor } from '../media-anchor.js'
import { OccupancyWatcher } from '../occupancy-watcher.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import { subjectFromOccupancyEvent } from '../rule-engine.js'

const DEVICE = 102
const ZONE = 'zone-parking'
const SEC = 1_000
/** The wall clock at which the recheck CONCLUDED the departure. */
const CONCLUDED_AT = 1_786_185_854_852
/** The last frame that confirmed the parked car was still there — eight
 *  minutes earlier, which is the gap the operator was complaining about. */
const LAST_CONFIRMED_AT = CONCLUDED_AT - 8 * 60 * SEC

// ── snapshot fixtures ───────────────────────────────────────────────

function parked(id: string, lastConfirmedAt: number) {
  return {
    id,
    className: 'car',
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    frameWidth: 1920,
    frameHeight: 1080,
    firstSeenAt: lastConfirmedAt - 3_600 * SEC,
    becameStationaryAt: lastConfirmedAt - 3_000 * SEC,
    lastConfirmedAt,
  }
}

function snapshot(opts: {
  readonly ts: number
  readonly members: readonly string[]
  readonly stationary?: readonly ReturnType<typeof parked>[]
}): CameraOccupancySnapshot {
  const count = opts.members.length
  return {
    ts: opts.ts,
    frameWidth: 1920,
    frameHeight: 1080,
    zones: [
      {
        zoneId: ZONE,
        zoneName: "Parking pat'",
        totalObjects: count,
        byClass: { car: count },
        trackIds: opts.members,
      },
    ],
    frame: { totalObjects: count, byClass: { car: count } },
    unzoned: { totalObjects: 0, byClass: {} },
    ...(opts.stationary !== undefined ? { stationaryObjects: opts.stationary } : {}),
  }
}

/** A watcher watching the one zone key, with the level already seeded as
 *  OCCUPIED by a parked car — the ordinary way this rule begins. */
function seededWatcher(seedAt: number): OccupancyWatcher {
  const watcher = new OccupancyWatcher()
  watcher.setWatchedKeys([{ zoneId: ZONE, threshold: 1, sustainSeconds: 0 }])
  watcher.observe(
    DEVICE,
    snapshot({
      ts: LAST_CONFIRMED_AT,
      members: ['stationary:car-1'],
      stationary: [parked('car-1', LAST_CONFIRMED_AT)],
    }),
    seedAt,
  )
  return watcher
}

describe('OccupancyWatcher — the edge dates itself', () => {
  it("dates a parked car's departure to its LAST CONFIRMATION, not to the recheck", () => {
    const watcher = seededWatcher(LAST_CONFIRMED_AT)
    // The 300 s recheck finds the registry no longer listing the car.
    const [edge] = watcher.observe(
      DEVICE,
      snapshot({ ts: CONCLUDED_AT, members: [] }),
      CONCLUDED_AT,
    )
    expect(edge?.occupied).toBe(false)
    // `timestamp` keeps its meaning — the instant the edge committed.
    expect(edge?.timestamp).toBe(CONCLUDED_AT)
    // …and beside it, when it actually happened.
    expect(edge?.observedAt).toBe(LAST_CONFIRMED_AT)
  })

  it('falls back to the DEPARTING READ when nothing parked can date the change', () => {
    const watcher = new OccupancyWatcher()
    watcher.setWatchedKeys([{ zoneId: ZONE, threshold: 1, sustainSeconds: 5 }])
    const seedAt = CONCLUDED_AT - 60 * SEC
    watcher.observe(DEVICE, snapshot({ ts: seedAt, members: ['trk-live'] }), seedAt)
    // The read that ARMS the strike is 5 s before the commit: a live object
    // walked out, no parked entry to date it, so the read itself is the moment.
    const armedAt = CONCLUDED_AT - 5 * SEC
    expect(watcher.observe(DEVICE, snapshot({ ts: armedAt, members: [] }), armedAt)).toHaveLength(0)
    const [edge] = watcher.observe(
      DEVICE,
      snapshot({ ts: CONCLUDED_AT, members: [] }),
      CONCLUDED_AT,
    )
    expect(edge?.timestamp).toBe(CONCLUDED_AT)
    expect(edge?.observedAt).toBe(armedAt)
  })

  it('leaves observedAt ABSENT when the snapshot can date nothing (unknown ≠ now)', () => {
    const watcher = new OccupancyWatcher()
    watcher.setWatchedKeys([{ zoneId: ZONE, threshold: 1, sustainSeconds: 0 }])
    // `ts: 0` is a snapshot with no usable instant, and no parked member either.
    watcher.observe(DEVICE, snapshot({ ts: 0, members: ['trk-live'] }), CONCLUDED_AT - SEC)
    const [edge] = watcher.observe(DEVICE, snapshot({ ts: 0, members: [] }), CONCLUDED_AT)
    expect(edge?.occupied).toBe(false)
    expect(edge?.observedAt).toBeUndefined()
    // …and the subject built from it carries no fabricated instant either.
    expect(subjectFromOccupancyEvent(edge!).observedAt).toBeUndefined()
  })

  it('carries the observed moment onto the rule subject, beside the timestamp', () => {
    const watcher = seededWatcher(LAST_CONFIRMED_AT)
    const [edge] = watcher.observe(
      DEVICE,
      snapshot({ ts: CONCLUDED_AT, members: [] }),
      CONCLUDED_AT,
    )
    const subject = subjectFromOccupancyEvent(edge!)
    expect(subject.timestamp).toBe(CONCLUDED_AT)
    expect(subject.observedAt).toBe(LAST_CONFIRMED_AT)
    // The identity still keys on the CONCLUSION: two edges of one key must stay
    // distinguishable whatever they are dated to.
    expect(subject.recordId.endsWith(`:${CONCLUDED_AT}`)).toBe(true)
  })
})

describe('mediaAnchor — unknown is never now', () => {
  it('anchors on the observed moment when there is one', () => {
    const anchor = mediaAnchor({ timestamp: CONCLUDED_AT, observedAt: LAST_CONFIRMED_AT })
    expect(anchor).toEqual({
      atMs: LAST_CONFIRMED_AT,
      source: 'observed',
      lagMs: CONCLUDED_AT - LAST_CONFIRMED_AT,
    })
    expect(anchorFellBack(anchor, true)).toBe(false)
  })

  it('falls back to the conclusion — and reports that it did — with no moment', () => {
    const anchor = mediaAnchor({ timestamp: CONCLUDED_AT })
    expect(anchor.atMs).toBe(CONCLUDED_AT)
    expect(anchor.source).toBe('concluded')
    expect(anchor.fallback).toBe('unknown')
    expect(anchorFellBack(anchor, true)).toBe(true)
    // A detection has no earlier moment to offer and must not produce a line.
    expect(anchorFellBack(anchor, false)).toBe(false)
  })

  it('refuses a moment that is not BEFORE the conclusion rather than clamping', () => {
    for (const observedAt of [CONCLUDED_AT, CONCLUDED_AT + SEC]) {
      const anchor = mediaAnchor({ timestamp: CONCLUDED_AT, observedAt })
      expect(anchor.atMs).toBe(CONCLUDED_AT)
      expect(anchor.fallback).toBe('not-before-conclusion')
    }
  })

  it('treats a failed measurement as unknown, never as the epoch', () => {
    for (const observedAt of [0, -1, Number.NaN]) {
      expect(mediaAnchor({ timestamp: CONCLUDED_AT, observedAt }).atMs).toBe(CONCLUDED_AT)
    }
  })
})

// ── the cut ─────────────────────────────────────────────────────────

interface SeenRequest {
  readonly aroundMs: number
}

function occupancyEntry(observedAt?: number): NcOutboxEntry {
  const payload: NcOutboxPayload = {
    ruleName: 'Posto libero',
    delivery: 'immediate',
    priority: 3,
    media: 'none',
    mediaGif: true,
    subject: {
      deviceId: DEVICE,
      className: 'car',
      zones: [],
      timestamp: CONCLUDED_AT,
      ...(observedAt !== undefined ? { observedAt } : {}),
      occupancy: {
        zone: ZONE,
        count: 0,
        capacity: 1,
        occupied: false,
      },
    },
  }
  return {
    id: 'rule-occ:occ-1:tgt-1',
    ruleId: 'rule-occ',
    targetId: 'tgt-1',
    deviceId: DEVICE,
    recordKind: 'device-event',
    recordId: 'occ-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: CONCLUDED_AT,
    updatedAt: CONCLUDED_AT,
    payload,
  }
}

function makeDispatcher(now: number, logger: IScopedLogger = makeSilentLogger()) {
  const seen: SeenRequest[] = []
  const sends: NcSendInput[] = []
  const dispatcher = new NcDispatcher({
    logger,
    listTargets: async () => [
      { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'zentik', enabled: true },
    ],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async () => null,
    renderEventMedia: async (req) => {
      seen.push({ aroundMs: req.aroundMs })
      return { gif: Uint8Array.from([1]), mp4: null }
    },
    now: () => now,
  })
  return { dispatcher, seen, sends }
}

describe('NcDispatcher — the cut is centred on the moment it HAPPENED', () => {
  it('asks the broker for the observed moment, not the conclusion', async () => {
    // The conclusion is 4 s old and the observed moment 10 s old — both inside
    // the clip ring, so the difference shows up as the window and not as a skip.
    const observedAt = CONCLUDED_AT - 10 * SEC
    const { dispatcher, seen } = makeDispatcher(CONCLUDED_AT + 4 * SEC)
    await dispatcher.deliver(occupancyEntry(observedAt))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aroundMs).toBe(observedAt)
  })

  it('falls back to the conclusion, loudly, when the row cannot date itself', async () => {
    const lines: string[] = []
    const logger: IScopedLogger = {
      ...makeSilentLogger(),
      warn: (msg: string) => {
        lines.push(msg)
      },
    }
    const { dispatcher, seen } = makeDispatcher(CONCLUDED_AT + 4 * SEC, logger)
    await dispatcher.deliver(occupancyEntry())
    expect(seen[0]?.aroundMs).toBe(CONCLUDED_AT)
    expect(lines).toContain('occupancy footage anchored on the conclusion — moment unknown')
  })

  it('refuses a cut whose observed moment predates the ring, and names that cause', async () => {
    const lines: string[] = []
    const logger: IScopedLogger = {
      ...makeSilentLogger(),
      warn: (msg: string) => {
        lines.push(msg)
      },
    }
    const { dispatcher, seen, sends } = makeDispatcher(CONCLUDED_AT, logger)
    // The real 102 case: the car left eight minutes before anyone concluded it.
    await dispatcher.deliver(occupancyEntry(LAST_CONFIRMED_AT))
    // No cut at all — a gif of the aftermath is worse than no gif, and the line
    // says the ring is the limit rather than blaming a queueing delay.
    expect(seen).toHaveLength(0)
    expect(lines).toContain(
      'footage window predates the clip ring — the moment is older than the ring holds',
    )
    // Still a delivered notification: losing the footage never costs the send.
    expect(sends).toHaveLength(1)
  })
})
