/**
 * `{ addonId }` pin for a collection cap's SCALAR method, on the child→parent
 * path (`onUnownedCall`), NOT the tRPC router.
 *
 * The bug this pins down: routing (`resolveCapRoute`) reads only `nodeId` and
 * `deviceId`, so a forked addon's `addonId` selector — injected by the codegen
 * on every method of a system-scoped collection cap — was dropped and the call
 * was answered by whichever provider registered first. Measured live on
 * 2026-08-09: `broker.getBrokerConfig({id:'ha_001', addonId:'provider-
 * homeassistant'})` returned Homematic's `null`, indistinguishable from "no
 * such broker", and the Home Assistant export could never open a link.
 */
import { describe, expect, it } from 'vitest'
import { pinnedCollectionCall } from '../cap-router-runtime.js'

type Provider = Record<string, (input?: unknown) => unknown>

interface RegistryFake {
  getDefinition(cap: string): { mode: string } | undefined
  getProviderByAddonId<T>(cap: string, addonId: string): T | null
  getProviderAddonIds(cap: string): readonly string[]
}

function registry(
  providers: Readonly<Record<string, Provider>>,
  mode = 'collection',
): RegistryFake {
  return {
    getDefinition: () => ({ mode }),
    getProviderByAddonId: <T>(_cap: string, addonId: string): T | null =>
      (providers[addonId] as T | undefined) ?? null,
    getProviderAddonIds: () => Object.keys(providers),
  }
}

const HA: Provider = {
  getBrokerConfig: (input) =>
    (input as { id: string }).id === 'ha_001' ? { baseUrl: 'http://ha:8123' } : null,
}
/** The first-registered provider on the operator's hub — owns `hm_*` only. */
const HOMEMATIC: Provider = { getBrokerConfig: () => null }

// The registry is a structural fake; the production type is the full
// CapabilityRegistry. This is the documented seam for these unit tests.
const asRegistry = (r: RegistryFake): Parameters<typeof pinnedCollectionCall>[0] =>
  r as unknown as Parameters<typeof pinnedCollectionCall>[0]

describe('pinnedCollectionCall', () => {
  it('answers from the NAMED provider, not the first-registered one', async () => {
    const reg = asRegistry(
      registry({ 'provider-homematic': HOMEMATIC, 'provider-homeassistant': HA }),
    )
    const out = await pinnedCollectionCall(reg, 'broker', 'getBrokerConfig', {
      id: 'ha_001',
      addonId: 'provider-homeassistant',
    })
    expect(out).toEqual({ value: { baseUrl: 'http://ha:8123' } })
  })

  it('boxes a legitimate null so it cannot be read as "not handled"', async () => {
    const reg = asRegistry(registry({ 'provider-homeassistant': HA }))
    const out = await pinnedCollectionCall(reg, 'broker', 'getBrokerConfig', {
      id: 'ha_999',
      addonId: 'provider-homeassistant',
    })
    expect(out).toEqual({ value: null })
  })

  it('REFUSES a pin naming a non-provider, spelling out the valid ids', async () => {
    const reg = asRegistry(registry({ 'provider-homematic': HOMEMATIC }))
    await expect(
      pinnedCollectionCall(reg, 'broker', 'getBrokerConfig', {
        id: 'ha_001',
        addonId: 'provider-homeassistant',
      }),
    ).rejects.toThrow(/no provider with addonId "provider-homeassistant".*provider-homematic/s)
  })

  it('does not claim an unpinned call — it routes normally', async () => {
    const reg = asRegistry(registry({ 'provider-homeassistant': HA }))
    expect(
      await pinnedCollectionCall(reg, 'broker', 'getBrokerConfig', { id: 'ha_001' }),
    ).toBeNull()
  })

  /**
   * An enumeration keeps the fan-out union. Pinning one is what turned a
   * provider's absence from "returns fewer rows" into BAD_REQUEST and took the
   * operator from "one Home Assistant instance" to "no instance at all".
   */
  it('never claims an array method — that contract is the union', async () => {
    const reg = asRegistry(
      registry({ 'provider-homeassistant': { list: () => [{ id: 'ha_001' }] } }),
    )
    expect(
      await pinnedCollectionCall(reg, 'broker', 'list', { addonId: 'provider-homeassistant' }),
    ).toBeNull()
  })

  it('never claims a non-collection cap — addonId there is provider DATA', async () => {
    const reg = asRegistry(registry({ x: { getLogs: () => ['line'] } }, 'singleton'))
    expect(await pinnedCollectionCall(reg, 'addons', 'getLogs', { addonId: 'x' })).toBeNull()
  })
})
