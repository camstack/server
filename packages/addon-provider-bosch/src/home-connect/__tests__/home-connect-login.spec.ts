import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  beginHomeConnectSignIn,
  completeHomeConnectSignIn,
  fetchHomeConnectAccount,
  type LoginFetch,
  type LoginHttpResponse,
} from '../home-connect-login.js'
import { entityIndexFromDescription } from '../home-connect-device-description.js'
import { buildStoreZip } from '../home-connect-iddf.js'

function response(status: number, body: string): LoginHttpResponse {
  return {
    status,
    headers: { get: () => null },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }
}

function accessToken(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url')
  return `e30.${payload}.sig`
}

type LoginStep = (
  url: string,
  body: string | undefined,
  headers: Readonly<Record<string, string>>,
) => LoginHttpResponse

function scripted(
  steps: ReadonlyArray<{ readonly match: string; readonly step: LoginStep }>,
): LoginFetch {
  return async (url, init) => {
    const found = steps.find((step) => `${init.method ?? 'GET'} ${url}`.includes(step.match))
    if (!found) throw new Error(`unexpected ${init.method} ${url}`)
    return found.step(url, init.body, init.headers)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const PAIRED = {
  appliances: [
    { haId: 'HAI-A', brand: 'BOSCH', haType: 'Dishwasher', vib: 'Sala', isDemo: false },
    { haId: 'HAI-B', brand: 'BOSCH', haType: 'Dishwasher', vib: 'Kitchen', isDemo: false },
  ],
}

describe('beginHomeConnectSignIn', () => {
  it('builds the Home Connect Local login link', () => {
    const started = beginHomeConnectSignIn()
    const url = new URL(started.authorizeUrl)
    const challenge = createHash('sha256').update(started.verifier).digest('base64url')
    expect(url.searchParams.get('code_challenge')).toBe(challenge)
    expect(url.searchParams.get('redirect_url')).toBe('hcauth://auth/prod')
    expect(url.searchParams.get('redirect_uri')).toBeNull()
    expect(url.searchParams.get('redirect_target')).toBeNull()
    expect(url.searchParams.get('scope')).toContain('ReadAccount')
    expect(url.searchParams.get('state')).toBe(started.state)
  })
})

describe('completeHomeConnectSignIn', () => {
  it('exchanges the pasted redirect and downloads each appliance profile', async () => {
    const started = beginHomeConnectSignIn()
    const token = accessToken('acct-1')
    let clientId = ''
    const fetchImpl = scripted([
      {
        match: 'POST https://api.home-connect.com/security/oauth/token',
        step: (_url, body) => {
          const params = new URLSearchParams(body)
          clientId = params.get('client_id') ?? ''
          expect(params.get('code_verifier')).toBe(started.verifier)
          expect(params.get('code')).toBe('auth-code')
          expect(params.get('redirect_uri')).toBe('hcauth://auth/prod')
          return response(200, JSON.stringify({ access_token: token, refresh_token: 'ref' }))
        },
      },
      {
        match:
          'GET https://eu.services.home-connect.com/api/account/v2/accounts/acct-1/paired-appliances',
        step: () => response(200, JSON.stringify(PAIRED)),
      },
      {
        match: '/encryption-information',
        step: (url) =>
          response(
            200,
            JSON.stringify(
              url.includes('HAI-A') ? { aes: { key: 'k', iv: 'i' } } : { tls: { key: 'psk-b' } },
            ),
          ),
      },
      {
        match: '/api/iddf/v1/iddf/',
        step: () => response(404, ''),
      },
    ])
    const account = await completeHomeConnectSignIn(
      {
        verifier: started.verifier,
        state: started.state,
        callback: `hcauth://auth/prod?code=auth-code&state=${started.state}&grant_type=authorization_code`,
      },
      fetchImpl,
    )
    expect(clientId).toBe('9B75AC9EC512F36C84256AC47D813E2C1DD0D6520DF774B020E1E6E2EB29B1F3')
    expect(account.token).toBe(token)
    expect(account.appliances.map((app) => app.name)).toEqual(['Sala', 'Kitchen'])
    expect(account.appliances[0]?.connection.host).toBe('HAI-A')
    expect(account.appliances[1]?.connection.host).toBe('BOSCH-Dishwasher-HAI-B')
    expect(account.appliances[1]?.connection.mode).toBe('TLS')
  })

  it('stores IDDF entities on the appliance connection when the zip is available', async () => {
    const zip = buildStoreZip({
      'appliance_DeviceDescription.xml':
        '<device><description><type>Dishwasher</type><model>M</model></description><status uid="228" refCID="01" refDID="00"/></device>',
      'appliance_FeatureMapping.xml':
        '<featureMappingFile><featureDescription><feature refUID="228">BSH.Common.Status.OperationState</feature></featureDescription><errorDescription/><enumDescriptionList/></featureMappingFile>',
    })
    const token = accessToken('acct-1')
    const fetchImpl = scripted([
      {
        match: 'POST https://api.home-connect.com/security/oauth/token',
        step: () => response(200, JSON.stringify({ access_token: token, refresh_token: 'ref' })),
      },
      {
        match: 'paired-appliances',
        step: () =>
          response(
            200,
            JSON.stringify({
              appliances: [
                {
                  haId: 'HAI-TLS',
                  brand: 'BOSCH',
                  haType: 'Dishwasher',
                  vib: 'Kitchen',
                  isDemo: false,
                },
              ],
            }),
          ),
      },
      {
        match: '/encryption-information',
        step: () => response(200, JSON.stringify({ tls: { key: 'psk-b' } })),
      },
      {
        match: '/api/iddf/v1/iddf/HAI-TLS',
        step: () => ({
          status: 200,
          headers: { get: () => null },
          text: async () => '',
          arrayBuffer: async () => Uint8Array.from(zip).buffer,
        }),
      },
    ])
    const account = await completeHomeConnectSignIn(
      {
        verifier: 'v',
        state: 's',
        callback: 'hcauth://auth/prod?code=auth-code&state=s&grant_type=authorization_code',
      },
      fetchImpl,
    )
    const parsed: unknown = JSON.parse(account.appliances[0]?.connection.deviceDescription ?? '{}')
    expect(isRecord(parsed)).toBe(true)
    if (!isRecord(parsed)) return
    expect(entityIndexFromDescription(parsed).get(552)?.name).toBe(
      'BSH.Common.Status.OperationState',
    )
  })

  it('refuses a pasted address whose state does not match the login link', async () => {
    await expect(
      completeHomeConnectSignIn(
        { verifier: 'v', state: 'expected', callback: 'hcauth://auth/prod?code=1&state=other' },
        async () => {
          throw new Error('should not fetch')
        },
      ),
    ).rejects.toThrow(/State mismatch/)
  })
})

describe('fetchHomeConnectAccount', () => {
  it('lists every appliance and refreshes a stale access token', async () => {
    const stale = accessToken('acct-1')
    const fresh = `${accessToken('acct-1')}fresh`
    let detailsAuth = ''
    const iddfHeaders: string[][] = []
    const fetchImpl = scripted([
      {
        match:
          'GET https://eu.services.home-connect.com/api/account/v2/accounts/acct-1/paired-appliances',
        step: (_url, _body, headers) => {
          detailsAuth = headers['authorization'] ?? ''
          if (detailsAuth === `Bearer ${stale}`) return response(401, '{}')
          return response(200, JSON.stringify(PAIRED))
        },
      },
      {
        match: 'POST https://api.home-connect.com/security/oauth/token',
        step: () => response(200, JSON.stringify({ access_token: fresh, refresh_token: 'ref2' })),
      },
      {
        match: '/encryption-information',
        step: (url) =>
          response(
            200,
            JSON.stringify(
              url.includes('HAI-A')
                ? { aes: { key: 'k1', iv: 'i1' } }
                : { aes: { key: 'k2', iv: 'i2' } },
            ),
          ),
      },
      {
        match: '/api/iddf/v1/iddf/',
        step: (_url, _body, headers) => {
          iddfHeaders.push(Object.keys(headers).map((name) => name.toLowerCase()))
          return response(404, '')
        },
      },
    ])
    const account = await fetchHomeConnectAccount({ token: stale, refresh: 'ref1' }, fetchImpl)
    // The IDDF endpoint is asked exactly as the reference downloaders ask it: the bearer
    // token and nothing else. An `accept: application/zip` was answered 403 on a live hub.
    expect(iddfHeaders.length).toBeGreaterThan(0)
    for (const names of iddfHeaders) expect(names).toEqual(['authorization'])
    expect(account.token).toBe(fresh)
    expect(account.refresh).toBe('ref2')
    expect(account.appliances.map((app) => app.name)).toEqual(['Sala', 'Kitchen'])
    expect(detailsAuth).toBe(`Bearer ${fresh}`)
  })
})
