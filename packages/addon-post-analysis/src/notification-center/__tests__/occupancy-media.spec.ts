/**
 * The occupancy edge's picture — a ZoneAnalytics count crossing carrying media.
 *
 * ## What was wrong
 *
 * An occupancy notification was text-only, always. `subjectFromOccupancyEvent`
 * set no `trackId`, so `buildEntries` froze no media owner onto the outbox
 * payload and the dispatcher's attachment ladder had nothing to resolve — even
 * though the snapshot that produced the edge lists, per zone, the trackIds of
 * the very objects being counted.
 *
 * ## What fixes it, and what does NOT
 *
 * NOT a new photograph taken at delivery time, and NOT an occupancy branch in
 * the dispatcher. The watcher already sees the members at commit; the edge
 * names ONE of them and the notification resolves it through
 * `getMediaForOwner('track', …)` — the same call a doorbell's still comes out
 * of (`device-event-media.spec.ts`).
 *
 * The owner rule is "the ARRIVAL": a member that was not in the scope at the
 * last confirmed-level sample is the object that caused the crossing. With no
 * arrival (a level that grew before the watcher was cold-started, a became-free
 * edge that still has members) the most recently listed member stands in.
 *
 * ## …and when the scope is EMPTY (2026-08-18)
 *
 * "Posto libero" is the notification the operator most wants a picture on, and
 * it is the one edge that can never own one: the vehicle whose departure is the
 * news has left, so there is no member, no crop, and nothing for the ladder to
 * resolve — `no still could be resolved … owners=[]`, live on camera 102.
 *
 * The fallback is the SOUND's, not a new mechanism: photograph the camera at
 * the edge and hold the bytes on the shared still shelf (`still-shelf.ts`), the
 * subject naming the shelf's owner id on `trackId`. A picture of the empty
 * parking space IS the news. The gate is exact — only an edge that owns no
 * member track, and only when a rule that would actually fire on THIS edge asks
 * for a still.
 */
import type { InMemoryRecords } from '@camstack/types'
import type {
  CameraOccupancySnapshot,
  MediaFile,
  NcRuleInput,
  OccupancyLookAnswer,
  OccupancyLookRequest,
  SensorEvent,
} from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import { makeTestMediaFile } from '../../__tests__/support/media-file.js'
import { completeLoggerStub, ncPruneWindowsPort, makeNcRecords } from './support/nc-test-deps.js'
import { NotificationCenter } from '../index.js'
import { chooseOccupancyMediaOwner, OccupancyWatcher } from '../occupancy-watcher.js'
import { NC_DEPARTURE_STILL_LEAD_MS } from '../still-shelf.js'
import { subjectFromOccupancyEvent } from '../rule-engine.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CALLER = { userId: 'admin-42', isAdmin: true }
const NOW = 1_786_185_854_852
const CAMERA = 101
const ZONE = 'zone-cortile'

const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q=='

// ── snapshot fixtures ───────────────────────────────────────────────

function snapshot(members: readonly string[], count = members.length): CameraOccupancySnapshot {
  return {
    ts: NOW,
    frameWidth: 1920,
    frameHeight: 1080,
    zones: [
      {
        zoneId: ZONE,
        zoneName: 'Cortile',
        totalObjects: count,
        byClass: { person: count },
        trackIds: members,
      },
    ],
    frame: { totalObjects: count, byClass: { person: count } },
    unzoned: { totalObjects: 0, byClass: {} },
  }
}

// ── the pure owner choice ───────────────────────────────────────────

describe('chooseOccupancyMediaOwner', () => {
  it('prefers the ARRIVAL — the member that was not there before the edge', () => {
    expect(chooseOccupancyMediaOwner(['trk-old', 'trk-new'], ['trk-old'])).toBe('trk-new')
  })

  it('falls back to the most recently listed member when nobody arrived', () => {
    expect(chooseOccupancyMediaOwner(['trk-a', 'trk-b'], ['trk-a', 'trk-b'])).toBe('trk-b')
  })

  it('names nobody when the scope is empty — a became-free edge is text-only', () => {
    expect(chooseOccupancyMediaOwner([], ['trk-a'])).toBeUndefined()
  })

  it('never names a parked object: `stationary:` ids own no track media', () => {
    expect(chooseOccupancyMediaOwner(['stationary:parked-car'], [])).toBeUndefined()
    expect(chooseOccupancyMediaOwner(['stationary:parked-car', 'trk-a'], [])).toBe('trk-a')
  })
})

