import { describe, it, expect, vi } from 'vitest'
import {
  callRegisterNodeWithRetry,
  hubServerVersionOf,
  buildNodeManifest,
} from '../../moleculer/register-node-client.js'
import type { RegisterNodeParams } from '../../moleculer/node-registry.js'

/** Minimal broker stub: `call` resolves/rejects per the scripted queue. */
function brokerStub(outcomes: Array<'fail' | 'ok'>) {
  const calls: Array<{ action: string; params: unknown; opts: unknown }> = []
  let i = 0
  return {
    calls,
    broker: {
      call: vi.fn((action: string, params: unknown, opts?: unknown) => {
        calls.push({ action, params, opts })
        const outcome = outcomes[i++] ?? 'ok'
        if (outcome === 'fail') return Promise.reject(new Error('transport not ready'))
        return Promise.resolve({ ok: true })
      }),
    },
  }
}

describe('buildNodeManifest', () => {
  it('maps per-addon cap-name lists into RegisteredAddonManifest[]', () => {
    const manifest = buildNodeManifest('hub/reolink', [
      { addonId: 'reolink', capabilities: ['switch', 'ptz'] },
    ])
    const expected: RegisterNodeParams = {
      nodeId: 'hub/reolink',
      addons: [{ addonId: 'reolink', capabilities: ['switch', 'ptz'] }],
    }
    expect(manifest).toEqual(expected)
  })

  it('omits nativeCaps when none are passed (first handshake)', () => {
    const manifest = buildNodeManifest('hub/reolink', [
      { addonId: 'reolink', capabilities: ['onvif'] },
    ])
    expect(manifest.nativeCaps).toBeUndefined()
  })

  it('threads device-scoped nativeCaps into the manifest (post-restore re-handshake)', () => {
    const manifest = buildNodeManifest(
      'hub/reolink',
      [{ addonId: 'reolink', capabilities: ['onvif'] }],
      [
        { capName: 'switch', addonId: 'reolink', deviceIds: [7, 12] },
        { capName: 'ptz', addonId: 'reolink', deviceIds: [7] },
      ],
    )
    const expected: RegisterNodeParams = {
      nodeId: 'hub/reolink',
      addons: [{ addonId: 'reolink', capabilities: ['onvif'] }],
      nativeCaps: [
        { capName: 'switch', addonId: 'reolink', deviceIds: [7, 12] },
        { capName: 'ptz', addonId: 'reolink', deviceIds: [7] },
      ],
    }
    expect(manifest).toEqual(expected)
  })
})

describe('callRegisterNodeWithRetry', () => {
  it('returns once the hub acks on the first attempt', async () => {
    const { broker, calls } = brokerStub(['ok'])
    await callRegisterNodeWithRetry(
      broker as never,
      {
        nodeId: 'hub/x',
        addons: [],
      },
      { baseDelayMs: 1, target: 'hub' },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.action).toBe('$hub.registerNode')
    // Pinned to the hub — undirected discovery is not enough on the TLS mesh.
    expect(calls[0]?.opts).toEqual({ nodeID: 'hub' })
  })

  it('retries until the hub acks (terminates on the real condition, not a fixed count)', async () => {
    const { broker, calls } = brokerStub(['fail', 'fail', 'ok'])
    await callRegisterNodeWithRetry(
      broker as never,
      {
        nodeId: 'hub/x',
        addons: [],
      },
      { baseDelayMs: 1, target: 'hub' },
    )
    expect(calls).toHaveLength(3)
  })

  it('calls $agent.registerNode when target is "agent"', async () => {
    const { broker, calls } = brokerStub(['ok'])
    await callRegisterNodeWithRetry(
      broker as never,
      {
        nodeId: 'dev-agent-0/grp',
        addons: [],
      },
      { baseDelayMs: 1, target: 'agent', targetNodeId: 'dev-agent-0' },
    )
    expect(calls[0]?.action).toBe('$agent.registerNode')
  })

  it('stops retrying when aborted', async () => {
    const { broker } = brokerStub(['fail', 'fail', 'fail', 'fail', 'fail'])
    const ac = new AbortController()
    const p = callRegisterNodeWithRetry(
      broker as never,
      {
        nodeId: 'hub/x',
        addons: [],
      },
      { baseDelayMs: 5, target: 'hub', signal: ac.signal },
    )
    ac.abort()
    await expect(p).rejects.toThrow(/abort/i)
  })
})

describe('hubServerVersionOf', () => {
  it('reads the hub version off an ack, and null for anything else', () => {
    expect(hubServerVersionOf({ ok: true, hubServerVersion: '1.2.650' })).toBe('1.2.650')
    expect(hubServerVersionOf({ ok: true })).toBeNull()
    expect(hubServerVersionOf(undefined)).toBeNull()
    expect(hubServerVersionOf({ ok: true, hubServerVersion: 5 })).toBeNull()
  })

  it('callRegisterNodeWithRetry resolves with the ack', async () => {
    const broker = { call: async () => ({ ok: true, hubServerVersion: '1.2.650' }) }
    const ack = await callRegisterNodeWithRetry(
      broker,
      { nodeId: 'a', addons: [] },
      { target: 'hub' },
    )
    expect(hubServerVersionOf(ack)).toBe('1.2.650')
  })
})
