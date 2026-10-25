/**
 * A runner (a forked child process) restarting is NOT a node going offline.
 *
 * `worker.online` / `worker.offline` were dead for every forked runner from
 * Phase F until 2026-10-02: no broker, so no `$node.connected`. The UDS registry
 * now emits them (the D696 provider gate needs them). This intake used to fold
 * them into the agent's `node-online` / `node-offline` kinds, so the seeded
 * "system" rule (`kinds: ['node-offline','node-online']`, no `nodeIds`) would
 * have pushed "node offline / node online" for every decoder respawn, addon
 * restart and update, without a hold-off — and a runner restart could spend the
 * cooldown of the rule that must report a real agent outage (re-review R1-H1).
 *
 * So a worker event produces NO notification subject: the node kinds stay
 * agent-only, exactly as 1.2.430 delivered. A runner that really dies is
 * `addon.runner-failed` (the D6 breaker). The events still reach the gates and
 * the topology push, which subscribe to them directly. And the durable liveness
 * ledger never holds a worker under a node kind, so a hub shutdown (every child
 * socket closing) cannot leave a row that the next boot's `worker.online` would
 * read as a flip.
 */
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { createEvent, NcRuleInputSchema, type SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcDeviceLookup } from '../device-directory.js'
import type { NcTargetRef } from '../dispatcher.js'
import { incomingFromSystemEvent } from '../event-intake.js'
import { NotificationCenter } from '../index.js'
import { resolvePruneWindows } from '../prune-windows.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CLUSTER = { type: 'core', id: 'local-child-registry' } as const

/** No device is known to the directory: these events are about nodes, not devices. */
const noDevices: NcDeviceLookup = () => undefined

function worker(online: boolean, workerId: string): SystemEvent {
  return online
    ? createEvent('worker.online', CLUSTER, { workerId })
    : createEvent('worker.offline', CLUSTER, { workerId })
}

function agent(online: boolean, agentId: string): SystemEvent {
  return online
    ? createEvent('agent.online', { type: 'core', id: 'agent-registry' }, { agentId })
    : createEvent('agent.offline', { type: 'core', id: 'agent-registry' }, { agentId })
}

describe('a runner restart is not a node liveness notification (R1-H1)', () => {
  const centers: NotificationCenter[] = []
  afterEach(async () => {
    await Promise.all(centers.splice(0).map((center) => center.stop()))
  })

  it('the intake turns worker.online / worker.offline into no subject; an agent still is node-online / node-offline', () => {
    expect(incomingFromSystemEvent(worker(false, 'hub/decoder-nodeav'), noDevices)).toBeNull()
    expect(incomingFromSystemEvent(worker(true, 'hub/decoder-nodeav'), noDevices)).toBeNull()
    expect(
      incomingFromSystemEvent(agent(false, 'agent-a'), noDevices)?.subject.systemEvent,
    ).toMatchObject({
      kind: 'node-offline',
      subject: 'node:agent-a',
      nodeId: 'agent-a',
    })
  })

  async function center(): Promise<{
    readonly world: InMemoryRecords
    readonly center: NotificationCenter
  }> {
    const world = makeNcRecords()
    const targets: NcTargetRef[] = [
      { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
    ]
    const nc = new NotificationCenter({
      deviceSettings: makeFakeDeviceSettings(),
      records: world.records,
      logger: makeSilentLogger(),
      pruneWindows: async () => resolvePruneWindows({}),
      dispatcher: {
        listTargets: async () => targets,
        send: async () => ({ success: true }),
        getMediaForOwner: async () => [],
        getDeviceName: async () => null,
      },
      listObjectEventsSince: async () => [],
      listRecentTracks: async () => [],
      listDeviceIdentities: async () => [],
      drainIntervalMs: 3_600_000,
      ruleReloadIntervalMs: 3_600_000,
    })
    centers.push(nc)
    await nc.start({ evaluation: true })
    // The seeded "system" section's node rule: both node kinds, no node filter.
    await nc.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Nodes',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['node-offline', 'node-online'] } },
        targets: [{ targetId: 'target-1' }],
        throttle: { cooldownSec: 0, scope: 'rule' },
      }),
    })
    return { world, center: nc }
  }

  const outbox = (world: InMemoryRecords): number => ncTable(world, 'outbox')?.size ?? 0

  it('a runner restarting — offline then online, twice — pushes nothing; an agent going offline and online still does', async () => {
    const { world, center: nc } = await center()
    // Both nodes observed once first: the ledger seeds a first observation silently.
    nc.onSystemEvent(agent(true, 'agent-a'))
    nc.onSystemEvent(worker(true, 'hub/decoder-nodeav'))
    for (let i = 0; i < 2; i += 1) {
      nc.onSystemEvent(worker(false, 'hub/decoder-nodeav'))
      nc.onSystemEvent(worker(true, 'hub/decoder-nodeav'))
    }
    // Give the evaluation every chance to write a row it should not write.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(outbox(world)).toBe(0)

    nc.onSystemEvent(agent(false, 'agent-a'))
    await vi.waitFor(() => expect(outbox(world)).toBe(1))
    nc.onSystemEvent(agent(true, 'agent-a'))
    await vi.waitFor(() => expect(outbox(world)).toBe(2))
  })

  it('a hub shutdown — every child socket closing — writes no worker row into the durable liveness ledger', async () => {
    const { world, center: nc } = await center()
    nc.onSystemEvent(agent(true, 'agent-a'))
    for (const child of ['decoder-nodeav', 'notifiers', 'post-analysis', 'provider-hikvision']) {
      nc.onSystemEvent(worker(false, `hub/${child}`))
    }
    // The agent's row lands (write-behind): the probe below can see a row at all.
    await vi.waitFor(() =>
      expect([...(ncTable(world, 'liveness')?.keys() ?? [])]).toContain('node:agent-a'),
    )
    const keys = [...(ncTable(world, 'liveness')?.keys() ?? [])]
    expect(keys.filter((key) => key.includes('/'))).toEqual([])
  })
})
