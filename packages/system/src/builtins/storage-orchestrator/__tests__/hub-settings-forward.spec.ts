/**
 * The agent's data door has the HUB behind it, not a local engine.
 *
 * An agent owns no `data-store-provider`: its persistence is the hub's.
 * The `settings-store` door the storage-orchestrator registers is therefore
 * a FORWARDER on an agent — every call rides `$hub-cap-fwd.forward` into the
 * hub's own routing, which lands on the hub's engine.
 *
 * What these pin:
 *
 *  1. **The payload crosses untouched.** `namespace` composes the table name
 *     inside the engine; a forwarder that injected, defaulted or dropped it
 *     would silently rename every table — the same hazard
 *     `data-store-dispatch.spec.ts` pins for the local path.
 *  2. **The envelope names the CAP, not the engine.** The hub routes
 *     `settings-store` (its own door); asking for `data-store-provider`
 *     would bypass the door on the far side.
 *  3. **A hub NEVER forwards.** The gate is the node role, and a hub that
 *     built a forwarder would route its own door back into itself.
 *  4. **An unreachable hub REJECTS.** It never answers "empty": a read that
 *     silently degrades to `{}` makes the next read-modify-write persist the
 *     patch alone (`addon-context-factory`'s `mergeBlob` only refuses when
 *     the read FAILED — an empty answer is indistinguishable from a store
 *     with nothing in it).
 */

import type { IClusterBroker, SettingsRecord } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  createHubSettingsForward,
  HUB_SETTINGS_FORWARD_TIMEOUT_MS,
  type HubForwardEnvelope,
  nodeOwnsItsDataStore,
  resolveHubSettingsForward,
} from '../hub-settings-forward.js'

interface Recorded {
  readonly envelope: HubForwardEnvelope
}

function recorder(result: unknown): {
  readonly calls: Recorded[]
  readonly forward: <TResult>(envelope: HubForwardEnvelope) => Promise<TResult>
} {
  const calls: Recorded[] = []
  return {
    calls,
    forward: <TResult>(envelope: HubForwardEnvelope): Promise<TResult> => {
      calls.push({ envelope })
      return Promise.resolve(result as TResult)
    },
  }
}

describe('nodeOwnsItsDataStore', () => {
  it('is TRUE on a hub — the hub is the store, it can never forward to itself', () => {
    expect(nodeOwnsItsDataStore({ CAMSTACK_ROLE: 'hub' })).toBe(true)
    expect(nodeOwnsItsDataStore({})).toBe(true)
    expect(nodeOwnsItsDataStore({ CAMSTACK_ROLE: '' })).toBe(true)
  })

  it('is FALSE on an agent — its persistence is the hub, always', () => {
    expect(nodeOwnsItsDataStore({ CAMSTACK_ROLE: 'agent' })).toBe(false)
    expect(nodeOwnsItsDataStore({ CAMSTACK_ROLE: '  AGENT ' })).toBe(false)
  })
})

