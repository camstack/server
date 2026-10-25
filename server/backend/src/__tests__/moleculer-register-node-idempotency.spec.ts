/**
 * MoleculerService.applyNodeManifest re-handshake idempotency (D3).
 *
 * Pre-existing bug: `applyNodeManifest` ran on EVERY `$hub.registerNode`
 * and called `registry.registerProvider(cap, key, proxy)` unconditionally
 * for every cap in the manifest. The D3 protocol legitimately re-handshakes
 * (a node sends its COMPLETE manifest again — e.g. the post-device-restore
 * `nativeCaps` re-handshake). `CapabilityRegistry.registerProvider` throws
 * on a duplicate `(cap, addonId)` pair (the guard is CORRECT — it catches an
 * addon double-`initialize()`), so the second handshake threw, the
 * registering node's retry loop retried forever, and the cluster entered a
 * registration storm.
 *
 * The fix makes `applyNodeManifest` diff-based: it honours the CLAUDE.md
 * invariant "`registerNode` replaces the node's entire cap set atomically".
 * A re-handshake with the SAME manifest is a no-op; a re-handshake that
 * drops a cap unregisters exactly that cap; a re-handshake that adds a cap
 * registers only the new one. No throw, no churn.
 *
 * These specs drive the genuine `MoleculerService` registration path twice
 * for the same `nodeId` against a REAL `CapabilityRegistry` (with its real
 * duplicate guard) and assert idempotency.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { CapabilityRegistry } from '@camstack/system'
import type { RegisterNodeParams } from '@camstack/system'
import type { CapabilityDefinition, IScopedLogger, SystemEvent } from '@camstack/types'
import { MoleculerService } from '../core/moleculer/moleculer.service.js'
import type { EventBusService } from '../core/events/event-bus.service.js'
import type { ConfigService } from '../core/config/config.service.js'
import type { LoggingService } from '../core/logging/logging.service.js'
import type { CapabilityService } from '../core/capability/capability.service.js'
import type { StreamProbeService } from '../core/streaming/stream-probe.service.js'

/**
 * Test-only view of `MoleculerService` exposing:
 *  - the genuine private registration entrypoint `onRegisterNode` — the
 *    same closure the `$hub.registerNode` Moleculer action invokes in
 *    production. Driving it directly exercises the real
 *    `nodeRegistry.registerNode` + `applyNodeManifest` path without
 *    standing up a TCP broker.
 *  - the public `createCapabilityProxy` method used to assert whether a
 *    dropped capability's call-routing entry was correctly removed from
 *    `nodeCallFns` after a reduced re-handshake.
 */
interface RegisterNodeDriver {
  onRegisterNode: (params: RegisterNodeParams) => void
  createCapabilityProxy: (
    capabilityName: string,
    nodeId: string,
  ) => Record<string, (params: unknown) => Promise<unknown>> | null
}

/** Build a harness whose declared caps are SINGLETON, for active-provider preference tests. */
function createSingletonHarness(capNames: readonly string[]): Harness {
  return createHarness(capNames, 'singleton')
}

/** A minimal real `CapabilityDefinition` so `getDefinition`/`expandCapMethods` resolve. */
function makeCapDef(
  name: string,
  mode: 'collection' | 'singleton' = 'collection',
): CapabilityDefinition {
  return {
    name,
    scope: 'system',
    mode,
    methods: {
      ping: {
        input: z.object({}),
        output: z.object({}),
        kind: 'query',
        auth: 'protected',
      },
    },
  }
}

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Harness {
  readonly driver: RegisterNodeDriver
  readonly registry: CapabilityRegistry
  readonly capNames: readonly string[]
}

/**
 * Build a real `MoleculerService` (constructor only — no broker start) wired
 * to a real `CapabilityRegistry` pre-declaring `capNames`. Returns the
 * service viewed through `RegisterNodeDriver` plus the registry to assert on.
 *
 * The broker is never started, so there is nothing to stop in teardown —
 * no `afterEach` teardown is needed.
 */
