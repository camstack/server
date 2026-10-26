import {
  type ClaimOutcome,
  type CompositionFieldPlan,
  CompositionSchema,
  composedDeviceRef,
  compositionReadKey,
  compositionSliceKey,
  compositionSourceKey,
  DeviceType,
  EventCategory,
  planComposition,
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  type SourceReader,
  type SourceReading,
  type SystemEvent,
} from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CompositionRuntime } from '../composition-runtime.js'
import type { PulseFieldSeed } from '../pulse-seed.js'
import { type OwnedFieldsApi, OwnedFieldsTarget } from '../owned-fields-target.js'
import {
  FakeTarget,
  FakeTimer,
  LOOKUP_CAP,
  type RecordingLogger,
  recordingLogger,
  roomPlan,
} from './fixtures.js'

const [T1, T2, T3] = ROOM_EXAMPLE_TEMPERATURE_SOURCES
const [M1, M2] = ROOM_EXAMPLE_MOTION_SOURCES
const k = (source: typeof T1, cap: string, fieldPath: string) =>
  compositionReadKey({ source: source!, cap, fieldPath })
const fresh = (value: number | boolean | null): SourceReading => ({ state: 'fresh', value })

let now: number
let readings: Map<string, SourceReading>
let target: FakeTarget
let timer: FakeTimer
let log: RecordingLogger
let runtime: CompositionRuntime
let emitted: SystemEvent[]
let emitFailure: string | null

beforeEach(() => {
  now = 1_000_000
  readings = new Map<string, SourceReading>([
    [k(T1, 'temperature-sensor', 'celsius'), fresh(21.0)],
    [k(T2, 'temperature-sensor', 'celsius'), fresh(21.5)],
    [k(T3, 'temperature-sensor', 'celsius'), fresh(21.4)],
    [k(T1, 'temperature-sensor', 'lastFetchedAt'), fresh(990_000)],
    [k(T2, 'temperature-sensor', 'lastFetchedAt'), fresh(995_000)],
    [k(T3, 'temperature-sensor', 'lastFetchedAt'), fresh(980_000)],
    [k(M1, 'motion', 'detected'), fresh(false)],
    [k(M2, 'motion', 'detected'), fresh(false)],
    [k(M1, 'motion', 'lastDetectedAt'), fresh(880_000)],
    [k(M2, 'motion', 'lastDetectedAt'), fresh(null)],
  ])
  target = new FakeTarget(1901)
  timer = new FakeTimer()
  log = recordingLogger()
  emitted = []
  emitFailure = null
  runtime = new CompositionRuntime({
    blockId: 'b-room',
    fields: roomPlan(),
    eventPlans: [],
    events: {
      emit: (event) => {
        if (emitFailure !== null) throw new Error(emitFailure)
        emitted.push(event)
      },
    },
    target,
    lookupCap: LOOKUP_CAP,
    read: (r) =>
      readings.get(compositionReadKey(r)) ?? {
        state: 'unavailable',
        reason: 'no fixture',
        fatal: false,
      },
    now: () => now,
    timer,
    logger: log.logger,
  })
})

function statefulDoorbellPlan(withExplode = false) {
  const composition = CompositionSchema.parse({
    target: { kind: 'new', type: DeviceType.Camera },
    features: [
      {
        kind: 'fields',
        cap: 'doorbell',
        fields: {
          lastPressedAt: {
            kind: 'expression',
            expr: withExplode
              ? 'rose(active, changedAt, 2000) / explode'
              : 'rose(active, changedAt)',
            bindings: {
              active: { kind: 'from', source: M1, cap: 'motion', fieldPath: 'detected' },
              changedAt: {
                kind: 'from',
                source: M1,
                cap: 'motion',
                fieldPath: 'lastDetectedAt',
              },
              ...(withExplode
                ? {
                    explode: {
                      kind: 'from',
                      source: T1,
                      cap: 'temperature-sensor',
                      fieldPath: 'celsius',
                    },
                  }
                : {}),
            },
          },
          pressCountSinceStart: {
            kind: 'expression',
            expr: 'count(changedAt)',
            bindings: {
              changedAt: {
                kind: 'from',
                source: M1,
                cap: 'motion',
                fieldPath: 'lastDetectedAt',
              },
            },
          },
        },
      },
    ],
  })
  const plan = planComposition(composition, LOOKUP_CAP)
  if (plan.problems.length > 0) throw new Error(plan.problems.map((p) => p.message).join('; '))
  return plan
}

describe('start', () => {
  it('seeds both caps and becomes available', () => {
    runtime.start()
    expect(target.writes).toEqual([
      { op: 'seed', cap: 'temperature-sensor', values: { celsius: 21.3, lastFetchedAt: 995_000 } },
      { op: 'seed', cap: 'binary', values: { on: true, lastChangedAt: 1_000_000 } },
    ])
    expect(target.availability).toEqual([true])
    expect(timer.armedAt).toBe(880_000 + 300_001)
  })

  it('initializes rose fallback and count from the exact existing-target seed', () => {
    const initialLastPressedAt = 1_790_587_990_669
    const firstSourceTimestamp = 1_790_587_990_000
    now = 1_790_587_991_000
    readings.set(k(M1, 'motion', 'detected'), fresh(false))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(firstSourceTimestamp))
    runtime = new CompositionRuntime({
      blockId: 'b-doorbell',
      fields: statefulDoorbellPlan().fields,
      eventPlans: [],
      events: { emit: (event) => emitted.push(event) },
      target,
      lookupCap: LOOKUP_CAP,
      initialByCap: new Map([
        ['doorbell', { lastPressedAt: initialLastPressedAt, pressCountSinceStart: 2 }],
      ]),
      read: (read) =>
        readings.get(compositionReadKey(read)) ?? {
          state: 'unavailable',
          reason: 'no fixture',
          fatal: false,
        },
      now: () => now,
      timer,
      logger: log.logger,
    })

    runtime.start()
    expect(target.writes).toEqual([
      {
        op: 'seed',
        cap: 'doorbell',
        values: { lastPressedAt: initialLastPressedAt, pressCountSinceStart: 2 },
      },
    ])

    const nextTimestamp = 1_790_587_992_000
    now = nextTimestamp
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(nextTimestamp))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))

    expect(target.writes.at(-1)).toEqual({
      op: 'patch',
      cap: 'doorbell',
      values: { lastPressedAt: nextTimestamp, pressCountSinceStart: 3 },
    })
  })
})