describe('createHubSettingsForward', () => {
  it('forwards a namespaced read verbatim under the settings-store cap name', async () => {
    const rec = recorder({ enabled: true })
    const forward = createHubSettingsForward(rec.forward)

    const value = await forward.get({
      namespace: 'native-metrics',
      collection: 'addon-settings',
      key: 'root',
    })

    expect(value).toEqual({ enabled: true })
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0]?.envelope).toEqual({
      capName: 'settings-store',
      method: 'get',
      args: { namespace: 'native-metrics', collection: 'addon-settings', key: 'root' },
    })
  })

  it('forwards a write verbatim — namespace, collection, key and value all survive', async () => {
    const rec = recorder(undefined)
    const forward = createHubSettingsForward(rec.forward)

    await forward.set({
      namespace: 'platform-probe',
      collection: 'addon-settings',
      key: 'root',
      value: { probedAt: 7 },
    })

    expect(rec.calls[0]?.envelope.method).toBe('set')
    expect(rec.calls[0]?.envelope.args).toEqual({
      namespace: 'platform-probe',
      collection: 'addon-settings',
      key: 'root',
      value: { probedAt: 7 },
    })
  })

  it('covers every method the door exposes — one forward each, none invented', async () => {
    const rows: readonly SettingsRecord[] = []
    const rec = recorder(rows)
    const forward = createHubSettingsForward(rec.forward)

    await forward.query({ collection: 'c' })
    await forward.insert({ collection: 'c', record: { id: 'a', data: {} } })
    await forward.insertMany({ collection: 'c', records: [] })
    await forward.update({ collection: 'c', id: 'a', data: {} })
    await forward.delete({ collection: 'c', key: 'a' })
    await forward.deleteWhere({ collection: 'c', filter: {} })
    await forward.updateWhere({ collection: 'c', filter: {}, data: {} })
    await forward.count({ collection: 'c' })
    await forward.aggregate({ collection: 'c', fields: [] })
    await forward.histogram({ collection: 'c', field: 'f', bucketSize: 1, origin: 0 })
    await forward.isEmpty({ collection: 'c' })
    await forward.declareCollection({ collection: 'c', columns: [] })

    expect(rec.calls.map((c) => c.envelope.method)).toEqual([
      'query',
      'insert',
      'insertMany',
      'update',
      'delete',
      'deleteWhere',
      'updateWhere',
      'count',
      'aggregate',
      'histogram',
      'isEmpty',
      'declareCollection',
    ])
    expect(rec.calls.every((c) => c.envelope.capName === 'settings-store')).toBe(true)
  })

  it('REJECTS when the hub does not answer — never a silent empty read', async () => {
    const forward = createHubSettingsForward(() =>
      Promise.reject(new Error('Service $hub-cap-fwd is not available')),
    )
    await expect(forward.get({ collection: 'addon-settings', key: 'root' })).rejects.toThrow(
      /not available/,
    )
  })
})

describe('resolveHubSettingsForward — the gate', () => {
  const logger = { info: vi.fn() }

  interface BrokerCall {
    readonly action: string
    readonly params: unknown
    readonly opts: unknown
  }

  function fakeBroker(result: unknown, calls: BrokerCall[]): IClusterBroker {
    return {
      nodeID: 'agent-a',
      call: <TParams = unknown, TResult = unknown>(
        action: string,
        params?: TParams,
        opts?: { nodeID?: string; timeout?: number },
      ): Promise<TResult> => {
        calls.push({ action, params, opts })
        return Promise.resolve(result as TResult)
      },
      waitForServices: () => Promise.resolve(),
      localBus: { on: () => {} },
    }
  }

  it('answers null on a HUB — the hub is the store and would forward into itself', () => {
    const calls: BrokerCall[] = []
    expect(
      resolveHubSettingsForward({
        env: { CAMSTACK_ROLE: 'hub' },
        broker: fakeBroker(null, calls),
        logger,
      }),
    ).toBeNull()
    expect(
      resolveHubSettingsForward({ env: {}, broker: fakeBroker(null, calls), logger }),
    ).toBeNull()
  })

  it('answers null with no cluster broker — a forked worker has no hop to make', () => {
    expect(
      resolveHubSettingsForward({ env: { CAMSTACK_ROLE: 'agent' }, broker: undefined, logger }),
    ).toBeNull()
  })

  it('builds a forwarder on an AGENT that rides $hub-cap-fwd.forward with the cap envelope', async () => {
    const calls: BrokerCall[] = []
    const forward = resolveHubSettingsForward({
      env: { CAMSTACK_ROLE: 'agent' },
      broker: fakeBroker({ hydrated: true }, calls),
      logger,
    })
    expect(forward).not.toBeNull()

    await expect(
      forward?.get({ namespace: 'native-metrics', collection: 'addon-settings', key: 'root' }),
    ).resolves.toEqual({ hydrated: true })

    expect(calls).toEqual([
      {
        action: '$hub-cap-fwd.forward',
        params: {
          capName: 'settings-store',
          method: 'get',
          args: { namespace: 'native-metrics', collection: 'addon-settings', key: 'root' },
        },
        opts: { timeout: HUB_SETTINGS_FORWARD_TIMEOUT_MS },
      },
    ])
  })
})