// ── the watcher freezes the owner onto the committed edge ───────────

describe('the committed edge names its media owner', () => {
  it('carries the arrival of a became-occupied edge', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ zoneId: ZONE, className: 'person', threshold: 1, sustainSeconds: 0 }])
    // A confirmed-level sample first (nobody in the zone) — the baseline the
    // arrival is measured against.
    expect(w.observe(CAMERA, snapshot([]), NOW)).toEqual([])
    const [edge] = w.observe(CAMERA, snapshot(['trk-a']), NOW + 1_000)
    expect(edge?.occupied).toBe(true)
    expect(edge?.mediaTrackId).toBe('trk-a')
  })

  // D691: a departure's picture is the subject that LEFT. The empty zone has
  // nobody to name, but the confirmed-level baseline does — the track whose
  // departure IS the news, and whose best shot was taken on its way out.
  it('names the member that LEFT on a became-free edge (D691)', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ zoneId: ZONE, className: 'person', threshold: 1, sustainSeconds: 0 }])
    w.observe(CAMERA, snapshot(['trk-a']), NOW)
    const [edge] = w.observe(CAMERA, snapshot([]), NOW + 1_000)
    expect(edge?.occupied).toBe(false)
    expect(edge?.mediaTrackId).toBe('trk-a')
  })

  it('prefers the member that left over one that stayed (D691)', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ zoneId: ZONE, className: 'person', threshold: 2, sustainSeconds: 0 }])
    w.observe(CAMERA, snapshot(['trk-a', 'trk-b']), NOW)
    const [edge] = w.observe(CAMERA, snapshot(['trk-b']), NOW + 1_000)
    expect(edge?.occupied).toBe(false)
    expect(edge?.mediaTrackId).toBe('trk-a')
  })

  it('names nobody when the only one that left was a PARKED entry — it owns no track media', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ zoneId: ZONE, className: 'person', threshold: 1, sustainSeconds: 0 }])
    w.observe(CAMERA, snapshot(['stationary:car']), NOW)
    const [edge] = w.observe(CAMERA, snapshot([]), NOW + 1_000)
    expect(edge?.occupied).toBe(false)
    expect(edge?.mediaTrackId).toBeUndefined()
  })

  it('a became-occupied edge never names a member that left — only who is there', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ zoneId: ZONE, className: 'person', threshold: 1, sustainSeconds: 0 }])
    w.observe(CAMERA, snapshot(['trk-gone'], 0), NOW)
    const [edge] = w.observe(CAMERA, snapshot(['stationary:car']), NOW + 1_000)
    expect(edge?.occupied).toBe(true)
    expect(edge?.mediaTrackId).toBeUndefined()
  })
})

describe('subjectFromOccupancyEvent', () => {
  it('names the edge’s media owner as the subject trackId', () => {
    const s = subjectFromOccupancyEvent({
      deviceId: CAMERA,
      zoneId: ZONE,
      zoneName: 'Cortile',
      className: 'person',
      count: 1,
      previousCount: 0,
      occupied: true,
      threshold: 1,
      timestamp: NOW,
      mediaTrackId: 'trk-a',
    })
    expect(s.trackId).toBe('trk-a')
  })

  it('leaves it absent when the edge named nobody', () => {
    const s = subjectFromOccupancyEvent({
      deviceId: CAMERA,
      count: 0,
      previousCount: 1,
      occupied: false,
      threshold: 1,
      timestamp: NOW,
    })
    expect(s.trackId).toBeUndefined()
  })
})

// ── live path ───────────────────────────────────────────────────────

