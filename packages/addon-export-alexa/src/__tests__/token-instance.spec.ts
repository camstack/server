/**
 * planning#415 T3: the Lambda routes are served per instance (D1046), and a skill refuses an
 * account-link token made for another instance (D1047) with a named, logged reason. A token
 * that names no instance keeps working where it worked before: on the default skill, and on a
 * skill whose ledger already lists the user — nothing is re-linked.
 */
import type { AddonContext, AddonHttpReply, AddonHttpRequest, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildRoutes, BROKER_HEADER, type HttpRouteDeps, type RoutedSkill } from '../http-server.js'
import type { SkillLookup } from '../instance-routing.js'
import { judgeTokenInstance } from '../token-instance.js'

const BROKER = 'https://broker.example.test'

interface Verified {
  readonly userId: string
  readonly username: string
  readonly scopes: readonly unknown[]
  readonly instanceId?: string
}

const verified = (instanceId?: string): Verified => ({
  userId: 'u1',
  username: 'op',
  scopes: [{ type: 'category', target: 'device', access: ['view', 'create'] }],
  ...(instanceId !== undefined ? { instanceId } : {}),
})

interface LogLine {
  readonly message: string
  readonly opts: unknown
}

function recordingLogger(warns: LogLine[]): IScopedLogger {
  const value: IScopedLogger = {
    debug() {},
    info() {},
    warn(message, opts) {
      warns.push({ message, opts })
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

interface World {
  readonly warns: LogLine[]
  readonly advertised: string[]
  readonly upserts: string[]
  readonly lookups: SkillLookup[]
  readonly deps: HttpRouteDeps
}

function world(opts: {
  readonly skillId: string
  readonly token: Verified
  readonly linkedUsers?: readonly string[]
}): World {
  const warns: LogLine[] = []
  const advertised: string[] = []
  const upserts: string[] = []
  const lookups: SkillLookup[] = []
  const ctx = {
    api: {
      userManagement: {
        oauthVerifyAccessToken: { query: async () => opts.token },
      },
    },
  } as unknown as AddonContext
  const logger = recordingLogger(warns)
  const hasLinkedUser = (userId: string): boolean => (opts.linkedUsers ?? []).includes(userId)
  const skill: RoutedSkill = {
    id: opts.skillId,
    getSettings: () =>
      ({
        enforceIngressToken: false,
        ingressToken: '',
        expectedAudience: 'skill',
      }) as never,
    directiveDeps: {} as RoutedSkill['directiveDeps'],
    hasLinkedUser,
    lwaTokensCallbackDeps: {
      ctx,
      logger,
      upsertToken: async (input) => {
        upserts.push(input.userId)
      },
      recordLinkedAccount: async () => {},
      instanceId: opts.skillId,
      judgeInstance: (caller) => judgeTokenInstance(caller, { id: opts.skillId, hasLinkedUser }),
    },
    onBrokerAdvertised: (url: string) => advertised.push(url),
  }
  const deps: HttpRouteDeps = {
    ctx,
    logger,
    resolveSkill: (lookup) => {
      lookups.push(lookup)
      return skill
    },
    snapshotRoute: {} as never,
    publicEndpoint: async () => ({
      ok: true,
      origin: 'https://hub.example.org',
    }),
  }
  return { warns, advertised, upserts, lookups, deps }
}

interface Sent {
  status: number
  body: unknown
}

async function call(
  w: World,
  path: string,
  request: {
    body: unknown
    instanceId?: string
    headers?: Record<string, string>
  },
): Promise<Sent> {
  const route = buildRoutes(w.deps).find((r) => r.path === path && r.perInstance === true)
  if (route === undefined) throw new Error(`no per-instance route ${path}`)
  const sent: Sent = { status: 0, body: null }
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
  await route.handler(
    {
      params: {},
      query: {},
      body: request.body,
      headers: { authorization: 'Bearer tok', ...request.headers },
      ...(request.instanceId !== undefined ? { instanceId: request.instanceId } : {}),
    } as unknown as AddonHttpRequest,
    reply as unknown as AddonHttpReply,
  )
  return sent
}

const DIRECTIVE = {
  directive: {
    header: { namespace: 'Alexa.Discovery', name: 'Discover' },
    payload: { scope: { token: 'tok' } },
  },
}
const BROKER_LINK = {
  brokerUrl: BROKER,
  brokerCredential: 'cred',
  lwaAccessToken: 'at',
  expiresAt: 1,
}

describe('the Lambda routes are per instance (D1046)', () => {
  it('declares the three Lambda routes perInstance, and not the snapshot', () => {
    const routes = buildRoutes(world({ skillId: 'export-alexa', token: verified() }).deps)
    const perInstance = routes.filter((r) => r.perInstance === true).map((r) => r.path)
    expect(perInstance.toSorted()).toEqual([
      '/directive',
      '/oauth/broker-link',
      '/oauth/lwa-tokens',
    ])
  })

  it('a path naming an instance resolves that skill; the path without one keeps the header lookup', async () => {
    const w = world({
      skillId: 'alexa-skill-2',
      token: verified('alexa-skill-2'),
    })
    await call(w, '/directive', {
      body: DIRECTIVE,
      instanceId: 'alexa-skill-2',
    })
    await call(w, '/directive', {
      body: DIRECTIVE,
      instanceId: 'export-alexa',
      headers: { 'x-camstack-ingress': 'tok-two' },
    })
    expect(w.lookups).toEqual([
      { pathInstanceId: 'alexa-skill-2', ingressHeader: undefined },
      { pathInstanceId: undefined, ingressHeader: 'tok-two' },
    ])
  })
})

describe('a skill refuses a token linked to another instance (D1047)', () => {
  it('directive: refused with the Alexa envelope and a logged reason, the skill is never reached', async () => {
    const w = world({
      skillId: 'alexa-skill-2',
      token: verified('alexa-skill-3'),
    })
    const sent = await call(w, '/directive', {
      body: DIRECTIVE,
      instanceId: 'alexa-skill-2',
      headers: { [BROKER_HEADER]: BROKER },
    })
    expect(JSON.stringify(sent.body)).toContain('INVALID_AUTHORIZATION_CREDENTIAL')
    expect(w.advertised).toEqual([])
    expect(w.warns.map((l) => l.message).join('\n')).toContain('token-instance-mismatch')
    expect(w.warns.find((l) => l.message.includes('token-instance'))?.opts).toMatchObject({
      meta: {
        instanceId: 'alexa-skill-2',
        tokenInstanceId: 'alexa-skill-3',
        userId: 'u1',
      },
    })
  })

  it('directive: a default-instance token is refused on a second skill that never linked the user', async () => {
    const w = world({ skillId: 'alexa-skill-2', token: verified() })
    const sent = await call(w, '/directive', {
      body: DIRECTIVE,
      instanceId: 'alexa-skill-2',
      headers: { [BROKER_HEADER]: BROKER },
    })
    expect(JSON.stringify(sent.body)).toContain('INVALID_AUTHORIZATION_CREDENTIAL')
    expect(w.advertised).toEqual([])
    expect(w.warns.map((l) => l.message).join('\n')).toContain('token-instance-unstated')
  })

  it('directive: a token naming the skill passes; so does an unstated one on a skill that linked the user', async () => {
    const named = world({
      skillId: 'alexa-skill-2',
      token: verified('alexa-skill-2'),
    })
    await call(named, '/directive', {
      body: DIRECTIVE,
      instanceId: 'alexa-skill-2',
      headers: { [BROKER_HEADER]: BROKER },
    })
    expect(named.advertised).toEqual([BROKER])

    const legacy = world({
      skillId: 'alexa-skill-2',
      token: verified(),
      linkedUsers: ['u1'],
    })
    await call(legacy, '/directive', {
      body: DIRECTIVE,
      instanceId: 'alexa-skill-2',
      headers: { [BROKER_HEADER]: BROKER },
    })
    expect(legacy.advertised).toEqual([BROKER])
  })

  it('directive: the default skill serves every token that names no instance, as before', async () => {
    const w = world({ skillId: 'export-alexa', token: verified() })
    await call(w, '/directive', {
      body: DIRECTIVE,
      instanceId: 'export-alexa',
      headers: { [BROKER_HEADER]: BROKER },
    })
    expect(w.advertised).toEqual([BROKER])
  })

  it('broker-link: a foreign token is refused 403 and stores nothing; the right one links', async () => {
    const foreign = world({
      skillId: 'export-alexa',
      token: verified('alexa-skill-2'),
    })
    const refused = await call(foreign, '/oauth/broker-link', {
      body: BROKER_LINK,
      instanceId: 'export-alexa',
    })
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ error: 'token-instance-mismatch' })
    expect(foreign.upserts).toEqual([])

    const own = world({
      skillId: 'alexa-skill-2',
      token: verified('alexa-skill-2'),
    })
    const ok = await call(own, '/oauth/broker-link', {
      body: BROKER_LINK,
      instanceId: 'alexa-skill-2',
    })
    expect(ok.status).toBe(200)
    expect(own.upserts).toEqual(['u1'])
  })

  it('lwa-tokens: a foreign token is refused 403 and stores nothing', async () => {
    const w = world({ skillId: 'alexa-skill-2', token: verified() })
    const refused = await call(w, '/oauth/lwa-tokens', {
      body: { lwaAccessToken: 'a', lwaRefreshToken: 'r', expiresAt: 1 },
      instanceId: 'alexa-skill-2',
    })
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ error: 'token-instance-unstated' })
    expect(w.upserts).toEqual([])
  })
})

describe('the OAuth descriptor lists the skills an account may be linked to (D1047)', () => {
  it('lists every running skill but the default one, and omits the field with none', async () => {
    const { buildAlexaOauthIntegration } = await import('../oauth-integration.js')
    expect(
      buildAlexaOauthIntegration('https://hub.example.org', [
        { id: 'alexa-skill-2', displayName: 'Garage skill' },
      ]).instances,
    ).toEqual([{ id: 'alexa-skill-2', displayName: 'Garage skill' }])
    expect(buildAlexaOauthIntegration('https://hub.example.org', [])).not.toHaveProperty(
      'instances',
    )
  })
})
