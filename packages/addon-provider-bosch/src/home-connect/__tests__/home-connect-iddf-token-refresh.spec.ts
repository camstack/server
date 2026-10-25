import { makeSecretMarker } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildHomeConnectConnectionPersister } from '../home-connect-connection-persist.js'
import { entityIndexFromDescription } from '../home-connect-device-description.js'
import { buildStoreZip } from '../home-connect-iddf.js'
import { enrichHomeConnectConnection } from '../home-connect-iddf-fetch.js'
import type { LoginFetch, LoginHttpResponse } from '../home-connect-login.js'
import type { HomeConnectConfig } from '../config.js'

const NOW = 1_800_000_000_000
const HA_ID = '014100544323005961'

function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
}

const STALE = jwt({ sub: 'acct', exp: NOW / 1000 - 60 })
const FRESH = jwt({ sub: 'acct', exp: NOW / 1000 + 3600 })
const NO_EXP = jwt({ sub: 'acct' })

const IDDF_ZIP = buildStoreZip({
  'appliance_DeviceDescription.xml':
    '<device><description><type>Dishwasher</type><model>M</model></description><status uid="228" refCID="01" refDID="00"/></device>',
  'appliance_FeatureMapping.xml':
    '<featureMappingFile><featureDescription><feature refUID="228">BSH.Common.Status.OperationState</feature></featureDescription><errorDescription/><enumDescriptionList/></featureMappingFile>',
})

const EMPTY_IDDF_ZIP = buildStoreZip({
  'appliance_DeviceDescription.xml':
    '<device><description><type>Dishwasher</type><model>M</model></description></device>',
  'appliance_FeatureMapping.xml':
    '<featureMappingFile><featureDescription/><errorDescription/><enumDescriptionList/></featureMappingFile>',
})

function zipResponse(zip: Buffer): LoginHttpResponse {
  return {
    status: 200,
    headers: {
      get: (name) => (name === 'content-type' ? 'application/zip' : null),
    },
    text: async () => '',
    arrayBuffer: async () => Uint8Array.from(zip).buffer,
  }
}

function jsonResponse(status: number, body: unknown): LoginHttpResponse {
  return {
    status,
    headers: {
      get: (name) => (name === 'content-type' ? 'application/json' : null),
    },
    text: async () => JSON.stringify(body),
  }
}

interface Cloud {
  readonly fetchImpl: LoginFetch
  readonly iddfAuth: string[]
  readonly refreshCalls: () => number
}

/** The cloud accepts only `validToken` on the IDDF; the token endpoint answers `refreshAnswer`. */
function cloud(opts: {
  readonly validToken: string
  readonly refreshAnswer: LoginHttpResponse
  readonly zip?: Buffer
}): Cloud {
  const iddfAuth: string[] = []
  let refreshes = 0
  const fetchImpl: LoginFetch = async (url, init) => {
    if (url.includes('/security/oauth/token')) {
      refreshes += 1
      return opts.refreshAnswer
    }
    if (url.includes('/api/iddf/v1/iddf/')) {
      const auth = init.headers['authorization'] ?? ''
      iddfAuth.push(auth)
      // As observed live: the IDDF endpoint answers 403 to a request that carries more
      // than the bearer token (an `accept: application/zip` was enough).
      const extra = Object.keys(init.headers).filter(
        (name) => name.toLowerCase() !== 'authorization',
      )
      if (extra.length > 0) return jsonResponse(403, {})
      if (auth !== `Bearer ${opts.validToken}`) return jsonResponse(401, {})
      return zipResponse(opts.zip ?? IDDF_ZIP)
    }
    return jsonResponse(404, {})
  }
  return { fetchImpl, iddfAuth, refreshCalls: () => refreshes }
}

function connection(token: string): HomeConnectConfig {
  return {
    token,
    refresh: 'ref-old',
    appliances: [
      {
        haId: HA_ID,
        name: 'Dishwasher',
        type: 'Dishwasher',
        host: `BOSCH-Dishwasher-${HA_ID}`,
        psk: 'psk',
        mode: 'TLS',
      },
    ],
  }
}

interface Logged {
  readonly message: string
  readonly meta: Record<string, unknown>
}

function hooks(): {
  readonly warns: Logged[]
  readonly onWarn: (message: string, meta: Record<string, unknown>) => void
  readonly now: () => number
} {
  const warns: Logged[] = []
  return {
    warns,
    onWarn: (message, meta) => warns.push({ message, meta }),
    now: () => NOW,
  }
}

