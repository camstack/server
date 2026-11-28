/**
 * A COLD DIRECTORY MUST NOT SEND A BLIND OFFLINE (planning#726). The centre
 * restarted, replayed offline for accessories before its directory knew them,
 * and "35 devices offline" was sent at +90 s.
 *
 * Each branch of the fix has its own spec; the comment on each names the piece
 * that, reverted, makes it fail.
 */
import type { InMemoryRecords } from '@dominevo/types'
import { createEvent, DeviceType, NcRuleInputSchema, type SystemEvent } from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcDeviceIdentity } from '../device-directory.js'
import { NotificationCenter } from '../index.js'
import { DEVICE_LIVENESS_HOLDOFF_MS } from '../liveness-holdoff.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { makeNcRecords, ncPruneWindowsPort, ncTable } from './support/nc-test-deps.js'

const ACCESSORY = 6001
const FIRST_LEVEL = 6002
const LATE_ACCESSORY = 6003
const UNKNOWN_ID = 7777
const STREAM_DEVICE = 6004
const NODE = 'agent-a'
const WINDOW = DEVICE_LIVENESS_HOLDOFF_MS
const STREAM_WINDOW = 15_000
const NODE_WINDOW = 60_000
const RELOAD_MS = 20_000

const TARGETS = [
  { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
] as const

const centers: NotificationCenter[] = []
/** First reads still pending at the end of a test: answered so `stop()` can finish. */
const unanswered: Array<() => void> = []

afterEach(async () => {
  for (const answer of unanswered.splice(0)) answer()
  await Promise.all(centers.map((center) => center.stop()))
  centers.length = 0
  vi.useRealTimers()
})

function device(deviceId: number, parentDeviceId: number | null): NcDeviceIdentity {
  return {
    deviceId,
    type: DeviceType.Sensor,
    name: `Device ${deviceId}`,
    isCamera: false,
    online: false,
    parentDeviceId,
  }
}

type DirectoryRead = () => Promise<readonly NcDeviceIdentity[]>

interface Harness {
  readonly center: NotificationCenter
  readonly world: InMemoryRecords
  /** Every info line the centre logged: message plus its meta. */
  readonly lines: readonly string[]
}

async function startCenter(read: DirectoryRead, started: 'await' | 'detach'): Promise<Harness> {
  const world = makeNcRecords()
  const lines: string[] = []
  const logger = mergeSilentLogger({
    info: (message, extras) => {
      lines.push(`${message} ${JSON.stringify(extras?.meta ?? {})}`)
    },
  })
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger,
    pruneWindows: ncPruneWindowsPort(),
    livenessHoldoffMs: WINDOW,
    streamLivenessHoldoffMs: STREAM_WINDOW,
    nodeLivenessHoldoffMs: NODE_WINDOW,
    dispatcher: {
      listTargets: async () => [...TARGETS],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Sensor',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: read,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: RELOAD_MS,
  })
  centers.push(center)
  if (started === 'await') {
    await center.start({ evaluation: true })
    await center.whenHydrated()
  } else {
    void center.start({ evaluation: true })
    await vi.advanceTimersByTimeAsync(10)
  }
  for (const kinds of [
    ['device-online', 'device-offline'],
    ['stream-online', 'stream-offline'],
    ['node-online', 'node-offline'],
  ]) {
    await center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: `Liveness ${kinds[0]}`,
        delivery: 'system-event',
        conditions: { systemEvent: { kinds } },
        targets: [{ targetId: 'target-1' }],
        media: { attach: 'none' },
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })
  }
  return { center, world, lines }
}

/** A directory that has not answered; `answer` is its first read finishing. */
async function startCold(
  devices: readonly NcDeviceIdentity[],
): Promise<Harness & { answer(): void }> {
  let answer: (list: readonly NcDeviceIdentity[]) => void = () => undefined
  const firstRead = new Promise<readonly NcDeviceIdentity[]>((resolve) => {
    answer = resolve
  })
  const harness = await startCenter(() => firstRead, 'detach')
  unanswered.push(() => answer([]))
  return { ...harness, answer: () => answer(devices) }
}

