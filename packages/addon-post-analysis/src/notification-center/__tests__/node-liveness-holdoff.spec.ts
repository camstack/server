/**
 * NODE LIVENESS — INSTANT, BUT NOT A PAGER FOR A RECONNECT STORM (D820).
 *
 * 2026-10-09: `agent-a` froze for ~45 min and the operator heard nothing,
 * because the only rule naming `node-offline` was a twice-a-day state summary.
 * An instant rule fixes that — and on the same morning the node's return
 * flipped it offline/online every 2–6 s for twenty minutes, so an instant rule
 * WITHOUT a grace period would have paged ~90 times per quarter hour.
 *
 * These specs pin the wiring: a flap shorter than the 60 s hold-off says
 * nothing, an outage that outlasts it is announced once (with the reason and
 * the display name), and the recovery says how long the node was gone.
 */
import type { InMemoryRecords } from '@camstack/types'
import { ncTable, makeNcRecords } from './support/nc-test-deps.js'
import { createEvent, NcRuleInputSchema, type SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NotificationCenter } from '../index.js'
import { NODE_LIVENESS_HOLDOFF_MS } from '../liveness-holdoff.js'
import { resolvePruneWindows } from '../prune-windows.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const TARGETS = [
  { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
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

describe('node liveness 60 s hold-off, wired', () => {
  it('a reconnect storm shorter than the hold-off notifies nothing', async () => {
    const world = await seededCenter()
    const center = centers[0]
    for (let i = 0; i < 10; i++) {
      center?.onSystemEvent(agent(false, 'connection-lost'))
      await vi.advanceTimersByTimeAsync(3_000)
      center?.onSystemEvent(agent(true))
      await vi.advanceTimersByTimeAsync(3_000)
    }
    await vi.advanceTimersByTimeAsync(NODE_LIVENESS_HOLDOFF_MS * 2)
    expect(ncTable(world, 'outbox')?.size ?? 0).toBe(0)
  })

  it('an outage that outlasts the hold-off is announced ONCE, named, with the reason', async () => {
    const world = await seededCenter()
    centers[0]?.onSystemEvent(agent(false, 'connection-lost'))
    await vi.advanceTimersByTimeAsync(NODE_LIVENESS_HOLDOFF_MS - 1_000)
    expect(ncTable(world, 'outbox')?.size ?? 0).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    const [offline] = frozen(world)
    expect(offline?.kind).toBe('node-offline')
    expect(offline?.bodyKey).toBe('system.node-offline.body.agent.connection-lost')
    expect(offline?.textParams?.['nodeName']).toBe('Unraid piccolo')
    expect(offline?.textParams?.['nodeId']).toBe(NODE)
  })

  it('the recovery says how long the node was offline, counted from the first disconnect', async () => {
    const world = await seededCenter()
    const center = centers[0]
    center?.onSystemEvent(agent(false))
    await vi.advanceTimersByTimeAsync(44 * 60_000)
    // The return is itself stormy; only the settled state is announced.
    center?.onSystemEvent(agent(true))
    await vi.advanceTimersByTimeAsync(2_000)
    center?.onSystemEvent(agent(false))
    await vi.advanceTimersByTimeAsync(2_000)
    center?.onSystemEvent(agent(true))
    await vi.advanceTimersByTimeAsync(NODE_LIVENESS_HOLDOFF_MS)
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(2)
    })
    const kinds = frozen(world).map((row) => row.kind)
    expect(kinds).toEqual(['node-offline', 'node-online'])
    const online = frozen(world)[1]
    expect(online?.bodyKey).toBe('system.node-online.body.agent.after')
    // Offline began at t=0; the return that SETTLED came at 44 min 4 s.
    expect(online?.textParams?.['offlineFor']).toBe('44 min')
    expect(online?.textParams?.['nodeName']).toBe('Unraid piccolo')
  })
})