interface LoggedLine {
  readonly level: 'info' | 'warn' | 'debug' | 'error'
  readonly message: string
  readonly tags?: Record<string, unknown>
  readonly meta?: Record<string, unknown>
}

interface Harness {
  readonly center: NotificationCenter
  readonly store: FakeSettingsStore
  readonly world: InMemoryRecords
  readonly sends: NcSendInput[]
  readonly lines: LoggedLine[]
  readonly mediaLookups: string[]
  /** Every camera the still shelf photographed, in order. */
  readonly snapshots: number[]
  /** Every past-instant still the shelf asked the ring for (D691). */
  readonly pastStills: Array<{ deviceId: number; atMs: number }>
  /** Every early occupancy look the centre asked the orchestrator for (D691). */
  readonly looks: OccupancyLookRequest[]
  /** What the orchestrator answers. */
  /** An `Error` makes the ask REJECT (an orchestrator older than D691). */
  lookAnswer: OccupancyLookAnswer | Error
}

/** The snapshot cap, as the centre is wired with it. */
type FakeSnapshot = (deviceId: number) => Promise<{ base64: string; contentType: string } | null>

/** The track alias store (D683): absorbed id → survivor. An `Error` makes
 *  every lookup REJECT (an alias-store outage). */
type FakeAliases = ReadonlyMap<string, string> | Error

/** The ring still at a past instant (D691), as the centre is wired with it. */
type FakePastStill = (
  deviceId: number,
  atMs: number,
) => Promise<{ base64: string; contentType: string } | null>

function freeRule(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'Posto libero',
    delivery: 'device-event',
    targets: [{ targetId: 'zentik' }],
    conditions: {
      devices: [CAMERA],
      occupancy: {
        zoneId: ZONE,
        className: 'person',
        op: 'became-free',
        count: 1,
        sustainSeconds: 0,
      },
    },
    media: { attach: 'best' },
    throttle: { cooldownSec: 0, scope: 'rule-device' },
    ...overrides,
  })
}

function occupancyRule(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'Cortile occupato',
    delivery: 'device-event',
    targets: [{ targetId: 'zentik' }],
    conditions: {
      devices: [CAMERA],
      occupancy: {
        zoneId: ZONE,
        className: 'person',
        op: 'became-occupied',
        count: 1,
        sustainSeconds: 0,
      },
    },
    media: { attach: 'best' },
    throttle: { cooldownSec: 0, scope: 'rule-device' },
    ...overrides,
  })
}

function trackMedia(): readonly MediaFile[] {
  return [
    makeTestMediaFile({
      kind: 'keyFrameSmall',
      base64: TINY_JPEG_B64,
      sizeBytes: 640,
      timestamp: NOW,
    }),
  ]
}