describe('an own-field read is answered by the runtime, not the hub (D670 amendment)', () => {
  const SELF = composedDeviceRef('b-doorbell')
  function selfCountPlan(withProbe = false) {
    const composition = CompositionSchema.parse({
      target: { kind: 'new', type: DeviceType.Camera },
      features: [
        {
          kind: 'fields',
          cap: 'doorbell',
          fields: {
            lastPressedAt: {
              kind: 'expression',
              expr: 'rose(active, changedAt)',
              bindings: {
                active: { kind: 'from', source: M1, cap: 'motion', fieldPath: 'detected' },
                changedAt: { kind: 'from', source: M1, cap: 'motion', fieldPath: 'lastDetectedAt' },
              },
            },
            pressCountSinceStart: {
              kind: 'expression',
              expr: withProbe ? 'count(pressed) + 0 * probe' : 'count(pressed)',
              bindings: {
                pressed: {
                  kind: 'from',
                  source: SELF,
                  cap: 'doorbell',
                  fieldPath: 'lastPressedAt',
                },
                // A non-own binding of the SAME field: every evaluation of the
                // count reads it, so a test can see whether a pass ran at all.
                ...(withProbe
                  ? {
                      probe: {
                        kind: 'from',
                        source: T1,
                        cap: 'temperature-sensor',
                        fieldPath: 'celsius',
                      },
                    }
                  : {}),
              },
            },
          },
        },
      ],
    })
    const plan = planComposition(composition, LOOKUP_CAP)
    if (plan.problems.length > 0) throw new Error(plan.problems.map((p) => p.message).join('; '))
    return plan
  }

  function selfRuntime(
    options: {
      readonly initial?: Readonly<Record<string, unknown>>
      readonly withProbe?: boolean
      readonly onRead?: (key: string) => void
    } = {},
  ): CompositionRuntime {
    return new CompositionRuntime({
      blockId: 'b-doorbell',
      fields: selfCountPlan(options.withProbe ?? false).fields,
      eventPlans: [],
      events: { emit: (event) => emitted.push(event) },
      target,
      lookupCap: LOOKUP_CAP,
      ...(options.initial === undefined
        ? {}
        : { initialByCap: new Map([['doorbell', options.initial]]) }),
      read: (read) => {
        options.onRead?.(compositionReadKey(read))
        return (
          readings.get(compositionReadKey(read)) ?? {
            state: 'unavailable',
            reason: 'the source has not reported yet',
            fatal: false,
          }
        )
      },
      isOwnRead: (read) => compositionSourceKey(read.source) === compositionSourceKey(SELF),
      now: () => now,
      timer,
      logger: log.logger,
    })
  }

  function press(at: number): void {
    now = at + 100
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(at))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
  }

  // Review H1: the source answered LATE at boot (the hub restart of 09-28
  // 20:24, when 1031 was not registered yet). The own field is unavailable
  // under the `null` policy, so the runtime PUBLISHES null for it; its reader
  // must see that null — as it did through the hub — or `count` stays unprimed
  // and swallows the first press as its seed. The source's first answer is its
  // idle level (D716: a first answer is a baseline, never a press).
  function sourceAnswers(at: number): void {
    now = at
    readings.set(k(M1, 'motion', 'detected'), fresh(false))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(at - 60_000))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
  }

  it('no slice, source late at boot: { null, 0 } at once, then the first press counts 1', () => {
    now = 1_790_587_991_000
    readings.delete(k(M1, 'motion', 'detected'))
    readings.delete(k(M1, 'motion', 'lastDetectedAt'))
    runtime = selfRuntime()
    runtime.start()
    expect(target.writes.at(-1)).toEqual({
      op: 'seed',
      cap: 'doorbell',
      values: { lastPressedAt: null, pressCountSinceStart: 0 },
    })

    sourceAnswers(now + 2_000)
    press(now + 5_000)
    expect(target.writes.at(-1)?.values).toEqual({
      lastPressedAt: now - 100,
      pressCountSinceStart: 1,
    })
  })

  it('restored { T0, 2 }, source late at boot: the first press counts 3', () => {
    now = 1_790_587_991_000
    readings.delete(k(M1, 'motion', 'detected'))
    readings.delete(k(M1, 'motion', 'lastDetectedAt'))
    runtime = selfRuntime({
      initial: { lastPressedAt: 1_790_587_000_000, pressCountSinceStart: 2 },
    })
    runtime.start()

    sourceAnswers(now + 2_000)
    press(now + 5_000)
    expect(target.writes.at(-1)?.values).toMatchObject({
      lastPressedAt: now - 100,
      pressCountSinceStart: 3,
    })
  })

  // D716: the hub booted while Home Assistant was down; HA then came back and
  // seeded its restored `on` with a NEW changedAt — fresh, and after the hub
  // started, so the first-sighting rule alone took it for a press. A first
  // answer after an outage, boot included, only baselines the level.
  it('source down since boot, first answer a restored ON with a fresh stamp: no press, no change', () => {
    const restored = 1_790_587_000_000
    now = 1_790_587_991_000
    readings.delete(k(M1, 'motion', 'detected'))
    readings.delete(k(M1, 'motion', 'lastDetectedAt'))
    runtime = makeStatefulDoorbellRuntime({ lastPressedAt: restored, pressCountSinceStart: 2 })
    runtime.start()

    now += 4_000
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(now - 10))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
    expect(emitted).toEqual([])
    for (const write of target.writes)
      expect(write.values).toMatchObject({ lastPressedAt: restored, pressCountSinceStart: 2 })

    // The doorbell then idles and rings for real: that press counts.
    sourceAnswers(now + 1_000)
    press(now + 5_000)
    expect(emitted).toHaveLength(1)
    expect(target.writes.at(-1)?.values).toMatchObject({ lastPressedAt: now - 100 })
  })

  // Review M1: the runtime's own write comes back from the hub as a state
  // change of its own cap. It is answered from the record, and the pass that
  // wrote it already re-ran its readers — the echo must not run another pass.
  it('the hub echo of its own write runs no pass', () => {
    now = 1_790_587_991_000
    readings.set(k(M1, 'motion', 'detected'), fresh(false))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(null))
    const probeKey = k(T1, 'temperature-sensor', 'celsius')
    let probeReads = 0
    runtime = selfRuntime({
      withProbe: true,
      onRead: (key) => {
        if (key === probeKey) probeReads++
      },
    })
    runtime.start()
    press(now + 1_000)
    expect(target.writes.at(-1)?.values).toMatchObject({ pressCountSinceStart: 1 })

    const before = probeReads
    runtime.onSourcesChanged(new Set([compositionSliceKey(SELF, 'doorbell')]))
    expect(probeReads).toBe(before)
  })

  it('seeds { null, 0 } with no slice on the hub, counts the first press', () => {
    now = 1_790_587_991_000
    readings.set(k(M1, 'motion', 'detected'), fresh(false))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(null))
    const hubReads: string[] = []
    runtime = new CompositionRuntime({
      blockId: 'b-doorbell',
      fields: selfCountPlan().fields,
      eventPlans: [],
      events: { emit: (event) => emitted.push(event) },
      target,
      lookupCap: LOOKUP_CAP,
      // The hub has no slice of the composition's own cap until it is seeded.
      read: (read) => {
        hubReads.push(compositionReadKey(read))
        return (
          readings.get(compositionReadKey(read)) ?? {
            state: 'unavailable',
            reason: 'the source has not reported `doorbell` yet',
            fatal: false,
          }
        )
      },
      isOwnRead: (read) => compositionSourceKey(read.source) === compositionSourceKey(SELF),
      now: () => now,
      timer,
      logger: log.logger,
    })

    runtime.start()
    expect(target.writes).toEqual([
      { op: 'seed', cap: 'doorbell', values: { lastPressedAt: null, pressCountSinceStart: 0 } },
    ])
    expect(hubReads.some((r) => r.startsWith(compositionSourceKey(SELF)))).toBe(false)

    const pressedAt = 1_790_587_992_000
    now = pressedAt
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(pressedAt))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
    expect(target.writes.at(-1)).toEqual({
      op: 'patch',
      cap: 'doorbell',
      values: { lastPressedAt: pressedAt, pressCountSinceStart: 1 },
    })

    const writes = target.writes.length
    runtime.onSourcesChanged(new Set([compositionSliceKey(SELF, 'doorbell')]))
    expect(target.writes).toHaveLength(writes)
  })
})

const EDGE_BASE = 1_790_587_990_000

function makeStatefulDoorbellRuntime(
  initial: Readonly<Record<string, unknown>>,
  withExplode = false,
  planned = statefulDoorbellPlan(withExplode),
  pulseSeeds?: ReadonlyMap<string, PulseFieldSeed>,
): CompositionRuntime {
  return new CompositionRuntime({
    blockId: 'b-doorbell',
    fields: planned.fields,
    eventPlans: planned.events,
    events: {
      emit: (event) => {
        if (emitFailure !== null) throw new Error(emitFailure)
        emitted.push(event)
      },
    },
    target,
    lookupCap: LOOKUP_CAP,
    initialByCap: new Map([['doorbell', initial]]),
    ...(pulseSeeds === undefined ? {} : { pulseSeeds }),
    read: (read) =>
      readings.get(compositionReadKey(read)) ?? {
        state: 'unavailable',
        reason: 'no fixture',
        fatal: false,
      },
    now: () => now,
    timer,
    logger: log.logger,
  })
}

const NATIVE_STAMP = 1_727_600_000_000
const SOURCE_STAMP = 1_761_300_000_000

