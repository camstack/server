/**
 * A dialog lead (the part above the form) never writes the record (planning#675): its edits
 * travel with the dialog's own "Save changes", merged with the form's. The last edit of a key
 * wins, the lead reads the record's live values, and closing drops the draft.
 */
import { selectOption } from '@camstack/ui-library/testing'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../brokers/__tests__/setup'

const mockUpdate = vi.hoisted(() => vi.fn(async (_input: unknown) => ({})))

const FORM = {
  sections: [
    {
      id: 'account',
      title: 'Account',
      columns: 1,
      fields: [
        {
          type: 'select',
          key: 'region',
          label: 'Region',
          options: ['eu', 'us', 'ap'].map((value) => ({ value, label: value })),
          default: 'eu',
        },
      ],
    },
  ],
}

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        integrationInstances: {
          instanceFormSchema: { query: async () => FORM },
          updateInstance: { mutate: mockUpdate },
        },
      },
    }),
  }
})

import { InstanceEditorDialog } from '../InstanceEditorDialog'
import { useInstanceLeadDraft } from '../instance-lead-draft'

/** A lead that sets its own key and the form's `region`, and shows the live region it reads. */
function TestLead() {
  const { values, patch } = useInstanceLeadDraft()
  return (
    <div>
      <button type="button" onClick={() => patch({ model: 'm1' })}>
        lead-model
      </button>
      <button type="button" onClick={() => patch({ region: 'ap' })}>
        lead-region
      </button>
      <span data-testid="live-region">{String(values.region)}</span>
    </div>
  )
}

const instance = {
  id: 'p1',
  name: 'Profile',
  kind: 'k',
  enabled: true,
  configured: true,
  status: { state: 'ok', label: 'Connected' },
  formValues: { region: 'eu', model: 'old' },
} as const

function Dialog({ onClose }: { readonly onClose: () => void }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <InstanceEditorDialog
        addonId="ai"
        providerName="AI"
        description={{
          role: 'devices',
          instanceMode: 'multiple',
          kind: 'account',
          canTest: false,
          kinds: [{ id: 'k', label: 'K', functionCap: 'broker' }],
        }}
        instance={instance}
        onClose={onClose}
        lead={<TestLead />}
      />
    </QueryClientProvider>
  )
}

afterEach(() => mockUpdate.mockClear())

describe('InstanceEditorDialog — lead draft', () => {
  it('a lead edit and a form edit travel in ONE updateInstance', async () => {
    render(<Dialog onClose={() => {}} />)
    const region = (await screen.findByLabelText('Region')) as HTMLButtonElement
    fireEvent.click(screen.getByText('lead-model'))
    selectOption(region, 'us')
    expect(mockUpdate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', values: { region: 'us', model: 'm1' } }),
    )
  })

  it('a form edit made AFTER the lead edit of the same key wins, and the lead reads it live', async () => {
    render(<Dialog onClose={() => {}} />)
    const region = (await screen.findByLabelText('Region')) as HTMLButtonElement
    fireEvent.click(screen.getByText('lead-region'))
    await waitFor(() => expect(screen.getByTestId('live-region').textContent).toBe('ap'))
    selectOption(region, 'us')
    await waitFor(() => expect(screen.getByTestId('live-region').textContent).toBe('us'))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ values: { region: 'us' } }))
  })

  it('closing writes nothing and the lead draft is gone when the dialog opens again', async () => {
    const onClose = vi.fn()
    const view = render(<Dialog onClose={onClose} />)
    await screen.findByLabelText('Region')
    fireEvent.click(screen.getByText('lead-model'))
    fireEvent.click(screen.getByRole('button', { name: /cancel|close/i }))
    expect(onClose).toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    // The table unmounts the dialog on close; opening it again starts from the server state.
    view.unmount()
    render(<Dialog onClose={() => {}} />)
    await screen.findByLabelText('Region')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ values: {} }))
  })
})
