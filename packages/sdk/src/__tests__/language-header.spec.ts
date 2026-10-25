/**
 * D863: the client's current language rides every HTTP request as
 * `x-camstack-lang`, read per request so a language switch needs no reconnect.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { System } from '../system.js'

afterEach(() => vi.unstubAllGlobals())

function captureHeaders(): { seen: Headers[] } {
  const seen: Headers[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return new Response(JSON.stringify({ result: { data: { json: null } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return { seen }
}

describe('System language header', () => {
  it('sends x-camstack-lang from getLanguage, re-read on every request', async () => {
    const { seen } = captureHeaders()
    let lang: string | undefined = 'it'
    const sys = new System({
      serverUrl: 'http://hub.test',
      useWebSocket: false,
      getLanguage: () => lang,
    })
    await sys.logout().catch(() => undefined)
    lang = 'en'
    await sys.logout().catch(() => undefined)
    expect(seen.map((h) => h.get('x-camstack-lang'))).toEqual(['it', 'en'])
  })

  it('sends no header when no language is known', async () => {
    const { seen } = captureHeaders()
    const sys = new System({ serverUrl: 'http://hub.test', useWebSocket: false })
    await sys.logout().catch(() => undefined)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]?.has('x-camstack-lang')).toBe(false)
  })
})
