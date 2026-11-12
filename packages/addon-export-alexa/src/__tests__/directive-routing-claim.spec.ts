/**
 * Option B (planning#378): the public origin is the `publicEndpoint` role, and a token whose
 * `hubUrl` routing claim no longer matches it is refused with a LOGGED, named reason - never
 * a silent 401. Tokens without the claim, and tokens whose claim equals the role, pass on.
 */
import type { AddonContext, AddonHttpReply, AddonHttpRequest, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildRoutes, BROKER_HEADER, type HttpRouteDeps, type RoutedSkill } from '../http-server.js'
import { NO_PUBLIC_ENDPOINT_REASON, type PublicEndpointResult } from '../public-endpoint.js'

const BROKER = 'https://broker.example.test'
const VERIFIED = {
  userId: 'u1',
  username: 'op',
  scopes: [{ type: 'category', target: 'device', access: ['view'] }],
}

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'HS256' })}.${part(payload)}.sig`
}

interface LogLine {
  readonly message: string
  readonly meta: unknown
}

function recordingLogger(warns: LogLine[]): IScopedLogger {
  const value: IScopedLogger = {
    debug() {},
    info() {},
    warn(message, opts) {
      warns.push({ message, meta: opts?.meta })
    },
    error() {},
    child() {
      return value
    },
    withTags() {
      return value
    },
  }
  return value
}

async function post(token: string, endpoint: PublicEndpointResult) {
  const warns: LogLine[] = []
  const advertised: string[] = []
  const deps: HttpRouteDeps = {
    ctx: {
      api: {
        userManagement: {
          oauthVerifyAccessToken: { query: async () => VERIFIED },
        },
      },
    } as unknown as AddonContext,
    logger: recordingLogger(warns),
    resolveSkill: () => ({
      id: 'export-alexa',
      getSettings: () =>
        ({
          enforceIngressToken: false,
          ingressToken: '',
          expectedAudience: 'skill',
        }) as never,
      directiveDeps: {} as RoutedSkill['directiveDeps'],
      hasLinkedUser: () => false,
      lwaTokensCallbackDeps: {} as never,
      onBrokerAdvertised: (url: string) => advertised.push(url),
    }),
    snapshotRoute: {} as never,
    publicEndpoint: async () => endpoint,
  }
  const route = buildRoutes(deps).find((r) => r.path === '/directive')
  const sent: { status: number; body: unknown } = { status: 0, body: null }
  const reply = {
    code(status: number) {
      sent.status = status
      return reply
    },
    send(body: unknown) {
      sent.body = body
      return reply
    },
  }
  await route?.handler(
    {
      body: { directive: { payload: { scope: { token } } } },
      headers: { [BROKER_HEADER]: BROKER },
    } as unknown as AddonHttpRequest,
    reply as unknown as AddonHttpReply,
  )
  return { sent, warns, advertised }
}

const ROLE: PublicEndpointResult = {
  ok: true,
  origin: 'https://hub.example.org',
}

describe('directive routing claim', () => {
  it('refuses a token issued for another origin, and logs why', async () => {
    const { sent, warns, advertised } = await post(jwt({ hubUrl: 'https://old.example.org' }), ROLE)
    expect(advertised).toEqual([])
    expect(JSON.stringify(sent.body)).toContain('INVALID_AUTHORIZATION_CREDENTIAL')
    expect(JSON.stringify(sent.body)).toContain('re-link')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.message).toContain('routing-claim-stale')
    expect(warns[0]?.meta).toMatchObject({
      claim: 'https://old.example.org',
      current: 'https://hub.example.org',
    })
  })

  it('names the typed reason when the role resolves to nothing', async () => {
    const { sent, warns } = await post(jwt({ hubUrl: 'https://old.example.org' }), {
      ok: false,
      reason: NO_PUBLIC_ENDPOINT_REASON,
    })
    expect(JSON.stringify(sent.body)).toContain('INVALID_AUTHORIZATION_CREDENTIAL')
    expect(warns[0]?.message).toContain('no-public-endpoint')
  })

  it('accepts a token whose claim equals the role', async () => {
    const { warns, advertised } = await post(jwt({ hubUrl: 'https://hub.example.org/' }), ROLE)
    expect(warns).toEqual([])
    expect(advertised).toEqual([BROKER])
  })

  it('accepts a token that carries no routing claim', async () => {
    const { warns, advertised } = await post(jwt({ sub: 'u1' }), ROLE)
    expect(warns).toEqual([])
    expect(advertised).toEqual([BROKER])
  })

  it('never writes the token into the log', async () => {
    const token = jwt({ hubUrl: 'https://old.example.org' })
    const { warns } = await post(token, ROLE)
    expect(JSON.stringify(warns)).not.toContain(token)
  })
})
