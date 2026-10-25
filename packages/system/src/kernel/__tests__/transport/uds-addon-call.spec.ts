/**
 * UDS addon-call plane (F3) — integration tests.
 *
 * Uses a REAL LocalChildRegistry + LocalChildClient over the real local
 * transport. Covers the two addon-LEVEL surfaces the per-addon Moleculer
 * broker used to carry before F1/F2 removed it:
 *   (1) callAddonOnChild({target:'routes'}) reaches the child onAddonCall
 *       handler and returns the (handler-stripped) route descriptors.
 *   (2) callAddonOnChild({target:'custom', action, args}) reaches the handler
 *       and returns its result, passing args through.
 *   (3) an unknown child id rejects with a clear error.
 *   (4) a child with NO onAddonCall handler rejects with a clear error.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import type { AddonCallInput } from '../../transport/child-cap-protocol.js'

const nid = (): string => `addoncall-test-${process.pid}-${Math.random().toString(36).slice(2)}`

describe('UDS addon-call plane — routes / custom', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalChildClient[] = []

  afterEach(async () => {
    for (const c of clients) await c.close().catch(() => {})
    clients.length = 0
    await registry?.close().catch(() => {})
    registry = null
  })

  // ── (1) routes ──────────────────────────────────────────────────────────
  it('(1) callAddonOnChild(target:routes) reaches the child handler and returns descriptors', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const seen: AddonCallInput[] = []
    const child = new LocalChildClient({
      nodeId,
      childId: 'export-alexa',
      caps: [],
      dispatch: async () => null,
    })
    child.onAddonCall(async (call) => {
      seen.push(call)
      if (call.target === 'routes') {
        return [
          { method: 'GET', path: '/start', access: 'public' },
          {
            method: 'POST',
            path: '/callback',
            access: 'authenticated',
            description: 'oauth callback',
          },
        ]
      }
      throw new Error('unexpected target')
    })
    clients.push(child)
    await child.start()

    const result = await registry.callAddonOnChild('export-alexa', {
      addonId: 'export-alexa',
      target: 'routes',
    })

    expect(seen).toHaveLength(1)
    const call0 = seen[0]
    if (!call0) throw new Error('expected one captured addon call')
    expect(call0.addonId).toBe('export-alexa')
    expect(call0.target).toBe('routes')
    expect(result).toEqual([
      { method: 'GET', path: '/start', access: 'public' },
      { method: 'POST', path: '/callback', access: 'authenticated', description: 'oauth callback' },
    ])
  })

  // ── (2) custom ──────────────────────────────────────────────────────────
  it('(2) callAddonOnChild(target:custom) reaches the handler, passes args, returns the result', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const seen: AddonCallInput[] = []
    const child = new LocalChildClient({
      nodeId,
      childId: 'benchmark',
      caps: [],
      dispatch: async () => null,
    })
    child.onAddonCall(async (call) => {
      seen.push(call)
      if (call.target === 'custom' && call.action === 'runBenchmark') {
        const args = call.args as { iterations: number }
        return { ran: args.iterations, ok: true }
      }
      throw new Error(`no handler for ${String(call.action)}`)
    })
    clients.push(child)
    await child.start()

    const result = await registry.callAddonOnChild('benchmark', {
      addonId: 'benchmark',
      target: 'custom',
      action: 'runBenchmark',
      args: { iterations: 42 },
    })

    expect(seen).toHaveLength(1)
    const call0 = seen[0]
    if (!call0) throw new Error('expected one captured addon call')
    expect(call0.target).toBe('custom')
    expect(call0.action).toBe('runBenchmark')
    expect(call0.args).toEqual({ iterations: 42 })
    expect(result).toEqual({ ran: 42, ok: true })
  })

  // ── (2b) settings ─────────────────────────────────────────────────────────
  // Guards the field-wiring class of bug: `method` must survive the round-trip
  // (protocol type → toAddonCall wire builder → child-side frame extraction).
  // It was missed in the child extraction once, collapsing every forked-addon
  // settings panel — this test fails if any of the three drops `method`.
  it('(2b) callAddonOnChild(target:settings) preserves method + args across the wire', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const seen: AddonCallInput[] = []
    const child = new LocalChildClient({
      nodeId,
      childId: 'stream-broker',
      caps: [],
      dispatch: async () => null,
    })
    child.onAddonCall(async (call) => {
      seen.push(call)
      if (call.target === 'settings' && call.method === 'getGlobalSettings') {
        return { sections: [{ id: 'stream-broker-settings', title: 'Stream Broker', fields: [] }] }
      }
      throw new Error(`unexpected settings call ${String(call.method)}`)
    })
    clients.push(child)
    await child.start()

    const result = await registry.callAddonOnChild('stream-broker', {
      addonId: 'stream-broker',
      target: 'settings',
      method: 'getGlobalSettings',
      args: { overlay: { defaultPreBufferSec: 12 } },
    })

    expect(seen).toHaveLength(1)
    const call0 = seen[0]
    if (!call0) throw new Error('expected one captured addon call')
    expect(call0.target).toBe('settings')
    expect(call0.method).toBe('getGlobalSettings')
    expect(call0.args).toEqual({ overlay: { defaultPreBufferSec: 12 } })
    expect(result).toEqual({
      sections: [{ id: 'stream-broker-settings', title: 'Stream Broker', fields: [] }],
    })
  })

  // ── (3) unknown child ────────────────────────────────────────────────────
  it('(3) callAddonOnChild for an unknown child rejects with a clear error', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    await expect(
      registry.callAddonOnChild('does-not-exist', { addonId: 'does-not-exist', target: 'routes' }),
    ).rejects.toThrow(/no local child "does-not-exist"/)
  })

  // ── (4) child with no handler ─────────────────────────────────────────────
  it('(4) addon-call against a child with no onAddonCall handler rejects with a clear error', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const child = new LocalChildClient({
      nodeId,
      childId: 'no-handler',
      caps: [],
      dispatch: async () => null,
    })
    clients.push(child)
    await child.start()

    await expect(
      registry.callAddonOnChild('no-handler', {
        addonId: 'no-handler',
        target: 'custom',
        action: 'x',
      }),
    ).rejects.toThrow(/no onAddonCall handler/)
  })
})
