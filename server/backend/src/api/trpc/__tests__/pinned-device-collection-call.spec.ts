/**
 * The `{ provider }` pin for a DEVICE-collection cap, on the child→parent UDS
 * path — the third place the same defect was found.
 *
 * `videoclips` has three providers on the operator's hub (`recorder`,
 * `provider-reolink`, `export-hap`). Every clip byte read named
 * `provider-reolink`, and every one was answered by somebody else: the
 * recorder ("an analytics visit … has no file behind it"), then — after a
 * redeploy in a different order — export-hap ("was not minted by the HomeKit
 * source"). The same clip, two different wrong answers, which is what a
 * first-wins resolution looks like from outside.
 *
 * Two fixes landed first and neither reached this path:
 *   - D592 fixed the tRPC MOUNT, which a forked addon never reaches.
 *   - D593 fixed the Moleculer transport link — but a hub-local runner is a
 *     broker-less UDS child whose chain is `[localProviderLink,
 *     ipcParentLink]`, with no `brokerTransportLink` in it at all.
 *
 * So the call arrives at the parent's `onUnownedCall`, where the routing
 * discards the selector by construction (`resolveCapRoute` takes only
 * `nodeId`/`deviceId`) and the child index answers "first child wins".
 *
 * `videoclips` mounts `device-scoped`, not `collection`: `resolveCapMount`
 * checks `scope: 'device' + kind: 'wrapper'` BEFORE `mode`, which is why the
 * existing `{ addonId }` pin does not see it and needed a device twin.
 */
import { describe, expect, it } from 'vitest'
import { devicePinOf, pinnedDeviceCollectionCall } from '../cap-router-runtime.js'

type Reg = Parameters<typeof devicePinOf>[0]

/**
 * A registry fake shaped like the real one for the three things these paths
 * read: the definition, the per-device bindings and the registered providers.
 */
function registry(providers: Readonly<Record<string, unknown>>, bound: readonly string[]): Reg {
  return {
    getDefinition: () => ({
      mode: 'collection',
      scope: 'device',
      kind: 'wrapper',
      methods: {},
    }),
    getCollectionEntries: () => Object.entries(providers),
    getProviderByAddonId: (_cap: string, addonId: string) => providers[addonId] ?? null,
    getProviderAddonIds: () => Object.keys(providers),
    getBindings: () => bound.map((addonId) => ({ addonId })),
    getNativeAddonId: () => null,
    getNativeProvider: () => null,
    getSingleton: () => null,
    // Every registered provider is admitted; the pin, not the enabled-filter,
    // is what these tests are about.
    resolveCollectionForDevice: () => Object.values(providers),
  } as unknown as Reg
}

const REOLINK = {
  readClipBytes: (input: unknown) => ({
    servedBy: 'provider-reolink',
    clipId: (input as { clipId: string }).clipId,
  }),
}
/** The sibling that answered for two days. It implements the method only to
 *  explain that it owns no such file. */
const EXPORT_HAP = {
  readClipBytes: () => {
    throw new Error('was not minted by the HomeKit source')
  },
}

describe('devicePinOf — what counts as a device-collection pin', () => {
  it('reads `provider` on a device-collection cap', () => {
    const reg = registry({ 'export-hap': EXPORT_HAP, 'provider-reolink': REOLINK }, [])
    expect(devicePinOf(reg, 'videoclips', { deviceId: 3628, provider: 'provider-reolink' })).toBe(
      'provider-reolink',
    )
  })

  it('is null with no provider named — unpinned calls route as they always did', () => {
    const reg = registry({ 'provider-reolink': REOLINK }, [])
    expect(devicePinOf(reg, 'videoclips', { deviceId: 3628 })).toBeNull()
  })

  it('is null without a deviceId — a device pin needs a device', () => {
    const reg = registry({ 'provider-reolink': REOLINK }, [])
    expect(devicePinOf(reg, 'videoclips', { provider: 'provider-reolink' })).toBeNull()
  })

  it('is null on an empty provider string — absence is not a pin', () => {
    const reg = registry({ 'provider-reolink': REOLINK }, [])
    expect(devicePinOf(reg, 'videoclips', { deviceId: 3628, provider: '' })).toBeNull()
  })
})

describe('pinnedDeviceCollectionCall — the NAMED provider answers', () => {
  it('answers from the pinned provider, not from the first-registered sibling', async () => {
    // Registration order puts export-hap first: exactly the hub's shape the
    // day the operator's clip came back "was not minted by the HomeKit source".
    const reg = registry({ 'export-hap': EXPORT_HAP, 'provider-reolink': REOLINK }, [
      'export-hap',
      'provider-reolink',
    ])

    const out = await pinnedDeviceCollectionCall(reg, 'videoclips', 'readClipBytes', {
      deviceId: 3628,
      clipId: 'native:reolink:onboard:0:abc',
      provider: 'provider-reolink',
    })

    expect(out).toEqual({
      value: { servedBy: 'provider-reolink', clipId: 'native:reolink:onboard:0:abc' },
    })
  })

  it('REFUSES a pin the device is not bound to, rather than serving a sibling', async () => {
    const reg = registry({ 'export-hap': EXPORT_HAP, 'provider-reolink': REOLINK }, [
      'export-hap',
      'provider-reolink',
    ])

    await expect(
      pinnedDeviceCollectionCall(reg, 'videoclips', 'readClipBytes', {
        deviceId: 3628,
        clipId: 'c',
        provider: 'provider-nonexistent',
      }),
    ).rejects.toThrow(/provider-nonexistent/)
  })

  it('declines an UNPINNED call so it routes normally — "not handled", not an answer', async () => {
    const reg = registry({ 'provider-reolink': REOLINK }, ['provider-reolink'])
    expect(
      await pinnedDeviceCollectionCall(reg, 'videoclips', 'readClipBytes', {
        deviceId: 3628,
        clipId: 'c',
      }),
    ).toBeNull()
  })

  it('boxes the result, so a legitimate null is not read as "not handled"', async () => {
    const NULLY = { getClipPlayback: () => null }
    const reg = registry({ 'provider-reolink': NULLY }, ['provider-reolink'])
    expect(
      await pinnedDeviceCollectionCall(reg, 'videoclips', 'getClipPlayback', {
        deviceId: 3628,
        provider: 'provider-reolink',
      }),
    ).toEqual({ value: null })
  })
})