describe('a pulse field before its first edge, and after a restart (D938)', () => {
  function idleSource(): void {
    now = EDGE_BASE
    readings.set(k(M1, 'motion', 'detected'), fresh(false))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(EDGE_BASE - 60_000))
  }

  it('before the first edge the field holds the seed-read slice, so a native stamp shows through', () => {
    idleSource()
    runtime = makeStatefulDoorbellRuntime({
      lastPressedAt: NATIVE_STAMP,
      pressCountSinceStart: 1,
    })
    runtime.start()
    expect(emitted).toEqual([])
    expect(target.writes.at(-1)?.values).toEqual({
      lastPressedAt: NATIVE_STAMP,
      pressCountSinceStart: 1,
    })
  })

  it('a restored claim stamp is written unchanged when the source is idle', () => {
    idleSource()
    runtime = makeStatefulDoorbellRuntime(
      { lastPressedAt: SOURCE_STAMP, pressCountSinceStart: 4 },
      false,
      statefulDoorbellPlan(),
      new Map<string, PulseFieldSeed>([
        ['doorbell.lastPressedAt', { kind: 'keep' }],
        ['doorbell.pressCountSinceStart', { kind: 'keep' }],
      ]),
    )
    runtime.start()
    expect(emitted).toEqual([])
    expect(target.writes.at(-1)?.values).toEqual({
      lastPressedAt: SOURCE_STAMP,
      pressCountSinceStart: 4,
    })
  })

  it('a source seed replaces the native stamp and does not emit', () => {
    idleSource()
    runtime = makeStatefulDoorbellRuntime(
      { lastPressedAt: NATIVE_STAMP, pressCountSinceStart: 1 },
      false,
      statefulDoorbellPlan(),
      new Map<string, PulseFieldSeed>([
        ['doorbell.lastPressedAt', { kind: 'value', value: SOURCE_STAMP }],
        ['doorbell.pressCountSinceStart', { kind: 'value', value: 0 }],
      ]),
    )
    runtime.start()
    expect(emitted).toEqual([])
    expect(target.writes.at(-1)?.values).toEqual({
      lastPressedAt: SOURCE_STAMP,
      pressCountSinceStart: 0,
    })
  })

  it('no proof writes null rather than the native stamp', () => {
    idleSource()
    runtime = makeStatefulDoorbellRuntime(
      { lastPressedAt: NATIVE_STAMP, pressCountSinceStart: 1 },
      false,
      statefulDoorbellPlan(),
      new Map<string, PulseFieldSeed>([
        ['doorbell.lastPressedAt', { kind: 'value', value: null }],
        ['doorbell.pressCountSinceStart', { kind: 'value', value: 0 }],
      ]),
    )
    runtime.start()
    expect(target.writes.at(-1)?.values).toEqual({
      lastPressedAt: null,
      pressCountSinceStart: 0,
    })
  })

  it('a failed seed publishes nothing, so the native stamp is not written and null is not either', () => {
    idleSource()
    runtime = makeStatefulDoorbellRuntime(
      { lastPressedAt: NATIVE_STAMP, pressCountSinceStart: 1 },
      false,
      statefulDoorbellPlan(),
      new Map<string, PulseFieldSeed>([
        ['doorbell.lastPressedAt', { kind: 'hold' }],
        ['doorbell.pressCountSinceStart', { kind: 'value', value: 0 }],
      ]),
    )
    runtime.start()
    expect(target.writes).toEqual([])
    expect(emitted).toEqual([])
  })
})

describe('D670 — state-derived events', () => {
  it('does not emit at the finite seed, then emits a newer edge from the target device', () => {
    now = EDGE_BASE
    readings.set(k(M1, 'motion', 'detected'), fresh(false))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(EDGE_BASE - 100))
    runtime = makeStatefulDoorbellRuntime({
      lastPressedAt: EDGE_BASE - 50,
      pressCountSinceStart: 2,
    })
    runtime.start()
    expect(emitted).toEqual([])

    const timestamp = EDGE_BASE + 100
    now = timestamp
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(timestamp))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))

    expect(emitted).toEqual([
      expect.objectContaining({
        category: EventCategory.DoorbellOnPressed,
        source: { type: 'device', id: target.id, deviceId: target.id },
        data: { deviceId: target.id, timestamp },
      }),
    ])
    expect(
      log.lines.find((line) => line.message === 'composition: state-derived event emitted'),
    ).toMatchObject({
      level: 'debug',
      extras: {
        tags: { deviceId: target.id },
        meta: {
          blockId: 'b-doorbell',
          cap: 'doorbell',
          eventName: 'onPressed',
          category: EventCategory.DoorbellOnPressed,
          timestamp,
        },
      },
    })
  })

  it('disarms rose across unavailable→fresh so a provider restart is not a press', () => {
    now = EDGE_BASE
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(EDGE_BASE - 100))
    runtime = makeStatefulDoorbellRuntime({
      lastPressedAt: EDGE_BASE - 50,
      pressCountSinceStart: 2,
    })
    runtime.start()
    emitted = []

    // Binding flap: source gone (confirmed unavailable), then restore seed
    // false and the real on — the pair that used to ring camera 101.
    readings.delete(k(M1, 'motion', 'detected'))
    readings.delete(k(M1, 'motion', 'lastDetectedAt'))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
    expect(emitted).toEqual([])

    now = EDGE_BASE + 50
    readings.set(k(M1, 'motion', 'detected'), fresh(false))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(EDGE_BASE + 50))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
    expect(emitted).toEqual([])

    now = EDGE_BASE + 100
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(EDGE_BASE + 100))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
    expect(emitted).toEqual([])
  })

  // D713, camera 101 2026-10-06 08:10:56: the HA provider was redeployed, the
  // switch cap unregistered, and the composer wrote `lastPressedAt: null` over
  // the restored stamp; the recovery then "changed" it back. The stamp is the
  // last edge, not a reading of now: the outage marks the field stale and
  // writes nothing, and the recovery with the same stamp is no change.
  it('a source outage keeps the restored lastPressedAt: stale, never null, and no change on recovery', () => {
    const restored = EDGE_BASE - 50
    now = EDGE_BASE
    readings.set(k(M1, 'motion', 'detected'), fresh(false))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(EDGE_BASE - 100))
    runtime = makeStatefulDoorbellRuntime({ lastPressedAt: restored, pressCountSinceStart: 2 })
    runtime.start()
    const afterStart = target.writes.length

    readings.set(k(M1, 'motion', 'detected'), {
      state: 'unavailable',
      reason: 'the provider unregistered `motion`',
      fatal: false,
      confirmed: true,
    })
    readings.set(k(M1, 'motion', 'lastDetectedAt'), {
      state: 'unavailable',
      reason: 'the provider unregistered `motion`',
      fatal: false,
      confirmed: true,
    })
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
    for (const write of target.writes.slice(afterStart))
      expect(write.values['lastPressedAt']).toBe(restored)
    expect(
      log.lines.find(
        (line) => line.message === 'composed field doorbell.lastPressedAt: fresh → stale',
      ),
    ).toBeDefined()
    expect(
      log.lines.some((line) =>
        line.message.startsWith('composed field doorbell.lastPressedAt: fresh → unavailable'),
      ),
    ).toBe(false)

    // Back, with the SAME level and stamp the provider had before.
    const beforeRecovery = target.writes.length
    readings.set(k(M1, 'motion', 'detected'), fresh(false))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(EDGE_BASE - 100))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
    for (const write of target.writes.slice(beforeRecovery))
      expect(write.values).toMatchObject({ lastPressedAt: restored, pressCountSinceStart: 2 })
    expect(emitted).toEqual([])

    // The next real press still counts.
    now = EDGE_BASE + 1_000
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(EDGE_BASE + 1_000))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
    expect(emitted).toHaveLength(1)
    expect(target.writes.at(-1)?.values).toMatchObject({ lastPressedAt: EDGE_BASE + 1_000 })
  })

  it('a GONE source is not held: the field is unavailable (D393)', () => {
    now = EDGE_BASE
    readings.set(k(M1, 'motion', 'detected'), fresh(false))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(EDGE_BASE - 100))
    runtime = makeStatefulDoorbellRuntime({
      lastPressedAt: EDGE_BASE - 50,
      pressCountSinceStart: 2,
    })
    runtime.start()
    readings.set(k(M1, 'motion', 'detected'), {
      state: 'unavailable',
      reason: 'the device was deleted',
      fatal: true,
    })
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
    expect(
      log.lines.some((line) =>
        line.message.startsWith('composed field doorbell.lastPressedAt: fresh → unavailable'),
      ),
    ).toBe(true)
  })

  it('advances high-water before a failed write, so retry does not duplicate the event', () => {
    const timestamp = EDGE_BASE + 100
    now = timestamp
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(timestamp))
    target.refuse = 'offline'
    const base = statefulDoorbellPlan()
    const direct = {
      ...base,
      fields: base.fields.map((field) =>
        field.path === 'lastPressedAt'
          ? {
              ...field,
              source: {
                kind: 'expression',
                expr: 'changedAt',
                bindings: {
                  changedAt: {
                    kind: 'from',
                    source: M1!,
                    cap: 'motion',
                    fieldPath: 'lastDetectedAt',
                  },
                },
              } as const,
              reads: [{ source: M1!, cap: 'motion', fieldPath: 'lastDetectedAt' }],
            }
          : field,
      ),
    }
    runtime = makeStatefulDoorbellRuntime(
      {
        lastPressedAt: EDGE_BASE,
        pressCountSinceStart: 2,
      },
      false,
      direct,
    )

    runtime.start()
    expect(emitted).toHaveLength(1)
    target.refuse = null
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))

    expect(emitted).toHaveLength(1)
    expect(target.writes).toHaveLength(1)
  })

  it('logs an event-bus failure and still writes the owned field', () => {
    const timestamp = EDGE_BASE + 100
    now = timestamp
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(timestamp))
    emitFailure = 'bus offline'
    runtime = makeStatefulDoorbellRuntime({
      lastPressedAt: EDGE_BASE,
      pressCountSinceStart: 2,
    })

    runtime.start()

    expect(target.writes).toHaveLength(1)
    expect(
      log.lines.some(
        (line) =>
          line.level === 'warn' &&
          line.message === 'composition: state-derived event delivery failed' &&
          line.extras?.tags?.deviceId === target.id,
      ),
    ).toBe(true)
  })

  it('does not consume rose memory when a later expression node fails', () => {
    const timestamp = EDGE_BASE + 100
    now = timestamp
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(timestamp))
    readings.set(k(T1, 'temperature-sensor', 'celsius'), fresh(null))
    runtime = makeStatefulDoorbellRuntime({ lastPressedAt: null, pressCountSinceStart: 0 }, true)

    runtime.start()
    expect(emitted).toEqual([])
    readings.set(k(T1, 'temperature-sensor', 'celsius'), fresh(1))
    runtime.onSourcesChanged(new Set([compositionSliceKey(T1!, 'temperature-sensor')]))

    expect(runtime.state().fields.find((field) => field.path === 'lastPressedAt')).toMatchObject({
      state: 'fresh',
      value: timestamp,
    })
    expect(emitted).toHaveLength(1)
  })

  it('keeps null and non-finite values below the event high-water', () => {
    now = EDGE_BASE
    readings.set(k(M1, 'motion', 'detected'), fresh(false))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(null))
    runtime = makeStatefulDoorbellRuntime({
      lastPressedAt: null,
      pressCountSinceStart: 0,
    })
    runtime.start()

    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(Number.POSITIVE_INFINITY))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
    expect(emitted).toEqual([])

    readings.set(k(M1, 'motion', 'detected'), fresh(false))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(EDGE_BASE + 50))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(EDGE_BASE + 100))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
    expect(emitted).toHaveLength(1)
  })

  it('isolates identical stateful call paths in different output fields', () => {
    const base = statefulDoorbellPlan().fields.find((field) => field.path === 'lastPressedAt')
    if (base === undefined) throw new Error('doorbell lastPressedAt plan missing')
    const source = (motion: NonNullable<typeof M1>) =>
      ({
        kind: 'expression',
        expr: 'rose(active, changedAt)',
        bindings: {
          active: { kind: 'from', source: motion, cap: 'motion', fieldPath: 'detected' },
          changedAt: {
            kind: 'from',
            source: motion,
            cap: 'motion',
            fieldPath: 'lastDetectedAt',
          },
        },
      }) as const
    const fields: readonly CompositionFieldPlan[] = [
      {
        ...base,
        path: 'first',
        source: source(M1!),
        reads: [
          { source: M1!, cap: 'motion', fieldPath: 'detected' },
          { source: M1!, cap: 'motion', fieldPath: 'lastDetectedAt' },
        ],
      },
      {
        ...base,
        path: 'second',
        source: source(M2!),
        reads: [
          { source: M2!, cap: 'motion', fieldPath: 'detected' },
          { source: M2!, cap: 'motion', fieldPath: 'lastDetectedAt' },
        ],
      },
    ]
    now = EDGE_BASE
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(EDGE_BASE + 100))
    readings.set(k(M2, 'motion', 'detected'), fresh(true))
    readings.set(k(M2, 'motion', 'lastDetectedAt'), fresh(EDGE_BASE + 200))
    runtime = new CompositionRuntime({
      blockId: 'b-two-edges',
      fields,
      eventPlans: [],
      events: { emit: () => undefined },
      target,
      lookupCap: LOOKUP_CAP,
      initialByCap: new Map([['doorbell', { first: null, second: null }]]),
      read: (read) =>
        readings.get(compositionReadKey(read)) ?? {
          state: 'unavailable',
          reason: 'no fixture',
          fatal: false,
        },
      now: () => now,
      timer,
      logger: log.logger,
    })

    now = EDGE_BASE + 200
    runtime.start()

    expect(runtime.state().fields.find((field) => field.path === 'first')?.value).toBe(
      EDGE_BASE + 100,
    )
    expect(runtime.state().fields.find((field) => field.path === 'second')?.value).toBe(
      EDGE_BASE + 200,
    )
  })
})

