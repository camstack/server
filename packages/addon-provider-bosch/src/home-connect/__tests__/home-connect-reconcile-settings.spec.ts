import { isSecretMarker, makeSecretMarker, type IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { homeConnectSettingsGap, logHomeConnectSettingsGap } from '../config.js'

describe('homeConnectSettingsGap', () => {
  const base = { token: 'access', refresh: 'refresh-1' }

  it('returns null when connectionFromSettings succeeds', () => {
    expect(homeConnectSettingsGap(base)).toBeNull()
  })

  it('returns token-missing when the access token is absent', () => {
    expect(homeConnectSettingsGap({ refresh: 'refresh-1' })).toBe('token-missing')
  })

  it('accepts an access token without a refresh token', () => {
    expect(homeConnectSettingsGap({ token: 'access' })).toBeNull()
  })

  it('returns token-unresolved-marker when the access token is a keychain marker', () => {
    const marker = makeSecretMarker('secret://owner/integration/x/token')
    expect(isSecretMarker(marker)).toBe(true)
    expect(homeConnectSettingsGap({ token: marker, refresh: 'refresh-1' })).toBe(
      'token-unresolved-marker',
    )
  })
})

describe('logHomeConnectSettingsGap (reconcile skip warn)', () => {
  it('warns with integration diagnostics when the token is an unresolved marker', () => {
    const warn = vi.fn()
    const logger = { warn } as Pick<IScopedLogger, 'warn'>
    const integrationId = 'int-1'
    const marker = makeSecretMarker('secret://owner/integration/int-1/token')

    logHomeConnectSettingsGap(logger, integrationId, { token: marker, refresh: 'refresh-1' })

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toBe(
      'Home Connect integration has incomplete account settings — skipping',
    )
    expect(warn.mock.calls[0]?.[1]).toEqual({
      meta: {
        integrationId,
        gap: 'token-unresolved-marker',
        tokenIsSecretMarker: true,
        tokenType: 'object',
        hasToken: false,
        hasRefresh: true,
      },
    })
  })

  it('does not warn when settings are complete', () => {
    const warn = vi.fn()
    const logger = { warn } as Pick<IScopedLogger, 'warn'>
    logHomeConnectSettingsGap(logger, 'int-2', { token: 'access', refresh: 'refresh-1' })
    expect(warn).not.toHaveBeenCalled()
  })
})
