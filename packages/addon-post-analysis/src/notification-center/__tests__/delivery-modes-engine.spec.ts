/**
 * DELIVERY MODES ON A SYSTEM RULE (D1019) — what the engine does with a match.
 *
 * One rule on the node pair `node-offline` / `node-online` is driven through a
 * whole outage and recovery under each combination of modes:
 *
 *  - activation only  → the offline is sent, the recovery edge is dropped;
 *  - deactivation only → the recovery is sent, the offline is dropped;
 *  - activation + schedule → the offline is sent AND the recovery edge is held
 *    for the summary (not sent, not "no match");
 *  - schedule only (the old `summary`) and a legacy `instant` behave as before.
 */
import type { InMemoryRecords, IScopedLogger, NcSystemEventDelivery } from '@camstack/types'
import { createEvent, NcRuleInputSchema, type SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationCenter } from '../index.js'
import { NODE_LIVENESS_HOLDOFF_MS } from '../liveness-holdoff.js'
import { resolvePruneWindows } from '../prune-windows.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'

const TARGETS = [
  { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
] as const
const NODE = 'agent-a'
const SCHEDULE = { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1199, endMinute: 1200 }] }

const centers: NotificationCenter[] = []

afterEach(async () => {
  await Promise.all(centers.map((center) => center.stop()))
  centers.length = 0
  vi.useRealTimers()
})

interface Recorded {
  readonly debug: string[]
}

function recordingLogger(recorded: Recorded): IScopedLogger {
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: (message: string) => {
      recorded.debug.push(message)
    },
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const HELD = 'rule matched — held for its scheduled state summary'

async function startCenter(
  world: InMemoryRecords,
  delivery: NcSystemEventDelivery | undefined,
  recorded: Recorded,
): Promise<NotificationCenter> {
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: recordingLogger(recorded),
    nodeLivenessHoldoffMs: NODE_LIVENESS_HOLDOFF_MS,
    dispatcher: {
      listTargets: async () => [...TARGETS],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Camera',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [],
    pruneWindows: async () => resolvePruneWindows({}),
    readNodeDirectory: async () => ({
      nodes: [{ id: NODE, isOnline: false, name: 'Unraid piccolo' }],
      complete: true,
    }),
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: true })
  await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Nodi',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['node-offline', 'node-online'] } },
      ...(delivery !== undefined ? { systemEventDelivery: delivery } : {}),
      targets: [{ targetId: 'target-1' }],
      media: { attach: 'none' },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
    }),
  })
  return center
}

function agent(online: boolean): SystemEvent {
  return createEvent(
    online ? 'agent.online' : 'agent.offline',
    { type: 'core', id: 'agent-registry' },
    online ? { agentId: NODE } : { agentId: NODE, reason: 'connection-lost' },
  )
}

function sentKinds(world: InMemoryRecords): readonly string[] {
  return [...(ncTable(world, 'outbox')?.values() ?? [])].map((row) => {
    const payload = (row as { payload: { subject: { systemEvent: { kind: string } } } }).payload
    return payload.subject.systemEvent.kind
  })
}

/** An outage that outlasts the hold-off, then a settled recovery. */
async function outageAndRecovery(
  delivery: NcSystemEventDelivery | undefined,
): Promise<{ kinds: readonly string[]; held: number }> {
  vi.useFakeTimers()
  const world = makeNcRecords()
  const recorded: Recorded = { debug: [] }
  const center = await startCenter(world, delivery, recorded)
  center.onSystemEvent(agent(true)) // first observation: seeds, never notifies
  center.onSystemEvent(agent(false))
  await vi.advanceTimersByTimeAsync(NODE_LIVENESS_HOLDOFF_MS + 1_000)
  center.onSystemEvent(agent(true))
  await vi.advanceTimersByTimeAsync(NODE_LIVENESS_HOLDOFF_MS + 1_000)
  return { kinds: sentKinds(world), held: recorded.debug.filter((m) => m === HELD).length }
}

describe('delivery modes — the engine', () => {
  it('activation only: the offline is sent, the recovery edge is dropped', async () => {
    const out = await outageAndRecovery({
      mode: 'modes',
      onActivation: true,
      onDeactivation: false,
    })
    expect(out).toEqual({ kinds: ['node-offline'], held: 0 })
  })

  it('deactivation only: the recovery is sent, the offline is dropped', async () => {
    const out = await outageAndRecovery({
      mode: 'modes',
      onActivation: false,
      onDeactivation: true,
    })
    expect(out).toEqual({ kinds: ['node-online'], held: 0 })
  })

  it('activation + schedule: sends the instant AND holds the other edge for the summary', async () => {
    const out = await outageAndRecovery({
      mode: 'modes',
      onActivation: true,
      onDeactivation: false,
      onSchedule: { schedule: SCHEDULE, grouping: 'rule' },
    })
    expect(out).toEqual({ kinds: ['node-offline'], held: 1 })
  })

  it('schedule only: nothing at once, every match held — exactly the old summary', async () => {
    const legacy = await outageAndRecovery({ mode: 'summary', schedule: SCHEDULE })
    const modes = await outageAndRecovery({
      mode: 'modes',
      onActivation: false,
      onDeactivation: false,
      onSchedule: { schedule: SCHEDULE, grouping: 'rule' },
    })
    expect(legacy).toEqual({ kinds: [], held: 2 })
    expect(modes).toEqual(legacy)
  })

  it('a stored legacy instant rule (key absent) still hears both edges', async () => {
    const out = await outageAndRecovery(undefined)
    expect(out).toEqual({ kinds: ['node-offline', 'node-online'], held: 0 })
  })
})
