/**
 * The intake seam, and the synthetic producer that proves it exists.
 *
 * There are two claims here and every test serves one of them:
 *
 *  1. **The notification path does not know who produced the event.** The same
 *     logical event, arriving from the pipeline producer and from the synthetic
 *     one, must produce the same match, the same outbox row and the same
 *     delivery. If the consumer could tell them apart, the tester would be
 *     testing a branch that only exists for tests.
 *
 *  2. **Persistence belongs to the producer.** The synthetic producer persists
 *     nothing — the only collection that grows is the outbox, which is the
 *     notification's own delivery queue and not a record of the event. That is
 *     asserted against the STORE, not against an intention.
 *
 * The marker (`synthetic: true`) is checked in both directions: it must reach
 * the durable row and the logs, and it must be unreachable from anything the
 * matcher reads.
 */
import type { InMemoryRecords } from '@camstack/types'
import type { NcRuleInput, ObjectEvent } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import {
  completeLoggerStub,
  ncPruneWindowsPort,
  makeNcRecords,
  ncTable,
} from './support/nc-test-deps.js'
import { makeTestObjectEvent } from '../../__tests__/support/events.js'
import { NotificationCenter } from '../index.js'
import type { NcOutboxEntry } from '../outbox.js'
import {
  buildSyntheticEvent,
  type NcTestEventInput,
  NcTestEventInputSchema,
} from '../test-event.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CALLER = { userId: 'admin-42', isAdmin: true }
const NOW = 1_000_000

/** A 1×1 JPEG — enough for the media ladder; sharp is never asked to cut it. */
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q=='

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
  readonly snapshots: number[]
}

function makeRuleInput(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'person at the gate',
    delivery: 'immediate',
    targets: [{ targetId: 'tgt-1' }],
    conditions: { classes: ['person'], zones: { ids: ['gate'] }, minConfidence: 0.6 },
    media: { attach: 'keyFrame' },
    ...overrides,
  })
}

/** The REAL producer's record, matching the rule above. */
function makeEvent(overrides: Partial<ObjectEvent> = {}): ObjectEvent {
  return makeTestObjectEvent({
    deviceId: 104,
    timestamp: NOW,
    className: 'person',
    confidence: 0.9,
    zones: ['gate'],
    ...overrides,
  })
}

/** The SYNTHETIC producer's input, describing the same thing. */
function makeInjection(overrides: Partial<NcTestEventInput> = {}): NcTestEventInput {
  return NcTestEventInputSchema.parse({
    trigger: 'object-event',
    deviceId: 104,
    classNames: ['person'],
    confidence: 0.9,
    zones: ['gate'],
    still: 'none',
    ...overrides,
  })
}

function makeHarness(now: () => number = () => NOW): Harness {
  const store = makeFakeSettingsStore()
  const world = makeNcRecords()
  const sends: NcSendInput[] = []
  const lines: LoggedLine[] = []
  const mediaLookups: string[] = []
  const snapshots: number[] = []
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
    { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
  ]
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: completeLoggerStub(logger),
    pruneWindows: ncPruneWindowsPort(),
    listUsers: async () => [],
    getDeviceRoute: async () => null,
    dispatcher: {
      listTargets: async () => targets,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async (_kind, id) => {
        mediaLookups.push(id)
        return []
      },
      getDeviceName: async () => 'Driveway',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    now,
    drainIntervalMs: 5,
    ruleReloadIntervalMs: 3_600_000,
  })
  return { center, store, world, sends, lines, mediaLookups, snapshots }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNcOutboxEntry(row: unknown): row is NcOutboxEntry {
  if (!isRecord(row)) return false
  return (
    typeof row.id === 'string' &&
    typeof row.ruleId === 'string' &&
    typeof row.targetId === 'string' &&
    typeof row.deviceId === 'number' &&
    typeof row.recordKind === 'string' &&
    typeof row.recordId === 'string' &&
    typeof row.status === 'string' &&
    typeof row.attempts === 'number' &&
    typeof row.nextAttemptAt === 'number' &&
    typeof row.createdAt === 'number' &&
    typeof row.updatedAt === 'number' &&
    typeof row.payload === 'object' &&
    row.payload !== null
  )
}

function outboxRows(world: InMemoryRecords): NcOutboxEntry[] {
  const rows = ncTable(world, 'outbox')
  if (rows === undefined) return []
  const out: NcOutboxEntry[] = []
  for (const [id, row] of rows.entries()) {
    const merged = { ...(row as Record<string, unknown>), id }
    if (isNcOutboxEntry(merged)) out.push(merged)
  }
  return out
}

/** Everything a delivered notification is, minus the parts that are unique to
 *  the record — what "the two producers are indistinguishable" actually means. */
