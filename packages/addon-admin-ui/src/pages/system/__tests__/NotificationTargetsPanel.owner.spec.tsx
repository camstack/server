// @vitest-environment jsdom
/**
 * The Owner column of the notification targets list names the user, never prints a user id:
 * an unanswered user list is a skeleton, an owner the list does not know is "unknown user".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  users: [] as Array<{ id: string; username: string }>,
  hangUsers: false,
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const real = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...real,
    useInstancesOfCap: () => ({
      data: [{ id: 't1', formValues: { ownerUserId: 'usr_8f3a' } }],
    }),
    useSystem: () => ({
      trpcClient: {
        userManagement: {
          listUsers: {
            query: () =>
              state.hangUsers ? new Promise(() => undefined) : Promise.resolve(state.users),
          },
        },
        notificationOutput: { listTargetKinds: { query: () => Promise.resolve([]) } },
      },
    }),
  }
})

vi.mock('../../../components/instances/InstancesTable', () => ({
  InstancesTable: ({
    extraColumns,
  }: {
    extraColumns: ReadonlyArray<{ render: (row: unknown) => ReactElement }>
  }) => <div data-testid="owner">{extraColumns[0]?.render({ kind: 'instance', id: 't1' })}</div>,
}))

import { NotificationTargetsPanel } from '../NotificationTargetsPanel'

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationTargetsPanel />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.users = []
  state.hangUsers = false
})
afterEach(cleanup)

describe('NotificationTargetsPanel owner cell', () => {
  it('shows the username of a known owner', async () => {
    state.users = [{ id: 'usr_8f3a', username: 'giulia' }]
    renderPanel()
    await waitFor(() => expect(screen.getByTestId('owner').textContent).toBe('giulia'))
  })

  it('never prints the raw id when the owner is not in the user list', async () => {
    state.users = [{ id: 'usr_other', username: 'marco' }]
    renderPanel()
    await waitFor(() => expect(screen.getByTestId('owner').textContent).toBe('unknown user'))
    expect(screen.getByTestId('owner').textContent).not.toContain('usr_8f3a')
  })

  it('never prints the raw id while the user list has not answered', () => {
    state.hangUsers = true
    renderPanel()
    expect(screen.getByTestId('owner').textContent).not.toContain('usr_8f3a')
    expect(screen.getByTestId('owner').textContent).toBe('')
  })
})