function makeHarness(
  mediaByOwner: ReadonlyMap<string, readonly MediaFile[]>,
  getSnapshot?: FakeSnapshot,
  getPastStill?: FakePastStill,
  aliases?: FakeAliases,
): Harness {
  const store = makeFakeSettingsStore()
  const world = makeNcRecords()
  const sends: NcSendInput[] = []
  const lines: LoggedLine[] = []
  const mediaLookups: string[] = []
  const snapshots: number[] = []
  const pastStills: Array<{ deviceId: number; atMs: number }> = []
  const looks: OccupancyLookRequest[] = []
  const answer: { current: OccupancyLookAnswer | Error } = {
    current: { scheduled: true, dueInMs: 0 },
  }
  const record =
    (level: LoggedLine['level']) =>
    (
      message: string,
      opts?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
    ): void => {
      lines.push({
        level,
        message,
        ...(opts?.tags ? { tags: opts.tags } : {}),
        ...(opts?.meta ? { meta: opts.meta } : {}),
      })
    }
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: (): unknown => logger,
  }
  const targets: NcTargetRef[] = [
    { id: 'zentik', addonId: 'notifiers', name: 'Zentik', kind: 'zentik', enabled: true },
  ]
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: completeLoggerStub(logger),
    pruneWindows: ncPruneWindowsPort(),
    listUsers: async () => [],
    getDeviceRoute: async () => null,
    ...(getSnapshot !== undefined
      ? {
          getSnapshot: async (deviceId: number) => {
            snapshots.push(deviceId)
            return getSnapshot(deviceId)
          },
        }
      : {}),
    ...(getPastStill !== undefined
      ? {
          getPastStill: async (deviceId: number, atMs: number) => {
            pastStills.push({ deviceId, atMs })
            return getPastStill(deviceId, atMs)
          },
        }
      : {}),
    ...(aliases !== undefined
      ? {
          resolveTrackAlias: async (id: string) => {
            if (aliases instanceof Error) throw aliases
            return aliases.get(id) ?? null
          },
        }
      : {}),
    requestOccupancyLook: async (ask: OccupancyLookRequest) => {
      looks.push(ask)
      const current = answer.current
      if (current instanceof Error) throw current
      return current
    },
    dispatcher: {
      listTargets: async () => targets,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async (ownerKind, ownerId) => {
        mediaLookups.push(`${ownerKind}:${ownerId}`)
        return mediaByOwner.get(ownerId) ?? []
      },
      renderEventMedia: async () => ({ gif: null, mp4: null }),
      getDeviceName: async () => 'Cortile',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    now: () => NOW,
    drainIntervalMs: 5,
    ruleReloadIntervalMs: 3_600_000,
  })
  const h: Harness = {
    center,
    store,
    world,
    sends,
    lines,
    mediaLookups,
    snapshots,
    pastStills,
    looks,
    get lookAnswer() {
      return answer.current
    },
    set lookAnswer(value: OccupancyLookAnswer | Error) {
      answer.current = value
    },
  }
  return h
}

/** The rule is created BEFORE `start`, because the watched occupancy key set is
 *  recomputed on boot and on the (long) reload tick. */
async function boot(
  mediaByOwner: ReadonlyMap<string, readonly MediaFile[]>,
  rules: readonly NcRuleInput[] = [occupancyRule()],
  getSnapshot?: FakeSnapshot,
  getPastStill?: FakePastStill,
  aliases?: FakeAliases,
): Promise<Harness> {
  const h = makeHarness(mediaByOwner, getSnapshot, getPastStill, aliases)
  for (const rule of rules) {
    await h.center.buildProvider().createRule({ rule, caller: CALLER })
  }
  await h.center.start({ evaluation: true })
  return h
}

/** The media owner the subject named, as the match line reports it. */
function stillOwnerOf(h: Harness): string {
  const line = h.lines.find((l) => l.message === 'rule matched — enqueueing')
  const trackId = line?.meta?.['trackId']
  return typeof trackId === 'string' ? trackId : ''
}

/** How many occupancy edges the watcher has committed so far. */
function committedEdges(h: Harness): number {
  return h.lines.filter((l) => l.message === 'occupancy edge committed').length
}

const camera: FakeSnapshot = async () => ({
  base64: TINY_JPEG_B64,
  contentType: 'image/jpeg',
})

/** The ring answers any past instant with a frame. */
const pastRing: FakePastStill = async () => ({
  base64: TINY_JPEG_B64,
  contentType: 'image/jpeg',
})

/** When the parked car was last confirmed — the departure's honest date. */
const PARKED_CONFIRMED_AT = NOW - 20_000

/** A zone holding only PARKED entries (`stationary:<id>`), each last confirmed
 *  at `confirmedAt` (0 = never: the entry cannot date a departure). */
function parkedSnapshot(ids: readonly string[], confirmedAt: number): CameraOccupancySnapshot {
  const base = snapshot(ids.map((id) => `stationary:${id}`))
  return {
    ...base,
    stationaryObjects: ids.map((id) => ({
      id,
      className: 'person',
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      frameWidth: 1920,
      frameHeight: 1080,
      firstSeenAt: confirmedAt,
      becameStationaryAt: confirmedAt,
      lastConfirmedAt: confirmedAt,
    })),
  }
}

