import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readConnection, settingsToConnection, type EnpalConnection } from '../config.js'
import { EnpalError, readEnpalSnapshot, type FetchLike } from '../enpal-client.js'

const csv = readFileSync(join(__dirname, 'fixtures', 'influx-last-values.csv'), 'utf8')
const html = readFileSync(join(__dirname, 'fixtures', 'device-messages.html'), 'utf8')
const TOKEN = 'fixture-token-do-not-log-0123456789'

function connection(patch: Record<string, unknown> = {}): EnpalConnection {
  return settingsToConnection({ host: '192.0.2.10', token: TOKEN, ...patch })
}

interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** A box fake: answers Influx on :8086 and the device page on :80. */
function box(opts: {
  readonly influx?: 'ok' | 'unauthorized' | 'down' | 'empty' | 'error500'
  readonly page?: 'ok' | 'down' | 'empty'
}): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchFake: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const isInflux = url.includes(':8086')
    if (isInflux) {
      switch (opts.influx ?? 'ok') {
        case 'down':
          throw new TypeError('fetch failed')
        case 'unauthorized':
          return new Response('{"code":"unauthorized"}', { status: 401 })
        case 'error500':
          return new Response('boom', { status: 500 })
        case 'empty':
          return new Response('\r\n', { status: 200 })
        case 'ok':
          return new Response(csv, { status: 200 })
      }
    }
    switch (opts.page ?? 'ok') {
      case 'down':
        throw new TypeError('fetch failed')
      case 'empty':
        return new Response('<html><body>nothing</body></html>', { status: 200 })
      case 'ok':
        return new Response(html, { status: 200 })
    }
  }
  return { fetch: fetchFake, calls }
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    if (err instanceof EnpalError) return err.kind
    throw err
  }
  return 'resolved'
}

describe('readEnpalSnapshot - InfluxDB', () => {
  it('posts one Flux query with the token header and parses the answer', async () => {
    const fake = box({})
    const snap = await readEnpalSnapshot({
      connection: connection(),
      fetch: fake.fetch,
      now: () => 7,
    })
    expect(snap.source).toBe('influxdb')
    expect(snap.fetchedAt).toBe(7)
    expect(snap.readings.get('Power.DC.Total')?.value).toBe(4200)
    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]
    expect(call?.url).toBe('http://192.0.2.10:8086/api/v2/query?org=enpal')
    expect(call?.init?.method).toBe('POST')
    const body = String(call?.init?.body)
    expect(body).toContain('from(bucket: "solar")')
    expect(body).toContain('last()')
    const headers = new Headers(call?.init?.headers)
    expect(headers.get('authorization')).toBe(`Token ${TOKEN}`)
    expect(headers.get('content-type')).toBe('application/vnd.flux')
  })

  it('url-encodes the organisation', async () => {
    const fake = box({})
    await readEnpalSnapshot({
      connection: connection({ org: 'my org' }),
      fetch: fake.fetch,
      now: () => 1,
    })
    expect(fake.calls[0]?.url).toContain('org=my%20org')
  })

  it('a bucket name that could break out of the Flux string is refused at the schema', () => {
    expect(() =>
      settingsToConnection({ host: 'h', token: 't', bucket: 'a") |> drop() //' }),
    ).toThrow()
  })
})