describe('recomputes only what a change affects', () => {
  it('a temperature change patches temperature and leaves binary alone', () => {
    runtime.start()
    readings.set(k(T1, 'temperature-sensor', 'celsius'), fresh(24.0))
    runtime.onSourcesChanged(new Set([compositionSliceKey(T1!, 'temperature-sensor')]))
    expect(target.writes.at(-1)).toEqual({
      op: 'patch',
      cap: 'temperature-sensor',
      values: { celsius: 22.3 },
    })
    expect(target.writes.filter((w) => w.cap === 'binary')).toHaveLength(1)
  })

  it('a new motion edge that keeps `on` true does not move lastChangedAt', () => {
    runtime.start()
    now = 1_050_000
    readings.set(k(M1, 'motion', 'lastDetectedAt'), fresh(1_050_000))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M1!, 'motion')]))
    expect(target.writes.filter((w) => w.cap === 'binary')).toHaveLength(1)
    expect(timer.armedAt).toBe(1_050_000 + 300_001)
  })
})

describe('the occupancy window closes on its deadline — no source event, no poll', () => {
  it('flips on→false and stamps lastChangedAt at the flip', () => {
    runtime.start()
    now = 880_000 + 300_001
    timer.trigger()
    expect(target.writes.at(-1)).toEqual({
      op: 'patch',
      cap: 'binary',
      values: { on: false, lastChangedAt: now },
    })
    expect(timer.armedAt).toBeNull()
  })
})

describe('stale keeps the last value (D49)', () => {
  it('writes nothing, stays available, logs once with the device tag', () => {
    runtime.start()
    readings.set(k(T2, 'temperature-sensor', 'celsius'), {
      state: 'stale',
      value: 21.5,
      reason: 'the source device is offline',
    })
    runtime.onSourcesChanged(new Set([compositionSliceKey(T2!, 'temperature-sensor')]))
    runtime.onSourcesChanged(new Set([compositionSliceKey(T2!, 'temperature-sensor')]))
    expect(target.writes).toHaveLength(2)
    expect(target.availability).toEqual([true])
    const staleLines = log.lines.filter((l) => l.message.includes('fresh → stale'))
    expect(staleLines).toHaveLength(1)
    expect(staleLines[0]?.extras?.tags).toEqual({ deviceId: 1901 })
    expect(runtime.state().fields.find((f) => f.path === 'celsius')).toMatchObject({
      state: 'stale',
      value: 21.3,
    })
  })
})

