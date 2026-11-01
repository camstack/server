// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const describeFetch = vi.fn()
const approveMutate = vi.fn()
const denyMutate = vi.fn()

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useSystem: () => ({}),
  trpc: {
    useUtils: () => ({ auth: { cliLoginDescribe: { fetch: describeFetch } } }),
    auth: {
      cliLoginApprove: { useMutation: () => ({ mutateAsync: approveMutate }) },
      cliLoginDeny: { useMutation: () => ({ mutateAsync: denyMutate }) },
    },
  },
}))

import { CliLoginApproval, requestAge } from '../CliLoginApproval'

const VIEW = {
  requestId: 'r-1',
  ip: '203.0.113.7',
  client: 'camstack-cli/1.2',
  createdAt: Date.now() - 30_000,
  expiresAt: Date.now() + 270_000,
}

beforeEach(() => {
  describeFetch.mockReset()
  approveMutate.mockReset()
  denyMutate.mockReset()
})

describe('CliLoginApproval', () => {
  it('starts with an empty code field even when the URL carries a code', () => {
    window.history.replaceState(null, '', '/approve?code=ABCD-EFGH')
    render(<CliLoginApproval onApproved={vi.fn()} onDenied={vi.fn()} />)
    const input = screen.getByLabelText('Sign-in code') as HTMLInputElement
    expect(input.value).toBe('')
  })

  it('shows who is asking, then approves with the typed code', async () => {
    describeFetch.mockResolvedValue(VIEW)
    approveMutate.mockResolvedValue({ ok: true })
    const onApproved = vi.fn()
    render(<CliLoginApproval onApproved={onApproved} onDenied={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: 'abcd-efgh' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.getByTestId('cli-login-ip').textContent).toBe('203.0.113.7'))
    expect(screen.getByTestId('cli-login-client').textContent).toBe('camstack-cli/1.2')
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onApproved).toHaveBeenCalled())
    expect(approveMutate).toHaveBeenCalledWith({ userCode: 'abcd-efgh' })
  })

  it('deny calls the denial and not the approval', async () => {
    describeFetch.mockResolvedValue(VIEW)
    denyMutate.mockResolvedValue({ ok: true })
    const onDenied = vi.fn()
    render(<CliLoginApproval onApproved={vi.fn()} onDenied={onDenied} />)
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: 'ABCDEFGH' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByTestId('cli-login-ip')
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(onDenied).toHaveBeenCalled())
    expect(approveMutate).not.toHaveBeenCalled()
  })

  it('an unknown code is reported and nothing is approved', async () => {
    describeFetch.mockRejectedValue(new Error('No pending sign-in request with that code'))
    render(<CliLoginApproval onApproved={vi.fn()} onDenied={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: 'ZZZZ-ZZZZ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/No pending sign-in/)
    expect(approveMutate).not.toHaveBeenCalled()
  })

  it('words the request age', () => {
    expect(requestAge(1000, 2000).key).toBe('justNow')
    expect(requestAge(0, 42_000)).toEqual({ key: 'seconds', value: 42 })
    expect(requestAge(0, 180_000)).toEqual({ key: 'minutes', value: 3 })
  })
})