describe('an occupancy notification carries the counted object’s picture', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('attaches the still resolved from the member track — no occupancy branch', async () => {
    h = await boot(new Map([['trk-a', trackMedia()]]))

    h.center.observeOccupancy(CAMERA, snapshot([]))
    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))

    const attachments = h.sends[0]?.notification.attachments ?? []
    expect(attachments.map((a) => a.mediaType)).toEqual(['image'])
    // THE discriminating assertion: the frame came out of the ordinary
    // media-owner lookup, addressed to the member TRACK. Remove the trackId
    // from the occupancy subject and this list is empty.
    expect(h.mediaLookups).toContain('track:trk-a')
  })

  it('a became-free edge on a node with NO snapshot cap ships text-only, and is NOT reported as a defect', async () => {
    // The bogus-warning guard: `device event has no marker track` is a real
    // defect report for a sensor press, and nonsense for an occupancy edge —
    // an empty zone has nobody to photograph, by construction.
    //
    // No `getSnapshot` is wired here, so the still shelf does not exist and
    // there is nothing to fall back to either. Text-only is then the whole
    // truth, and this is the one state in which it still is.
    h = await boot(new Map(), [
      occupancyRule({
        name: 'Cortile libero',
        conditions: {
          devices: [CAMERA],
          occupancy: {
            zoneId: ZONE,
            className: 'person',
            op: 'became-free',
            count: 1,
            sustainSeconds: 0,
          },
        },
      }),
    ])

    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    h.center.observeOccupancy(CAMERA, snapshot([]))
    // The edge names the departed `trk-a` (D691), which owns no media here:
    // the dispatcher's bounded still-wait runs before it ships text-only.
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(h.sends[0]?.notification.attachments).toBeUndefined()
    expect(h.lines.filter((l) => l.message.includes('no marker track'))).toEqual([])
  })

  it('the rule tester’s occupancy injection carries a still, like production now does', async () => {
    // `triggerCanCarryStill` used to answer `unattachable` for occupancy, and it
    // was right to: the payload froze no owner. It does now, so the tester must
    // stand in for that member track rather than describe a production that no
    // longer exists.
    h = await boot(new Map())

    const result = await h.center.injectTestEvent(
      {
        trigger: 'occupancy-event',
        deviceId: CAMERA,
        classNames: ['person'],
        zones: [],
        occupancy: {
          zoneId: ZONE,
          zoneName: 'Cortile',
          className: 'person',
          count: 1,
          previousCount: 0,
          occupied: true,
          threshold: 1,
        },
        bypassCooldown: false,
        bypassMute: false,
        runActions: false,
        still: 'live',
      },
      { getSnapshot: async () => ({ base64: TINY_JPEG_B64, contentType: 'image/jpeg' }) },
    )

    expect(result.still).toBe('live')
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))
    expect(h.sends[0]?.notification.attachments?.map((a) => a.mediaType)).toEqual(['image'])
  })

  it('NEUTRALISATION: a real device event with no marker still warns', async () => {
    // The other half of the pair. If the suppression is written too widely (any
    // subject, any kind) this line disappears and the doorbell regression of
    // 2026-08-08 becomes invisible again.
    h = await boot(new Map(), [
      NcRuleInputSchema.parse({
        name: 'Campanello',
        delivery: 'device-event',
        targets: [{ targetId: 'zentik' }],
        conditions: { devices: [CAMERA], sensorKinds: ['doorbell'] },
        media: { attach: 'best' },
      }),
    ])
    const press: SensorEvent = {
      id: 'pa-sensor-1',
      deviceId: CAMERA,
      sourceDeviceId: CAMERA,
      kind: 'doorbell',
      value: { lastPressedAt: NOW },
      timestamp: NOW,
    }

    h.center.onSensorEventPersisted(press)
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))

    const line = h.lines.find((l) => l.message.includes('no marker track'))
    expect(line?.level).toBe('warn')
    expect(line?.tags).toEqual({ deviceId: CAMERA })
  })
})

// ── the empty scope's fallback: a live PHOTOGRAPH ────────────────────

