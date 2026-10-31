// @vitest-environment jsdom
/**
 * The first-run password change (D728 seed admin / changeme).
 *
 * The forced page used to call the ADMIN reset (`userManagement.resetPassword`),
 * which ends every session of the user — the caller's own included, socket and
 * all. The request died under the operator ("Unknown error"), he was signed out,
 * and the new password was already stored. The page must change the caller's
 * OWN password (`auth.changeOwnPassword`), which keeps this session.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { changeOwnPasswordMock, resetMutateMock, navigateMock, clearMock, auth } = vi.hoisted(
  () => ({
    changeOwnPasswordMock: vi.fn(),
    resetMutateMock: vi.fn(),
    navigateMock: vi.fn(),
    clearMock: vi.fn(),
    auth: { mustChangePassword: true },
  }),
)

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    Button: actual.Button,
    Input: actual.Input,
    Select: actual.Select,
    FileInput: actual.FileInput,
    Textarea: actual.Textarea,
    Checkbox: actual.Checkbox,
    Slider: actual.Slider,
    Radio: actual.Radio,
    useThemeMode: () => ({ resolvedMode: 'dark' }),
    useSystem: () => ({ changeOwnPassword: changeOwnPasswordMock }),
    useUserManagementResetPassword: () => ({ mutate: resetMutateMock, isPending: false }),
    hubPath: (p: string) => p,
  }
})

vi.mock('../../contexts/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'u-admin-0001', username: 'admin', isAdmin: true, exp: 0, scopes: [] },
    mustChangePassword: auth.mustChangePassword,
    clearMustChangePassword: clearMock,
    logout: vi.fn(),
  }),
}))

import { ChangePasswordPage } from '../ChangePassword'

const NEW_PASSWORD = 'n3w-secret-pw'

function fillAndSubmit(): void {
  fireEvent.change(screen.getByTestId('change-password-new'), {
    target: { value: NEW_PASSWORD },
  })
  fireEvent.change(screen.getByTestId('change-password-confirm'), {
    target: { value: NEW_PASSWORD },
  })
  fireEvent.click(screen.getByTestId('change-password-submit'))
}

class FakeTrpcError extends Error {
  readonly data: unknown
  constructor(message: string, data: unknown) {
    super(message)
    this.data = data
  }
}

beforeEach(() => {
  auth.mustChangePassword = true
  changeOwnPasswordMock.mockReset()
  changeOwnPasswordMock.mockResolvedValue({ success: true })
  resetMutateMock.mockReset()
  navigateMock.mockReset()
  clearMock.mockReset()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ChangePasswordPage — first run', () => {
  it('changes the caller OWN password (keeps this session), never the admin reset', async () => {
    render(<ChangePasswordPage />)
    fillAndSubmit()
    await waitFor(() => expect(changeOwnPasswordMock).toHaveBeenCalledTimes(1))
    expect(changeOwnPasswordMock).toHaveBeenCalledWith({
      currentPassword: 'changeme',
      newPassword: NEW_PASSWORD,
    })
    expect(resetMutateMock).not.toHaveBeenCalled()
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/devices', { replace: true }))
    expect(clearMock).toHaveBeenCalledTimes(1)
  })

  it('a lost connection is named as such, never "Unknown error"', async () => {
    changeOwnPasswordMock.mockRejectedValue(new FakeTrpcError('Unknown error', undefined))
    render(<ChangePasswordPage />)
    fillAndSubmit()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toMatch(/unknown error/i)
    expect(alert.textContent).toMatch(/connection/i)
    expect(navigateMock).not.toHaveBeenCalled()
    expect(clearMock).not.toHaveBeenCalled()
  })
})

describe('ChangePasswordPage — a voluntary change', () => {
  it('asks for the current password and sends it', async () => {
    auth.mustChangePassword = false
    render(<ChangePasswordPage />)
    fireEvent.change(screen.getByTestId('change-password-current'), {
      target: { value: 'old-pw-123' },
    })
    fillAndSubmit()
    await waitFor(() =>
      expect(changeOwnPasswordMock).toHaveBeenCalledWith({
        currentPassword: 'old-pw-123',
        newPassword: NEW_PASSWORD,
      }),
    )
  })

  it('a wrong current password says so', async () => {
    auth.mustChangePassword = false
    changeOwnPasswordMock.mockRejectedValue(
      new FakeTrpcError('Password is incorrect', {
        code: 'INTERNAL_SERVER_ERROR',
        i18n: { code: 'auth.password-incorrect' },
      }),
    )
    render(<ChangePasswordPage />)
    fireEvent.change(screen.getByTestId('change-password-current'), {
      target: { value: 'wrong-pw-123' },
    })
    fillAndSubmit()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/current password is incorrect/i)
  })
})