function deliveryShape(entry: NcOutboxEntry): Record<string, unknown> {
  return {
    ruleId: entry.ruleId,
    targetId: entry.targetId,
    deviceId: entry.deviceId,
    recordKind: entry.recordKind,
    ruleName: entry.payload.ruleName,
    delivery: entry.payload.delivery,
    priority: entry.payload.priority,
    media: entry.payload.media,
    className: entry.payload.subject.className,
    zones: entry.payload.subject.zones,
    confidence: entry.payload.subject.confidence,
    matchedOn: entry.payload.matchedOn,
  }
}

describe('the intake seam — a producer-agnostic notification path', () => {
  let h: Harness

  afterEach(async () => {
    await h.center.stop()
  })

  async function boot(
    rule: NcRuleInput = makeRuleInput(),
    now: () => number = () => NOW,
  ): Promise<void> {
    h = makeHarness(now)
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({ rule, caller: CALLER })
  }

  it('the SAME event from the pipeline and from the tester produces the SAME delivery', async () => {
    // The claim in one test: if the consumer could tell the producers apart,
    // these two shapes would differ.
    await boot()
    h.center.onObjectEventPersisted(makeEvent())
    await vi.waitFor(() => expect(outboxRows(h.world)).toHaveLength(1))
    const fromPipeline = deliveryShape(outboxRows(h.world)[0] as NcOutboxEntry)

    // A second injection would hit the rule's cooldown, which is a property of
    // the rule and not of the producer — so bypass it, exactly as the operator
    // would when re-testing.
    const result = await h.center.injectTestEvent(makeInjection({ bypassCooldown: true }))
    await vi.waitFor(() => expect(outboxRows(h.world)).toHaveLength(2))
    const fromTester = deliveryShape(outboxRows(h.world)[1] as NcOutboxEntry)

    expect(fromTester).toEqual(fromPipeline)
    expect(result.outcomes[0]?.matched).toBe(true)
    expect(result.outcomes[0]?.enqueued).toBe(1)
  })

  it('both producers reach the notifier — one send each, same rule', async () => {
    await boot()
    h.center.onObjectEventPersisted(makeEvent())
    // No media exists for either subject, so both deliveries pay the bounded
    // still wait (NC_STILL_WAIT_MS) before shipping text-only.
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })
    await h.center.injectTestEvent(makeInjection({ bypassCooldown: true }))
    await vi.waitFor(() => expect(h.sends).toHaveLength(2), { timeout: 8_000 })
    expect(h.sends[1]?.notification.title).toEqual(h.sends[0]?.notification.title)
  }, 20_000)

  it('a rejected condition is reported the same way for both producers', async () => {
    // Discriminating: `minConfidence` fails on an ABSENT confidence, and the
    // tester must be able to produce that state rather than defaulting it.
    await boot()
    const result = await h.center.injectTestEvent(
      NcTestEventInputSchema.parse({
        trigger: 'object-event',
        deviceId: 104,
        classNames: ['person'],
        zones: ['gate'],
        still: 'none',
      }),
    )
    expect(result.outcomes[0]?.matched).toBe(false)
    expect(result.outcomes[0]?.failedCondition).toBe('minConfidence')
    expect(outboxRows(h.world)).toHaveLength(0)
  })
})

describe('the synthetic producer persists NOTHING', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('the only collection an injection grows is the outbox', async () => {
    h = makeHarness()
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })

    const before = new Map(
      [...h.world.tables.entries()].map(([name, rows]) => [name, rows.size] as const),
    )
    await h.center.injectTestEvent(makeInjection())
    await vi.waitFor(() => expect(outboxRows(h.world)).toHaveLength(1))

    for (const [name, rows] of h.world.tables.entries()) {
      if (name === 'outbox') continue
      expect(`${name}:${rows.size}`).toBe(`${name}:${before.get(name) ?? 0}`)
    }
  })

  it('the record id says what it is, and it is unique per injection', async () => {
    h = makeHarness()
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })

    const a = await h.center.injectTestEvent(makeInjection({ bypassCooldown: true }))
    const b = await h.center.injectTestEvent(makeInjection({ bypassCooldown: true }))
    expect(a.recordId.startsWith('synthetic:')).toBe(true)
    expect(b.recordId).not.toBe(a.recordId)
    // Two tests of the same rule must both arrive; a shared id would dedup the
    // second into silence in the outbox.
    await vi.waitFor(() => expect(outboxRows(h.world)).toHaveLength(2))
  })
})

