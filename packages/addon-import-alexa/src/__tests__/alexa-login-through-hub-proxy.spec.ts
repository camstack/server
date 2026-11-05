import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VendorLoginProxy } from '@camstack/types'
import { AlexaProxyLoginManager } from '../alexa-proxy-login-manager.js'
import {
  FIXTURE_SECRETS,
  fakeAmazon,
  fixtureJson,
  fixtureText,
  refreshRoutes,
  type AmazonRoutes,
} from './helpers/amazon-fake.js'
import { recordingLogger } from './helpers/recording-logger.js'

/**
 * The whole Amazon sign-in, with the hub login proxy in front of a scripted Amazon: the proxy's
 * `fetchFn` serves the fixture pages as www.amazon.it, a second scripted Amazon answers the
 * device registration, and the browser side is a plain fetch against the proxy.
 */

const AMAZON = 'https://www.amazon.it'

function page(body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...extra } })
}

function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ location })
  for (const c of cookies) headers.append('set-cookie', c)
  return new Response(null, { status: 302, headers })
}

interface Scenario {
  readonly landing: string
}

function scriptedAmazon(scenario: Scenario): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const method = init?.method ?? 'GET'
    const key = `${method} ${url.host}${url.pathname}`
    if (key === 'GET www.amazon.it/ap/signin') {
      return new Response(fixtureText('ax-claim-form.html'), {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'set-cookie': 'session-id=FIXTURE-REGISTER-SESSION; Path=/; Secure',
        },
      })
    }
    if (key === 'POST www.amazon.it/ap/signin') return redirect(`${AMAZON}/ap/cvf/request`)
    if (key === 'GET www.amazon.it/ap/cvf/request') return page(fixtureText('cvf.html'))
    if (key === 'POST www.amazon.it/ap/cvf/verify') return redirect(scenario.landing)
    return new Response('unrouted', { status: 404 })
  }
}

function registerRoutes(): AmazonRoutes {
  return {
    ...refreshRoutes(),
    'POST api.amazon.it/auth/register': { json: fixtureJson('register-success.json') },
    'GET alexa.amazon.it/api/users/me?platform=ios&version=2.2.651540.0': {
      json: fixtureJson('users-me.json'),
    },
  }
}