describe('an occupancy edge that owns nobody falls back to a photograph of the camera', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('“posto libero” (D691): the picture is the car that LEFT, never the empty space', async () => {
    h = await boot(new Map([['trk-a', trackMedia()]]), [freeRule()], camera, pastRing)

    h.center.observeOccupancy(CAMERA, snapshot([]))
    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    // Nobody photographed the camera at the commit: the departed track owns it.
    expect(h.snapshots).toEqual([])
    expect(h.pastStills).toEqual([])
    expect(stillOwnerOf(h)).toBe('trk-a')
    expect(h.mediaLookups).toContain('track:trk-a')
    expect(h.sends[0]?.notification.attachments?.map((a) => a.mediaType)).toEqual(['image'])
  })

  it('a PARKED departure is a ring still at the moment it left, never a live photo (D691)', async () => {
    h = await boot(new Map(), [freeRule()], camera, pastRing)

    h.center.observeOccupancy(CAMERA, parkedSnapshot(['car'], PARKED_CONFIRMED_AT))
    h.center.observeOccupancy(CAMERA, parkedSnapshot([], PARKED_CONFIRMED_AT))
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    // The departure is dated on the parked entry's last confirmation, and the
    // picture is cut from the ring a lead BEFORE it — the car still there.
    expect(h.pastStills).toEqual([
      { deviceId: CAMERA, atMs: PARKED_CONFIRMED_AT - NC_DEPARTURE_STILL_LEAD_MS },
    ])
    expect(h.snapshots).toEqual([])
    expect(stillOwnerOf(h)).toMatch(/^nc-still:/)
    expect(h.sends[0]?.notification.attachments?.map((a) => a.mediaType)).toEqual(['image'])
  })

  it('with no ring still to cut, a departure ships NO picture of the empty space, and says why', async () => {
    h = await boot(new Map(), [freeRule()], camera)

    h.center.observeOccupancy(CAMERA, parkedSnapshot(['car'], PARKED_CONFIRMED_AT))
    h.center.observeOccupancy(CAMERA, parkedSnapshot([], PARKED_CONFIRMED_AT))
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(h.snapshots).toEqual([])
    expect(h.sends[0]?.notification.attachments).toBeUndefined()
    const line = h.lines.find((l) => l.message.startsWith('occupancy departure still: none'))
    expect(line?.level).toBe('warn')
    expect(line?.tags).toEqual({ deviceId: CAMERA })
    expect(line?.meta?.['reason']).toBe('no-ring-still')
  })

  it('an UNDATED departure is not photographed at all — the moment is unknown', async () => {
    h = await boot(new Map(), [freeRule()], camera, pastRing)

    h.center.observeOccupancy(CAMERA, { ...parkedSnapshot(['car'], 0), ts: 0 })
    h.center.observeOccupancy(CAMERA, { ...parkedSnapshot([], 0), ts: 0 })
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(h.pastStills).toEqual([])
    expect(h.snapshots).toEqual([])
    const line = h.lines.find((l) => l.message.startsWith('occupancy departure still: none'))
    expect(line?.meta?.['reason']).toBe('moment-unknown')
  })

  it('an edge that already owns a member track is never photographed', async () => {
    // One derivation per picture: an occupied edge names the object it counted,
    // and photographing over it would answer a different question with a worse
    // frame.
    h = await boot(new Map([['trk-a', trackMedia()]]), [occupancyRule()], camera)

    h.center.observeOccupancy(CAMERA, snapshot([]))
    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(h.snapshots).toEqual([])
    expect(h.mediaLookups).toContain('track:trk-a')
    expect(h.sends[0]?.notification.attachments?.map((a) => a.mediaType)).toEqual(['image'])
  })

  it('an edge no enabled rule would fire on photographs nothing', async () => {
    // The watcher commits BOTH polarities of a watched key, so a rule that only
    // asks about arrivals still produces the free edge. Photographing it would
    // be a snapshot no notification can ever carry.
    h = await boot(new Map([['trk-a', trackMedia()]]), [occupancyRule()], camera)

    h.center.observeOccupancy(CAMERA, snapshot([]))
    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await vi.waitFor(() => expect(committedEdges(h)).toBe(2), { timeout: 8_000 })
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(h.snapshots).toEqual([])
  })

  it('a rule that EXCLUDES the camera (D641) photographs nothing and sends nothing', async () => {
    const occupancy = freeRule().conditions.occupancy
    h = await boot(
      new Map(),
      [freeRule({ conditions: { occupancy, devicesExclude: [CAMERA] } })],
      camera,
    )

    h.center.observeOccupancy(CAMERA, snapshot([]))
    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await vi.waitFor(() => expect(committedEdges(h)).toBe(2), { timeout: 8_000 })
    await new Promise((r) => setTimeout(r, 100))

    expect(h.snapshots).toEqual([])
    expect(h.sends).toHaveLength(0)
  })

  it('a rule that wants no still photographs nothing', async () => {
    h = await boot(new Map(), [freeRule({ media: { attach: 'none' } })], camera)

    h.center.observeOccupancy(CAMERA, snapshot([]))
    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(h.snapshots).toEqual([])
    expect(h.sends[0]?.notification.attachments).toBeUndefined()
  })

  it('a camera that does not answer costs the picture, never the notification', async () => {
    // An ARRIVAL that owns nobody (every member parked) is still photographed
    // live — the subject is there now. Only a departure moved to the ring.
    h = await boot(new Map(), [occupancyRule()], async () => {
      throw new Error('camera offline')
    })

    h.center.observeOccupancy(CAMERA, snapshot([]))
    h.center.observeOccupancy(CAMERA, snapshot(['stationary:car']))
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 10_000 })

    expect(h.sends[0]?.notification.attachments).toBeUndefined()
    const line = h.lines.find((l) => l.message.includes('occupancy still'))
    expect(line?.level).toBe('warn')
    // Grouped by CAMERA — the question always arrives as "why did 102 …".
    expect(line?.tags).toEqual({ deviceId: CAMERA })
  })
})