describe('unavailable is per field, never global (D393)', () => {
  it('a GONE source: celsius unavailable, device offline, block failure names it, occupancy keeps flowing', () => {
    runtime.start()
    readings.set(k(T2, 'temperature-sensor', 'celsius'), {
      state: 'unavailable',
      reason:
        'source `provider-homeassistant/sensor.sofa_temperature` (device 12) was removed — two reads agreed',
      fatal: true,
    })
    runtime.onSourcesChanged(new Set([compositionSliceKey(T2!, 'temperature-sensor')]))
    expect(target.availability).toEqual([true, false])
    expect(runtime.state().failure).toContain('sensor.sofa_temperature')
    expect(runtime.state().fields.find((f) => f.path === 'celsius')).toMatchObject({
      state: 'unavailable',
      value: null,
    })
    readings.set(k(M2, 'motion', 'detected'), fresh(true))
    runtime.onSourcesChanged(new Set([compositionSliceKey(M2!, 'motion')]))
    expect(runtime.state().fields.find((f) => f.path === 'on')).toMatchObject({
      state: 'fresh',
      value: true,
    })
  })

  it('an expression failure is unavailable but NOT a block failure', () => {
    runtime.start()
    readings.set(k(T2, 'temperature-sensor', 'celsius'), fresh(null))
    runtime.onSourcesChanged(new Set([compositionSliceKey(T2!, 'temperature-sensor')]))
    expect(runtime.state().failure).toBeNull()
    expect(runtime.state().fields.find((f) => f.path === 'celsius')?.state).toBe('unavailable')
  })

  it('a write the cap schema refuses is named and makes the fields unavailable', () => {
    target.refuse = 'celsius: expected number'
    runtime.start()
    expect(
      log.lines.some(
        (l) => l.message.includes('refused a write') && l.extras?.tags?.deviceId === 1901,
      ),
    ).toBe(true)
    expect(target.availability).toEqual([false])
  })
  it('a refused write never masks a gone source in the same pass — the fatal outcome wins', () => {
    runtime.start()
    target.refuse = 'lastFetchedAt: expected number'
    readings.set(k(T2, 'temperature-sensor', 'celsius'), {
      state: 'unavailable',
      reason:
        'source `provider-homeassistant/sensor.sofa_temperature` (device 12) was removed — two reads agreed',
      fatal: true,
    })
    readings.set(k(T1, 'temperature-sensor', 'lastFetchedAt'), fresh(999_000))
    runtime.onSourcesChanged(
      new Set([
        compositionSliceKey(T1!, 'temperature-sensor'),
        compositionSliceKey(T2!, 'temperature-sensor'),
      ]),
    )
    expect(log.lines.some((l) => l.message.includes('refused a write'))).toBe(true)
    expect(runtime.state().failure).toContain('sensor.sofa_temperature')
    expect(runtime.state().fields.find((f) => f.path === 'celsius')).toMatchObject({
      state: 'unavailable',
      value: null,
    })
  })
})

describe('disable', () => {
  it('makes every field unavailable, takes the device offline and disarms the timer', () => {
    runtime.start()
    runtime.disable('the block is disabled')
    expect(target.availability).toEqual([true, false])
    expect(timer.armedAt).toBeNull()
    expect(runtime.state().fields.every((f) => f.state === 'unavailable')).toBe(true)
  })
})

const STAMP = 1_700_000_000_000

/** The room, with `temperature-sensor.lastFetchedAt` a required CONSTANT. */
function constantPlan(): readonly CompositionFieldPlan[] {
  return roomPlan().map((f) =>
    f.cap === 'temperature-sensor' && f.path === 'lastFetchedAt'
      ? {
          ...f,
          role: 'constant',
          reads: [],
          source: { kind: 'expression', expr: `${STAMP}`, bindings: {} },
        }
      : f,
  )
}

/** The room, with `temperature-sensor.celsius` nullable: unavailable is written `null`. */
function nullableCelsiusPlan(): readonly CompositionFieldPlan[] {
  return roomPlan().map((f) =>
    f.path === 'celsius' ? { ...f, nullable: true, unavailable: 'null' } : f,
  )
}

/** The room, where `lastFetchedAt` carries a second, later window: a deadline that outlives `on`'s. */
function windowedFetchPlan(): readonly CompositionFieldPlan[] {
  return roomPlan().map((f) =>
    f.path === 'lastFetchedAt'
      ? {
          ...f,
          reads: [{ source: T1!, cap: 'temperature-sensor', fieldPath: 'lastFetchedAt' }],
          source: {
            kind: 'expression',
            expr: 'within(f1, 400000)',
            bindings: {
              f1: {
                kind: 'from',
                source: T1!,
                cap: 'temperature-sensor',
                fieldPath: 'lastFetchedAt',
              },
            },
          },
        }
      : f,
  )
}

function runtimeWith(
  fields: readonly CompositionFieldPlan[],
  read?: SourceReader,
): CompositionRuntime {
  return new CompositionRuntime({
    blockId: 'b-room',
    fields,
    eventPlans: [],
    events: { emit: () => undefined },
    target,
    lookupCap: LOOKUP_CAP,
    read:
      read ??
      ((r) =>
        readings.get(compositionReadKey(r)) ?? {
          state: 'unavailable',
          reason: 'no fixture',
          fatal: false,
        }),
    now: () => now,
    timer,
    logger: log.logger,
  })
}

const temperature = (): string => compositionSliceKey(T1!, 'temperature-sensor')

describe('a refused write keeps its cap write-pending and is retried WHOLE', () => {
  it('a refused seed: a later change on one field seeds every required field, the constant included', () => {
    runtime = runtimeWith(constantPlan())
    target.refuse = 'transient'
    runtime.start()
    target.refuse = null
    readings.set(k(T1, 'temperature-sensor', 'celsius'), fresh(24.0))
    runtime.onSourcesChanged(new Set([temperature()]))
    expect(target.writes).toEqual([
      { op: 'seed', cap: 'temperature-sensor', values: { celsius: 22.3, lastFetchedAt: STAMP } },
    ])
  })

  it('an evaluation that changes nothing still retries the seed; a deadline pass retries the rest', () => {
    target.refuse = 'transient'
    runtime.start()
    target.refuse = null
    runtime.onSourcesChanged(new Set([temperature()]))
    expect(target.writes).toEqual([
      { op: 'seed', cap: 'temperature-sensor', values: { celsius: 21.3, lastFetchedAt: 995_000 } },
    ])
    expect(runtime.state().fields.find((f) => f.path === 'on')).toMatchObject({
      state: 'unavailable',
      value: null,
    })
    now = 880_000 + 300_001
    timer.trigger()
    expect(target.writes.at(-1)).toEqual({
      op: 'seed',
      cap: 'binary',
      values: { on: false, lastChangedAt: now },
    })
    expect(target.availability).toEqual([false, true])
  })

  it('logs the refusal once per failure transition, not once per retry', () => {
    target.refuse = 'transient'
    runtime.start()
    runtime.onSourcesChanged(new Set([temperature()]))
    const refused = log.lines.filter(
      (l) =>
        l.message.includes('refused a write') && l.extras?.meta?.['cap'] === 'temperature-sensor',
    )
    expect(refused).toHaveLength(1)
  })
})

describe('a target that throws', () => {
  it('never throws out; logs it tagged; the timer is re-armed; the next change writes the whole current slice', () => {
    target.throwing = 'disk on fire'
    expect(() => runtime.start()).not.toThrow()
    runtime.onSourcesChanged(new Set([temperature()]))
    const threw = log.lines.filter((l) => l.message.includes('write threw'))
    expect(threw.map((l) => l.extras?.meta?.['cap'])).toEqual(['temperature-sensor', 'binary'])
    expect(threw.every((l) => l.extras?.tags?.deviceId === 1901)).toBe(true)
    expect(timer.armedAt).toBe(880_000 + 300_001)
    expect(target.availability).toEqual([false])

    target.throwing = null
    readings.set(k(T1, 'temperature-sensor', 'celsius'), fresh(24.0))
    runtime.onSourcesChanged(new Set([temperature()]))
    expect(target.writes).toEqual([
      { op: 'seed', cap: 'temperature-sensor', values: { celsius: 22.3, lastFetchedAt: 995_000 } },
    ])
  })

  it('a thrown PATCH: the next evaluation re-sends every current value of the cap', () => {
    runtime.start()
    target.throwing = 'disk on fire'
    readings.set(k(T1, 'temperature-sensor', 'celsius'), fresh(25.0))
    expect(() => runtime.onSourcesChanged(new Set([temperature()]))).not.toThrow()
    expect(target.availability).toEqual([true, false])
    target.throwing = null
    runtime.onSourcesChanged(new Set([compositionSliceKey(T3!, 'temperature-sensor')]))
    expect(target.writes.at(-1)).toEqual({
      op: 'patch',
      cap: 'temperature-sensor',
      values: { celsius: 22.6, lastFetchedAt: 995_000 },
    })
    expect(target.availability).toEqual([true, false, true])
  })

  it('a pass that throws elsewhere is logged; finally re-arms the next FUTURE deadline, never a past one', () => {
    let broken = false
    runtime = runtimeWith(windowedFetchPlan(), (r) => {
      if (broken) throw new Error('reader exploded')
      return (
        readings.get(compositionReadKey(r)) ?? {
          state: 'unavailable',
          reason: 'no fixture',
          fatal: false,
        }
      )
    })
    runtime.start()
    broken = true
    expect(() => runtime.onSourcesChanged(new Set([temperature()]))).not.toThrow()
    expect(
      log.lines.some((l) => l.message.includes('pass threw') && l.extras?.tags?.deviceId === 1901),
    ).toBe(true)
    expect(timer.armedAt).toBe(880_000 + 300_001)
    now = 880_000 + 300_001
    expect(() => timer.trigger()).not.toThrow()
    expect(timer.armedAt).toBe(990_000 + 400_001)
  })
})

