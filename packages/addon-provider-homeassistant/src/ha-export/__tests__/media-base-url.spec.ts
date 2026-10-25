/**
 * Home Assistant pulls images from the hub over the LAN, so the media base
 * is the hub's `internal` role (D734) — never the public endpoint the
 * notification links and sign-in use.
 */
import { describe, expect, it } from 'vitest'
import { haMediaBaseUrl } from '../media-url.js'

describe('haMediaBaseUrl', () => {
  it('is the internal address, even when a public endpoint is set', () => {
    const book = {
      roles: {
        internal: { resolved: 'http://192.0.2.10:4480' },
        publicEndpoint: { resolved: 'https://cams.example.org' },
      },
    }
    expect(haMediaBaseUrl(book)).toBe('http://192.0.2.10:4480')
  })

  it('is null when nothing qualifies — never a loopback substitute', () => {
    expect(haMediaBaseUrl({ roles: { internal: { resolved: null } } })).toBeNull()
  })
})
