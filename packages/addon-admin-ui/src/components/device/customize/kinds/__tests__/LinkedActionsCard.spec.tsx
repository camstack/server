/**
 * Linked actions (D356): the card lists what the camera links, and a link is
 * written only for what the operator ticked.
 */
import { DeviceType } from '@dominevo/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import { CustomizeDraftProvider } from '../../customize-draft'

const CAMERA = {
  id: 103,
  name: 'Kitchen',
  addonId: 'provider-reolink',
  stableId: 'r-103',
  type: DeviceType.Camera,
  location: null,
  role: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: true,
  config: {},
}

function entry(id: string, name: string, readOnly: boolean) {
  return { id, name, readOnly, addonId: readOnly ? 'provider-homeassistant' : 'automation' }
}
const ENTRIES = [
  entry('internal:feed', 'Feed the dog', false),
  entry('internal:lock', 'Lock up', false),
  entry('ha:movie', 'Movie night', true),
]

const linkedIds = vi.hoisted((): { current: readonly string[] } => ({ current: [] }))
const stamp = vi.hoisted((): { current: number } => ({ current: 321 }))
const setLinks = vi.fn(async (_input: unknown) => ({}))
const runAction = vi.fn()

vi.mock('@dominevo/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dominevo/ui-library')>()
  return {
    ...actual,
    useActionsList: () => ({ data: ENTRIES }),
    useActionsGetLinks: () => ({
      data: { deviceId: 103, actionIds: linkedIds.current, updatedAt: stamp.current },
      refetch: vi.fn(async () => undefined),
    }),
    useActionsSetLinks: () => ({ mutateAsync: setLinks, isPending: false, error: null }),
    useActionsRun: () => ({ mutate: runAction, isPending: false }),
  }
})

import { ConfirmDialogProvider, DataTable, type DataColumn } from '@dominevo/ui-library'
import {
  LinkedActionButtons,
  LinkedActionItem,
  LinkedActionSource,
  LinkedActionValue,
  type LinkedActionTableLine,
  linkedActionTableLines,
  useLinkedActions,
} from '../LinkedActionsCard'

function Rows(): ReactElement {
  const state = useLinkedActions(CAMERA)
  const columns: readonly DataColumn<LinkedActionTableLine>[] = [
    {
      mobile: 'primary',
      key: 'item',
      header: 'Item',
      notSortableReason: 'item',
      render: (line) => <LinkedActionItem line={line} />,
    },
    {
      mobile: 'keep',
      key: 'value',
      header: 'Value',
      notSortableReason: 'value',
      render: (line) => <LinkedActionValue line={line} />,
    },
    {
      mobile: 'hidden',
      key: 'source',
      header: 'Source',
      notSortableReason: 'source',
      render: (line) => <LinkedActionSource line={line} />,
    },
    {
      mobile: 'keep',
      key: 'actions',
      header: 'Actions',
      notSortableReason: 'actions',
      render: (line) => <LinkedActionButtons line={line} state={state} />,
    },
  ]
  return (
    <>
      <DataTable
        columns={columns}
        rows={linkedActionTableLines(state)}
        rowKey={(line) => (line.kind === 'actionEntry' ? line.entry.id : line.kind)}
      />
      {state.dialog}
    </>
  )
}

function renderCard() {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <CustomizeDraftProvider order={['linked-actions']}>
          <Rows />
        </CustomizeDraftProvider>
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
}

/** The tab's one Save: nothing is written until it is pressed. */
async function pressSave(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /^Save$/i }))
}

describe('LinkedActionsCard', () => {
  beforeEach(() => {
    setLinks.mockClear()
    runAction.mockClear()
    linkedIds.current = []
    stamp.current = 321
  })

  it('shows nothing linked until the operator picks', () => {
    renderCard()
    expect(screen.getByText('None linked.')).toBeTruthy()
    expect(setLinks).not.toHaveBeenCalled()
  })

  it('links only the ticked actions, on top of the existing ones, written on Save', async () => {
    linkedIds.current = ['internal:feed']
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }))
    fireEvent.click(screen.getByText('Movie night'))
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 action' }))
    expect(setLinks).not.toHaveBeenCalled()
    await pressSave()
    await waitFor(() =>
      expect(setLinks).toHaveBeenCalledWith({
        deviceId: 103,
        actionIds: ['internal:feed', 'ha:movie'],
        expectedUpdatedAt: 321,
      }),
    )
  })

  it('unlink asks first, then is a draft: Discard brings the row back, Save writes it', async () => {
    linkedIds.current = ['internal:feed', 'internal:lock']
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Run Lock up' }))
    expect(runAction).toHaveBeenCalledWith({ actionId: 'internal:lock', deviceId: 103 })
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Feed the dog' }))
    const ask = await screen.findByRole('dialog')
    expect(ask.textContent).toContain('Feed the dog')
    fireEvent.click(within(ask).getByRole('button', { name: /remove/i }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Unlink Feed the dog' })).toBeNull(),
    )
    expect(setLinks).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: /^Discard$/i }))
    expect(screen.getByRole('button', { name: 'Unlink Feed the dog' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Feed the dog' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /remove/i }),
    )
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Unlink Feed the dog' })).toBeNull(),
    )
    await pressSave()
    await waitFor(() =>
      expect(setLinks).toHaveBeenCalledWith({
        deviceId: 103,
        actionIds: ['internal:lock'],
        expectedUpdatedAt: 321,
      }),
    )
  })

  it('a stale refusal keeps the draft and shows the reason; the next Save chains the new stamp', async () => {
    linkedIds.current = ['internal:feed', 'internal:lock']
    stamp.current = 321
    setLinks.mockRejectedValueOnce(new Error('[stale-stamp] changed since you read it'))
    const view = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Feed the dog' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /remove/i }),
    )
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Unlink Feed the dog' })).toBeNull(),
    )
    await pressSave()
    expect((await screen.findAllByText(/stale-stamp/))[0]).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Unlink Feed the dog' })).toBeNull()
    stamp.current = 400
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ConfirmDialogProvider>
          <CustomizeDraftProvider order={['linked-actions']}>
            <Rows />
          </CustomizeDraftProvider>
        </ConfirmDialogProvider>
      </QueryClientProvider>,
    )
    await pressSave()
    await waitFor(() => expect(setLinks).toHaveBeenCalledTimes(2))
    expect(setLinks.mock.calls[1]?.[0]).toMatchObject({ expectedUpdatedAt: 400 })
  })
})

describe('sameIds', () => {
  it('is order-insensitive: a reorder is not a change', async () => {
    const { sameIds } = await import('../LinkedActionsCard')
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameIds(['a'], ['a', 'b'])).toBe(false)
  })
})