// ── D691: a pending flip asks for ONE look at its sustain's end ─────

describe('a pending occupancy flip asks the orchestrator for one look at its sustain end (D691)', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  const sustained = (): NcRuleInput => {
    const occupancy = { ...freeRule().conditions.occupancy, sustainSeconds: 29 }
    return freeRule({ conditions: { devices: [CAMERA], occupancy } })
  }

  it('asks once, when the flip ARMS, for the sustain it still has to hold', async () => {
    h = await boot(new Map(), [sustained()])

    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    expect(h.looks).toEqual([])
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await vi.waitFor(() => expect(h.looks).toHaveLength(1))
    expect(h.looks[0]).toEqual({ deviceId: CAMERA, afterMs: 29_000, reason: 'occupancy-pending' })

    // The same pending flip, sampled again: no second ask.
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await new Promise((r) => setTimeout(r, 20))
    expect(h.looks).toHaveLength(1)
  })

  it('a refused look is said, per camera — the edge is left to the cadence', async () => {
    h = await boot(new Map(), [sustained()])
    h.lookAnswer = { scheduled: false, refusedBecause: 'unknown-camera' }

    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await vi.waitFor(() =>
      expect(h.lines.some((l) => l.message.startsWith('occupancy early look: refused'))).toBe(true),
    )
    const line = h.lines.find((l) => l.message.startsWith('occupancy early look: refused'))
    expect(line?.tags).toEqual({ deviceId: CAMERA })
    expect(line?.meta?.['refusedBecause']).toBe('unknown-camera')
  })

  // Fix round 1 (review L1): an orchestrator older than D691 rejects every
  // ask. That is said ONCE per camera at warn, not once per armed flip.
  it('a failing ask warns once per camera until one succeeds', async () => {
    h = await boot(new Map(), [sustained()])
    h.lookAnswer = new Error("method 'requestOccupancyLook' not found on provider")

    for (let i = 0; i < 3; i++) {
      h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
      h.center.observeOccupancy(CAMERA, snapshot([]))
    }
    await vi.waitFor(() => expect(h.looks).toHaveLength(3))
    await new Promise((r) => setTimeout(r, 20))
    const warned = (): number =>
      h.lines.filter(
        (l) => l.level === 'warn' && l.message.startsWith('occupancy early look: the ask failed'),
      ).length
    expect(warned()).toBe(1)

    // One success re-arms the warning.
    h.lookAnswer = { scheduled: true, dueInMs: 1 }
    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await vi.waitFor(() => expect(h.looks).toHaveLength(4))
    await new Promise((r) => setTimeout(r, 20))
    h.lookAnswer = new Error('again')
    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await vi.waitFor(() => expect(warned()).toBe(2))
  })
})

