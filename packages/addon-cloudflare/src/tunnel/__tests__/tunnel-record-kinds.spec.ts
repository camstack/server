/** The `tunnels` kind: both tokens are secret paths; the record is named after the addon. */
import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_TUNNEL_DEFAULT_BODY,
  CLOUDFLARE_TUNNEL_RECORD_ID,
  CloudflareTunnelBodySchema,
  cloudflareTunnelsKind,
} from '../tunnel-record-kinds.js'

describe('cloudflareTunnelsKind', () => {
  it('marks the two tokens (and only them) as keychain secrets', () => {
    expect([...cloudflareTunnelsKind.declaration.secretPaths].sort()).toEqual([
      'customApiToken',
      'customTunnelToken',
    ])
  })

  it('is a single instance named after the addon id', () => {
    expect(CLOUDFLARE_TUNNEL_RECORD_ID).toBe('cloudflare-tunnel')
  })

  it('accepts the default body (a fresh install starts in quick mode)', () => {
    const parsed = CloudflareTunnelBodySchema.safeParse({
      name: 'x',
      ...CLOUDFLARE_TUNNEL_DEFAULT_BODY,
    })
    expect(parsed.success).toBe(true)
    expect(CLOUDFLARE_TUNNEL_DEFAULT_BODY.mode).toBe('quick')
  })

  it('keeps the origin keys out of the record (they are node settings)', () => {
    expect(Object.keys(CLOUDFLARE_TUNNEL_DEFAULT_BODY)).not.toEqual(
      expect.arrayContaining(['localHost']),
    )
    expect(Object.keys(CLOUDFLARE_TUNNEL_DEFAULT_BODY)).not.toContain('localPort')
    expect(Object.keys(CLOUDFLARE_TUNNEL_DEFAULT_BODY)).not.toContain('localPortMode')
  })
})
