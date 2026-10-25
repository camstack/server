import { describe, expect, it, vi } from 'vitest'
import { fillBrokerConnectPath, startServerNavigation } from '../broker-oauth-popup'

describe('fillBrokerConnectPath', () => {
  it('substitutes {{brokerId}} and encodes the id', () => {
    expect(
      fillBrokerConnectPath(
        '/addon/google-services/oauth/start?brokerId={{brokerId}}',
        'google_001',
      ),
    ).toBe('/addon/google-services/oauth/start?brokerId=google_001')
  })

  it('encodes reserved characters in the broker id', () => {
    expect(fillBrokerConnectPath('?brokerId={{brokerId}}', 'a/b c')).toBe('?brokerId=a%2Fb%20c')
  })
})

describe('startServerNavigation', () => {
  it('opens the server route in the sign-in popup, flagged as a popup flow', () => {
    const popup = { closed: false } as unknown as Window
    const open = vi.fn(() => popup)
    const assign = vi.fn()
    startServerNavigation('/addon/google-services/oauth/start?brokerId=g1', undefined, {
      open,
      assign,
      watch: vi.fn(),
    })
    expect(open).toHaveBeenCalledWith('/addon/google-services/oauth/start?brokerId=g1&popup=1')
    expect(assign).not.toHaveBeenCalled()
  })

  it('falls back to a full-page navigation when the popup is blocked (PWA)', () => {
    const assign = vi.fn()
    startServerNavigation('/addon/google-services/oauth/start?brokerId=g1', undefined, {
      open: () => null,
      assign,
      watch: vi.fn(),
    })
    expect(assign).toHaveBeenCalledWith('/addon/google-services/oauth/start?brokerId=g1&popup=1')
  })

  it('reports the popup outcome to the caller so it can refresh', () => {
    const onSettled = vi.fn()
    const popup = { closed: false } as unknown as Window
    let deliver: (r: { ok: boolean }) => void = () => {}
    startServerNavigation('/addon/x/oauth/start', onSettled, {
      open: () => popup,
      assign: vi.fn(),
      watch: (_p, cb) => {
        deliver = cb
        return () => {}
      },
    })
    deliver({ ok: true })
    expect(onSettled).toHaveBeenCalledWith({ ok: true })
  })
})
