/**
 * A browser that lands on a refused `/api/oauth2/authorize` (a wrong link, an
 * integration that is not up yet, a redirect target the integration does not
 * admit) is sent to the CamStack completion page with a reason CODE, not left
 * on a bare JSON body. A machine caller keeps the JSON it always got.
 */
import cookie from '@fastify/cookie'
import type { IScopedLogger } from '@camstack/types'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE } from '../../../auth/session-cookie.js'
import { registerOauth2Routes } from '../oauth2-routes.js'

function logger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

const NO_INTEGRATIONS = {
  getCollectionEntries: () => new Map(),
  getManifestDeclarers: () => [] as string[],
  hasProvider: () => false,
}

const ALEXA = {
  getCollectionEntries: () =>
    new Map([
      [
        'export-alexa',
        {
          getDescriptor: async () => ({
            integrationId: 'export-alexa',
            displayName: 'Alexa Smart Home',
            requestedScopes: [],
            allowedRedirectPrefixes: ['https://layla.amazon.com/'],
          }),
        },
      ],
    ]),
  getManifestDeclarers: () => [] as string[],
  hasProvider: () => true,
}

let app: FastifyInstance | undefined

async function build(registry: unknown): Promise<FastifyInstance> {
  const fastify = Fastify()
  await fastify.register(cookie)
  registerOauth2Routes(fastify, {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double for the registry surface the route reads
    getRegistry: () => registry as never,
    verifyToken: () => ({ userId: 'u1', username: 'admin', isAdmin: true }),
    isLiveUser: async () => true,
    publicHubUrl: async () => 'https://hub.example',
    logger: logger(),
  })
  app = fastify
  return fastify
}

afterEach(async () => {
  await app?.close()
  app = undefined
})

const BROWSER = { accept: 'text/html,application/xhtml+xml', cookie: `${SESSION_COOKIE}=tok` }
const MACHINE = { accept: 'application/json', cookie: `${SESSION_COOKIE}=tok` }

describe('oauth2 authorize refusals', () => {
  it('a browser on an unknown integration lands on the completion page with a reason code', async () => {
    const res = await (await build(NO_INTEGRATIONS)).inject({
      method: 'GET',
      url: '/api/oauth2/authorize?response_type=code&integration=nope&redirect_uri=https://layla.amazon.com/cb&state=s',
      headers: BROWSER,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(
      '/sso-complete#return=oauth&status=error&integration=nope&reason=invalid_request',
    )
  })

  it('a redirect_uri the integration does not admit lands as invalid_request too', async () => {
    const res = await (await build(ALEXA)).inject({
      method: 'GET',
      url: '/api/oauth2/authorize?response_type=code&integration=export-alexa&redirect_uri=https://evil.example/cb&state=s',
      headers: BROWSER,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('reason=invalid_request')
    // never the attacker-controlled URL, never a code or token
    expect(String(res.headers.location)).not.toContain('evil.example')
  })

  it('an integration whose addon has not registered yet lands as unavailable', async () => {
    const res = await (
      await build({
        getCollectionEntries: () => new Map(),
        getManifestDeclarers: () => ['export-alexa'],
        hasProvider: () => false,
      })
    ).inject({
      method: 'GET',
      url: '/api/oauth2/authorize?response_type=code&integration=export-alexa&redirect_uri=https://layla.amazon.com/cb&state=s',
      headers: BROWSER,
    })
    expect(res.headers.location).toContain('reason=unavailable')
  })

  it('a machine caller keeps the JSON refusal and its status', async () => {
    const res = await (await build(NO_INTEGRATIONS)).inject({
      method: 'GET',
      url: '/api/oauth2/authorize?response_type=code&integration=nope&redirect_uri=https://layla.amazon.com/cb&state=s',
      headers: MACHINE,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: expect.stringContaining('invalid_request') })
  })
})
