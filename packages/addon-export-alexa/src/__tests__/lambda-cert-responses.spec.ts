/**
 * The skill Lambda's Alexa-facing responses, held to the shapes Amazon's
 * Smart Home certification checks:
 *
 *   - `Alexa.ErrorResponse` carries the directive's `correlationToken` and an
 *     `endpoint` (alexa-errorresponse: both required);
 *   - an AcceptGrant failure is `Alexa.Authorization/ErrorResponse` with
 *     `ACCEPT_GRANT_FAILED` (alexa-authorization), not the generic namespace;
 *   - a hub that cannot be reached is `BRIDGE_UNREACHABLE` — the hub is the
 *     bridge every camera sits behind — never `INTERNAL_ERROR`;
 *   - a hub reply that is not an Alexa event never reaches Alexa as-is;
 *   - the account-linking page refuses a non-HTTPS hub URL on the page itself
 *     (no navigation, no alert, no script) and cannot be broken out of by its query.
 *     The full hub-address step is pinned in `lambda-authorize.spec.ts`.
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

interface FakeResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
  json(): Promise<unknown>
  readonly headers: { get(name: string): string | null }
}
type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<FakeResponse>
type Handler = (event: unknown) => Promise<Record<string, unknown>>

const lambda = require('../../lambda-template/index.js') as {
  createHandler(deps: Record<string, unknown>): Handler
}

const HUB = 'https://hub.example.test'

function jwtWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}
const BEARER = jwtWith({ hubUrl: HUB, sub: 'u1' })

function response(status: number, body: unknown, contentType = 'application/json'): FakeResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: { get: () => contentType },
  }
}

const silent = { info: () => {}, warn: () => {}, error: () => {} }

function handlerWith(fetch: FetchFn, env: Record<string, string> = {}): Handler {
  return lambda.createHandler({
    env,
    fetch,
    store: null,
    secrets: {
      lwa: async () => null,
      skill: async () => null,
      invalidate: () => {},
    },
    now: () => 1_800_000_000_000,
    log: silent,
  })
}

function powerDirective() {
  return {
    directive: {
      header: {
        namespace: 'Alexa.PowerController',
        name: 'TurnOn',
        messageId: 'm-1',
        correlationToken: 'corr-1',
        payloadVersion: '3',
      },
      endpoint: {
        scope: { type: 'BearerToken', token: BEARER },
        endpointId: '101__privacy',
      },
      payload: {},
    },
  }
}

interface ErrorEvent {
  readonly event: {
    readonly header: {
      readonly namespace: string
      readonly name: string
      readonly messageId: string
      readonly correlationToken?: string
    }
    readonly endpoint?: { readonly endpointId: string }
    readonly payload: { readonly type: string; readonly message: string }
  }
}

describe('directive errors', () => {
  it('a hub that cannot be reached is BRIDGE_UNREACHABLE, with correlationToken and endpoint', async () => {
    const res = (await handlerWith(async () => {
      throw new Error('connect ETIMEDOUT')
    })(powerDirective())) as unknown as ErrorEvent
    expect(res.event.header.namespace).toBe('Alexa')
    expect(res.event.header.name).toBe('ErrorResponse')
    expect(res.event.header.correlationToken).toBe('corr-1')
    expect(res.event.endpoint?.endpointId).toBe('101__privacy')
    expect(res.event.payload.type).toBe('BRIDGE_UNREACHABLE')
  })

  it('a tunnel error page (5xx, not JSON) is BRIDGE_UNREACHABLE too', async () => {
    const res = (await handlerWith(async () =>
      response(530, '<html>origin unreachable</html>', 'text/html'),
    )(powerDirective())) as unknown as ErrorEvent
    expect(res.event.payload.type).toBe('BRIDGE_UNREACHABLE')
    expect(res.event.endpoint?.endpointId).toBe('101__privacy')
  })

  it('a JSON reply that is not an Alexa event is turned into an ErrorResponse', async () => {
    const res = (await handlerWith(async () => response(401, { error: 'invalid_ingress_token' }))(
      powerDirective(),
    )) as unknown as ErrorEvent
    expect(res.event.header.name).toBe('ErrorResponse')
    expect(res.event.header.correlationToken).toBe('corr-1')
    expect(res.event.payload.type).toBe('INTERNAL_ERROR')
  })

  it('a hub ErrorResponse missing endpoint/correlationToken is completed on the way out', async () => {
    const res = (await handlerWith(async () =>
      response(200, {
        event: {
          header: {
            namespace: 'Alexa',
            name: 'ErrorResponse',
            messageId: 'm-1',
            payloadVersion: '3',
          },
          payload: { type: 'INVALID_DIRECTIVE', message: 'x' },
        },
      }),
    )(powerDirective())) as unknown as ErrorEvent
    expect(res.event.header.correlationToken).toBe('corr-1')
    expect(res.event.endpoint?.endpointId).toBe('101__privacy')
    expect(res.event.payload.type).toBe('INVALID_DIRECTIVE')
  })

  it('a hub success response passes through untouched', async () => {
    const ok = {
      event: {
        header: {
          namespace: 'Alexa',
          name: 'Response',
          messageId: 'm-1',
          correlationToken: 'corr-1',
          payloadVersion: '3',
        },
        endpoint: { endpointId: '101__privacy' },
        payload: {},
      },
      context: { properties: [] },
    }
    const res = await handlerWith(async () => response(200, ok))(powerDirective())
    expect(res).toEqual(ok)
  })

  it('a directive with no bearer still answers with the endpoint and correlationToken', async () => {
    const d = powerDirective()
    const noBearer = {
      directive: { ...d.directive, endpoint: { endpointId: '101__privacy' } },
    }
    const res = (await handlerWith(async () => response(200, {}))(
      noBearer,
    )) as unknown as ErrorEvent
    expect(res.event.payload.type).toBe('INVALID_AUTHORIZATION_CREDENTIAL')
    expect(res.event.header.correlationToken).toBe('corr-1')
    expect(res.event.endpoint?.endpointId).toBe('101__privacy')
  })
})

describe('AcceptGrant errors', () => {
  it('fail in the Alexa.Authorization namespace with ACCEPT_GRANT_FAILED', async () => {
    const res = (await handlerWith(async () => response(200, {}))({
      directive: {
        header: {
          namespace: 'Alexa.Authorization',
          name: 'AcceptGrant',
          messageId: 'm-2',
          payloadVersion: '3',
        },
        payload: { grant: { type: 'OAuth2.AuthorizationCode', code: 'C' } },
      },
    })) as unknown as ErrorEvent
    expect(res.event.header.namespace).toBe('Alexa.Authorization')
    expect(res.event.header.name).toBe('ErrorResponse')
    expect(res.event.payload.type).toBe('ACCEPT_GRANT_FAILED')
    expect(res.event.endpoint).toBeUndefined()
  })
})

describe('account-linking /authorize page', () => {
  function authorizeEvent(rawQueryString: string) {
    return {
      rawPath: '/authorize',
      rawQueryString,
      requestContext: { http: { method: 'GET' } },
      headers: {},
      isBase64Encoded: false,
    }
  }

  it('cannot be broken out of by its query string', async () => {
    const res = await handlerWith(async () => response(200, {}))(
      authorizeEvent('state=</script><script>alert(1)</script>'),
    )
    const html = String(res.body)
    expect(html).not.toContain('</script><script>alert(1)')
  })

  it('refuses a non-HTTPS hub URL on the page (checked server-side, no script, no alert)', async () => {
    const res = await handlerWith(async () => response(200, {}))(
      authorizeEvent('state=s&hubUrl=http%3A%2F%2Fhub.example.com'),
    )
    const html = String(res.body)
    expect(html).toContain('data-reason="not_https"')
    expect(html).not.toMatch(/<script|\balert\(/)
  })
})