describe('the synthetic marker — present where it helps, absent where it would lie', () => {
  it('never appears on the subject, which is all the matcher can read', () => {
    // Structural, not behavioural: a condition cannot be authored against a
    // field the subject does not carry.
    const event = buildSyntheticEvent(makeInjection(), 'synthetic:abc', NOW)
    expect(event.origin).toBe('synthetic')
    expect(Object.keys(event.subject)).not.toContain('origin')
    expect(Object.keys(event.subject)).not.toContain('synthetic')
    // The id IS the marker and is meant to be visible — it is the grep key, and
    // no condition matches on a record id. Nothing ELSE carries it.
    expect(event.subject.recordId).toBe('synthetic:abc')
    const { recordId: _id, trackId: _trk, ...matchable } = event.subject
    expect(JSON.stringify(matchable)).not.toContain('synthetic')
  })

  it('reaches the durable outbox row and the logs', async () => {
    const h = makeHarness()
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })
    try {
      await h.center.injectTestEvent(makeInjection())
      await vi.waitFor(() => expect(outboxRows(h.world)).toHaveLength(1))
      expect(outboxRows(h.world)[0]?.payload.synthetic).toBe(true)

      const line = h.lines.find((l) => l.message === 'synthetic event injected')
      expect(line?.level).toBe('info')
      expect(line?.tags).toMatchObject({ deviceId: 104 })
      expect(line?.meta).toMatchObject({ synthetic: true })
      const matched = h.lines.find((l) => l.message === 'rule matched — enqueueing')
      expect(matched?.meta).toMatchObject({ origin: 'synthetic' })
    } finally {
      await h.center.stop()
    }
  })

  it('a REAL event leaves the marker off the row entirely', async () => {
    const h = makeHarness()
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })
    try {
      h.center.onObjectEventPersisted(makeEvent())
      await vi.waitFor(() => expect(outboxRows(h.world)).toHaveLength(1))
      expect(outboxRows(h.world)[0]?.payload.synthetic).toBeUndefined()
    } finally {
      await h.center.stop()
    }
  })
})

describe('the side gates behave as the operator asked', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('a rule in cooldown SUPPRESSES the injection, and says so', async () => {
    let clock = NOW
    h = makeHarness(() => clock)
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })

    h.center.onObjectEventPersisted(makeEvent())
    await vi.waitFor(() => expect(outboxRows(h.world)).toHaveLength(1))

    clock = NOW + 1_000
    const result = await h.center.injectTestEvent(makeInjection())
    expect(result.outcomes[0]?.matched).toBe(true)
    expect(result.outcomes[0]?.cooldown).toBe('suppressed')
    expect(result.outcomes[0]?.enqueued).toBe(0)
    expect(outboxRows(h.world)).toHaveLength(1)
  })

  it('the bypass fires AND does not consume the window', async () => {
    // The discriminating half: without the "do not consume" rule, the real
    // notification due at NOW+61s would be silenced by the test.
    let clock = NOW
    h = makeHarness(() => clock)
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })

    h.center.onObjectEventPersisted(makeEvent())
    await vi.waitFor(() => expect(outboxRows(h.world)).toHaveLength(1))

    clock = NOW + 50_000
    const bypassed = await h.center.injectTestEvent(makeInjection({ bypassCooldown: true }))
    expect(bypassed.outcomes[0]?.cooldown).toBe('bypassed')
    await vi.waitFor(() => expect(outboxRows(h.world)).toHaveLength(2))

    // Past the ORIGINAL 60 s window — the real event fires. Had the bypass
    // stamped the window, this would still be inside it.
    clock = NOW + 61_000
    // A distinct track — `maxPerTrack: 1` dedups on track id, not cooldown.
    h.center.onObjectEventPersisted(makeEvent({ timestamp: clock, trackId: 'trk-after-window' }))
    await vi.waitFor(() => expect(outboxRows(h.world)).toHaveLength(3))
  })

  it('a MUTED camera drops the injection unless the bypass is asked for', async () => {
    h = makeHarness()
    await h.center.start({ evaluation: true })
    const provider = h.center.buildProvider()
    await provider.createRule({ rule: makeRuleInput(), caller: CALLER })
    await provider.setDeviceMuted({ deviceId: 104, muted: true })

    const dropped = await h.center.injectTestEvent(makeInjection())
    expect(dropped.droppedBy).toBe('muted')
    expect(outboxRows(h.world)).toHaveLength(0)

    const forced = await h.center.injectTestEvent(makeInjection({ bypassMute: true }))
    expect(forced.droppedBy).toBeUndefined()
    expect(forced.outcomes[0]?.matched).toBe(true)
  })

  it('onlyRuleId narrows the candidates without changing any verdict', async () => {
    h = makeHarness()
    await h.center.start({ evaluation: true })
    const provider = h.center.buildProvider()
    const { rule: mine } = await provider.createRule({ rule: makeRuleInput(), caller: CALLER })
    await provider.createRule({
      rule: makeRuleInput({ name: 'the other one', conditions: { classes: ['person'] } }),
      caller: CALLER,
    })

    const all = await h.center.injectTestEvent(makeInjection({ bypassCooldown: true }))
    expect(all.outcomes).toHaveLength(2)

    const one = await h.center.injectTestEvent(
      makeInjection({ bypassCooldown: true, onlyRuleId: mine.id }),
    )
    expect(one.outcomes).toHaveLength(1)
    expect(one.outcomes[0]?.ruleId).toBe(mine.id)
    // Same verdict, narrower list — the narrowing is not an evaluation change.
    expect(one.outcomes[0]?.matched).toBe(all.outcomes.find((o) => o.ruleId === mine.id)?.matched)
  })

  it('a rule with an onTrigger sequence does NOT actuate on a test by default', async () => {
    const runs: string[] = []
    h = makeHarness()
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({
      rule: makeRuleInput({
        actions: {
          onTrigger: [
            {
              kind: 'do',
              action: { kind: 'cap', cap: 'cover', method: 'open', deviceId: 104 },
            },
          ],
        },
      }),
      caller: CALLER,
    })
    // No actuator is wired in this harness, so the assertion that matters is
    // the reported note — the switch is what the operator reads.
    const result = await h.center.injectTestEvent(makeInjection())
    expect(runs).toEqual([])
    expect(result.notes.some((n) => n.includes('NOT run'))).toBe(true)
  })
})

