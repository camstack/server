import { describe, it, expect } from 'vitest'
import { AlexaDeviceCodeManager } from '../alexa-device-code-manager.js'
import { fakeAmazon, fixtureJson, refreshRoutes, type AmazonReply } from './helpers/amazon-fake.js'
import { recordingLogger } from './helpers/recording-logger.js'

const PRIVATE_CODE = 'PRIVATE-CODE-SECRET'
const REFRESH_TOKEN = 'FIXTURE-REFRESH-TOKEN'
const COOKIE_VALUE = 'FIXTURE-EXCHANGED-SESSION'

const pairBody = {
  public_code: 'ABCDE',
  private_code: PRIVATE_CODE,
  expires_in: 600,
  polling_interval_in_seconds: 5,
}
const successBody = fixtureJson('register-success.json')
const fixtureReply400 = (): AmazonReply => ({
  status: 400,
  json: { response: { error: { code: 'InvalidRequest' } } },
})
const pending: AmazonReply = {
  status: 401,
  json: { response: { error: { code: 'Unauthorized' } } },
}
const ok = (json: unknown): AmazonReply => ({ status: 200, json })

/** A scripted Amazon: the codepair answer, then the register answers in order (the last repeats). */
function setup(opts: { codepair?: AmazonReply; registers: AmazonReply[]; tick?: number }) {
  const log = recordingLogger()
  const clock = { t: 1_000_000 }
  const amazon = fakeAmazon({
    ...refreshRoutes(),
    'POST api.amazon.it/auth/create/codepair': opts.codepair ?? ok(pairBody),
    'POST api.amazon.de/auth/create/codepair': opts.codepair ?? ok(pairBody),
    'POST api.amazon.fr/auth/create/codepair': opts.codepair ?? ok(pairBody),
    'POST api.amazon.es/auth/create/codepair': opts.codepair ?? ok(pairBody),
    'POST api.amazon.com/auth/create/codepair': opts.codepair ?? ok(pairBody),
    'POST api.amazon.co.uk/auth/create/codepair': opts.codepair ?? ok(pairBody),
    ...Object.fromEntries(
      ['it', 'de', 'fr', 'es', 'com', 'co.uk'].map((tld) => [
        `POST api.amazon.${tld}/auth/register`,
        (_req: unknown, n: number) =>
          opts.registers[Math.min(n - 1, opts.registers.length - 1)] ?? pending,
      ]),
    ),
  })
  const manager = new AlexaDeviceCodeManager({
    logger: log.logger,
    session: {
      http: amazon.http,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += opts.tick ?? ms
      },
    },
  })
  return { manager, calls: amazon.calls, lines: log.lines, dump: log.dump, amazon }
}

async function settle(manager: AlexaDeviceCodeManager, sessionId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const phase = manager.status(sessionId)?.phase
    if (phase !== 'awaiting-code') return
    await new Promise((r) => setTimeout(r, 0))
  }
}

describe('device-code sign-in', () => {
  it('codepair, pending 401, then success: captured with the full cookieData', async () => {
    const { manager, calls } = setup({
      registers: [pending, pending, ok(successBody)],
    })
    const started = await manager.start('amazon.it')
    expect(started.userCode).toBe('ABCDE')
    expect(started.verificationUrl).toBe('https://www.amazon.it/code')
    expect(calls[0]?.host).toBe('api.amazon.it')
    expect(manager.status(started.sessionId)?.phase).toBe('awaiting-code')

    await settle(manager, started.sessionId)
    const status = manager.status(started.sessionId)
    expect(status?.phase).toBe('captured')
    expect(status?.method).toBe('device-code')
    expect(calls.filter((c) => c.path === '/auth/register')).toHaveLength(3)
    expect(calls.filter((c) => c.path === '/auth/token')).toHaveLength(1)

    const captured = manager.takeCaptured(started.sessionId)
    expect(captured?.cookie).toContain('session-id=')
    expect(captured?.cookieData).toMatchObject({
      csrf: 'FIXTURE-CSRF',
      refreshToken: REFRESH_TOKEN,
      amazonPage: 'amazon.it',
      macDms: { adp_token: 'FIXTURE-ADP-TOKEN' },
      dataVersion: 2,
    })
    expect(captured?.cookieData).toHaveProperty('deviceSerial')
  })

  it('expires without confirmation', async () => {
    const { manager } = setup({ registers: [pending], tick: 300_000 })
    const started = await manager.start('amazon.de')
    await settle(manager, started.sessionId)
    const status = manager.status(started.sessionId)
    expect(status?.phase).toBe('expired')
    expect(manager.takeCaptured(started.sessionId)).toBeNull()
  })

  it('a refused codepair throws naming status and Amazon code', async () => {
    const { manager, lines } = setup({
      codepair: { status: 403, json: { response: { error: { code: 'InvalidDeviceType' } } } },
      registers: [pending],
    })
    await expect(manager.start('amazon.com')).rejects.toThrow(/HTTP 403.*InvalidDeviceType/)
    expect(lines.some((l) => /HTTP 403/.test(l.message))).toBe(true)
  })

  it('a registration refused with a non-401 error ends in error naming the cause', async () => {
    const { manager } = setup({
      registers: [fixtureReply400()],
    })
    const started = await manager.start('amazon.fr')
    await settle(manager, started.sessionId)
    const status = manager.status(started.sessionId)
    expect(status?.phase).toBe('error')
    expect(status?.error).toMatch(/HTTP 400.*InvalidRequest/)
  })

  it('cancel stops polling', async () => {
    const { manager, calls } = setup({ registers: [pending] })
    const started = await manager.start('amazon.es')
    await manager.cancel(started.sessionId)
    const seen = calls.length
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.length).toBe(seen)
    expect(manager.status(started.sessionId)).toBeNull()
  })

  it('never puts the private code, tokens or cookies in status, logs or errors', async () => {
    const { manager, lines } = setup({
      registers: [pending, ok(successBody)],
    })
    const started = await manager.start('amazon.it')
    await settle(manager, started.sessionId)
    const dump = JSON.stringify([manager.status(started.sessionId), started, lines])
    for (const secret of [PRIVATE_CODE, REFRESH_TOKEN, COOKIE_VALUE])
      expect(dump).not.toContain(secret)

    expect(manager.status(started.sessionId)?.phase).toBe('captured')

    const failing = setup({
      codepair: { status: 500, json: { private_code: PRIVATE_CODE, error: 'boom' } },
      registers: [pending],
    })
    const err = await failing.manager.start('amazon.com').catch((e: unknown) => String(e))
    expect(`${err}${JSON.stringify(failing.lines)}`).not.toContain(PRIVATE_CODE)
  })

  it('rides out a network blip or a 5xx while polling', async () => {
    const { manager } = setup({
      registers: [pending, { status: 503, json: {} }, pending, ok(successBody)],
    })
    const started = await manager.start('amazon.it')
    await settle(manager, started.sessionId)
    expect(manager.status(started.sessionId)?.phase).toBe('captured')
  })

  it('gives up after repeated failures', async () => {
    const { manager } = setup({ registers: [{ status: 503, json: {} }] })
    const started = await manager.start('amazon.it')
    await settle(manager, started.sessionId)
    expect(manager.status(started.sessionId)?.phase).toBe('error')
  })
})
