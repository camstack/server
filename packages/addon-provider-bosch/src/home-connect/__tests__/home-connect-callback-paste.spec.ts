import { describe, expect, it } from 'vitest'
import {
  completeHomeConnectSignIn,
  HomeConnectLoginError,
  type LoginFetch,
  type LoginHttpResponse,
} from '../home-connect-login.js'

function response(status: number, body: string): LoginHttpResponse {
  return {
    status,
    headers: { get: () => null },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }
}

function accessToken(): string {
  return `e30.${Buffer.from(JSON.stringify({ sub: 'acct' })).toString('base64url')}.sig`
}

/** A cloud whose token endpoint accepts one code, once. */
function cloud(seenCodes: string[]): LoginFetch {
  const spent = new Set<string>()
  return async (url, init) => {
    if (url.endsWith('/security/oauth/token')) {
      const code = new URLSearchParams(init.body ?? '').get('code') ?? ''
      seenCodes.push(code)
      if (code !== 'good-code' || spent.has(code)) {
        return response(400, JSON.stringify({ error: 'invalid_grant' }))
      }
      spent.add(code)
      return response(200, JSON.stringify({ access_token: accessToken(), refresh_token: 'rt' }))
    }
    if (url.includes('/paired-appliances')) return response(200, JSON.stringify({ appliances: [] }))
    throw new Error(`unexpected ${init.method} ${url}`)
  }
}

const STATE = 'state-1'

async function paste(callback: string, seen: string[] = []) {
  return completeHomeConnectSignIn({ verifier: 'v', state: STATE, callback }, cloud(seen))
}

describe('Home Connect paste step', () => {
  it('accepts the full hcauth address', async () => {
    const seen: string[] = []
    await paste(
      `hcauth://auth/prod?code=good-code&state=${STATE}&grant_type=authorization_code`,
      seen,
    )
    expect(seen).toEqual(['good-code'])
  })

  it('accepts an address copied from the browser developer tools', async () => {
    const seen: string[] = []
    await paste(`Location: hcauth://auth/prod?code=good-code&state=${STATE}`, seen)
    await paste(`"hcauth://auth/prod?state=${STATE}&code=good-code"`, seen)
    await paste(`code=good-code&state=${STATE}`, seen)
    expect(seen).toEqual(['good-code', 'good-code', 'good-code'])
  })

  it('accepts the bare code', async () => {
    const seen: string[] = []
    await paste('  good-code \n', seen)
    expect(seen).toEqual(['good-code'])
  })

  it('rejects a wrong state before calling the cloud', async () => {
    const seen: string[] = []
    await expect(
      paste('hcauth://auth/prod?code=good-code&state=other', seen),
    ).rejects.toMatchObject({
      reason: 'state-mismatch',
    })
    expect(seen).toEqual([])
  })

  it('names each failure the operator can act on', async () => {
    await expect(paste('')).rejects.toMatchObject({ reason: 'empty' })
    await expect(paste('hcauth://auth/prod?state=' + STATE)).rejects.toMatchObject({
      reason: 'no-code',
    })
    await expect(paste('hcauth://auth/prod?code=good-code')).rejects.toMatchObject({
      reason: 'state-missing',
    })
    await expect(
      paste(`hcauth://auth/prod?error=access_denied&state=${STATE}`),
    ).rejects.toMatchObject({ reason: 'denied' })
    await expect(paste('expired-code')).rejects.toMatchObject({
      reason: 'code-rejected',
    })
    await expect(paste('expired-code')).rejects.toBeInstanceOf(HomeConnectLoginError)
  })

  it('reports a code that was already used as such', async () => {
    const fetchImpl = cloud([])
    const input = { verifier: 'v', state: STATE, callback: 'good-code' }
    await completeHomeConnectSignIn(input, fetchImpl)
    await expect(completeHomeConnectSignIn(input, fetchImpl)).rejects.toThrow(
      /already used or has expired/,
    )
  })
})
