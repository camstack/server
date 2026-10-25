/**
 * PackageDropDetector — gate logic, delivered/picked-up pairing, and
 * restart-safety. See docs/superpowers/specs/2026-07-17-package-zones-design.md §5.
 */

import type { IScopedLogger, ObjectEvent, Zone, ZoneRule } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { createNoopLogger } from '../../../embedding-encoder/shared/noop-logger.js'
import { PACKAGE_DROP_DEFAULTS, type PackageDropSettings } from '../../package-settings.js'
import {
  deliveredIdempotencyKey,
  PACKAGE_EVENT_CLASS,
  PackageDropDetector,
  type PackageObjectEventClient,
  pickedUpIdempotencyKey,
  type StationaryChange,
} from '../package-drop-detector.js'
import type { PackageCollector } from '../package/package-collector-mirror.js'
import { incomingFromPackageEvent } from '../../../notification-center/event-intake.js'
import { mediaAnchor, selfDatingKindOf } from '../../../notification-center/media-anchor.js'
import type { StationaryEntry } from '../stationary/stationary-types.js'

// ── Fakes ────────────────────────────────────────────────────────────

/**
 * In-memory object-event store that ASSIGNS the key, as the database does
 * (D474), and returns it.
 *
 * Assigning it here is the whole point: the detector can no longer choose an
 * event id, so a fake that accepted one would let a producer that never reads
 * the insert's answer keep passing. Rows are looked up by the producer's
 * `idempotencyKey`, which is what the detector itself matches on.
 */
function makeEvents(): PackageObjectEventClient & {
  rows: Map<number, ObjectEvent>
  byKey: (idempotencyKey: string) => ObjectEvent | undefined
} {
  const rows = new Map<number, ObjectEvent>()
  let nextRowId = 1
  return {
    rows,
    byKey: (idempotencyKey) => [...rows.values()].find((e) => e.idempotencyKey === idempotencyKey),
    insertObject: async (ev) => {
      const id = nextRowId++
      rows.set(id, { ...ev, id })
      return id
    },
    queryObject: async (q) => {
      return [...rows.values()].filter(
        (e) =>
          e.deviceId === q.deviceId &&
          (q.classFilter === undefined || e.className === q.classFilter),
      )
    },
  }
}

interface CapturedEmitter {
  delivered: Array<{
    entryId: string
    eventId: string
    zoneIds: readonly string[]
  }>
  pickedUp: Array<{
    entryId: string
    deliveredEventId: string
    collectorTrackId?: string
  }>
}

function makeEmitter(): {
  emit: {
    delivered: (p: { entryId: string; eventId: string; zoneIds: readonly string[] }) => void
    pickedUp: (p: { entryId: string; deliveredEventId: string; collectorTrackId?: string }) => void
  }
  captured: CapturedEmitter
} {
  const captured: CapturedEmitter = { delivered: [], pickedUp: [] }
  return {
    captured,
    emit: {
      delivered: (p) =>
        captured.delivered.push({
          entryId: p.entryId,
          eventId: p.eventId,
          zoneIds: p.zoneIds,
        }),
      pickedUp: (p) =>
        captured.pickedUp.push({
          entryId: p.entryId,
          deliveredEventId: p.deliveredEventId,
          ...(p.collectorTrackId !== undefined ? { collectorTrackId: p.collectorTrackId } : {}),
        }),
    },
  }
}

const FRAME_W = 1920
const FRAME_H = 1080

/** Full-frame polygon so any centroid lands inside. */
const PORCH_ZONE: Zone = {
  id: 'porch',
  name: 'Porch',
  kind: 'polygon',
  polygon: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  color: '#fff',
}

const PACKAGE_RULE: ZoneRule = {
  id: 'pkg-rule-1',
  zoneIds: ['porch'],
  mode: 'include',
  enabled: true,
}

/** Deterministic media ROW id (D482) for a fixture LABEL — not a real
 *  rowid, just a stable, non-zero number a test can assert back against for
 *  the same label. */
function mediaIdFor(label: string): number {
  let hash = 0
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000
  return hash + 1000
}