describe('stop is terminal', () => {
  it('a source event or a start after stop writes nothing and arms nothing', () => {
    runtime.start()
    runtime.stop()
    readings.set(k(T1, 'temperature-sensor', 'celsius'), fresh(24.0))
    runtime.onSourcesChanged(new Set([temperature()]))
    runtime.start()
    runtime.disable('late')
    expect(target.writes).toHaveLength(2)
    expect(target.availability).toEqual([true])
    expect(timer.armedAt).toBeNull()
  })
})

describe('edges', () => {
  it('the failure is sticky: the source coming back does not bring the device back', () => {
    runtime.start()
    readings.set(k(T2, 'temperature-sensor', 'celsius'), {
      state: 'unavailable',
      reason: 'sensor.sofa_temperature was removed',
      fatal: true,
    })
    runtime.onSourcesChanged(new Set([compositionSliceKey(T2!, 'temperature-sensor')]))
    readings.set(k(T2, 'temperature-sensor', 'celsius'), fresh(21.5))
    runtime.onSourcesChanged(new Set([compositionSliceKey(T2!, 'temperature-sensor')]))
    expect(target.availability).toEqual([true, false])
    expect(runtime.state().failure).toContain('sensor.sofa_temperature')
  })

  it('disable keeps a gone source as the field reason', () => {
    runtime.start()
    readings.set(k(T2, 'temperature-sensor', 'celsius'), {
      state: 'unavailable',
      reason: 'sensor.sofa_temperature was removed',
      fatal: true,
    })
    runtime.onSourcesChanged(new Set([compositionSliceKey(T2!, 'temperature-sensor')]))
    runtime.disable('the block is disabled')
    expect(runtime.state().fields.find((f) => f.path === 'celsius')?.reason).toContain(
      'sensor.sofa_temperature',
    )
  })

  it('a nullable field that goes unavailable is written null; disable writes it null too', () => {
    runtime = runtimeWith(nullableCelsiusPlan())
    runtime.start()
    readings.set(k(T2, 'temperature-sensor', 'celsius'), fresh(null))
    runtime.onSourcesChanged(new Set([compositionSliceKey(T2!, 'temperature-sensor')]))
    expect(target.writes.at(-1)).toEqual({
      op: 'patch',
      cap: 'temperature-sensor',
      values: { celsius: null },
    })
    expect(target.availability).toEqual([true])

    readings.set(k(T2, 'temperature-sensor', 'celsius'), fresh(21.5))
    const second = new FakeTarget(1902)
    target = second
    runtime = runtimeWith(nullableCelsiusPlan())
    runtime.start()
    runtime.disable('the block is disabled')
    expect(second.writes.at(-1)).toEqual({
      op: 'patch',
      cap: 'temperature-sensor',
      values: { celsius: null },
    })
  })

  it('a timer that fires early changes nothing and re-arms the same deadline', () => {
    runtime.start()
    now = 1_100_000
    timer.trigger()
    expect(target.writes).toHaveLength(2)
    expect(timer.armedAt).toBe(880_000 + 300_001)
  })
})

describe('fix round 2', () => {
  it('a setAvailable that throws is retried on the next pass', () => {
    target.availabilityThrows = 1
    runtime.start()
    expect(target.availability).toEqual([])
    runtime.onSourcesChanged(new Set([temperature()]))
    expect(target.availability).toEqual([true])
    expect(runtime.state().available).toBe(true)
  })

  it('a reader that keeps throwing logs its transitions and the pass error once, not every pass', () => {
    const fetched = k(T1, 'temperature-sensor', 'lastFetchedAt')
    let broken = false
    runtime = runtimeWith(roomPlan(), (r) => {
      if (broken && compositionReadKey(r) === fetched) throw new Error('reader exploded')
      return (
        readings.get(compositionReadKey(r)) ?? {
          state: 'unavailable',
          reason: 'no fixture',
          fatal: false,
        }
      )
    })
    runtime.start()
    broken = true
    readings.set(k(T2, 'temperature-sensor', 'celsius'), {
      state: 'stale',
      value: 21.5,
      reason: 'offline',
    })
    runtime.onSourcesChanged(new Set([temperature()]))
    runtime.onSourcesChanged(new Set([temperature()]))
    expect(log.lines.filter((l) => l.message.includes('fresh → stale'))).toHaveLength(1)
    expect(log.lines.filter((l) => l.message.includes('pass threw'))).toHaveLength(1)
  })
})

describe('a target that reports an enqueued write did not land (D663, S5)', () => {
  it('a thrown RPC makes the cap write-pending by name; the next pass re-writes the WHOLE cap', () => {
    runtime.start()
    target.failAsync('temperature-sensor', { kind: 'threw', error: 'hub down' })
    expect(runtime.state().fields.find((f) => f.path === 'celsius')).toMatchObject({
      state: 'unavailable',
      value: null,
      reason: expect.stringContaining('hub down'),
    })
    expect(runtime.state().fields.find((f) => f.path === 'lastFetchedAt')?.state).toBe(
      'unavailable',
    )
    expect(runtime.state().fields.find((f) => f.path === 'on')?.state).toBe('fresh')
    expect(target.availability).toEqual([true, false])
    readings.set(k(T1, 'temperature-sensor', 'celsius'), fresh(24.0))
    runtime.onSourcesChanged(new Set([temperature()]))
    expect(target.writes.at(-1)).toEqual({
      op: 'patch',
      cap: 'temperature-sensor',
      values: { celsius: 22.3, lastFetchedAt: 995_000 },
    })
    expect(runtime.state().fields.find((f) => f.path === 'celsius')?.state).toBe('fresh')
    expect(target.availability).toEqual([true, false, true])
  })

  it('a refusal is escalated by its hub code, and a deadline pass retries it', () => {
    runtime.start()
    target.failAsync('binary', { kind: 'refused', code: 'not-claimed', message: 'claim lost' })
    expect(runtime.state().fields.find((f) => f.path === 'on')?.reason).toContain('not-claimed')
    const warned = log.lines.filter((l) => l.message.includes('refused a write'))
    expect(warned).toHaveLength(1)
    expect(warned[0]?.extras).toMatchObject({
      tags: { deviceId: 1901 },
      meta: { cap: 'binary', error: 'not-claimed: claim lost' },
    })
    now = 880_000 + 300_001
    timer.trigger()
    expect(target.writes.at(-1)).toEqual({
      op: 'patch',
      cap: 'binary',
      values: { on: false, lastChangedAt: now },
    })
  })

  it('after stop, a late failure report changes nothing', () => {
    runtime.start()
    runtime.stop()
    target.failAsync('binary', { kind: 'threw', error: 'late' })
    expect(runtime.state().fields.find((f) => f.path === 'on')?.state).toBe('fresh')
  })
})

const DAYS_SOURCE = { addonId: 'provider-homeassistant', stableId: 'ha:desiccant-days' } as const
const DAYS = {
  kind: 'from',
  source: DAYS_SOURCE,
  cap: 'numeric-sensor',
  fieldPath: 'value',
} as const
const daysKey = (): string => compositionReadKey({ ...DAYS, source: DAYS_SOURCE })

/** Consumables on a new device: two items sharing `status`; the desiccant's remaining days read a sensor. */
function consumablesPlan(): readonly CompositionFieldPlan[] {
  const composition = CompositionSchema.parse({
    target: { kind: 'new', type: DeviceType.Generic },
    features: [
      {
        kind: 'fields',
        cap: 'consumables',
        fields: {
          lastChangedAt: { kind: 'expression', expr: 'now', bindings: {} },
          lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} },
        },
        items: {
          filter: {
            label: 'Filter',
            fields: { status: { kind: 'expression', expr: '"ok"', bindings: {} } },
          },
          desiccant: {
            label: 'Desiccant',
            fields: {
              'remaining.value': DAYS,
              'remaining.kind': { kind: 'expression', expr: '"duration"', bindings: {} },
              status: {
                kind: 'expression',
                expr: 'd <= 0 ? "replace" : "ok"',
                bindings: { d: DAYS },
              },
            },
          },
        },
      },
    ],
  })
  const plan = planComposition(composition, LOOKUP_CAP)
  if (plan.problems.length > 0) throw new Error(plan.problems.map((p) => p.message).join('; '))
  return plan.fields
}