function liveness(deviceId: number, online: boolean): SystemEvent {
  return createEvent(
    online ? 'device.online' : 'device.offline',
    { type: 'device', id: deviceId },
    { deviceId, providerId: 'provider-unifi' },
  )
}

function outbox(world: InMemoryRecords): number {
  return ncTable(world, 'outbox').size
}

function logged(lines: readonly string[], fragment: string): boolean {
  return lines.some((line) => line.includes(fragment))
}

describe('an offline from a cold directory is judged once it answers (planning#726)', () => {
  // Reverted: `releaseDirectoryParked` + `arm` parking -> the flip arms blind and speaks at +90 s.
  it('THE INCIDENT: cold offline, directory places an accessory, its drop, 90 s: nothing is sent', async () => {
    vi.useFakeTimers()
    const { center, world, answer } = await startCold([
      device(ACCESSORY, 6000),
      device(FIRST_LEVEL, null),
    ])
    center.onSystemEvent(liveness(ACCESSORY, true))
    center.onSystemEvent(liveness(ACCESSORY, false))
    answer()
    await vi.advanceTimersByTimeAsync(1_000)
    center.onSystemEvent(liveness(ACCESSORY, true))
    await vi.advanceTimersByTimeAsync(WINDOW * 2)
    expect(outbox(world)).toBe(0)
  })

  it('control: a real first-level device offline from a cold directory still fires after 90 s', async () => {
    vi.useFakeTimers()
    const { center, world, answer } = await startCold([
      device(ACCESSORY, 6000),
      device(FIRST_LEVEL, null),
    ])
    center.onSystemEvent(liveness(FIRST_LEVEL, true))
    center.onSystemEvent(liveness(FIRST_LEVEL, false))
    answer()
    await vi.advanceTimersByTimeAsync(WINDOW - 5_000)
    expect(outbox(world)).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => {
      expect(outbox(world)).toBeGreaterThan(0)
    })
  })

  // Reverted: the bound timer in `parkForDirectory` -> the flip is parked forever, nothing is said.
  it('a directory that never answers: the flip speaks after the bound, and says how long it was held', async () => {
    vi.useFakeTimers()
    const { center, world, lines } = await startCold([])
    center.onSystemEvent(liveness(FIRST_LEVEL, true))
    center.onSystemEvent(liveness(FIRST_LEVEL, false))
    await vi.advanceTimersByTimeAsync(WINDOW - 5_000)
    expect(outbox(world)).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => {
      expect(outbox(world)).toBeGreaterThan(0)
    })
    expect(logged(lines, '"reason":"bound"')).toBe(true)
    expect(logged(lines, `"heldMs":${WINDOW}`)).toBe(true)
  })

  // Reverted: `hasAnswered()` -> `isWarm()` in `judgeLivenessDevice`: the empty read releases the flip.
  it('an EMPTY first answer is not an answer: the flip stays parked until the bound', async () => {
    vi.useFakeTimers()
    const { center, world, lines } = await startCenter(async () => [], 'await')
    center.onSystemEvent(liveness(FIRST_LEVEL, true))
    center.onSystemEvent(liveness(FIRST_LEVEL, false))
    await vi.advanceTimersByTimeAsync(RELOAD_MS + 1_000)
    expect(logged(lines, 'the device directory has not loaded')).toBe(true)
    expect(logged(lines, '"reason":"directory-warm"')).toBe(false)
    await vi.advanceTimersByTimeAsync(WINDOW)
    expect(logged(lines, '"reason":"bound"')).toBe(true)
    await vi.waitFor(() => {
      expect(outbox(world)).toBeGreaterThan(0)
    })
  })
})

