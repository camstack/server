// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConfirmDialogProvider, useConfirm } from '../confirm-dialog'

interface TriggerProps {
  readonly action: () => Promise<unknown>
  readonly onDone: (accepted: boolean) => void
}

function Trigger({ action, onDone }: TriggerProps) {
  const confirm = useConfirm()
  return (
    <button
      type="button"
      onClick={() =>
        void confirm({
          title: 'Delete it?',
          message: 'm',
          confirmLabel: 'Do it',
          variant: 'danger',
          action,
        }).then(onDone)
      }
    >
      open
    </button>
  )
}

describe('useConfirm — action', () => {
  it('stays open and busy while the action runs, resolves true after', async () => {
    let finish!: () => void
    const action = () =>
      new Promise<void>((r) => {
        finish = r
      })
    const results: boolean[] = []
    render(
      <ConfirmDialogProvider>
        <Trigger action={action} onDone={(r) => results.push(r)} />
      </ConfirmDialogProvider>,
    )
    fireEvent.click(screen.getByText('open'))
    fireEvent.click(await screen.findByText('Do it'))
    const btn = screen.getByText('Do it').closest('button')
    expect(btn?.getAttribute('aria-busy')).toBe('true')
    expect(btn?.disabled).toBe(true)
    expect(results).toEqual([])
    finish()
    await waitFor(() => expect(results).toEqual([true]))
    expect(screen.queryByText('Do it')).toBeNull()
  })

  it('a failure is shown in the dialog, which stays open', async () => {
    const results: boolean[] = []
    render(
      <ConfirmDialogProvider>
        <Trigger action={() => Promise.reject(new Error('nope'))} onDone={(r) => results.push(r)} />
      </ConfirmDialogProvider>,
    )
    fireEvent.click(screen.getByText('open'))
    fireEvent.click(await screen.findByText('Do it'))
    expect((await screen.findByRole('alert')).textContent).toBe('nope')
    expect(screen.getByText('Do it')).toBeTruthy()
    expect(results).toEqual([])
  })
})
