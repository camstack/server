import { describe, it, expect, vi } from 'vitest'
import type { AddonHttpReply, AddonHttpRequest, IScopedLogger } from '@camstack/types'
import { abortableSleep } from '../alexa-device-code-login.js'
import { AlexaDeviceCodeManager } from '../alexa-device-code-manager.js'
import { buildAlexaLoginRoutes } from '../alexa-login-routes.js'
import type { AlexaProxyLoginManager } from '../alexa-proxy-login-manager.js'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
} as unknown as IScopedLogger

function reply() {
  const state: { status: number; body: unknown } = { status: 0, body: undefined }
  const r = {
    code: (c: number) => {
      state.status = c
      return r
    },
    send: (b: unknown) => {
      state.body = b
    },
  }
  return { state, reply: r as unknown as AddonHttpReply }
}

function req(over: Partial<AddonHttpRequest>): AddonHttpRequest {
  return { params: {}, query: {}, body: {}, headers: {}, ...over } as AddonHttpRequest
}

describe('device-code login routes', () => {
  function setup() {
    const proxyLogin = {
      start: vi.fn(),
      status: vi.fn(() => null),
      takeCaptured: vi.fn(() => null),
      cancel: vi.fn(async () => undefined),
    } as unknown as AlexaProxyLoginManager
    const deviceCode = new AlexaDeviceCodeManager({
      logger,
      session: {
        http: async (r) =>
          r.path === '/auth/create/codepair'
            ? { status: 200, json: { public_code: 'ABCDE', private_code: 'p', expires_in: 600 } }
            : { status: 401, json: null },
        refresh: async () => ({}),
        sleep: (_ms, signal) => abortableSleep(1e9, signal),
        now: () => 1000,
      },
    })
    const routes = buildAlexaLoginRoutes({
      logger,
      proxyLogin,
      deviceCode,
      commitCookie: vi.fn(async () => ({ brokerId: 'b' })),
    })
    const find = (path: string) => {
      const route = routes.find((r) => r.path === path)
      if (route === undefined) throw new Error(`no route ${path}`)
      return route
    }
    return { proxyLogin, find }
  }

  it('code/start answers the code, status finds it by id, cancel drops it', async () => {
    const { proxyLogin, find } = setup()
    const start = reply()
    await find('/login/code/start').handler(
      req({ body: { amazonDomain: 'amazon.it' } }),
      start.reply,
    )
    expect(start.state.status).toBe(200)
    expect(start.state.body).toMatchObject({
      userCode: 'ABCDE',
      verificationUrl: 'https://www.amazon.it/code',
      expiresAt: 601000,
    })
    expect(proxyLogin.start).not.toHaveBeenCalled()
    const sessionId = (start.state.body as { sessionId: string }).sessionId

    const status = reply()
    await find('/login/status').handler(req({ query: { sessionId } }), status.reply)
    expect(status.state.body).toMatchObject({
      method: 'device-code',
      phase: 'awaiting-code',
      userCode: 'ABCDE',
    })

    const cancel = reply()
    await find('/login/cancel').handler(req({ body: { sessionId } }), cancel.reply)
    const after = reply()
    await find('/login/status').handler(req({ query: { sessionId } }), after.reply)
    expect(after.state.status).toBe(404)
  })
})
