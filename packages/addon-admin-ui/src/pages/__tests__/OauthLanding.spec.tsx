// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OAUTH_RETURN_DELAY_MS } from '../../lib/oauth-landing'
import { OauthLandingPage } from '../OauthLanding'

const BROKER_OK = { status: 'success', addonId: 'google-services', brokerId: 'google_001' } as const

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('OauthLandingPage', () => {
  it('a finished sign-in says so and returns to the broker page on its own', () => {
    const onContinue = vi.fn()
    render(<OauthLandingPage outcome={BROKER_OK} closable={false} onContinue={onContinue} />)
    expect(screen.getByTestId('oauth-landing-title').textContent).toBe('Signed in')
    expect(onContinue).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(OAUTH_RETURN_DELAY_MS)
    })
    expect(onContinue).toHaveBeenCalledWith(
      '/system/integrations?tab=brokers&integration=google-services',
    )
  })

  it('the button returns right away', () => {
    const onContinue = vi.fn()
    render(<OauthLandingPage outcome={BROKER_OK} closable={false} onContinue={onContinue} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back to CamStack' }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('a sign-out reads as one', () => {
    render(
      <OauthLandingPage
        outcome={{ ...BROKER_OK, action: 'disconnect' }}
        closable={false}
        onContinue={vi.fn()}
      />,
    )
    expect(screen.getByTestId('oauth-landing-title').textContent).toBe('Signed out')
  })

  it('a failure names the reason in words and does NOT return on its own', () => {
    const onContinue = vi.fn()
    render(
      <OauthLandingPage
        outcome={{ status: 'error', addonId: 'google-services', reason: 'access_denied' }}
        closable={false}
        onContinue={onContinue}
      />,
    )
    expect(screen.getByTestId('oauth-landing-title').textContent).toBe('Sign-in did not finish')
    expect(screen.getByTestId('oauth-landing-reason').textContent).toMatch(/denied/i)
    act(() => {
      vi.advanceTimersByTime(OAUTH_RETURN_DELAY_MS * 3)
    })
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('every reason code has its own wording, and an unknown one a generic line', () => {
    const texts = new Set<string>()
    for (const reason of [
      'access_denied',
      'invalid_state',
      'invalid_request',
      'unknown_broker',
      'not_configured',
      'exchange_failed',
      'no_refresh_token',
      'unavailable',
      'unknown',
    ] as const) {
      const { unmount } = render(
        <OauthLandingPage
          outcome={{ status: 'error', reason }}
          closable={false}
          onContinue={vi.fn()}
        />,
      )
      texts.add(screen.getByTestId('oauth-landing-reason').textContent ?? '')
      unmount()
    }
    expect(texts.size).toBe(9)
  })

  it('offers to close only a window that was opened as a popup', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <OauthLandingPage
        outcome={BROKER_OK}
        closable={false}
        onContinue={vi.fn()}
        onClose={onClose}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Close this window' })).toBeNull()
    rerender(
      <OauthLandingPage outcome={BROKER_OK} closable onContinue={vi.fn()} onClose={onClose} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close this window' }))
    expect(onClose).toHaveBeenCalled()
  })
})