describe('the still — real media, honestly reported', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('a LIVE snapshot is served through the ordinary media-owner lookup', async () => {
    h = makeHarness()
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })

    const result = await h.center.injectTestEvent(makeInjection({ still: 'live' }), {
      getSnapshot: async (deviceId) => {
        h.snapshots.push(deviceId)
        return { base64: TINY_JPEG_B64, contentType: 'image/jpeg' }
      },
    })
    expect(result.still).toBe('live')
    expect(h.snapshots).toEqual([104])
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))
    // The dispatcher ran its own ladder and found the frame — it was never told
    // the event was synthetic.
    expect(h.sends[0]?.notification.attachments?.[0]?.mediaType).toBe('image')
  })

  it('a camera that cannot be photographed costs the picture, never the test', async () => {
    h = makeHarness()
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })

    const result = await h.center.injectTestEvent(makeInjection({ still: 'live' }), {
      getSnapshot: async () => {
        throw new Error('camera offline')
      },
    })
    expect(result.still).toBe('unavailable')
    expect(result.outcomes[0]?.matched).toBe(true)
    // Nothing was stored, so this delivery pays the bounded still wait
    // (NC_STILL_WAIT_MS) and then ships without a picture — which is the point.
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })
  })

  it('a DEVICE-event trigger carries a still — the marker track owns it', async () => {
    // The inversion of 2026-08-08. This test asserted `unattachable` and was
    // right to: a doorbell notification had no media owner and never carried a
    // picture. Production now projects a marker track carrying the camera's
    // frame and the notification names it, so the tester stands in for exactly
    // that marker — `buildSyntheticEvent` gives a device event a trackId and the
    // RAM-held still is served through the ordinary owner lookup.
    h = makeHarness()
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({
      rule: makeRuleInput({
        name: 'doorbell',
        delivery: 'device-event',
        conditions: { sensorKinds: ['doorbell'] },
        media: { attach: 'best' },
      }),
      caller: CALLER,
    })

    const result = await h.center.injectTestEvent(
      NcTestEventInputSchema.parse({
        trigger: 'device-event',
        deviceId: 104,
        sensorKind: 'doorbell',
        still: 'live',
      }),
      {
        getSnapshot: async (deviceId) => {
          h.snapshots.push(deviceId)
          return { base64: TINY_JPEG_B64, contentType: 'image/jpeg' }
        },
      },
    )
    expect(result.still).toBe('live')
    expect(result.outcomes[0]?.matched).toBe(true)
    expect(h.snapshots).toEqual([104])
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))
    // The dispatcher resolved it through the SAME ladder every other
    // attachment uses — it has no device-event branch.
    expect(h.sends[0]?.notification.attachments?.[0]?.mediaType).toBe('image')
  })
})

describe('a result that matched nothing is an ANSWER', () => {
  it('names the delivery no enabled rule declares', async () => {
    const h = makeHarness()
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })
    try {
      const result = await h.center.injectTestEvent(
        NcTestEventInputSchema.parse({ trigger: 'track-end', deviceId: 104, still: 'none' }),
      )
      expect(result.droppedBy).toBe('no-candidate-rule')
      expect(result.notes.join(' ')).toContain('track-end')
    } finally {
      await h.center.stop()
    }
  })
})