describe('a warm directory judges only accessories (planning#726)', () => {
  // Reverted: `judgeLivenessDevice` answering 'accessory' for an id it cannot place.
  it('an id the warm directory cannot place SPEAKS', async () => {
    vi.useFakeTimers()
    const { center, world } = await startCenter(async () => [device(FIRST_LEVEL, null)], 'await')
    center.onSystemEvent(liveness(UNKNOWN_ID, true))
    center.onSystemEvent(liveness(UNKNOWN_ID, false))
    await vi.advanceTimersByTimeAsync(WINDOW + 1_000)
    await vi.waitFor(() => {
      expect(outbox(world)).toBeGreaterThan(0)
    })
  })

  // Reverted: the `dropByJudgement` call in `fire()` -> the flip is announced at +90 s.
  it('fire() re-judges: the device becomes an accessory between arm and fire, nothing is sent', async () => {
    vi.useFakeTimers()
    let list: readonly NcDeviceIdentity[] = [device(LATE_ACCESSORY, null)]
    const { center, world, lines } = await startCenter(async () => list, 'await')
    center.onSystemEvent(liveness(LATE_ACCESSORY, true))
    center.onSystemEvent(liveness(LATE_ACCESSORY, false))
    list = [device(LATE_ACCESSORY, 6000)]
    await vi.advanceTimersByTimeAsync(WINDOW + 1_000)
    expect(outbox(world)).toBe(0)
    expect(logged(lines, 'liveness flip dropped - not announced')).toBe(true)
  })

  // Reverted: the `cancelFlip` call in `holdUntilIntegrationAnswers`. The log line is what the
  // spec reads, because `fire()`'s re-judge would also keep the outbox empty.
  it('an accessory drop cancels the armed flip: the recovery arrives after the directory placed it', async () => {
    vi.useFakeTimers()
    let list: readonly NcDeviceIdentity[] = [device(LATE_ACCESSORY, null)]
    const { center, world, lines } = await startCenter(async () => list, 'await')
    center.onSystemEvent(liveness(LATE_ACCESSORY, true))
    center.onSystemEvent(liveness(LATE_ACCESSORY, false))
    list = [device(LATE_ACCESSORY, 6000)]
    await vi.advanceTimersByTimeAsync(RELOAD_MS + 1_000)
    center.onSystemEvent(liveness(LATE_ACCESSORY, true))
    expect(logged(lines, 'liveness flip cancelled - the device is an accessory')).toBe(true)
    await vi.advanceTimersByTimeAsync(WINDOW * 2)
    expect(outbox(world)).toBe(0)
  })
})

describe('node and stream hold-offs do not wait for the device directory (planning#726)', () => {
  // Reverted: a `judge` passed to the stream or node hold-off in the centre's constructor.
  it('with a cold directory a stream offline fires at its own 15 s window, a node offline at 60 s', async () => {
    vi.useFakeTimers()
    // The stream's device is an accessory in the directory that answers 1 s later: the stream
    // window does not consult the directory, so its flip is unchanged.
    const { center, world, answer } = await startCold([device(STREAM_DEVICE, 6000)])
    center.onSystemEvent(
      createEvent(
        'stream.offline',
        { type: 'device', id: STREAM_DEVICE },
        {
          deviceId: STREAM_DEVICE,
          profile: 'high',
          reason: 'stale-timeout',
          brokerId: 'broker-1',
          sourceType: 'rtsp',
          lastPacketAt: 0,
        },
      ),
    )
    await vi.advanceTimersByTimeAsync(1_000)
    answer()
    await vi.advanceTimersByTimeAsync(STREAM_WINDOW + 1_000)
    await vi.waitFor(() => {
      expect(outbox(world)).toBe(1)
    })
    const node = (online: boolean): SystemEvent =>
      createEvent(
        online ? 'agent.online' : 'agent.offline',
        { type: 'core', id: 'agent-registry' },
        { agentId: NODE },
      )
    center.onSystemEvent(node(true))
    center.onSystemEvent(node(false))
    await vi.advanceTimersByTimeAsync(NODE_WINDOW + 1_000)
    await vi.waitFor(() => {
      expect(outbox(world)).toBe(2)
    })
  })
})
