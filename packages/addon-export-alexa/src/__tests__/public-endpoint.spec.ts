/**
 * The hub's public origin is the `publicEndpoint` role of the local-network palette, read on
 * every use. A role that resolves to nothing, and a read that fails, are typed refusals that
 * name the Network page; there is no loopback or LAN substitute.
 */
import { describe, expect, it } from 'vitest'
import {
  createPublicEndpointReader,
  NO_PUBLIC_ENDPOINT_REASON,
  PUBLIC_ENDPOINT_UNREADABLE_REASON,
  resolvePublicEndpoint,
} from '../public-endpoint.js'

const book = (resolved: string | null) => ({
  roles: { publicEndpoint: { resolved } },
})

describe('resolvePublicEndpoint', () => {
  it('returns the role origin without trailing slashes', () => {
    expect(resolvePublicEndpoint(book('https://hub.example.org///'))).toEqual({
      ok: true,
      origin: 'https://hub.example.org',
    })
  })

  it('refuses with the typed reason when the role resolves to nothing', () => {
    expect(resolvePublicEndpoint(book(null))).toEqual({
      ok: false,
      reason: NO_PUBLIC_ENDPOINT_REASON,
    })
    expect(resolvePublicEndpoint(book('  '))).toEqual({
      ok: false,
      reason: NO_PUBLIC_ENDPOINT_REASON,
    })
  })

  it('names the Network page in the refusal', () => {
    expect(NO_PUBLIC_ENDPOINT_REASON.code).toBe('no-public-endpoint')
    expect(NO_PUBLIC_ENDPOINT_REASON.message).toContain('Network page')
  })
})

describe('createPublicEndpointReader', () => {
  it('reads the palette on every call, never memoised', async () => {
    let answer: string | null = 'https://a.example.org'
    let reads = 0
    const read = createPublicEndpointReader(async () => {
      reads += 1
      return book(answer)
    })
    expect(await read()).toEqual({ ok: true, origin: 'https://a.example.org' })
    answer = 'https://b.example.org'
    expect(await read()).toEqual({ ok: true, origin: 'https://b.example.org' })
    expect(reads).toBe(2)
  })

  it('a failing read is the unreadable refusal, not an exception', async () => {
    const read = createPublicEndpointReader(async () => {
      throw new Error('registry down')
    })
    expect(await read()).toEqual({
      ok: false,
      reason: PUBLIC_ENDPOINT_UNREADABLE_REASON,
    })
  })
})