describe('item arrays: records keyed per item, the whole array written (D663, ruling M)', () => {
  beforeEach(() => {
    readings.set(daysKey(), fresh(12))
    runtime = runtimeWith(consumablesPlan())
  })

  it('two items sharing `status` are two field states with two item keys', () => {
    runtime.start()
    const statuses = runtime.state().fields.filter((f) => f.path === 'status')
    expect(statuses.map((f) => f.item?.key).sort()).toEqual(['desiccant', 'filter'])
    expect(statuses.map((f) => f.value)).toEqual(expect.arrayContaining(['ok', 'ok']))
  })

  it('the seed carries the assembled array, items sorted by key on the cap’s emptyItem', () => {
    runtime.start()
    expect(target.writes).toEqual([
      {
        op: 'seed',
        cap: 'consumables',
        values: {
          lastChangedAt: 1_000_000,
          lastFetchedAt: 1_000_000,
          items: [
            {
              key: 'desiccant',
              label: 'Desiccant',
              level: null,
              status: 'ok',
              lastResetAt: null,
              resettable: false,
              remaining: { value: 12, kind: 'duration' },
            },
            {
              key: 'filter',
              label: 'Filter',
              level: null,
              status: 'ok',
              lastResetAt: null,
              resettable: false,
            },
          ],
        },
      },
    ])
    expect(target.availability).toEqual([true])
  })

  it('a change to ONE item leaf patches the WHOLE array — the other item is never dropped', () => {
    runtime.start()
    now = 1_000_500
    readings.set(daysKey(), fresh(0))
    runtime.onSourcesChanged(new Set([compositionSliceKey(DAYS_SOURCE, 'numeric-sensor')]))
    const last = target.writes.at(-1)
    expect(last?.op).toBe('patch')
    expect(last?.values['items']).toEqual([
      expect.objectContaining({
        key: 'desiccant',
        status: 'replace',
        remaining: { value: 0, kind: 'duration' },
      }),
      expect.objectContaining({ key: 'filter', status: 'ok' }),
    ])
    expect(last?.values['lastChangedAt']).toBe(1_000_500)
  })

  it('a nullable item leaf that goes unavailable is written null inside its item', () => {
    runtime.start()
    readings.set(daysKey(), { state: 'unavailable', reason: 'sensor offline', fatal: false })
    runtime.onSourcesChanged(new Set([compositionSliceKey(DAYS_SOURCE, 'numeric-sensor')]))
    const last = target.writes.at(-1)
    expect(last?.values['items']).toEqual([
      expect.objectContaining({ key: 'desiccant', remaining: { value: null, kind: 'duration' } }),
      expect.objectContaining({ key: 'filter' }),
    ])
    expect(target.availability).toEqual([true])
  })

  it('a required item leaf with no fallback holds the WHOLE items field, named once (defensive)', () => {
    runtime = runtimeWith(
      consumablesPlan().map((f) =>
        f.item?.key === 'desiccant' && f.path === 'remaining.value'
          ? { ...f, nullable: false, unavailable: 'offline' }
          : f,
      ),
    )
    runtime.start()
    readings.set(daysKey(), { state: 'unavailable', reason: 'sensor offline', fatal: false })
    runtime.onSourcesChanged(new Set([compositionSliceKey(DAYS_SOURCE, 'numeric-sensor')]))
    runtime.onSourcesChanged(new Set([compositionSliceKey(DAYS_SOURCE, 'numeric-sensor')]))
    expect(target.writes.filter((w) => 'items' in w.values)).toHaveLength(1)
    expect(target.availability).toEqual([true, false])
    const held = log.lines.filter((l) => l.message.includes('items held'))
    expect(held).toHaveLength(1)
    expect(held[0]?.extras).toMatchObject({
      tags: { deviceId: 1901 },
      meta: { cap: 'consumables', missing: ['items[desiccant].remaining.value'] },
    })
  })
})

/** The room, where `binary.on` REPLACES a native field: unavailable hands it back (S1b). */
function releasePlan(): readonly CompositionFieldPlan[] {
  return roomPlan().map((f) => (f.path === 'on' ? { ...f, unavailable: 'release' } : f))
}

const motion = (): string => compositionSliceKey(M1!, 'motion')
/** A CONFIRMED unavailability (an answer, e.g. an unregistration a re-read agreed with): the only kind that releases. */
const UNREACHABLE: SourceReading = {
  state: 'unavailable',
  reason: 'motion sensor unreachable',
  fatal: false,
  confirmed: true,
}
/** No answer yet — a failed, first or empty read (D49): HOLDS a release field, never releases it. */
const UNANSWERED: SourceReading = {
  state: 'unavailable',
  reason: 'motion sensor read failed',
  fatal: false,
}

describe('a `release` field whose source is unavailable is handed back (D663, S1b)', () => {
  beforeEach(() => {
    runtime = runtimeWith(releasePlan())
    runtime.start()
  })

  it('withholds the field, reports it released with its reason, never takes the device offline', () => {
    readings.set(k(M1, 'motion', 'detected'), UNREACHABLE)
    runtime.onSourcesChanged(new Set([motion()]))
    expect(target.withholds).toEqual([{ cap: 'binary', fields: ['on'] }])
    expect(runtime.state().released).toEqual([
      { cap: 'binary', path: 'on', reason: expect.stringContaining('unreachable') },
    ])
    expect(runtime.state().fields.find((f) => f.path === 'on')).toMatchObject({
      state: 'unavailable',
      value: null,
    })
    expect(target.availability).toEqual([true])
    expect(runtime.state().failure).toBeNull()
    const line = log.lines.find((l) => l.extras?.meta?.['direction'] === 'released')
    expect(line?.extras).toMatchObject({
      tags: { deviceId: 1901 },
      meta: { blockId: 'b-room', cap: 'binary', field: 'on', direction: 'released' },
    })
    // The same released set is not re-sent on a pass that changes nothing.
    runtime.onSourcesChanged(new Set([motion()]))
    expect(target.withholds).toHaveLength(1)
  })

  it('the source coming back re-widens the claim, then writes the field again', () => {
    readings.set(k(M1, 'motion', 'detected'), UNREACHABLE)
    runtime.onSourcesChanged(new Set([motion()]))
    const before = target.writes.length
    now = 1_000_100
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    runtime.onSourcesChanged(new Set([motion()]))
    expect(target.withholds.at(-1)).toEqual({ cap: 'binary', fields: [] })
    expect(target.writes.length).toBe(before + 1)
    expect(target.writes.at(-1)).toMatchObject({
      op: 'patch',
      cap: 'binary',
      values: { on: true },
    })
    expect(runtime.state().released).toEqual([])
    expect(log.lines.some((l) => l.extras?.meta?.['direction'] === 'reclaimed')).toBe(true)
  })

  it('an UNCONFIRMED unavailability HOLDS the field (D49, fix round 2): no withhold, no write, named in `held`; the answer then decides', () => {
    const writes = target.writes.length
    readings.set(k(M1, 'motion', 'detected'), UNANSWERED)
    runtime.onSourcesChanged(new Set([motion()]))
    expect(target.withholds).toEqual([])
    expect(target.writes.length).toBe(writes)
    expect(runtime.state().released).toEqual([])
    expect(runtime.state().held).toEqual([
      { cap: 'binary', path: 'on', reason: expect.stringContaining('read failed') },
    ])
    readings.set(k(M1, 'motion', 'detected'), UNREACHABLE)
    runtime.onSourcesChanged(new Set([motion()]))
    expect(target.withholds).toEqual([{ cap: 'binary', fields: ['on'] }])
    expect(runtime.state().held).toEqual([])
  })

  it('a runtime STARTED on an unconfirmed release field does not seed (claim) that cap — the persisted claim stays as it is', () => {
    target = new FakeTarget(1902)
    readings.set(k(M1, 'motion', 'detected'), UNANSWERED)
    const held = runtimeWith(releasePlan())
    held.start()
    expect(target.writes.filter((w) => w.cap === 'binary')).toEqual([])
    expect(target.withholds).toEqual([])
    expect(held.state().held).toHaveLength(1)
  })

  it('stale is a value (D49): nothing is withheld, the last value stays', () => {
    readings.set(k(M1, 'motion', 'detected'), {
      state: 'stale',
      value: false,
      reason: 'the source device is offline',
    })
    runtime.onSourcesChanged(new Set([motion()]))
    expect(target.withholds).toEqual([])
    expect(runtime.state().released).toEqual([])
    expect(runtime.state().fields.find((f) => f.path === 'on')).toMatchObject({
      state: 'stale',
      value: true,
    })
  })

  it('a withhold the target could not land is re-sent on the next pass', () => {
    readings.set(k(M1, 'motion', 'detected'), UNREACHABLE)
    runtime.onSourcesChanged(new Set([motion()]))
    target.failAsync('binary', { kind: 'threw', error: 'hub down' })
    runtime.onSourcesChanged(new Set([motion()]))
    expect(target.withholds).toEqual([
      { cap: 'binary', fields: ['on'] },
      { cap: 'binary', fields: ['on'] },
    ])
  })
})

