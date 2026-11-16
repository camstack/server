import { describe, expect, it, vi } from 'vitest'
import { commandOrigin } from '../../cap-call-context.js'
import type { AddonApi } from '../../generated/addon-api.js'
import { createDeviceProxy } from '../../generated/device-proxy.js'

/** The one leaf this spec calls; the rest of the api is never touched. */
interface SwitchApi {
  readonly switch: { readonly setState: { readonly mutate: ReturnType<typeof vi.fn> } }
}

describe('a DeviceProxy command carries the origin claim it is given', () => {
  const mutate = vi.fn(async () => undefined)
  const fake: SwitchApi = { switch: { setState: { mutate } } }
  // boundary: the generated AddonApi is too wide to fake without a cast
  const api = fake as unknown as AddonApi
  const proxy = createDeviceProxy(api, {
    deviceId: 7,
    entries: [
      {
        capName: 'switch',
        kind: 'native',
        providerNodeId: 'n1',
        providerAddonId: 'a',
        nativeAddonId: 'a',
      },
    ],
  })

  it('passes the options through untouched as the second tRPC argument', async () => {
    const origin = commandOrigin({
      kind: 'on-behalf',
      source: 'homekit',
      principalId: 'ctrl-1',
    })
    await proxy.switch?.setState({ on: true }, origin)
    expect(mutate).toHaveBeenLastCalledWith({ on: true, deviceId: 7, nodeId: 'n1' }, origin)
  })

  it('sends no second argument value when none is given', async () => {
    await proxy.switch?.setState({ on: false })
    expect(mutate).toHaveBeenLastCalledWith({ on: false, deviceId: 7, nodeId: 'n1' }, undefined)
  })
})