describe('readEnpalSnapshot - failures are typed, never zeros', () => {
  it('unreachable box -> kind unreachable (no snapshot at all)', async () => {
    const fake = box({ influx: 'down' })
    expect(
      await kindOf(
        readEnpalSnapshot({
          connection: connection({ source: 'influx' }),
          fetch: fake.fetch,
          now: () => 1,
        }),
      ),
    ).toBe('unreachable')
  })

  it('401 -> kind unauthorized', async () => {
    const fake = box({ influx: 'unauthorized' })
    expect(
      await kindOf(
        readEnpalSnapshot({
          connection: connection({ source: 'influx' }),
          fetch: fake.fetch,
          now: () => 1,
        }),
      ),
    ).toBe('unauthorized')
  })

  it('HTTP 500 -> kind bad-response', async () => {
    const fake = box({ influx: 'error500' })
    expect(
      await kindOf(
        readEnpalSnapshot({
          connection: connection({ source: 'influx' }),
          fetch: fake.fetch,
          now: () => 1,
        }),
      ),
    ).toBe('bad-response')
  })

  it('an answer with no series in the window -> kind empty, not a snapshot of nothing', async () => {
    const fake = box({ influx: 'empty' })
    expect(
      await kindOf(
        readEnpalSnapshot({
          connection: connection({ source: 'influx' }),
          fetch: fake.fetch,
          now: () => 1,
        }),
      ),
    ).toBe('empty')
  })

  it('influx source without a token -> kind token-missing, and nothing is sent', async () => {
    const fake = box({})
    expect(
      await kindOf(
        readEnpalSnapshot({
          connection: connection({ source: 'influx', token: '' }),
          fetch: fake.fetch,
          now: () => 1,
        }),
      ),
    ).toBe('token-missing')
    expect(fake.calls).toHaveLength(0)
  })

  it('a keychain marker is not a token: token-missing, nothing sent', async () => {
    const fake = box({})
    const marker = { $secret: 'secret://x/y/z', v: 1 }
    const read = readConnection({ host: '192.0.2.10', source: 'influx', token: marker })
    expect(read.tokenLocked).toBe(true)
    expect(
      await kindOf(
        readEnpalSnapshot({
          connection: read.connection,
          tokenLocked: read.tokenLocked,
          fetch: fake.fetch,
          now: () => 1,
        }),
      ),
    ).toBe('token-missing')
    expect(fake.calls).toHaveLength(0)
  })
})

describe('readEnpalSnapshot - source order', () => {
  it('auto: a rejected token falls back to the device page and says so', async () => {
    const fake = box({ influx: 'unauthorized' })
    const snap = await readEnpalSnapshot({
      connection: connection(),
      fetch: fake.fetch,
      now: () => 1,
    })
    expect(snap.source).toBe('device-page')
    expect(snap.fallbackReason?.kind).toBe('unauthorized')
    expect(snap.readings.get('Power.Consumption.Total')?.unit).toBe('kW')
  })

  it('auto without a token goes straight to the page', async () => {
    const fake = box({})
    const snap = await readEnpalSnapshot({
      connection: connection({ token: '' }),
      fetch: fake.fetch,
      now: () => 1,
    })
    expect(snap.source).toBe('device-page')
    expect(fake.calls.every((c) => !c.url.includes(':8086'))).toBe(true)
  })

  it('auto: both sources failing reports the primary (influx) failure', async () => {
    const fake = box({ influx: 'down', page: 'down' })
    expect(
      await kindOf(
        readEnpalSnapshot({ connection: connection(), fetch: fake.fetch, now: () => 1 }),
      ),
    ).toBe('unreachable')
  })

  it('page source: a page without device rows says firmware, not zero', async () => {
    const fake = box({ page: 'empty' })
    const err = await readEnpalSnapshot({
      connection: connection({ source: 'page' }),
      fetch: fake.fetch,
      now: () => 1,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EnpalError)
    expect(err instanceof EnpalError && err.kind).toBe('empty')
  })
})

describe('token hygiene', () => {
  it('the token is in no error message and no error field', async () => {
    for (const influx of ['down', 'unauthorized', 'error500', 'empty'] as const) {
      const fake = box({ influx, page: 'down' })
      const err = await readEnpalSnapshot({
        connection: connection(),
        fetch: fake.fetch,
        now: () => 1,
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(EnpalError)
      expect(JSON.stringify(err)).not.toContain(TOKEN)
      expect(String(err instanceof Error ? err.message : '')).not.toContain(TOKEN)
    }
  })

  it('the token is never put in the URL', async () => {
    const fake = box({})
    await readEnpalSnapshot({ connection: connection(), fetch: fake.fetch, now: () => 1 })
    expect(fake.calls.every((c) => !c.url.includes(TOKEN))).toBe(true)
  })
})
