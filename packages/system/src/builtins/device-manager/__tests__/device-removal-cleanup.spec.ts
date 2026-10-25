/**
 * A removed device leaves nothing of its own behind (D864).
 *
 * Live case: `secret://provider-dreame/device/4483/navigationAccessCode`
 * outlived device 4483 — the device-manager removal cleared its own config
 * rows but never the keychain, whose values are owned by the DRIVER.
 *
 * Pinned here against the real addon + the real `removeDevice`:
 *  - every owner's `device/<id>` secret goes, another device's stays;
 *  - its config rows go, another device's stay;
 *  - one store failing neither blocks the others nor fails the removal, is
 *    logged with `tags: { deviceId }`, and is retried by the bounded reconcile;
 *  - one summary line per device carries the counts per store.
 */
import { createSecretsAccess, type KeychainTransport, type SecretsAccess } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOVAL_RETRY_DELAYS_MS } from '../removal-cleanup.js'
import { type Harness, registerCamera, setup } from './device-manager-harness.js'

interface FakeKeychain {
  readonly values: Map<string, string>
  failPurge: boolean
  purgeCalls: number
}

/** A keychain transport whose scope-wide delete mirrors the real service's contract. */
function fakeKeychain(): { kc: FakeKeychain; secrets: SecretsAccess } {
  const kc: FakeKeychain = { values: new Map(), failPurge: false, purgeCalls: 0 }
  const transport: KeychainTransport = {
    put: async ({ ref, value }) => {
      kc.values.set(ref, value)
      return { ref, version: 1 }
    },
    resolve: async () => ({}),
    delete: async ({ refs }) => ({ deleted: refs.filter((r) => kc.values.delete(r)).length }),
    getState: async () => ({ state: 'ready' }),
    deleteDeviceScope: async ({ deviceId }) => {
      kc.purgeCalls++
      if (kc.failPurge) throw new Error('keychain busy')
      const refs = [...kc.values.keys()].filter((r) => r.includes(`/device/${deviceId}/`))
      for (const ref of refs) kc.values.delete(ref)
      return { refs }
    },
  }
  return { kc, secrets: createSecretsAccess({ owner: 'device-manager', transport }) }
}

interface Fleet {
  readonly h: Harness
  readonly kc: FakeKeychain
  readonly removed: number
  readonly kept: number
}

async function fleet(): Promise<Fleet> {
  const { kc, secrets } = fakeKeychain()
  const h = await setup({ secrets })
  const removed = await registerCamera(h, 'provider-dreame', 'vacuum-a')
  const kept = await registerCamera(h, 'provider-dreame', 'vacuum-b')
  for (const id of [removed, kept]) {
    await h.settings.writeDeviceStore(id, { host: `10.0.0.${id}` })
    await h.settings.writeDeviceRuntimeState(id, { battery: { percentage: 50 } })
  }
  kc.values.set(`secret://provider-dreame/device/${removed}/navigationAccessCode`, 'code-a')
  kc.values.set(`secret://provider-hikvision/device/${removed}/password`, 'pass-a')
  kc.values.set(`secret://provider-dreame/device/${kept}/navigationAccessCode`, 'code-b')
  kc.values.set('secret://cloudflare-tunnel/global/customApiToken', 'token')
  return { h, kc, removed, kept }
}

function summaryLog(h: Harness, deviceId: number): Record<string, unknown> | undefined {
  const call = vi
    .mocked(h.logger.info)
    .mock.calls.find(
      (c) =>
        c[0] === 'device removal cleanup' &&
        (c[1] as { tags?: { deviceId?: number } } | undefined)?.tags?.deviceId === deviceId,
    )
  return (call?.[1] as { meta?: Record<string, unknown> } | undefined)?.meta
}

describe('device removal cleans the data it owns, store by store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('deletes the removed device’s scoped secrets and config rows; another device’s stay', async () => {
    const { h, kc, removed, kept } = await fleet()

    await h.provider.removeDevice({ deviceId: removed })

    expect([...kc.values.keys()].sort()).toEqual(
      [
        `secret://provider-dreame/device/${kept}/navigationAccessCode`,
        'secret://cloudflare-tunnel/global/customApiToken',
      ].sort(),
    )
    expect(await h.settings.readDeviceStore(removed)).toEqual({})
    expect(await h.settings.readDeviceRuntimeState(removed)).toEqual({})
    expect(await h.settings.readDeviceStore(kept)).toEqual({ host: `10.0.0.${kept}` })
    expect(await h.settings.readDeviceRuntimeState(kept)).toEqual({ battery: { percentage: 50 } })
  })

  it('logs the cleanup once per device with the counts per store', async () => {
    const { h, removed } = await fleet()
    await h.provider.removeDevice({ deviceId: removed })
    const meta = summaryLog(h, removed)
    expect(meta?.['counts']).toMatchObject({
      'keychain-secrets': 2,
      'device-config': 1,
      'runtime-state': 1,
    })
    expect(meta?.['failed']).toEqual([])
    const lines = vi
      .mocked(h.logger.info)
      .mock.calls.filter((c) => c[0] === 'device removal cleanup')
    expect(lines).toHaveLength(1)
  })

  it('a failing keychain neither blocks the other stores nor fails the removal, and is logged', async () => {
    const { h, kc, removed } = await fleet()
    kc.failPurge = true

    await expect(h.provider.removeDevice({ deviceId: removed })).resolves.toBeUndefined()

    expect(await h.settings.readDeviceStore(removed)).toEqual({})
    expect(await h.settings.readDeviceRuntimeState(removed)).toEqual({})
    const warned = vi
      .mocked(h.logger.warn)
      .mock.calls.find(
        (c) => c[0] === 'device removal cleanup incomplete — failed steps are retried',
      )
    expect(warned?.[1]).toMatchObject({
      tags: { deviceId: removed },
      meta: { failed: ['keychain-secrets'] },
    })
    expect(kc.values.has(`secret://provider-dreame/device/${removed}/navigationAccessCode`)).toBe(
      true,
    )
  })

  it('the bounded reconcile retries the failed step and stops once it lands', async () => {
    const { h, kc, removed } = await fleet()
    kc.failPurge = true
    await h.provider.removeDevice({ deviceId: removed })
    kc.failPurge = false

    await vi.advanceTimersByTimeAsync(REMOVAL_RETRY_DELAYS_MS[0] ?? 0)

    expect(kc.values.has(`secret://provider-dreame/device/${removed}/navigationAccessCode`)).toBe(
      false,
    )
    const callsAfterSuccess = kc.purgeCalls
    await vi.advanceTimersByTimeAsync(REMOVAL_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0))
    expect(kc.purgeCalls).toBe(callsAfterSuccess)
  })

  it('gives up loudly after the bounded attempts — no endless loop', async () => {
    const { h, kc, removed } = await fleet()
    kc.failPurge = true
    await h.provider.removeDevice({ deviceId: removed })

    await vi.advanceTimersByTimeAsync(REMOVAL_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 1)

    expect(kc.purgeCalls).toBe(1 + REMOVAL_RETRY_DELAYS_MS.length)
    const gaveUp = vi
      .mocked(h.logger.error)
      .mock.calls.find((c) => String(c[0]).startsWith('device removal cleanup gave up'))
    expect(gaveUp?.[1]).toMatchObject({ tags: { deviceId: removed } })
  })
})
