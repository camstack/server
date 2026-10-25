/**
 * capability.binding-changed propagation — kernel side.
 *
 * P0-5: when the operator swaps the addon implementing a cap on a node
 * via `pipelineOrchestrator.setCapabilityBinding`, every kernel process
 * on that node must update its local `preferredProviderRegistry` so
 * subsequent `ctx.resolveProvider(capName)` lookups return the newly
 * bound addon.
 *
 * The wiring has two layers in `addon-context-factory.ts`:
 *   1. `setPreferredProvider(capName, addonId)` — pure map mutation.
 *   2. `ensureBindingSubscription(broker)` — subscribes once per process
 *      to the `$hub.event` localBus channel and, on every
 *      `capability.binding-changed` event, calls `setPreferredProvider`.
 *
 * Layer 1 is covered by a direct unit test (deterministic, fast).
 * Layer 2 is covered by an end-to-end test that emits the event via a
 * real Moleculer ServiceBroker and asserts `resolveProvider` flips to
 * the newly bound addon.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import {
  createAddonContext,
  setPreferredProvider,
  withAddonScope,
  __resetBindingSubscriptionForTests,
} from '../../moleculer/addon-context-factory.js'
import { EventCategory, type AddonDeclaration } from '@camstack/types'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

describe('capability.binding-changed propagation', () => {
  let broker: ServiceBroker | null = null
  let tmpDir = ''

  beforeEach(() => {
    // Reset the module-level one-shot guard so each test can install
    // a fresh binding subscription against its own ServiceBroker.
    __resetBindingSubscriptionForTests()
  })

  afterEach(async () => {
    if (broker) {
      await broker.stop()
      broker = null
    }
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* swallow */
      }
      tmpDir = ''
    }
  })

  // ── Layer 1: setPreferredProvider direct contract ─────────────────
  it('resolveProvider honours setPreferredProvider when multiple providers register for the same cap', async () => {
    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    await broker.start()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-binding-test-'))

    // Two addons register providers for the SAME cap name, on the same
    // process. Use `withAddonScope` so each provider is correctly
    // indexed under the right addonId in `providersByAddonId`.
    const provA = { impl: 'A' }
    const provB = { impl: 'B' }

    const decl = (id: string): AddonDeclaration => ({ id, entry: './index.js' })

    const ctxA = await createAddonContext(broker, decl('motion-wasm'), tmpDir)
    withAddonScope('motion-wasm', () => {
      ctxA.registerProvider!('cap-under-test', provA)
    })

    const ctxB = await createAddonContext(broker, decl('motion-hardware'), tmpDir)
    withAddonScope('motion-hardware', () => {
      ctxB.registerProvider!('cap-under-test', provB)
    })

    // First-registered wins before any preference is set.
    expect(ctxA.resolveProvider!('cap-under-test')).toBe(provA)
    expect(ctxB.resolveProvider!('cap-under-test')).toBe(provA)

    // Operator binds the cap to `motion-hardware` — preferredProviderRegistry
    // flips, every subsequent lookup returns the new implementation.
    setPreferredProvider('cap-under-test', 'motion-hardware')
    expect(ctxA.resolveProvider!('cap-under-test')).toBe(provB)
    expect(ctxB.resolveProvider!('cap-under-test')).toBe(provB)

    // Swap back.
    setPreferredProvider('cap-under-test', 'motion-wasm')
    expect(ctxA.resolveProvider!('cap-under-test')).toBe(provA)

    // Clearing the preference falls back to first-registered.
    setPreferredProvider('cap-under-test', null)
    expect(ctxA.resolveProvider!('cap-under-test')).toBe(provA)
  })

  // ── Layer 2: $hub.event broadcast wiring ──────────────────────────
  it('updates the preferredProviderRegistry when a capability.binding-changed event is broadcast on $hub.event', async () => {
    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    await broker.start()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-binding-test-'))

    const provA = { impl: 'cap-a' }
    const provB = { impl: 'cap-b' }

    const decl = (id: string): AddonDeclaration => ({ id, entry: './index.js' })

    // Note: creating the first addon context wires the one-shot
    // `$hub.event` subscription inside the factory.
    const ctxA = await createAddonContext(broker, decl('prov-a'), tmpDir)
    withAddonScope('prov-a', () => {
      ctxA.registerProvider!('wire-test-cap', provA)
    })
    const ctxB = await createAddonContext(broker, decl('prov-b'), tmpDir)
    withAddonScope('prov-b', () => {
      ctxB.registerProvider!('wire-test-cap', provB)
    })

    // First-registered wins.
    expect(ctxA.resolveProvider!('wire-test-cap')).toBe(provA)

    // Emit the broadcast event the same way the cluster hub-forwarder
    // does — a plain `localBus.emit('$hub.event', payload)`. The
    // binding-subscription handler installed by `createAddonContext`
    // filters by category === 'capability.binding-changed' and the
    // local `nodeID`.
    broker.localBus.emit('$hub.event', {
      category: EventCategory.CapabilityBindingChanged,
      data: {
        nodeId: 'hub',
        capName: 'wire-test-cap',
        addonId: 'prov-b',
      },
    })
    await new Promise((r) => setTimeout(r, 5))

    expect(ctxA.resolveProvider!('wire-test-cap')).toBe(provB)

    // A binding event targeted at a different nodeID must be ignored —
    // local providerRegistry stays unchanged.
    broker.localBus.emit('$hub.event', {
      category: EventCategory.CapabilityBindingChanged,
      data: {
        nodeId: 'some-other-node',
        capName: 'wire-test-cap',
        addonId: 'prov-a',
      },
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(ctxA.resolveProvider!('wire-test-cap')).toBe(provB) // still B

    // Clean up the preference so this test doesn't leak into others.
    setPreferredProvider('wire-test-cap', null)
  })

  // ── Layer 3: unrelated events don't touch the registry ───────────
  it('ignores $hub.event broadcasts that are not capability.binding-changed', async () => {
    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    await broker.start()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-binding-test-'))

    const prov1 = { impl: 1 }
    const prov2 = { impl: 2 }
    const decl = (id: string): AddonDeclaration => ({ id, entry: './index.js' })
    const ctx1 = await createAddonContext(broker, decl('a1'), tmpDir)
    withAddonScope('a1', () => {
      ctx1.registerProvider!('noise-test-cap', prov1)
    })
    const ctx2 = await createAddonContext(broker, decl('a2'), tmpDir)
    withAddonScope('a2', () => {
      ctx2.registerProvider!('noise-test-cap', prov2)
    })

    broker.localBus.emit('$hub.event', {
      category: EventCategory.DetectionResult,
      data: { frame: {} },
    })
    await new Promise((r) => setTimeout(r, 5))

    // No preference was set — first-registered still wins.
    expect(ctx1.resolveProvider!('noise-test-cap')).toBe(prov1)
  })
})
