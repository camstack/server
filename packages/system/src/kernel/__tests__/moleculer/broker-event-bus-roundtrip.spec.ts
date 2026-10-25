/**
 * Broker event-bus round-trip — worker emit → hub via `camstack.evt.*` broadcast.
 *
 * The benchmark addon (and every other forkable addon) runs in a child
 * process. When it calls `this.ctx.eventBus.emit(event)`, the scoped
 * bus is the broker-backed implementation from
 * `createAddonContext` → `createBrokerEventBus`. That bus calls
 * `broker.broadcast('camstack.evt.<category>', event)` — one Moleculer
 * event per category that reaches every broker's `$event-bus` service
 * wildcard handler. The legacy `broker.call('$hub.event', …)` path was
 * removed as redundant.
 *
 * These tests assert the round-trip actually works in a real Moleculer
 * cluster setup (Fake transporter in-memory, two brokers, real
 * HubService registered on the hub side, a `$event-bus` wildcard
 * subscriber installed on the hub). They isolate the kernel-layer
 * plumbing from the NestJS / WS layer so we can tell where the chain
 * breaks in production when the UI stops seeing events.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ServiceBroker } from 'moleculer'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createAddonContext,
  getBrokerEventBus,
  registerEventBusService,
} from '../../moleculer/addon-context-factory.js'
import { createHubService } from '../../moleculer/hub-service.js'
import { EventCategory } from '@camstack/types'
import type { AddonDeclaration, SystemEvent } from '@camstack/types'

function decl(id: string): AddonDeclaration {
  return { id, entry: './index.js' }
}

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `broker-eb-${label}-`))
}

async function waitFor<T>(fn: () => T | undefined, timeout = 2000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const v = fn()
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

describe('broker event-bus round-trip — worker emit → hub via camstack.evt.* broadcast', () => {
  let hubBroker: ServiceBroker
  let workerBroker: ServiceBroker
  let receivedEvents: SystemEvent[]
  let hubDir: string
  let workerDir: string

  beforeAll(async () => {
    hubBroker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    workerBroker = new ServiceBroker({
      nodeID: 'hub/benchmark',
      transporter: 'Fake',
      logger: false,
    })

    receivedEvents = []
    hubBroker.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )

    // Register `$event-bus` on both brokers BEFORE start so the Moleculer
    // handshake propagates the `camstack.evt.**` subscription. The hub
    // subscriber captures every event that reaches the hub via the cluster
    // broadcast — this is the only transport after the `$hub.event` removal.
    registerEventBusService(hubBroker)
    registerEventBusService(workerBroker)
    getBrokerEventBus(hubBroker).subscribe({ category: '**' }, (event) => {
      receivedEvents.push(event)
    })

    await hubBroker.start()
    await workerBroker.start()

    // Wait for node discovery — the worker must see the hub before any
    // cluster broadcast can be routed across the transport.
    await waitFor(() => {
      const nodes = workerBroker.registry
        .getNodeList({ onlyAvailable: true })
        .map((n: { id: string }) => n.id)
      return nodes.includes('hub') ? true : undefined
    })

    hubDir = tmpDir('hub')
    workerDir = tmpDir('worker')
  })

  afterAll(async () => {
    try {
      await workerBroker.stop()
    } catch {
      /* already stopped */
    }
    try {
      await hubBroker.stop()
    } catch {
      /* already stopped */
    }
    for (const dir of [hubDir, workerDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* swallow */
      }
    }
  })

  it('delivers a single event from worker ctx.eventBus.emit to the hub HubService handler', async () => {
    const ctx = await createAddonContext(workerBroker, decl('benchmark'), workerDir)

    const event: SystemEvent = {
      id: 'bench-1',
      timestamp: new Date(),
      source: { type: 'pipeline', id: 'benchmark' },
      category: EventCategory.BenchmarkProgress,
      data: { type: 'pipeline.benchmark.progress', iteration: 1, totalMs: 42 },
    }

    const before = receivedEvents.length
    ctx.eventBus.emit(event)

    const after = await waitFor(() =>
      receivedEvents.length > before ? receivedEvents.length : undefined,
    )

    expect(after).toBe(before + 1)
    // The bus enriches every emit with `sourceNodeId` + `sourceAddonId`
    // (see `createBrokerEventBus`). Those extra fields ride on the
    // broadcast payload; we look them up via index access so we don't
    // need a local type assertion on `SystemEvent`.
    const arrived = receivedEvents[after - 1]!
    expect(arrived.id).toBe('bench-1')
    expect(arrived.category).toBe(EventCategory.BenchmarkProgress)
    const enriched: Record<string, unknown> = { ...arrived }
    expect(enriched['sourceAddonId']).toBe('benchmark')
    expect(enriched['sourceNodeId']).toBe('hub/benchmark')
    expect(arrived.data['iteration']).toBe(1)
  })

  it('delivers a burst of events in order (matches runBenchmark loop pattern)', async () => {
    const ctx = await createAddonContext(workerBroker, decl('benchmark'), workerDir)

    const before = receivedEvents.length
    for (let i = 1; i <= 5; i++) {
      ctx.eventBus.emit({
        id: `burst-${i}`,
        timestamp: new Date(),
        source: { type: 'pipeline', id: 'benchmark' },
        category: EventCategory.BenchmarkProgress,
        data: { type: 'pipeline.benchmark.progress', iteration: i, totalMs: 50 + i },
      })
    }

    await waitFor(() => (receivedEvents.length >= before + 5 ? true : undefined))

    const burst = receivedEvents.slice(before, before + 5)
    const iterations = burst.map((e) => e.data['iteration'])
    expect(iterations).toEqual([1, 2, 3, 4, 5])
  })

  it('ignores non-matching categories but still delivers matching ones (smoke test for filtering downstream)', async () => {
    const ctx = await createAddonContext(workerBroker, decl('benchmark'), workerDir)

    const before = receivedEvents.length
    ctx.eventBus.emit({
      id: 'other-1',
      timestamp: new Date(),
      source: { type: 'pipeline', id: 'benchmark' },
      category: EventCategory.PlatformProbePhase,
      data: { type: EventCategory.PlatformProbePhase, phase: 'started' },
    })
    ctx.eventBus.emit({
      id: 'match-1',
      timestamp: new Date(),
      source: { type: 'pipeline', id: 'benchmark' },
      category: EventCategory.BenchmarkProgress,
      data: { type: 'pipeline.benchmark.progress', iteration: 99, totalMs: 99 },
    })

    await waitFor(() => (receivedEvents.length >= before + 2 ? true : undefined))

    // Hub receives both — downstream filtering happens in EventBusService
    // subscriber (subscribe({ category: EventCategory.BenchmarkProgress })).
    const recent = receivedEvents.slice(before, before + 2)
    const categories = recent.map((e) => e.category)
    expect(categories).toContain(EventCategory.PlatformProbePhase)
    expect(categories).toContain(EventCategory.BenchmarkProgress)
  })
})
