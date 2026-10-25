// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@camstack/ui-library', () => ({ hubPath: (p: string) => p }))

import { SsoCompletePage } from '../SsoComplete'

const LINKED = { target: 'profile', query: 'linkError=session' } as const

describe('SsoCompletePage (D794 amendment)', () => {
  it('spins while the outcome is being handed back', () => {
    render(<SsoCompletePage completion={LINKED} result={null} />)
    expect(screen.getByText(/Finishing sign-in/)).toBeTruthy()
  })

  it('a failed link that nobody can take says why and offers to close', () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
    render(
      <SsoCompletePage
        completion={LINKED}
        result={{ kind: 'link-error', message: 'Sign in again, then link.' }}
      />,
    )
    expect(screen.getByTestId('sso-complete-result').textContent).toBe('Sign in again, then link.')
    fireEvent.click(screen.getByText('Close this window'))
    expect(close).toHaveBeenCalled()
    close.mockRestore()
  })
})
