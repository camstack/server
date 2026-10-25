/**
 * D734: every link a notification carries EXCEPT the tap — buttons,
 * attachments / media, admin links — is built on the hub's public endpoint,
 * whatever the notification-taps role says. The fake API answers the taps
 * role with something different on purpose: a resolver that read it would
 * mint on that address and fail here.
 */
import type { ConnectionEndpoint } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { pickArtifactBaseUrl } from '../artifact-url.js'
import { type NcLinkEndpointApi, notificationLinkEndpoints } from '../link-endpoints.js'

const PUBLIC = 'https://cams.example.org'
const LAN: ConnectionEndpoint = {
  label: 'LAN — eth0',
  baseUrl: 'https://192.0.2.10:4443',
  kind: 'lan-ipv4',
  interfaceKind: 'lan',
  plausible: true,
  plausibleReason: '',
  priority: 0,
}

function api(publicEndpoint: string | null | Error): NcLinkEndpointApi & {
  readonly getNotificationEndpoint: ReturnType<typeof vi.fn>
} {
  const getNotificationEndpoint = vi.fn(async () => ({
    baseUrl: 'http://192.0.2.10:4480',
    resolved: 'http://192.0.2.10:4480',
  }))
  return {
    getNotificationEndpoint,
    localNetwork: {
      getAddresses: {
        query: async () => {
          if (publicEndpoint instanceof Error) throw publicEndpoint
          return { roles: { publicEndpoint: { resolved: publicEndpoint } } }
        },
      },
      getConnectionEndpoints: { query: async () => ({ endpoints: [LAN] }) },
    },
    networkAccess: {
      getStatus: {
        query: async () => ({
          connected: true,
          endpoint: { url: 'https://tunnel.example', protocol: 'https' },
        }),
      },
      listEndpoints: { query: async () => [] },
    },
  }
}

describe('notificationLinkEndpoints', () => {
  it('buttons, media and admin links resolve on the public endpoint', async () => {
    const fake = api(PUBLIC)
    const out = await notificationLinkEndpoints(fake, makeSilentLogger())
    expect(pickArtifactBaseUrl(out)).toBe(PUBLIC)
    expect(fake.getNotificationEndpoint).not.toHaveBeenCalled()
  })

  it('a public endpoint on the LAN wins over the connected tunnel — it is the operator answer', async () => {
    const out = await notificationLinkEndpoints(api('http://192.0.2.10:4480'), makeSilentLogger())
    expect(pickArtifactBaseUrl(out)).toBe('http://192.0.2.10:4480')
  })

  it('an unreadable public endpoint falls back to the ingress ladder', async () => {
    const out = await notificationLinkEndpoints(api(new Error('down')), makeSilentLogger())
    expect(pickArtifactBaseUrl(out)).toBe('https://tunnel.example')
  })
})