function createHarness(
  capNames: readonly string[],
  mode: 'collection' | 'singleton' = 'collection',
): Harness {
  const registry = new CapabilityRegistry(makeLogger())
  for (const name of capNames) {
    registry.declareCapability(makeCapDef(name, mode))
  }
  // Boot-complete state — `getAllProviders` returns [] until `ready()`.
  registry.ready()

  const fakeEventBus = {
    emit: (_event: SystemEvent) => undefined,
    // `ReadinessRegistry` (built in the MoleculerService constructor)
    // subscribes to `system.ready-state` + `agent.offline`. A no-op
    // subscription returning an unsubscribe fn keeps the constructor happy.
    subscribe: () => () => undefined,
    getRecent: () => [],
  } as unknown as EventBusService

  const fakeConfig = {
    get: () => undefined,
    getAddonConfig: () => ({}),
  } as unknown as ConfigService

  const fakeLogging = {
    createLogger: () => makeLogger(),
    writeFromWorker: () => undefined,
  } as unknown as LoggingService

  const fakeCapability = {
    getRegistry: () => registry,
  } as unknown as CapabilityService

  const fakeStreamProbe = {} as unknown as StreamProbeService

  const service = new MoleculerService(
    fakeEventBus,
    fakeConfig,
    fakeLogging,
    fakeCapability,
    fakeStreamProbe,
  )

  return {
    driver: service as unknown as RegisterNodeDriver,
    registry,
    capNames,
  }
}

/** Provider count for a cap on the registry — counts every registered key. */
function providerCount(registry: CapabilityRegistry, capName: string): number {
  return registry.getAllProviders(capName).length
}

describe('MoleculerService.applyNodeManifest — re-handshake idempotency', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness(['cap-alpha', 'cap-beta'])
  })

  it('a re-handshake with the IDENTICAL manifest does not throw and leaves each provider registered exactly once', () => {
    const manifest: RegisterNodeParams = {
      nodeId: 'hub/reolink',
      addons: [{ addonId: 'reolink', capabilities: ['cap-alpha', 'cap-beta'] }],
    }

    // First handshake.
    harness.driver.onRegisterNode(manifest)
    expect(providerCount(harness.registry, 'cap-alpha')).toBe(1)
    expect(providerCount(harness.registry, 'cap-beta')).toBe(1)

    // Re-handshake — the documented post-device-restore re-handshake.
    // BEFORE the fix this threw `provider already registered for capability`.
    expect(() => harness.driver.onRegisterNode(manifest)).not.toThrow()

    // No duplicate, no loss — exactly one provider per cap.
    expect(providerCount(harness.registry, 'cap-alpha')).toBe(1)
    expect(providerCount(harness.registry, 'cap-beta')).toBe(1)
    expect(harness.registry.getProviderByAddon('cap-alpha', 'reolink')).not.toBeNull()
    expect(harness.registry.getProviderByAddon('cap-beta', 'reolink')).not.toBeNull()
  })

  it('three handshakes survive without throwing (registration storm regression guard)', () => {
    const manifest: RegisterNodeParams = {
      nodeId: 'hub/reolink',
      addons: [{ addonId: 'reolink', capabilities: ['cap-alpha', 'cap-beta'] }],
    }

    expect(() => {
      harness.driver.onRegisterNode(manifest)
      harness.driver.onRegisterNode(manifest)
      harness.driver.onRegisterNode(manifest)
    }).not.toThrow()

    expect(providerCount(harness.registry, 'cap-alpha')).toBe(1)
    expect(providerCount(harness.registry, 'cap-beta')).toBe(1)
  })

  it('a re-handshake that DROPS one capability unregisters that provider while the others remain', () => {
    const fullManifest: RegisterNodeParams = {
      nodeId: 'hub/reolink',
      addons: [{ addonId: 'reolink', capabilities: ['cap-alpha', 'cap-beta'] }],
    }
    const reducedManifest: RegisterNodeParams = {
      nodeId: 'hub/reolink',
      addons: [{ addonId: 'reolink', capabilities: ['cap-alpha'] }],
    }

    // First: full manifest — both caps registered.
    harness.driver.onRegisterNode(fullManifest)
    expect(providerCount(harness.registry, 'cap-alpha')).toBe(1)
    expect(providerCount(harness.registry, 'cap-beta')).toBe(1)

    // Second: identical full manifest — still idempotent, no throw.
    expect(() => harness.driver.onRegisterNode(fullManifest)).not.toThrow()
    expect(providerCount(harness.registry, 'cap-alpha')).toBe(1)
    expect(providerCount(harness.registry, 'cap-beta')).toBe(1)

    // Third: reduced manifest — cap-beta dropped, cap-alpha kept.
    expect(() => harness.driver.onRegisterNode(reducedManifest)).not.toThrow()
    expect(providerCount(harness.registry, 'cap-alpha')).toBe(1)
    expect(providerCount(harness.registry, 'cap-beta')).toBe(0)
    expect(harness.registry.getProviderByAddon('cap-alpha', 'reolink')).not.toBeNull()
    expect(harness.registry.getProviderByAddon('cap-beta', 'reolink')).toBeNull()

    // Verify that the call-routing entry for the dropped cap was removed
    // from `nodeCallFns`. `createCapabilityProxy` is the public seam that
    // delegates to `findCallFn` internally — a null return means no entry
    // exists for that (nodeId, cap) pair, confirming the delete ran.
    expect(harness.driver.createCapabilityProxy('cap-beta', 'hub/reolink')).toBeNull()
    // The still-present cap must remain routable.
    expect(harness.driver.createCapabilityProxy('cap-alpha', 'hub/reolink')).not.toBeNull()
  })
})

