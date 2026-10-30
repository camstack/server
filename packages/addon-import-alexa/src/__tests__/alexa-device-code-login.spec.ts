import { describe, it, expect, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { AlexaDeviceCodeManager } from '../alexa-device-code-manager.js'
import type { DeviceCodeHttp, DeviceCodeHttpRequest } from '../alexa-device-code-login.js'

const PRIVATE_CODE = 'PRIVATE-CODE-SECRET'
const REFRESH_TOKEN = 'REFRESH-TOKEN-SECRET'
const COOKIE_VALUE = 'COOKIE-VALUE-SECRET'

interface LogLine {
  readonly message: string
  readonly meta: unknown
}

function makeLogger(lines: LogLine[]): IScopedLogger {
  const record = (message: string, opts?: { meta?: unknown }): void => {
    lines.push({ message, meta: opts?.meta })
  }
  const logger = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: () => logger,
  }
  return logger as unknown as IScopedLogger
}

const pairBody = {
  public_code: 'ABCDE',
  private_code: PRIVATE_CODE,
  expires_in: 600,
  polling_interval_in_seconds: 5,
}
const successBody = {
  response: {
    success: {
      tokens: {
        bearer: { refresh_token: REFRESH_TOKEN },
        website_cookies: [{ Name: 'session-id', Value: COOKIE_VALUE }],
        mac_dms: { device_private_key: 'k', adp_token: 't' },
      },
    },
  },
}
const pending = { status: 401, json: { response: { error: { code: 'Unauthorized' } } } }

/** A scripted Amazon: the codepair answer, then the register answers in order (the last repeats). */
function fakeHttp(
  codepair: { status: number; json: unknown },
  registers: { status: number; json: unknown }[],
) {
  const calls: DeviceCodeHttpRequest[] = []
  let i = 0
  const http: DeviceCodeHttp = async (req) => {
    calls.push(req)
    if (req.path === '/auth/create/codepair') return codepair
    const r = registers[Math.min(i, registers.length - 1)]!
    i += 1
    return r
  }
  return { http, calls }
}

function setup(opts: {
  codepair?: { status: number; json: unknown }
  registers: { status: number; json: unknown }[]
  clock?: { t: number }
  tick?: number
}) {
  const lines: LogLine[] = []
  const clock = opts.clock ?? { t: 1_000_000 }
  const { http, calls } = fakeHttp(opts.codepair ?? { status: 200, json: pairBody }, opts.registers)
  const refresh = vi.fn(async () => ({
    localCookie: `session-id=${COOKIE_VALUE}; csrf=abc`,
    csrf: 'csrf-value',
    refreshToken: REFRESH_TOKEN,
    loginCookie: 'x',
    dataVersion: 2,
  }))
  const manager = new AlexaDeviceCodeManager({
    logger: makeLogger(lines),
    session: {
      http,
      refresh,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += opts.tick ?? ms
      },
    },
  })
  return { manager, calls, lines, refresh, clock }
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
    const { manager, calls, refresh } = setup({
      registers: [pending, pending, { status: 200, json: successBody }],
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
    expect(refresh).toHaveBeenCalledTimes(1)

    const captured = manager.takeCaptured(started.sessionId)
    expect(captured?.cookie).toContain('session-id=')
    expect(captured?.cookieData).toMatchObject({
      csrf: 'csrf-value',
      refreshToken: REFRESH_TOKEN,
      amazonPage: 'amazon.it',
      macDms: { adp_token: 't' },
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
      registers: [{ status: 400, json: { response: { error: { code: 'InvalidRequest' } } } }],
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
      registers: [pending, { status: 200, json: successBody }],
    })
    const started = await manager.start('amazon.co.uk')
    await settle(manager, started.sessionId)
    const dump = JSON.stringify([manager.status(started.sessionId), started, lines])
    for (const secret of [PRIVATE_CODE, REFRESH_TOKEN, COOKIE_VALUE])
      expect(dump).not.toContain(secret)

    const failing = setup({
      codepair: { status: 500, json: { private_code: PRIVATE_CODE, error: 'boom' } },
      registers: [pending],
    })
    const err = await failing.manager.start('amazon.com').catch((e: unknown) => String(e))
    expect(`${err}${JSON.stringify(failing.lines)}`).not.toContain(PRIVATE_CODE)
  })
})
