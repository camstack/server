// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const reauthenticate = vi.fn()
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn() }))
vi.mock('@camstack/ui-library', () => ({
  useSystem: () => ({ reauthenticate, reauthBeginPasskey: vi.fn() }),
  Dialog: ({ open, children }: { open: boolean; children: unknown }) =>
    open ? <div role="dialog">{children as never}</div> : null,
  DialogContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogHeader: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogTitle: ({ children }: { children: unknown }) => <h2>{children as never}</h2>,
  DialogDescription: ({ children }: { children: unknown }) => <p>{children as never}</p>,
  DialogFooter: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  Button: (props: Record<string, unknown>) => <button {...props} />,
  Input: (props: Record<string, unknown>) => <input {...props} />,
}))

import { useReauthPrompt } from '../ReauthDialog'

let outcome: string | null | undefined
function Harness() {
  const { requestProof, dialog } = useReauthPrompt('Turning off 2FA')
  return (
    <div>
      <button
        onClick={() => {
          void requestProof().then((p) => {
            outcome = p
          })
        }}
      >
        go
      </button>
      {dialog}
    </div>
  )
}

describe('useReauthPrompt', () => {
  it('asks for the password and resolves with the hub’s proof', async () => {
    outcome = undefined
    reauthenticate.mockResolvedValueOnce({
      reauthToken: 'proof-xyz',
      expiresAt: 1,
      method: 'password',
    })
    render(<Harness />)
    fireEvent.click(screen.getByText('go'))
    expect(screen.getByRole('dialog').textContent).toContain('Turning off 2FA')
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'pw' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Confirm'))
    })
    expect(reauthenticate).toHaveBeenCalledWith({ password: 'pw' })
    await waitFor(() => expect(outcome).toBe('proof-xyz'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a wrong password keeps the dialog open with the error', async () => {
    reauthenticate.mockRejectedValueOnce(new Error('Password is incorrect'))
    render(<Harness />)
    fireEvent.click(screen.getByText('go'))
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'bad' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Confirm'))
    })
    expect(screen.getByRole('alert').textContent).toContain('Password is incorrect')
  })
})
