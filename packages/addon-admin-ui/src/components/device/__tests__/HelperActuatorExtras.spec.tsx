/**
 * A lock group on its device page (D944): locking is one tap, unlocking asks
 * first and sends `confirm: true` only after the dialog is accepted. The group
 * refuses an unconfirmed unlock on its own; this pins that the page never
 * skips the question.
 */
import { groupTemplate } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const lock = vi.fn(async () => undefined)
const unlock = vi.fn(async (_input: { deviceId: number; confirm?: boolean }) => undefined)

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useLockControlLock: () => ({ mutateAsync: lock, isPending: false }),
    useLockControlUnlock: () => ({ mutateAsync: unlock, isPending: false }),
    useDeviceManagerGetBindings: () => ({ status: 'pending', data: undefined }),
  }
})

import { HelperActuatorExtras } from '../HelperActuatorExtras'

function renderExtras(templateId: 'lock' | 'cover'): void {
  const template = groupTemplate(templateId)
  if (template === null) throw new Error('missing template')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <HelperActuatorExtras
        deviceId={900}
        template={template}
        members={[]}
        fleet={[]}
        fleetKind="answered"
        snapshot={{ kind: 'answered', caps: {} }}
        nameOf={(id) => String(id)}
      />
    </QueryClientProvider>,
  )
}

describe('lock group controls', () => {
  beforeEach(() => {
    lock.mockClear()
    unlock.mockClear()
  })
  afterEach(cleanup)

  it('locks with one tap and no confirmation', () => {
    renderExtras('lock')
    fireEvent.click(screen.getByTestId('helper-lock-all'))
    expect(lock).toHaveBeenCalledWith({ deviceId: 900 })
    expect(unlock).not.toHaveBeenCalled()
  })

  it('asks before unlocking, and sends the confirmation only after it is accepted', async () => {
    renderExtras('lock')
    fireEvent.click(screen.getByRole('button', { name: 'Unlock all' }))
    expect(unlock).not.toHaveBeenCalled()
    expect(await screen.findByText('Unlock every lock in this group?')).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: 'Unlock all' })
    const confirm = buttons[buttons.length - 1]
    if (confirm === undefined) throw new Error('no confirm button')
    fireEvent.click(confirm)
    await vi.waitFor(() => expect(unlock).toHaveBeenCalledTimes(1))
    expect(unlock).toHaveBeenCalledWith({ deviceId: 900, confirm: true })
  })

  it('a cover group has no lock buttons', () => {
    renderExtras('cover')
    expect(screen.queryByTestId('helper-lock-controls')).toBeNull()
  })
})