describe('MoleculerService.applyNodeManifest — singleton local-first preference (UDS regression)', () => {
  // A `placement: 'any-node'` singleton (e.g. `pipeline-executor`) can register
  // on BOTH the hub-local forked child AND a remote agent. The hub must resolve
  // its OWN local provider (reachable over UDS) — never the agent's proxy, whose
  // callFn routes over Moleculer to a UDS-only agent runner that no longer hosts
  // the service ("not found on <agent>"). First-registered-wins picked the agent.
  const LOCAL = 'hub/detection-pipeline'
  const REMOTE = 'dev-agent-0/detection-pipeline'
  const singleton: (nodeId: string) => RegisterNodeParams = (nodeId) => ({
    nodeId,
    addons: [{ addonId: 'detection-pipeline', capabilities: ['pipeline-executor'] }],
  })

  it('prefers the hub-local provider when the REMOTE one registered first', () => {
    const { driver, registry } = createSingletonHarness(['pipeline-executor'])
    driver.onRegisterNode(singleton(REMOTE)) // agent first → would win under first-wins
    driver.onRegisterNode(singleton(LOCAL)) // hub-local second
    // Active provider must be the hub-local key (bare addonId, no '@').
    expect(registry.getSingletonAddonId('pipeline-executor')).toBe('detection-pipeline')
    expect(registry.getSingletonAddonId('pipeline-executor')).not.toContain('@')
  })

  it('keeps the hub-local provider active when a REMOTE one registers afterwards', () => {
    const { driver, registry } = createSingletonHarness(['pipeline-executor'])
    driver.onRegisterNode(singleton(LOCAL)) // hub-local first
    driver.onRegisterNode(singleton(REMOTE)) // agent second must NOT steal active
    expect(registry.getSingletonAddonId('pipeline-executor')).toBe('detection-pipeline')
  })
})

describe('MoleculerService.applyNodeManifest — isolated infra engine (D233)', () => {
  // sqlite-settings forks (`execution.isolate`) and advertises
  // `data-store-provider` — an INFRA_CAPABILITIES name. The skip that kept
  // remote agents from planting their sqlite into the hub collection also
  // dropped the hub-local child, so getCollection stayed empty and the
  // settings door had nothing behind it (1.2.149).
  const sqliteCaps = ['data-store-provider', 'vector-store'] as const

  it('registers data-store-provider from a hub-local sqlite-settings child', () => {
    const { driver, registry } = createHarness([...sqliteCaps])
    driver.onRegisterNode({
      nodeId: 'hub/sqlite-settings',
      addons: [{ addonId: 'sqlite-settings', capabilities: [...sqliteCaps] }],
    })
    expect(providerCount(registry, 'data-store-provider')).toBe(1)
    expect(registry.getProviderByAddon('data-store-provider', 'sqlite-settings')).not.toBeNull()
    expect(providerCount(registry, 'vector-store')).toBe(1)
  })

  it('does not plant a remote agent sqlite into the hub data-store-provider collection', () => {
    const { driver, registry } = createHarness([...sqliteCaps])
    driver.onRegisterNode({
      nodeId: 'agent-a',
      addons: [{ addonId: 'sqlite-settings', capabilities: [...sqliteCaps] }],
    })
    expect(providerCount(registry, 'data-store-provider')).toBe(0)
    expect(registry.getProviderByAddon('data-store-provider', 'sqlite-settings')).toBeNull()
    // Non-infra caps from the same handshake still apply (agent vector-store
    // is addressable as addonId@nodeId). The door only cares about the engine.
    expect(providerCount(registry, 'vector-store')).toBe(1)
  })
})