// ── Fix round 1 (review M3): a departed track that owns no media ───

describe('a departed track with no media of its own falls back to the ring still (D691, M3)', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('cuts the ring at the departure when the departed track resolves nothing', async () => {
    // `trk-a` left, but owns no media (fused away, or too short to persist one).
    h = await boot(new Map(), [freeRule()], camera, pastRing)

    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(stillOwnerOf(h)).toBe('trk-a')
    // Dated on the departing read (`snapshot().ts === NOW`), cut a lead before.
    expect(h.pastStills).toEqual([{ deviceId: CAMERA, atMs: NOW - NC_DEPARTURE_STILL_LEAD_MS }])
    expect(h.snapshots).toEqual([])
    expect(h.sends[0]?.notification.attachments?.map((a) => a.mediaType)).toEqual(['image'])
    const line = h.lines.find((l) =>
      l.message.startsWith('occupancy departure still: the departed'),
    )
    expect(line?.tags).toEqual({ deviceId: CAMERA })
  })

  it('never cuts the ring when the departed track owns its picture', async () => {
    h = await boot(new Map([['trk-a', trackMedia()]]), [freeRule()], camera, pastRing)

    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(h.pastStills).toEqual([])
  })
})

// ── D683 × D691 (review M3 carry): a FUSED-AWAY departed track ─────
//
// On tracker v2 the track that left can have been absorbed by an L2 fusion:
// its id now owns nothing because its media was re-pointed to the SURVIVOR.
// The departure's picture is that survivor's — the ring still is only for a
// departed subject nobody owns, never for one the fusion merely renamed.

describe('a departed track that was FUSED AWAY is pictured by its survivor (D683 × D691)', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('resolves the absorbed id to its survivor BEFORE falling back to the ring', async () => {
    h = await boot(
      new Map([['trk-s', trackMedia()]]),
      [freeRule()],
      camera,
      pastRing,
      new Map([['trk-a', 'trk-s']]),
    )

    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(stillOwnerOf(h)).toBe('trk-a')
    expect(h.mediaLookups).toContain('track:trk-s')
    expect(h.pastStills).toEqual([])
    expect(h.sends[0]?.notification.attachments?.map((a) => a.mediaType)).toEqual(['image'])
  })

  it('a survivor that owns nothing either still falls back to the ring still', async () => {
    h = await boot(new Map(), [freeRule()], camera, pastRing, new Map([['trk-a', 'trk-s']]))

    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(h.pastStills).toEqual([{ deviceId: CAMERA, atMs: NOW - NC_DEPARTURE_STILL_LEAD_MS }])
  })

  it('an alias store that FAILS reads the id as asked (D315) and says so once, per camera', async () => {
    h = await boot(new Map(), [freeRule()], camera, pastRing, new Error('alias store down'))

    h.center.observeOccupancy(CAMERA, snapshot(['trk-a']))
    h.center.observeOccupancy(CAMERA, snapshot([]))
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    // The id as asked owns nothing → the ring still, exactly as before fusion.
    expect(h.mediaLookups).toContain('track:trk-a')
    expect(h.pastStills).toEqual([{ deviceId: CAMERA, atMs: NOW - NC_DEPARTURE_STILL_LEAD_MS }])
    const warns = h.lines.filter(
      (l) => l.level === 'warn' && l.message.startsWith('departed track alias resolution failed'),
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]?.tags).toEqual({ deviceId: CAMERA })
    expect(warns[0]?.meta?.['id']).toBe('trk-a')
  })
})