const CLAIM_OK: ClaimOutcome = { ok: true, changed: true }

function fakeApi(): OwnedFieldsApi {
  return {
    claimFields: vi.fn(async () => CLAIM_OK),
    patchOwnedFields: vi.fn(async () => CLAIM_OK),
    releaseClaim: vi.fn(async () => CLAIM_OK),
  }
}

/** The room's claimed field sets, as Task 11 feeds them from the plan. */
const ROOM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  binary: ['on', 'lastChangedAt'],
  'temperature-sensor': ['celsius', 'lastFetchedAt'],
}

/** The chain has no timers: two macrotask turns drain it. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

function ownedRuntime(
  api: OwnedFieldsApi,
  fields: readonly CompositionFieldPlan[],
): CompositionRuntime {
  const owned = new OwnedFieldsTarget({
    deviceId: 1901,
    owner: 'b-room',
    modeOf: () => 'replace',
    fieldsOf: (cap) => ROOM_FIELDS[cap] ?? [],
    api,
    logger: log.logger,
  })
  return new CompositionRuntime({
    blockId: 'b-room',
    fields,
    eventPlans: [],
    events: { emit: () => undefined },
    target: owned,
    lookupCap: LOOKUP_CAP,
    read: (r) =>
      readings.get(compositionReadKey(r)) ?? {
        state: 'unavailable',
        reason: 'no fixture',
        fatal: false,
      },
    now: () => now,
    timer,
    logger: log.logger,
  })
}

const binaryClaims = (api: OwnedFieldsApi) =>
  vi.mocked(api.claimFields).mock.calls.filter(([input]) => input.capName === 'binary')

describe('over the REAL claim-backed target (D663 fix round 1)', () => {
  let api: OwnedFieldsApi

  beforeEach(() => {
    api = fakeApi()
  })

  it('I-1: releasing ONE field of a two-field cap sends the NARROWED claim at once — no sibling change needed', async () => {
    runtime = ownedRuntime(api, releasePlan())
    runtime.start()
    await settle()
    expect(binaryClaims(api).at(-1)?.[0]).toMatchObject({ fields: ['on', 'lastChangedAt'] })
    readings.set(k(M1, 'motion', 'detected'), UNREACHABLE)
    runtime.onSourcesChanged(new Set([motion()]))
    await settle()
    expect(api.releaseClaim).not.toHaveBeenCalled()
    expect(binaryClaims(api).at(-1)?.[0]).toEqual({
      deviceId: 1901,
      capName: 'binary',
      owner: 'b-room',
      mode: 'replace',
      fields: ['lastChangedAt'],
      values: { lastChangedAt: 1_000_000 },
    })
  })

  it('I-3: a TERMINAL refusal (owned-by-other) stops the cap for good — one claim RPC, however many source events follow; state names it', async () => {
    vi.mocked(api.claimFields).mockImplementation(async (input) =>
      input.capName === 'binary'
        ? { ok: false, code: 'owned-by-other', message: 'binary is owned by blk-9' }
        : CLAIM_OK,
    )
    runtime = ownedRuntime(api, roomPlan())
    runtime.start()
    await settle()
    for (const detected of [true, false, true]) {
      now += 1_000
      readings.set(k(M1, 'motion', 'detected'), fresh(detected))
      runtime.onSourcesChanged(new Set([motion()]))
      await settle()
    }
    expect(binaryClaims(api)).toHaveLength(1)
    expect(api.patchOwnedFields).not.toHaveBeenCalled()
    expect(runtime.state().fields.find((f) => f.path === 'on')).toMatchObject({
      state: 'unavailable',
      value: null,
      reason: expect.stringContaining('owned-by-other'),
    })
    expect(runtime.state().failure).toContain('binary')
    expect(runtime.state().fields.find((f) => f.path === 'celsius')?.state).toBe('fresh')
    const errors = log.lines.filter(
      (l) => l.level === 'error' && l.message.includes('refused for good'),
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]?.extras).toMatchObject({
      tags: { deviceId: 1901 },
      meta: { cap: 'binary', code: 'owned-by-other' },
    })
  })

  it('a TRANSIENT refusal (migration-in-flight) stays pending and is retried on the next pass', async () => {
    vi.mocked(api.claimFields)
      .mockResolvedValueOnce(CLAIM_OK)
      .mockResolvedValueOnce({ ok: false, code: 'migration-in-flight', message: 'row moving' })
      .mockResolvedValue(CLAIM_OK)
    runtime = ownedRuntime(api, roomPlan())
    runtime.start()
    await settle()
    expect(runtime.state().failure).toBeNull()
    readings.set(k(M1, 'motion', 'detected'), fresh(true))
    runtime.onSourcesChanged(new Set([motion()]))
    await settle()
    expect(vi.mocked(api.claimFields)).toHaveBeenCalledTimes(3)
    expect(runtime.state().fields.every((f) => f.state === 'fresh')).toBe(true)
  })

  it('M-2: a failed whole-cap release is re-sent and, once accepted with nothing left to write, the cap is no longer pending', async () => {
    vi.mocked(api.releaseClaim)
      .mockRejectedValueOnce(new Error('hub down'))
      .mockResolvedValue(CLAIM_OK)
    // Both temperature fields are derived: every temperature source unavailable releases the WHOLE cap.
    const plan = roomPlan().map(
      (f): CompositionFieldPlan =>
        f.cap === 'temperature-sensor' ? { ...f, unavailable: 'release' } : f,
    )
    runtime = ownedRuntime(api, plan)
    runtime.start()
    await settle()
    for (const source of [T1, T2, T3]) {
      readings.set(k(source, 'temperature-sensor', 'celsius'), UNREACHABLE)
      readings.set(k(source, 'temperature-sensor', 'lastFetchedAt'), UNREACHABLE)
    }
    const allTemperature = new Set(
      [T1, T2, T3].map((source) => compositionSliceKey(source!, 'temperature-sensor')),
    )
    runtime.onSourcesChanged(allTemperature)
    await settle()
    expect(vi.mocked(api.releaseClaim)).toHaveBeenCalledTimes(1)
    expect(runtime.state().fields.find((f) => f.path === 'celsius')?.reason).toContain('threw')
    // The next pass re-sends the withhold; it lands; nothing remains to write.
    runtime.onSourcesChanged(allTemperature)
    await settle()
    expect(vi.mocked(api.releaseClaim)).toHaveBeenCalledTimes(2)
    expect(runtime.state().fields.find((f) => f.path === 'celsius')?.reason).toContain(
      'unreachable',
    )
    expect(
      runtime
        .state()
        .released.map((r) => r.path)
        .sort(),
    ).toEqual(['celsius', 'lastFetchedAt'])
  })

  it('M-1: a flapping source costs one RPC per transition, no amplification, and the transition line counts the flaps', async () => {
    runtime = ownedRuntime(api, releasePlan())
    runtime.start()
    await settle()
    const before = vi.mocked(api.claimFields).mock.calls.length
    for (const reading of [UNREACHABLE, fresh(true), UNREACHABLE, fresh(false)]) {
      readings.set(k(M1, 'motion', 'detected'), reading)
      runtime.onSourcesChanged(new Set([motion()]))
      await settle()
    }
    // 4 transitions → 4 claims (2 narrowed, 2 re-widened), no release: lastChangedAt stays claimable.
    expect(vi.mocked(api.claimFields).mock.calls.length - before).toBe(4)
    expect(api.releaseClaim).not.toHaveBeenCalled()
    const released = log.lines.filter((l) => l.extras?.meta?.['direction'] === 'released')
    expect(released.map((l) => l.extras?.meta?.['flaps'])).toEqual([1, 2])
  })
})