describe('Home Connect IDDF fetch refreshes the account token', () => {
  it('refreshes an expired token BEFORE the IDDF fetch, maps the entities and returns the rotated pair', async () => {
    const c = cloud({
      validToken: FRESH,
      refreshAnswer: jsonResponse(200, {
        access_token: FRESH,
        refresh_token: 'ref-new',
      }),
    })
    const h = hooks()
    const result = await enrichHomeConnectConnection(connection(STALE), c.fetchImpl, h)

    expect(c.iddfAuth).toEqual([`Bearer ${FRESH}`])
    expect(c.refreshCalls()).toBe(1)
    expect(result.changed).toBe(true)
    expect(result.tokenRotated).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.connection.token).toBe(FRESH)
    expect(result.connection.refresh).toBe('ref-new')
    const row = result.connection.appliances?.[0]
    expect(entityIndexFromDescription(row?.deviceDescription).get(552)?.name).toBe(
      'BSH.Common.Status.OperationState',
    )
  })

  it('a 401 on a token with no expiry refreshes once and retries the fetch', async () => {
    const c = cloud({
      validToken: FRESH,
      refreshAnswer: jsonResponse(200, { access_token: FRESH }),
    })
    const result = await enrichHomeConnectConnection(connection(NO_EXP), c.fetchImpl, hooks())

    expect(c.iddfAuth).toEqual([`Bearer ${NO_EXP}`, `Bearer ${FRESH}`])
    expect(c.refreshCalls()).toBe(1)
    expect(result.changed).toBe(true)
    expect(result.connection.token).toBe(FRESH)
    // No new refresh token in the answer: the one that was used is kept, never blanked.
    expect(result.connection.refresh).toBe('ref-old')
  })

  it('a failed refresh changes nothing stored and logs why the appliance stays degraded', async () => {
    const c = cloud({
      validToken: FRESH,
      refreshAnswer: jsonResponse(400, { error: 'invalid_grant' }),
    })
    const h = hooks()
    const before = connection(STALE)
    const result = await enrichHomeConnectConnection(before, c.fetchImpl, h)

    expect(c.refreshCalls()).toBe(1)
    expect(result.tokenRotated).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.connection).toBe(before)
    expect(result.missing).toEqual([HA_ID])
    expect(h.warns.map((w) => w.message)).toEqual([
      'Home Connect access token refresh failed — keeping the stored token',
      'Home Connect IDDF unavailable — appliance stays degraded until it loads',
    ])
    expect(h.warns[0]?.meta).toMatchObject({
      reason: 'refresh-rejected',
      status: 400,
    })
    expect(h.warns[1]?.meta).toMatchObject({
      haId: HA_ID,
      reason: 'unauthorized',
      status: 401,
      contentType: 'application/json',
    })
    expect(JSON.stringify(h.warns)).not.toContain(STALE)
    expect(JSON.stringify(h.warns)).not.toContain('ref-old')
  })

  it('an IDDF zip that parses to zero entities is its own reason, not a success', async () => {
    const c = cloud({
      validToken: FRESH,
      refreshAnswer: jsonResponse(500, {}),
      zip: EMPTY_IDDF_ZIP,
    })
    const h = hooks()
    const result = await enrichHomeConnectConnection(connection(FRESH), c.fetchImpl, h)

    expect(result.changed).toBe(false)
    expect(result.missing).toEqual([HA_ID])
    expect(c.refreshCalls()).toBe(0)
    expect(h.warns).toHaveLength(1)
    expect(h.warns[0]?.meta).toMatchObject({
      haId: HA_ID,
      reason: 'no-entities',
      status: 200,
      contentType: 'application/zip',
      zipEntries: 2,
      entityCount: 0,
    })
    expect(h.warns[0]?.meta['bytes']).toBe(EMPTY_IDDF_ZIP.length)
    expect(h.warns[0]?.meta['headHex']).toBe(EMPTY_IDDF_ZIP.subarray(0, 16).toString('hex'))
  })

  it('an unparsable body logs its first 16 bytes and the encoding headers, never the token', async () => {
    const body = Buffer.from('this is not a zip archive at all')
    const c = cloud({ validToken: FRESH, refreshAnswer: jsonResponse(500, {}), zip: body })
    const h = hooks()
    await enrichHomeConnectConnection(connection(FRESH), c.fetchImpl, h)

    expect(h.warns).toHaveLength(1)
    expect(h.warns[0]?.meta).toMatchObject({
      reason: 'unparsable-zip',
      zipEntries: 0,
      zipEntryNames: [],
      headHex: body.subarray(0, 16).toString('hex'),
      contentEncoding: null,
      contentDisposition: null,
    })
    expect(JSON.stringify(h.warns)).not.toContain(FRESH)
  })
})

describe('the rotated token is persisted to the keychain', () => {
  function persistHarness(stored: Record<string, unknown>) {
    const setSettings = vi.fn(
      async (_input: unknown): Promise<unknown> => ({
        success: true,
      }),
    )
    const warn = vi.fn()
    const persist = buildHomeConnectConnectionPersister({
      getSettings: async () => stored,
      setSettings,
      logger: { warn },
    })
    return { persist, setSettings, warn }
  }

  it('writes the rotated access + refresh token, named as keychain secrets', async () => {
    const x = persistHarness({
      token: STALE,
      refresh: 'ref-old',
      appliances: [],
    })
    await x.persist('int-1', { ...connection(FRESH), refresh: 'ref-new' })

    expect(x.setSettings).toHaveBeenCalledTimes(1)
    const call = x.setSettings.mock.calls[0]?.[0]
    expect(call).toMatchObject({
      id: 'int-1',
      settings: { token: FRESH, refresh: 'ref-new' },
    })
    expect(call).toHaveProperty('secretKeys', expect.arrayContaining(['token', 'refresh']))
  })

  it('writes nothing while a stored token cannot be read from the keychain', async () => {
    const x = persistHarness({
      token: makeSecretMarker('secret://addon/int-1/token'),
      refresh: 'ref-old',
      appliances: [],
    })
    await x.persist('int-1', connection(FRESH))

    expect(x.setSettings).not.toHaveBeenCalled()
    expect(x.warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(x.warn.mock.calls)).not.toContain(FRESH)
  })
})