function makeEntry(over: Partial<StationaryEntry> = {}): StationaryEntry {
  return {
    id: over.id ?? 'entry-1',
    deviceId: over.deviceId ?? 102,
    className: over.className ?? PACKAGE_EVENT_CLASS,
    // 200×200 = 40 000 px on a 1920×1080 frame ⇒ areaFrac ≈ 0.019 > default 0.004.
    bbox: over.bbox ?? { x: 400, y: 300, w: 200, h: 200 },
    frameWidth: over.frameWidth ?? FRAME_W,
    frameHeight: over.frameHeight ?? FRAME_H,
    firstSeenAt: over.firstSeenAt ?? 0,
    becameStationaryAt: over.becameStationaryAt ?? 30_000,
    lastConfirmedAt: over.lastConfirmedAt ?? 30_000,
    ...(over.sourceTrackId !== undefined ? { sourceTrackId: over.sourceTrackId } : {}),
    ...(over.label !== undefined ? { label: over.label } : {}),
    ...(over.confidence !== undefined ? { confidence: over.confidence } : {}),
    ...(over.keyFrameMediaId !== undefined ? { keyFrameMediaId: over.keyFrameMediaId } : {}),
  }
}

interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly deviceId: unknown
}

/** Records every line so the gate-logging contract is testable: a branch that
 *  DROPS work silently is the defect this suite now pins (see the repo rule —
 *  the 3-hour blackout produced not one line). */
