/** Which key the client joins with: the instance once it exists, the node settings only before. */
import { describe, expect, it } from 'vitest'
import { effectiveCredentials } from '../tailnet-credentials.js'

const settings = { authKey: 'legacy-key', hostname: 'legacy-host' }
const record = (over: {
  enabled?: boolean
  secrets?: 'resolved' | 'unavailable'
  authKey?: string
}) => ({
  id: 'tailscale-client',
  body: { name: 'Tailscale', hostname: 'record-host', authKey: over.authKey },
  enabled: over.enabled ?? true,
  secrets: over.secrets ?? 'resolved',
})

describe('effective tailnet credentials', () => {
  it('falls back to the node settings only while no instance exists', () => {
    expect(effectiveCredentials(null, settings)).toEqual(settings)
  })

  it('the record wins once it exists, even over a leftover key in the settings', () => {
    expect(effectiveCredentials(record({ authKey: 'record-key' }), settings)).toEqual({
      authKey: 'record-key',
      hostname: 'record-host',
    })
    expect(effectiveCredentials(record({}), settings).authKey).toBe('')
  })

  it('a switched-off instance or a locked keychain offers no key to rejoin with', () => {
    expect(effectiveCredentials(record({ authKey: 'k', enabled: false }), settings).authKey).toBe(
      '',
    )
    expect(
      effectiveCredentials(record({ authKey: 'k', secrets: 'unavailable' }), settings).authKey,
    ).toBe('')
  })
})
