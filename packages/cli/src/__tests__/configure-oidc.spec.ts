import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { configureOidc, OIDC_TOOL_SHAPE } from '../mcp/configure-oidc.js'
import type { FetchFn } from '../mcp/context.js'
import { dryRunOf, gatedHub, writes } from './configure-fixtures.js'

const PALETTE = {
  roles: {
    publicEndpoint: { resolved: 'https://cam.example.test/' },
    appConnections: { resolved: ['http://192.168.1.9:4443'] },
  },
}

const answers = (extra: { [path: string]: unknown } = {}): { [path: string]: unknown } => ({
  'localNetwork.getAddresses': PALETTE,
  'oidcConnections.listConnections': [],
  'oidcConnections.createConnection': { id: 'x' },
  'oidcConnections.updateConnection': { ok: true },
  ...extra,
})

function discoveryFetch(issuer: string, extra: { [k: string]: unknown } = {}): FetchFn {
  return async () =>
    new Response(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        ...extra,
      }),
    )
}

function hub(fetchFn: FetchFn, extra: { [path: string]: unknown } = {}) {
  const h = gatedHub(answers(extra))
  return { calls: h.calls, ctx: { ...h.ctx, fetch: fetchFn } }
}

describe('configure_oidc', () => {
  it('pocket-id public client: preview then confirm creates a connection with no secret', async () => {
    const { ctx, calls } = hub(discoveryFetch('https://id.example.test'))
    const args = {
      provider: 'pocket-id' as const,
      host: 'id.example.test',
      client_id: 'abc',
      client_type: 'public' as const,
    }
    const preview = dryRunOf(await configureOidc(ctx, args, undefined))
    expect(preview.token).toBeDefined()
    expect(JSON.stringify(preview.describe)).not.toContain('secretStep')
    expect(writes(calls)).toHaveLength(0)

    await configureOidc(ctx, args, preview.token)
    const posted = writes(calls)
    expect(posted.map((c) => c.path)).toEqual([
      'oidcConnections.createConnection',
      'oidcConnections.updateConnection',
    ])
    expect(posted[1]?.input).toMatchObject({
      id: 'pocket-id',
      issuerUrl: 'https://id.example.test',
      clientId: 'abc',
    })
    expect(JSON.stringify(posted)).not.toContain('clientSecret')
  })

  it('authentik confidential: issuer from the slug and the UI instruction for the secret', async () => {
    const issuer = 'https://auth.example.test/application/o/camstack/'
    const { ctx, calls } = hub(discoveryFetch(issuer))
    const out = dryRunOf(
      await configureOidc(
        ctx,
        {
          provider: 'authentik',
          host: 'auth.example.test',
          application_slug: 'camstack',
          client_id: 'cid',
          client_type: 'confidential',
        },
        undefined,
      ),
    )
    const text = JSON.stringify(out.describe)
    expect(text).toContain(issuer)
    expect(text).toContain('secretStep')
    expect(text).toContain('/system/identity?tab=authentication')
    expect(writes(calls)).toHaveLength(0)
  })

  it('the redirect URI comes from the palette, never loopback', async () => {
    const { ctx } = hub(discoveryFetch('https://id.example.test'))
    const q = await configureOidc(ctx, { provider: 'pocket-id' }, undefined)
    expect(q).toMatchObject({
      status: 'questions',
      redirectUri: 'https://cam.example.test/addon/auth-oidc/pocket-id/callback',
    })
    const loop = hub(discoveryFetch('https://id.example.test'), {
      'localNetwork.getAddresses': {
        roles: {
          publicEndpoint: { resolved: 'https://127.0.0.1:4443' },
          appConnections: { resolved: ['https://127.0.0.1:4443', 'http://192.168.1.9:4443'] },
        },
      },
    })
    const q2 = await configureOidc(loop.ctx, { provider: 'pocket-id' }, undefined)
    expect(JSON.stringify(q2)).toContain(
      'http://192.168.1.9:4443/addon/auth-oidc/pocket-id/callback',
    )
    expect(JSON.stringify(q2)).not.toContain('127.0.0.1')
  })

  it('warns, without failing, when discovery lacks S256', async () => {
    const { ctx } = hub(
      discoveryFetch('https://id.example.test', { code_challenge_methods_supported: ['plain'] }),
    )
    const out = dryRunOf(
      await configureOidc(
        ctx,
        { provider: 'pocket-id', host: 'id.example.test', client_id: 'abc' },
        undefined,
      ),
    )
    expect(out.token).toBeDefined()
    expect(JSON.stringify(out.describe)).toContain('does not include S256')
  })

  it('a provider without public clients refuses client_type public', async () => {
    const { ctx } = hub(discoveryFetch('https://accounts.google.com'))
    const out = await configureOidc(
      ctx,
      { provider: 'google', client_id: 'g', client_type: 'public' },
      undefined,
    )
    expect(JSON.stringify(out)).toContain('does not issue public clients')
  })

  it('the tool schema has no secret-like field', () => {
    const keys = Object.keys(OIDC_TOOL_SHAPE)
    expect(keys.filter((k) => /secret|password|credential|passphrase/i.test(k))).toEqual([])
    expect(z.object(OIDC_TOOL_SHAPE).shape).not.toHaveProperty('client_secret')
  })
})
