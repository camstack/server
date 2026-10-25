// @vitest-environment jsdom
/**
 * An `addon-action-button` with `prompt` asks the operator for one value and
 * sends it as `input[param]` — a one-shot argument that never becomes a saved
 * setting. Cancelling the dialog runs nothing.
 */
import type { ConfigField } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialogProvider } from '../confirm-dialog'
import { FormField } from '../config-form-field'

const REMOVE: ConfigField = {
  type: 'addon-action-button',
  key: '__remove',
  label: 'Remove ids',
  addonId: 'export-alexa',
  action: 'removeAlexaEndpoints',
  buttonLabel: 'Remove ids…',
  prompt: { param: 'endpointIds', title: 'Endpoint ids', placeholder: '54, 54__privacy' },
  successMessage: 'Removed from {deliveredAccounts} account(s).',
}

function renderButton(onAction: (a: string, k: string, v?: unknown) => Promise<unknown>) {
  render(
    <ConfirmDialogProvider>
      <FormField field={REMOVE} values={{}} onChange={vi.fn()} onAction={onAction} />
    </ConfirmDialogProvider>,
  )
}

describe('addon-action-button — prompt', () => {
  it('sends the typed value as the named param and reports the result', async () => {
    const onAction = vi.fn(async () => ({ deliveredAccounts: 2 }))
    renderButton(onAction)
    fireEvent.click(screen.getByText('Remove ids…'))
    const input = await screen.findByPlaceholderText('54, 54__privacy')
    fireEvent.change(input, { target: { value: '54 54__98' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith('removeAlexaEndpoints', '__remove', {
        endpointIds: '54 54__98',
      }),
    )
    expect(await screen.findByText('Removed from 2 account(s).')).toBeTruthy()
  })

  it('runs nothing when the operator cancels', async () => {
    const onAction = vi.fn(async () => ({}))
    renderButton(onAction)
    fireEvent.click(screen.getByText('Remove ids…'))
    await screen.findByPlaceholderText('54, 54__privacy')
    fireEvent.click(screen.getByText('Cancel'))
    await waitFor(() => expect(screen.queryByPlaceholderText('54, 54__privacy')).toBeNull())
    expect(onAction).not.toHaveBeenCalled()
  })
})
