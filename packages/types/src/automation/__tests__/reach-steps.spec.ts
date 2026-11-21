import { describe, expect, it } from 'vitest'
import {
  type HttpFetch,
  httpExpectationMet,
  reachVars,
  runHttpStep,
  runProbeStep,
  type TcpConnect,
} from '../reach-steps.js'

/** A clock the fake sleep advances: a window is judged on this, never on wall time. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 1_000
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms
    },
  }
}

const never = (): boolean => false

describe('runProbeStep', () => {
  it('reaches a host on the first try and times it', async () => {
    const c = clock()
    const connect: TcpConnect = async () => {
      await c.sleep(12)
    }
    const out = await runProbeStep(
      { connect, ...c, isAborted: never },
      { host: '10.0.0.2', port: 80, timeoutSeconds: 3 },
    )
    expect(out.met).toBe(true)
    expect(out.attempts).toBe(1)
    expect(out.result).toEqual({ reachable: true, rttMs: 12, error: null })
  })

  it('a refused connection is unreachable with the error, never a 0 ms round trip', async () => {
    const c = clock()
    const connect: TcpConnect = async () => {
      throw new Error('ECONNREFUSED')
    }
    const out = await runProbeStep(
      { connect, ...c, isAborted: never },
      { host: '10.0.0.2', port: 80, timeoutSeconds: 3 },
    )
    expect(out.met).toBe(false)
    expect(out.result).toEqual({ reachable: false, rttMs: null, error: 'ECONNREFUSED' })
  })

  it('expect unreachable is met by a refusal', async () => {
    const c = clock()
    const connect: TcpConnect = async () => {
      throw new Error('ETIMEDOUT')
    }
    const out = await runProbeStep(
      { connect, ...c, isAborted: never },
      { host: 'h', port: 80, timeoutSeconds: 1, expect: 'unreachable' },
    )
    expect(out.met).toBe(true)
  })

  it('retries every 5 s until the host answers, inside the window', async () => {
    const c = clock()
    let calls = 0
    const connect: TcpConnect = async () => {
      calls += 1
      if (calls < 4) throw new Error('EHOSTUNREACH')
    }
    const out = await runProbeStep(
      { connect, ...c, isAborted: never },
      { host: 'h', port: 2010, timeoutSeconds: 2, retryUntilSeconds: 60 },
    )
    expect(out.met).toBe(true)
    expect(out.attempts).toBe(4)
  })

  it('an expectation not met when the window ends is NOT met, after a bounded number of tries', async () => {
    const c = clock()
    let calls = 0
    const connect: TcpConnect = async () => {
      calls += 1
      throw new Error('EHOSTUNREACH')
    }
    const out = await runProbeStep(
      { connect, ...c, isAborted: never },
      { host: 'h', port: 80, timeoutSeconds: 2, retryUntilSeconds: 20 },
    )
    expect(out.met).toBe(false)
    expect(out.attempts).toBe(calls)
    expect(calls).toBeGreaterThan(1)
    expect(calls).toBeLessThanOrEqual(5)
    expect(out.message).toContain('EHOSTUNREACH')
  })

  it('without a window it tries once', async () => {
    const c = clock()
    let calls = 0
    const connect: TcpConnect = async () => {
      calls += 1
      throw new Error('x')
    }
    await runProbeStep(
      { connect, ...c, isAborted: never },
      { host: 'h', port: 80, timeoutSeconds: 2 },
    )
    expect(calls).toBe(1)
  })

  it('a run aborted while retrying stops probing', async () => {
    const c = clock()
    let calls = 0
    const connect: TcpConnect = async () => {
      calls += 1
      throw new Error('x')
    }
    const out = await runProbeStep(
      { connect, ...c, isAborted: () => calls >= 2 },
      { host: 'h', port: 80, timeoutSeconds: 2, retryUntilSeconds: 300 },
    )
    expect(out.met).toBe(false)
    expect(calls).toBe(2)
  })
})

function respond(status: number, body: string): HttpFetch {
  return async () => ({ status, text: async () => body })
}

describe('runHttpStep', () => {
  const base = { method: 'GET', url: 'http://ccu/sysinfo.json', timeoutSeconds: 5 } as const

  it('parses a JSON body and records status, ok and the cut text', async () => {
    const c = clock()
    const out = await runHttpStep(
      {
        fetch: respond(200, '{"sysInfo":{"rawUartRemoteAddress":"192.168.1.9"}}'),
        ...c,
        isAborted: never,
      },
      base,
    )
    expect(out.met).toBe(true)
    expect(out.result.status).toBe(200)
    expect(out.result.ok).toBe(true)
    expect(out.result.error).toBeNull()
    expect(out.result.json).toEqual({ sysInfo: { rawUartRemoteAddress: '192.168.1.9' } })
  })

  it('a transport failure has a null status and the error, not a 0', async () => {
    const c = clock()
    const fetchFn: HttpFetch = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    const out = await runHttpStep({ fetch: fetchFn, ...c, isAborted: never }, base)
    expect(out.met).toBe(false)
    expect(out.result).toEqual({
      status: null,
      ok: false,
      json: null,
      text: null,
      error: 'connect ECONNREFUSED',
    })
  })

  it('without an expectation a non-2xx answer is not met', async () => {
    const c = clock()
    const out = await runHttpStep({ fetch: respond(503, 'busy'), ...c, isAborted: never }, base)
    expect(out.met).toBe(false)
    expect(out.result.status).toBe(503)
    expect(out.result.text).toBe('busy')
  })

  it('caps the kept text', async () => {
    const c = clock()
    const out = await runHttpStep(
      { fetch: respond(200, 'x'.repeat(200_000)), ...c, isAborted: never },
      base,
    )
    expect(out.result.text?.length).toBe(65_536)
    expect(out.result.json).toBeNull()
  })

  it('a JSON expectation (field neq "") holds only when the field is there and different', async () => {
    const c = clock()
    const expectation = {
      on: 'json',
      fieldPath: 'sysInfo.rawUartRemoteAddress',
      operator: 'ne',
      value: '',
    } as const
    const connected = await runHttpStep(
      {
        fetch: respond(200, '{"sysInfo":{"rawUartRemoteAddress":"192.168.1.9"}}'),
        ...c,
        isAborted: never,
      },
      { ...base, expect: expectation },
    )
    const empty = await runHttpStep(
      { fetch: respond(200, '{"sysInfo":{"rawUartRemoteAddress":""}}'), ...c, isAborted: never },
      { ...base, expect: expectation },
    )
    const missing = await runHttpStep(
      { fetch: respond(200, '{"sysInfo":{}}'), ...c, isAborted: never },
      { ...base, expect: expectation },
    )
    expect(connected.met).toBe(true)
    expect(empty.met).toBe(false)
    expect(missing.met).toBe(false)
  })

  it('retries until the expectation holds', async () => {
    const c = clock()
    let calls = 0
    const fetchFn: HttpFetch = async () => {
      calls += 1
      return { status: 200, text: async () => (calls < 3 ? '{"a":""}' : '{"a":"up"}') }
    }
    const out = await runHttpStep(
      { fetch: fetchFn, ...c, isAborted: never },
      {
        ...base,
        retryUntilSeconds: 60,
        expect: { on: 'json', fieldPath: 'a', operator: 'ne', value: '' },
      },
    )
    expect(out.met).toBe(true)
    expect(out.attempts).toBe(3)
  })

  it('does not put header values or the body into the outcome message', async () => {
    const c = clock()
    const out = await runHttpStep(
      { fetch: respond(401, 'secret-body'), ...c, isAborted: never },
      { ...base, headers: { Authorization: 'Bearer SECRET-TOKEN' }, body: 'payload-SECRET' },
    )
    expect(out.message).not.toContain('SECRET')
    expect(out.message).not.toContain('secret-body')
  })

  it('passes method, headers and body to fetch', async () => {
    const c = clock()
    const seen: { method?: string; headers?: Record<string, string>; body?: string }[] = []
    const fetchFn: HttpFetch = async (_url, init) => {
      seen.push({ method: init.method, headers: init.headers, body: init.body })
      return { status: 200, text: async () => '{}' }
    }
    await runHttpStep(
      { fetch: fetchFn, ...c, isAborted: never },
      { ...base, method: 'POST', headers: { 'X-A': '1' }, body: '{"k":1}' },
    )
    expect(seen).toEqual([{ method: 'POST', headers: { 'X-A': '1' }, body: '{"k":1}' }])
  })
})

describe('httpExpectationMet', () => {
  it('a status expectation compares the status', () => {
    const result = { status: 204, ok: true, json: null, text: '', error: null }
    expect(httpExpectationMet(result, { on: 'status', operator: 'eq', value: 204 })).toBe(true)
    expect(httpExpectationMet(result, { on: 'status', operator: 'eq', value: 200 })).toBe(false)
  })
})

describe('reachVars', () => {
  it('stores the result and its scalar fields flat, so {{vars.ccu.reachable}} resolves', () => {
    expect(reachVars('ccu', { reachable: true, rttMs: 4, error: null })).toEqual({
      ccu: { reachable: true, rttMs: 4, error: null },
      'ccu.reachable': true,
      'ccu.rttMs': 4,
      'ccu.error': '',
    })
  })

  it('flattens the JSON body of a response', () => {
    const vars = reachVars('r', {
      status: 200,
      ok: true,
      json: { sysInfo: { addr: '1.2.3.4' } },
      text: '{}',
      error: null,
    })
    expect(vars['r.json.sysInfo.addr']).toBe('1.2.3.4')
    expect(vars['r.status']).toBe(200)
  })
})