function makeRecordingLogger(): { logger: IScopedLogger; lines: LogLine[] } {
  const lines: LogLine[] = []
  const at =
    (level: LogLine['level']) =>
    (message: string, ctx?: { tags?: Record<string, unknown> }): void => {
      lines.push({ level, message, deviceId: ctx?.tags?.['deviceId'] })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

interface Harness {
  detector: PackageDropDetector
  events: ReturnType<typeof makeEvents>
  captured: CapturedEmitter
  lines: LogLine[]
}

function makeDetector(opts: {
  settings?: Partial<PackageDropSettings>
  zones?: readonly Zone[]
  rules?: readonly ZoneRule[]
  events?: ReturnType<typeof makeEvents>
  recordLogs?: boolean
}): Harness {
  const events = opts.events ?? makeEvents()
  const emitter = makeEmitter()
  const recorder = makeRecordingLogger()
  const settings: PackageDropSettings = {
    ...PACKAGE_DROP_DEFAULTS,
    packageDropEnabled: true,
    ...opts.settings,
  }
  const detector = new PackageDropDetector({
    events,
    emit: emitter.emit,
    logger: opts.recordLogs === false ? createNoopLogger() : recorder.logger,
    resolveZones: async () => opts.zones ?? [PORCH_ZONE],
    resolvePackageRules: async () => opts.rules ?? [PACKAGE_RULE],
    resolveSettings: async () => settings,
    resolveZoneMembershipMinOverlap: async () => 0,
  })
  return {
    detector,
    events,
    captured: emitter.captured,
    lines: recorder.lines,
  }
}

/** Every gate line must be attributable to a camera — the repo rule that a miss
 *  rate is ALWAYS asked per-camera ("why is 102 worse than 101?"). */
function gateLine(h: Harness, needle: string): LogLine {
  const line = h.lines.find((l) => l.message.includes(needle))
  expect(
    line,
    `no log line matching ${needle}; got ${h.lines.map((l) => l.message).join(' | ')}`,
  ).toBeDefined()
  return line as LogLine
}

function appeared(entry: StationaryEntry): StationaryChange {
  return { phase: 'appeared', entry, timestamp: entry.becameStationaryAt }
}
function departed(entry: StationaryEntry, timestamp = 90_000): StationaryChange {
  return { phase: 'departed', entry, timestamp }
}
function departedWithCollector(
  entry: StationaryEntry,
  collector: PackageCollector,
  timestamp = 90_000,
): StationaryChange {
  return { phase: 'departed', entry, timestamp, collector }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('PackageDropDetector — delivered gates', () => {
  it('emits package-delivered and persists a package object-event when all gates pass', async () => {
    const h = makeDetector({
      settings: { packageDropClassFilter: [PACKAGE_EVENT_CLASS] },
    })
    const entry = makeEntry({ keyFrameMediaId: mediaIdFor('media/k1') })
    await h.detector.onStationaryChange(appeared(entry))

    expect(h.captured.delivered).toHaveLength(1)
    const row = h.events.byKey(deliveredIdempotencyKey('entry-1'))
    expect(row).toBeDefined()
    // The payload names the row's REAL id, not the idempotence key it used to
    // double as (D474).
    expect(h.captured.delivered[0]).toMatchObject({
      entryId: 'entry-1',
      eventId: String(row?.id),
      zoneIds: ['porch'],
    })
    expect(row?.className).toBe(PACKAGE_EVENT_CLASS)
    expect(row?.state).toBe('idle')
    expect(row?.mediaId).toBe(mediaIdFor('media/k1'))
    expect(row?.zones).toEqual(['porch'])
  })

  it('class gate — a non-package stationary object never delivers', async () => {
    const h = makeDetector({})
    await h.detector.onStationaryChange(appeared(makeEntry({ className: 'vehicle' })))
    expect(h.captured.delivered).toHaveLength(0)
    expect(h.events.rows.size).toBe(0)
  })

  it('enabled gate — disabled camera never delivers', async () => {
    const h = makeDetector({ settings: { packageDropEnabled: false } })
    await h.detector.onStationaryChange(appeared(makeEntry()))
    expect(h.captured.delivered).toHaveLength(0)
  })

  it('zone gate — no enabled package rule ⇒ no delivery', async () => {
    const h = makeDetector({ rules: [] })
    await h.detector.onStationaryChange(appeared(makeEntry()))
    expect(h.captured.delivered).toHaveLength(0)
  })

  it('zone gate — a disabled rule does not count', async () => {
    const h = makeDetector({ rules: [{ ...PACKAGE_RULE, enabled: false }] })
    await h.detector.onStationaryChange(appeared(makeEntry()))
    expect(h.captured.delivered).toHaveLength(0)
  })

  it('zone gate — bbox does not meet membership overlap on the rule zone ⇒ no delivery', async () => {
    // Zone in the top-left 10% only; entry bbox around (500,400) has no overlap.
    const tinyZone: Zone = {
      ...PORCH_ZONE,
      polygon: [
        { x: 0, y: 0 },
        { x: 0.1, y: 0 },
        { x: 0.1, y: 0.1 },
        { x: 0, y: 0.1 },
      ],
    }
    const h = makeDetector({ zones: [tinyZone] })
    await h.detector.onStationaryChange(appeared(makeEntry()))
    expect(h.captured.delivered).toHaveLength(0)
  })

  it('dwell gate — under the dwell threshold ⇒ no delivery', async () => {
    const h = makeDetector({ settings: { packageDropDwellSec: 60 } })
    // becameStationaryAt 30s, firstSeen 0 ⇒ observed dwell 30s < 60s.
    await h.detector.onStationaryChange(appeared(makeEntry()))
    expect(h.captured.delivered).toHaveLength(0)
  })

  it('size gate — a tiny far-field blob ⇒ no delivery', async () => {
    const h = makeDetector({})
    // 10×10 = 100 px ⇒ areaFrac ≈ 0.00005 < default 0.004.
    await h.detector.onStationaryChange(appeared(makeEntry({ bbox: { x: 5, y: 5, w: 10, h: 10 } })))
    expect(h.captured.delivered).toHaveLength(0)
  })

  it('size gate — device 101 light wedge (9.46% of frame) ⇒ no delivery, logged', async () => {
    // The REAL box behind 348/350 false positives (2026-08-21 analysis):
    // streetlight wedge on the granite paving, 640×360 frame, conf 0.877.
    const h = makeDetector({})
    await h.detector.onStationaryChange(
      appeared(
        makeEntry({
          bbox: { x: 104.5, y: 165.5, w: 271.3, h: 80.3 },
          frameWidth: 640,
          frameHeight: 360,
          confidence: 0.877,
        }),
      ),
    )
    expect(h.captured.delivered).toHaveLength(0)
    const line = gateLine(h, 'above the maximum area')
    expect(line.level).toBe('info')
    expect(line.deviceId).toBe(102)
  })

  it('size gate — the true 2026-08-18 parcel (1.14%) still delivers', async () => {
    const h = makeDetector({})
    await h.detector.onStationaryChange(
      appeared(
        makeEntry({
          bbox: { x: 263.1, y: 278.5, w: 59.2, h: 44.4 },
          frameWidth: 640,
          frameHeight: 360,
          confidence: 0.885,
        }),
      ),
    )
    expect(h.captured.delivered).toHaveLength(1)
  })

  it('idempotent — the same appeared twice yields ONE delivery', async () => {
    const h = makeDetector({})
    const entry = makeEntry()
    await h.detector.onStationaryChange(appeared(entry))
    await h.detector.onStationaryChange(appeared(entry))
    expect(h.captured.delivered).toHaveLength(1)
    expect(h.events.rows.size).toBe(1)
  })
})

describe('PackageDropDetector — every gate logs, with a deviceId tag', () => {
  it('gate 0 (switch) logs once per transition, not once per promotion', async () => {
    const h = makeDetector({ settings: { packageDropEnabled: false } })
    await h.detector.onStationaryChange(appeared(makeEntry({ id: 'e1' })))
    await h.detector.onStationaryChange(appeared(makeEntry({ id: 'e2' })))
    const switchLines = h.lines.filter((l) => l.message.includes('gate 0/5'))
    expect(switchLines).toHaveLength(1)
    expect(switchLines[0]?.deviceId).toBe(102)
  })

  it('gate 1 (class) logs at DEBUG — a parking lot must not flood info', async () => {
    const h = makeDetector({})
    await h.detector.onStationaryChange(appeared(makeEntry({ className: 'vehicle' })))
    const line = gateLine(h, 'gate 1/5')
    expect(line.level).toBe('debug')
    expect(line.deviceId).toBe(102)
  })

  it('gate 2 (zone) logs when there is no enabled package rule', async () => {
    const h = makeDetector({ rules: [] })
    await h.detector.onStationaryChange(appeared(makeEntry()))
    const line = gateLine(h, 'no enabled package-stage zone rule')
    expect(line.level).toBe('info')
    expect(line.deviceId).toBe(102)
  })

  it('gate 2 (zone) logs when no package zone meets membership overlap', async () => {
    const tinyZone: Zone = {
      ...PORCH_ZONE,
      polygon: [
        { x: 0, y: 0 },
        { x: 0.1, y: 0 },
        { x: 0.1, y: 0.1 },
        { x: 0, y: 0.1 },
      ],
    }
    const h = makeDetector({ zones: [tinyZone] })
    await h.detector.onStationaryChange(appeared(makeEntry()))
    const line = gateLine(h, 'no package zone meets membership overlap')
    expect(line.level).toBe('info')
    expect(line.deviceId).toBe(102)
  })

  it('gate 3 (dwell) logs the observed and the required dwell', async () => {
    const h = makeDetector({ settings: { packageDropDwellSec: 60 } })
    await h.detector.onStationaryChange(appeared(makeEntry()))
    const line = gateLine(h, 'gate 3/5')
    expect(line.level).toBe('info')
    expect(line.deviceId).toBe(102)
  })

  it('gate 4 (size) logs the measured area fraction', async () => {
    const h = makeDetector({})
    await h.detector.onStationaryChange(appeared(makeEntry({ bbox: { x: 5, y: 5, w: 10, h: 10 } })))
    const line = gateLine(h, 'gate 4/5')
    expect(line.level).toBe('info')
    expect(line.deviceId).toBe(102)
  })

  it('gate 5 (idempotence) logs the repeat instead of dropping it silently', async () => {
    const h = makeDetector({})
    const entry = makeEntry()
    await h.detector.onStationaryChange(appeared(entry))
    await h.detector.onStationaryChange(appeared(entry))
    const line = gateLine(h, 'gate 5/5')
    expect(line.level).toBe('info')
    expect(line.deviceId).toBe(102)
  })

  it('a delivery logs its own success line', async () => {
    const h = makeDetector({})
    await h.detector.onStationaryChange(appeared(makeEntry()))
    const line = gateLine(h, 'package delivered')
    expect(line.level).toBe('info')
    expect(line.deviceId).toBe(102)
  })

  it('EVERY emitted line carries a deviceId tag', async () => {
    const h = makeDetector({ rules: [] })
    await h.detector.onStationaryChange(appeared(makeEntry()))
    expect(h.lines.length).toBeGreaterThan(0)
    for (const line of h.lines) expect(line.deviceId).toBe(102)
  })
})

describe('PackageDropDetector — the delivered event carries the detector score', () => {
  it('uses the entry confidence so a notification rule can filter it', async () => {
    const h = makeDetector({})
    await h.detector.onStationaryChange(appeared(makeEntry({ confidence: 0.5293 })))
    const row = h.events.byKey(deliveredIdempotencyKey('entry-1'))
    expect(row?.confidence).toBe(0.5293)
    // Importance is the event's PRIORITY and stays fixed — the two are not
    // the same number and must not be collapsed again.
    expect(row?.importance).toBe(1)
  })

  it('falls back to 1 when the producer did not know a score', async () => {
    const h = makeDetector({})
    await h.detector.onStationaryChange(appeared(makeEntry()))
    expect(h.events.byKey(deliveredIdempotencyKey('entry-1'))?.confidence).toBe(1)
  })
})

describe('PackageDropDetector — picked-up pairing', () => {
  it('emits package-picked-up on departure of a delivered entry', async () => {
    const h = makeDetector({})
    const entry = makeEntry()
    await h.detector.onStationaryChange(appeared(entry))
    await h.detector.onStationaryChange(departed(entry))

    expect(h.captured.pickedUp).toHaveLength(1)
    expect(h.captured.pickedUp[0]).toMatchObject({
      entryId: 'entry-1',
      deliveredEventId: String(h.events.byKey(deliveredIdempotencyKey('entry-1'))?.id),
    })
    const row = h.events.byKey(pickedUpIdempotencyKey('entry-1'))
    expect(row?.state).toBe('left')
  })

  it('does not pick up an entry that was never delivered', async () => {
    const h = makeDetector({})
    await h.detector.onStationaryChange(departed(makeEntry({ className: 'vehicle' })))
    expect(h.captured.pickedUp).toHaveLength(0)
  })

  it('pickupEnabled=false suppresses the pick-up event', async () => {
    const h = makeDetector({ settings: { packageDropPickupEnabled: false } })
    const entry = makeEntry()
    await h.detector.onStationaryChange(appeared(entry))
    await h.detector.onStationaryChange(departed(entry))
    expect(h.captured.delivered).toHaveLength(1)
    expect(h.captured.pickedUp).toHaveLength(0)
  })

  it('never records a pick-up twice for the same entry', async () => {
    const h = makeDetector({})
    const entry = makeEntry()
    await h.detector.onStationaryChange(appeared(entry))
    await h.detector.onStationaryChange(departed(entry))
    await h.detector.onStationaryChange(departed(entry, 95_000))
    expect(h.captured.pickedUp).toHaveLength(1)
  })
})

describe('PackageDropDetector — the pick-up carries the COLLECTOR (D404)', () => {
  const COLLECTOR: PackageCollector = {
    trackId: 'trk-person-9',
    className: 'person',
    observedAt: 88_400,
    skewMs: 600,
    keyFrameMediaId: mediaIdFor('kf-person-9'),
  }

  it('names the collector track as the pick-up row media owner, not the parcel', async () => {
    const h = makeDetector({})
    const entry = makeEntry({ sourceTrackId: 'trk-parcel-1' })
    await h.detector.onStationaryChange(appeared(entry))
    await h.detector.onStationaryChange(departedWithCollector(entry, COLLECTOR))

    const row = h.events.byKey(pickedUpIdempotencyKey('entry-1'))
    // The whole defect: this used to be `trk-parcel-1` — a photograph of where
    // the parcel used to be, not of who took it.
    expect(row?.trackId).toBe('trk-person-9')
    // …and the delivery row still names the parcel.
    expect(h.events.byKey(deliveredIdempotencyKey('entry-1'))?.trackId).toBe('trk-parcel-1')
  })

  it('carries the collector key frame as the row media key', async () => {
    const h = makeDetector({})
    const entry = makeEntry({
      sourceTrackId: 'trk-parcel-1',
      keyFrameMediaId: mediaIdFor('kf-parcel'),
    })
    await h.detector.onStationaryChange(appeared(entry))
    await h.detector.onStationaryChange(departedWithCollector(entry, COLLECTOR))
    expect(h.events.byKey(pickedUpIdempotencyKey('entry-1'))?.mediaId).toBe(
      mediaIdFor('kf-person-9'),
    )
  })

  it('announces the collector on the bus payload', async () => {
    const h = makeDetector({})
    const entry = makeEntry({ sourceTrackId: 'trk-parcel-1' })
    await h.detector.onStationaryChange(appeared(entry))
    await h.detector.onStationaryChange(departedWithCollector(entry, COLLECTOR))
    expect(h.captured.pickedUp[0]?.collectorTrackId).toBe('trk-person-9')
  })

  it('still sends the pick-up with the parcel owner when NO collector was found, and says so', async () => {
    const h = makeDetector({})
    const entry = makeEntry({ sourceTrackId: 'trk-parcel-1' })
    await h.detector.onStationaryChange(appeared(entry))
    await h.detector.onStationaryChange(departed(entry))

    // Degraded, never conditional: the notification ships.
    expect(h.captured.pickedUp).toHaveLength(1)
    expect(h.captured.pickedUp[0]?.collectorTrackId).toBeUndefined()
    expect(h.events.byKey(pickedUpIdempotencyKey('entry-1'))?.trackId).toBe('trk-parcel-1')
    // …and the degrade is named, per camera.
    const line = gateLine(h, 'no collector track')
    expect(line.deviceId).toBe(102)
  })

  it('logs the collector it chose, with the skew, tagged with the camera', async () => {
    const h = makeDetector({})
    const entry = makeEntry({ sourceTrackId: 'trk-parcel-1' })
    await h.detector.onStationaryChange(appeared(entry))
    await h.detector.onStationaryChange(departedWithCollector(entry, COLLECTOR))
    expect(gateLine(h, 'package picked up').deviceId).toBe(102)
  })
})

describe('PackageDropDetector — restart safety', () => {
  let sharedEvents: ReturnType<typeof makeEvents>

  beforeEach(() => {
    sharedEvents = makeEvents()
  })

  it('a delivery persisted before restart still pairs a pick-up after restart', async () => {
    const entry = makeEntry()
    // Detector #1 delivers; the row persists in the shared store.
    const first = makeDetector({ events: sharedEvents })
    await first.detector.onStationaryChange(appeared(entry))
    expect(first.captured.delivered).toHaveLength(1)

    // "Restart": a fresh detector over the SAME persisted store. The
    // registry hydrates WITHOUT firing onChange, so no re-delivery fires;
    // a later departure still pairs to the persisted delivery.
    const second = makeDetector({ events: sharedEvents })
    await second.detector.onStationaryChange(departed(entry))
    expect(second.captured.delivered).toHaveLength(0)
    expect(second.captured.pickedUp).toHaveLength(1)
    expect(second.captured.pickedUp[0]?.deliveredEventId).toBe(
      String(sharedEvents.byKey(deliveredIdempotencyKey('entry-1'))?.id),
    )
  })

  it('a replayed appeared after restart does NOT re-deliver (dedup via persisted row)', async () => {
    const entry = makeEntry()
    const first = makeDetector({ events: sharedEvents })
    await first.detector.onStationaryChange(appeared(entry))

    const second = makeDetector({ events: sharedEvents })
    await second.detector.onStationaryChange(appeared(entry))
    expect(second.captured.delivered).toHaveLength(0)
    expect(sharedEvents.rows.size).toBe(1)
  })
})

// ── B2: NC package-event persist hook ────────────────────────────────

describe('PackageDropDetector — onPersisted (NC package-event hook)', () => {
  it('fires onPersisted with the durable event + phase for delivery and pick-up', async () => {
    const events = makeEvents()
    const emitter = makeEmitter()
    const persisted: Array<{ id: number; phase: 'delivered' | 'picked-up' }> = []
    const detector = new PackageDropDetector({
      events,
      emit: emitter.emit,
      logger: createNoopLogger(),
      resolveZones: async () => [PORCH_ZONE],
      resolvePackageRules: async () => [PACKAGE_RULE],
      resolveSettings: async () => ({
        ...PACKAGE_DROP_DEFAULTS,
        packageDropEnabled: true,
      }),
      resolveZoneMembershipMinOverlap: async () => 0,
      onPersisted: (ev, phase) => persisted.push({ id: ev.id, phase }),
    })
    const entry = makeEntry()
    await detector.onStationaryChange(appeared(entry))
    await detector.onStationaryChange(departed(entry))
    // Bound to the rows the store really holds, so the assertion stays about
    // "the hook saw the durable event" rather than about a chosen id.
    expect(persisted).toEqual([
      { id: events.byKey(deliveredIdempotencyKey('entry-1'))?.id, phase: 'delivered' },
      { id: events.byKey(pickedUpIdempotencyKey('entry-1'))?.id, phase: 'picked-up' },
    ])
  })
})

// ── D682 / D684: the pick-up's footage is about the pick-up ──────────

describe('PackageDropDetector — a pick-up STORES the moment it happened on its row (D682, D684)', () => {
  /** The parcel's last sighting. */
  const T0 = 30_000
  /** The departure is CONCLUDED five minutes of unseen time later. */
  const CONCLUDED = T0 + 300_000

  interface Persisted {
    readonly ev: ObjectEvent
    readonly phase: 'delivered' | 'picked-up'
  }

  function harness(): {
    detector: PackageDropDetector
    persisted: Persisted[]
    events: ReturnType<typeof makeEvents>
  } {
    const persisted: Persisted[] = []
    const events = makeEvents()
    const detector = new PackageDropDetector({
      events,
      emit: makeEmitter().emit,
      logger: createNoopLogger(),
      resolveZones: async () => [PORCH_ZONE],
      resolvePackageRules: async () => [PACKAGE_RULE],
      resolveSettings: async () => ({ ...PACKAGE_DROP_DEFAULTS, packageDropEnabled: true }),
      resolveZoneMembershipMinOverlap: async () => 0,
      onPersisted: (ev, phase) => persisted.push({ ev, phase }),
    })
    return { detector, persisted, events }
  }

  it('writes the last sighting onto the pick-up ROW, beside the conclusion', async () => {
    const h = harness()
    const entry = makeEntry({ lastConfirmedAt: T0 })
    await h.detector.onStationaryChange(appeared(entry))
    await h.detector.onStationaryChange(departed(entry, CONCLUDED))

    // What the table holds — what the reconcile will read back.
    const row = h.events.byKey(pickedUpIdempotencyKey(entry.id))
    expect(row?.observedAt).toBe(T0)
    // `timestamp` keeps its meaning: the row is still the CONCLUSION.
    expect(row?.timestamp).toBe(CONCLUDED)
  })

  it('anchors the live pick-up footage on the last sighting, from the row alone', async () => {
    const h = harness()
    const entry = makeEntry({ lastConfirmedAt: T0 })
    await h.detector.onStationaryChange(appeared(entry))
    await h.detector.onStationaryChange(departed(entry, CONCLUDED))

    const pickUp = h.persisted.find((p) => p.phase === 'picked-up')
    expect(pickUp?.ev.observedAt).toBe(T0)
    // The whole path the live hook takes: detector → intake → subject → anchor.
    const subject = incomingFromPackageEvent(pickUp!.ev, 'picked-up').subject
    const anchor = mediaAnchor(subject)
    expect(anchor.atMs).toBe(T0)
    expect(anchor.source).toBe('observed')
    expect(anchor.lagMs).toBe(300_000)
    // The live hook's event IS the stored row: a replay builds the same subject.
    const stored = h.events.byKey(pickedUpIdempotencyKey(entry.id))
    expect(incomingFromPackageEvent(stored!, 'picked-up').subject).toEqual(subject)
  })

  it("prefers the collector's own instant when the mirror named one", async () => {
    const h = harness()
    const entry = makeEntry({ lastConfirmedAt: T0 })
    const collector: PackageCollector = {
      trackId: 'trk-person-9',
      className: 'person',
      observedAt: T0 - 800,
      skewMs: 800,
    }
    await h.detector.onStationaryChange(appeared(entry))
    await h.detector.onStationaryChange(departedWithCollector(entry, collector, CONCLUDED))
    expect(h.events.byKey(pickedUpIdempotencyKey(entry.id))?.observedAt).toBe(T0 - 800)
  })

  it('leaves the delivery alone — it is concluded as it happens', async () => {
    const h = harness()
    const entry = makeEntry({ lastConfirmedAt: T0 })
    await h.detector.onStationaryChange(appeared(entry))
    const delivery = h.persisted.find((p) => p.phase === 'delivered')
    expect(delivery?.ev.observedAt).toBeUndefined()
    expect(h.events.byKey(deliveredIdempotencyKey(entry.id))?.observedAt).toBeUndefined()
    const subject = incomingFromPackageEvent(delivery!.ev, 'delivered').subject
    // A delivery has no earlier moment to offer, so its fallback is not news.
    expect(selfDatingKindOf(subject)).toBeNull()
    expect(mediaAnchor(subject).atMs).toBe(delivery?.ev.timestamp)
  })
})