describe('the Amazon login through the hub login proxy', () => {
  let front: Server
  let frontPort = 0
  let proxy: VendorLoginProxy
  let manager: AlexaProxyLoginManager
  let amazon: ReturnType<typeof fakeAmazon>
  let log: ReturnType<typeof recordingLogger>
  let scenario: Scenario

  async function boot(routes: AmazonRoutes, landing: string): Promise<void> {
    scenario = { landing }
    amazon = fakeAmazon(routes)
    log = recordingLogger()
    proxy = new VendorLoginProxy({
      addonId: 'import-alexa',
      logger: log.logger,
      fetchFn: scriptedAmazon(scenario),
    })
    front = createServer((req, res) => void proxy.handler(req, res))
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve))
    frontPort = (front.address() as AddressInfo).port
    manager = new AlexaProxyLoginManager({
      logger: log.logger,
      getLoginProxy: () => proxy,
      http: amazon.http,
      randomBytes: (size) => Buffer.alloc(size, 3),
    })
  }

  beforeEach(() => undefined)
  afterEach(async () => {
    await manager.dispose()
    await new Promise<void>((resolve) => front.close(() => resolve()))
  })

  const viaFront = (hubPath: string): string =>
    `http://127.0.0.1:${frontPort}${hubPath.replace('/addon/import-alexa/vendor-login', '')}`

  /** Sign in: the entry page, the identifier step, then the final verification post. */
  async function walkToEnd(loginUrl: string): Promise<string> {
    const first = await fetch(viaFront(loginUrl), { redirect: 'manual' })
    expect(first.status).toBe(200)
    const action = /action="([^"]+)"/.exec(await first.text())?.[1] ?? ''
    expect(action.startsWith('/addon/import-alexa/vendor-login/')).toBe(true)
    const signIn = await fetch(viaFront(action), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=a%40b.c&password=x',
    })
    const cvf = signIn.headers.get('location') ?? ''
    expect(cvf).toContain('/ap/cvf/request')
    const form = await fetch(viaFront(cvf), { redirect: 'manual' })
    const verify = /action="([^"]+)"/.exec(await form.text())?.[1] ?? ''
    const done = await fetch(viaFront(verify), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'code=123456',
    })
    return done.headers.get('location') ?? ''
  }

  it('walks the sign-in, registers the device and lands on the result page without secrets', async () => {
    await boot(registerRoutes(), fixtureText('maplanding-with-code.url'))
    const started = await manager.start('amazon.it')
    expect(
      started.loginUrl.startsWith(
        `/addon/import-alexa/vendor-login/${started.sessionId}/www.amazon.it/ap/signin`,
      ),
    ).toBe(true)
    expect(started.loginUrl.startsWith('/')).toBe(true)

    const landing = await walkToEnd(started.loginUrl)
    expect(landing).toContain('/sso-complete#')
    expect(landing).toContain('status=success')
    expect(landing).toContain('addon=import-alexa')
    for (const secret of FIXTURE_SECRETS) expect(landing).not.toContain(secret)
    expect(landing).not.toContain('maplanding')

    expect(manager.status(started.sessionId)?.phase).toBe('captured')
    const captured = manager.takeCaptured(started.sessionId)
    expect(captured?.cookie).toContain('csrf=FIXTURE-CSRF')
    expect(captured?.cookieData).toMatchObject({
      refreshToken: 'FIXTURE-REFRESH-TOKEN',
      dataVersion: 2,
      deviceAppName: 'CamStack',
    })

    const register = amazon.callsTo('POST api.amazon.it/auth/register')[0]
    expect(register?.body).toContain('FIXTURE-AUTH-CODE')
    // the cookie the browser collected rides along as website_cookies
    expect(register?.body).toContain('FIXTURE-REGISTER-SESSION')
    for (const secret of FIXTURE_SECRETS) expect(log.dump()).not.toContain(secret)
  })

  it('ends at once with no_authorization_code when Amazon landed without the oa2 code', async () => {
    await boot(registerRoutes(), fixtureText('maplanding-without-code.url'))
    const started = await manager.start('amazon.it')
    const landing = await walkToEnd(started.loginUrl)
    expect(landing).toContain('status=error')
    expect(landing).toContain('reason=no_authorization_code')
    expect(amazon.callsTo('POST api.amazon.it/auth/register')).toHaveLength(0)
    expect(manager.status(started.sessionId)?.phase).toBe('error')
  })

  it('lands on the result page with a reason when Amazon refuses the registration', async () => {
    await boot(
      {
        ...registerRoutes(),
        'POST api.amazon.it/auth/register': { status: 401, json: fixtureJson('register-401.json') },
      },
      fixtureText('maplanding-with-code.url'),
    )
    const started = await manager.start('amazon.it')
    const landing = await walkToEnd(started.loginUrl)
    expect(landing).toContain('status=error')
    expect(landing).toContain('reason=exchange_failed')
    expect(landing).not.toContain('FIXTURE-AUTH-CODE')
    expect(log.dump()).not.toContain('FIXTURE-DO-NOT-ECHO')
    expect(manager.takeCaptured(started.sessionId)).toBeNull()
  })

  it('lands with a reason when the registration blob cannot be built', async () => {
    await boot(
      { ...registerRoutes(), 'POST api.amazon.it/auth/token': { status: 401, json: {} } },
      fixtureText('maplanding-with-code.url'),
    )
    const started = await manager.start('amazon.it')
    const landing = await walkToEnd(started.loginUrl)
    expect(landing).toContain('reason=exchange_failed')
  })

  it('refuses a replay of the entry after the attempt was cancelled', async () => {
    await boot(registerRoutes(), fixtureText('maplanding-with-code.url'))
    const started = await manager.start('amazon.it')
    await manager.cancel(started.sessionId)
    const again = await fetch(viaFront(started.loginUrl), { redirect: 'manual' })
    expect(again.headers.get('location') ?? '').toContain('reason=invalid_state')
  })

  it('says so when the hub does not serve the login proxy', async () => {
    await boot(registerRoutes(), fixtureText('maplanding-with-code.url'))
    const bare = new AlexaProxyLoginManager({ logger: log.logger, getLoginProxy: () => null })
    await expect(bare.start('amazon.it')).rejects.toThrow(/hub login proxy is not available/)
  })
})
