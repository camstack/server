import {
  AUTOMATIC_HUB_ADDRESS_FLAGS,
  type ConnectionEndpoint,
  resolveHubAddressRoles,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHubHttpSource } from '../addon-upload.js'
import {
  clusterBaseUrlResolver,
  HubAddressUnavailableError,
  type LocalNetworkEndpointsSource,
  resolveHubBaseUrl,
} from '../hub-cluster-url.js'

/**
 * The URL a hub hands an agent for an addon bundle or a model pull.
 *
 * The defect: it was `CAMSTACK_HUB_PUBLIC_URL ?? 'https://127.0.0.1:4443'`. A
 * Mac hub (the desktop app has no field for that variable) and any container
 * without it handed the agent its OWN loopback. These tests run with the
 * variable absent — and, for good measure, set to loopback — and require a
 * LAN URL from the `local-network` palette, and never loopback.
 */

const lan: ConnectionEndpoint = {
  label: 'LAN — en0',
  baseUrl: 'https://192.0.2.40:4443',
  kind: 'lan-ipv4',
  interfaceKind: 'lan',
  plausible: true,
  plausibleReason: '',
  priority: 0,
}
const loopback: ConnectionEndpoint = {
  label: 'Loopback',
  baseUrl: 'https://127.0.0.1:4443',
  kind: 'loopback',
  interfaceKind: 'loopback',
  plausible: false,
  plausibleReason: 'Loopback',
  priority: 1000,
}

/** A provider answering the way `local-network` does: the flagged address, else the palette. */
function source(
  endpoints: readonly ConnectionEndpoint[],
  internalFlag: string | null = null,
  publicEndpointFlag: string | null = null,
): LocalNetworkEndpointsSource {
  const flags = {
    ...AUTOMATIC_HUB_ADDRESS_FLAGS,
    internal: internalFlag,
    publicEndpoint: publicEndpointFlag,
  }
  return {
    getAddresses: async () => ({
      rows: [],
      roles: resolveHubAddressRoles(endpoints, endpoints, flags),
      appLinkHub: null,
    }),
  }
}

const ENV = 'CAMSTACK_HUB_PUBLIC_URL'
let saved: string | undefined
beforeEach(() => {
  saved = process.env[ENV]
  delete process.env[ENV]
})
afterEach(() => {
  if (saved === undefined) delete process.env[ENV]
  else process.env[ENV] = saved
})

describe('the agent-pull base URL', () => {
  it('a hub with no env hands agents its LAN address', async () => {
    const baseUrl = await clusterBaseUrlResolver(() => source([loopback, lan]))()
    const pulled = buildHubHttpSource(Buffer.from('tgz'), baseUrl)
    expect(new URL(pulled.url).origin).toBe('https://192.0.2.40:4443')
  })

  it('ignores the retired env var entirely, even when it names loopback', async () => {
    process.env[ENV] = 'https://127.0.0.1:4443'
    const baseUrl = await clusterBaseUrlResolver(() => source([lan]))()
    expect(baseUrl).toBe('https://192.0.2.40:4443')
  })

  it('the address flagged internal wins over the detected one (Docker bridge)', async () => {
    const bridge: ConnectionEndpoint = { ...lan, baseUrl: 'https://172.17.0.2:4443' }
    const baseUrl = await clusterBaseUrlResolver(() =>
      source([bridge], 'https://192.0.2.20:4443'),
    )()
    expect(baseUrl).toBe('https://192.0.2.20:4443')
  })

  it('refuses — never loopback — when the palette has nothing an agent can reach', async () => {
    await expect(resolveHubBaseUrl(() => source([loopback]), 'internal')).rejects.toBeInstanceOf(
      HubAddressUnavailableError,
    )
    await expect(resolveHubBaseUrl(() => null, 'internal')).rejects.toThrow(
      /local-network capability is not available/,
    )
  })
})

describe('the OAuth2 / browser-facing base URL (publicEndpoint, D734)', () => {
  it('each audience reads its own role: agents never get the public endpoint', async () => {
    const getSource = (): LocalNetworkEndpointsSource =>
      source([lan], null, 'https://cams.example.org')
    expect(await resolveHubBaseUrl(getSource, 'publicEndpoint')).toBe('https://cams.example.org')
    expect(await clusterBaseUrlResolver(getSource)()).toBe('https://192.0.2.40:4443')
  })
})
