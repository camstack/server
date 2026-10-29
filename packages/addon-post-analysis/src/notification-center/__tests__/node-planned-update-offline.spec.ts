/**
 * A NODE THAT ANNOUNCED AN UPDATE IS NOT PAGED FOR GOING OFFLINE (planned-update grace).
 *
 * The announcement (`system.restarting`, kinds `node-updating` / `node-restarting`)
 * opens a window; an offline inside it is held up to PLANNED_UPDATE_OFFLINE_GRACE_MS.
 * Back inside the window: nothing. Not back: one offline whose wording says so.
 * No announcement, or one older than the window: the 60 s behaviour, unchanged.
 */
import type { InMemoryRecords } from '@camstack/types'
import { ncTable, makeNcRecords } from './support/nc-test-deps.js'
import { createEvent, NcRuleInputSchema, type SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NotificationCenter } from '../index.js'
import { NODE_LIVENESS_HOLDOFF_MS } from '../liveness-holdoff.js'
import { PLANNED_UPDATE_OFFLINE_GRACE_MS } from '../planned-update-window.js'
import { resolvePruneWindows } from '../prune-windows.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const TARGETS = [
  {
    id: 'target-1',
    addonId: 'notifiers',
    name: 'phone',
    kind: 'ntfy',
    enabled: true,
  },
] as const

const NODE = 'agent-a'

const centers: NotificationCenter[] = []

afterEach(async () => {
  await Promise.all(centers.map((center) => center.stop()))
  centers.length = 0
  vi.useRealTimers()
})

async function startCenter(world: InMemoryRecords): Promise<NotificationCenter> {
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
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
      name: 'Nodi — offline e ritorno online',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['node-offline', 'node-online'] } },
      systemEventDelivery: { mode: 'instant' },
      targets: [{ targetId: 'target-1' }],
      media: { attach: 'none' },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
    }),
  })
  return center
}

function agent(online: boolean, reason?: 'connection-lost' | 'shutdown'): SystemEvent {
  return createEvent(
    online ? 'agent.online' : 'agent.offline',
    { type: 'core', id: 'agent-registry' },
    online ? { agentId: NODE } : { agentId: NODE, ...(reason !== undefined ? { reason } : {}) },
  )
}

function announceUpdate(): SystemEvent {
  return createEvent(
    'system.restarting',
    { type: 'agent', id: NODE },
    {
      kind: 'framework-update',
      requestedAt: 1,
      packageName: '@camstack/server',
      fromVersion: '1.2.499',
      toVersion: '1.2.500',
      nodeId: NODE,
    },
  )
}

interface FrozenSystemEvent {
  readonly kind: string
  readonly bodyKey?: string
  readonly textParams?: Readonly<Record<string, string>>
}

function frozen(world: InMemoryRecords): readonly FrozenSystemEvent[] {
  return [...(ncTable(world, 'outbox')?.values() ?? [])].map((row) => {
    const payload = (row as { payload: { subject: { systemEvent: FrozenSystemEvent } } }).payload
    return payload.subject.systemEvent
  })
}

async function seededCenter(): Promise<InMemoryRecords> {
  vi.useFakeTimers()
  const world = makeNcRecords()
  const center = await startCenter(world)
  center.onSystemEvent(agent(true)) // first observation: seeds, never notifies
  return world
}

describe('planned-update offline grace, wired', () => {
  it('held, then back online inside the window: nothing is sent', async () => {
    const world = await seededCenter()
    const center = centers[0]
    center?.onSystemEvent(announceUpdate())
    center?.onSystemEvent(agent(false, 'shutdown'))
    await vi.advanceTimersByTimeAsync(NODE_LIVENESS_HOLDOFF_MS * 3)
    expect(ncTable(world, 'outbox')?.size ?? 0).toBe(0)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    center?.onSystemEvent(agent(true))
    await vi.advanceTimersByTimeAsync(PLANNED_UPDATE_OFFLINE_GRACE_MS * 2)
    expect(ncTable(world, 'outbox')?.size ?? 0).toBe(0)
  })

  it('held, never back: ONE offline at the end of the window, worded as an update', async () => {
    const world = await seededCenter()
    const center = centers[0]
    center?.onSystemEvent(announceUpdate())
    center?.onSystemEvent(agent(false, 'shutdown'))
    await vi.advanceTimersByTimeAsync(PLANNED_UPDATE_OFFLINE_GRACE_MS - 1_000)
    expect(ncTable(world, 'outbox')?.size ?? 0).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    const [offline] = frozen(world)
    expect(offline?.kind).toBe('node-offline')
    expect(offline?.bodyKey).toBe('system.node-offline.body.agent.updating')
    expect(offline?.textParams?.['graceMin']).toBe('10')
    expect(offline?.textParams?.['nodeName']).toBe('Unraid piccolo')
  })

  it('no announcement: the offline goes out at the normal hold-off', async () => {
    const world = await seededCenter()
    centers[0]?.onSystemEvent(agent(false, 'shutdown'))
    await vi.advanceTimersByTimeAsync(NODE_LIVENESS_HOLDOFF_MS)
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    expect(frozen(world)[0]?.bodyKey).toBe('system.node-offline.body.agent.shutdown')
  })

  it('a stale announcement (older than the window) does not suppress', async () => {
    const world = await seededCenter()
    const center = centers[0]
    center?.onSystemEvent(announceUpdate())
    await vi.advanceTimersByTimeAsync(PLANNED_UPDATE_OFFLINE_GRACE_MS + 1_000)
    center?.onSystemEvent(agent(false, 'shutdown'))
    await vi.advanceTimersByTimeAsync(NODE_LIVENESS_HOLDOFF_MS)
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    expect(frozen(world)[0]?.bodyKey).toBe('system.node-offline.body.agent.shutdown')
  })
})
