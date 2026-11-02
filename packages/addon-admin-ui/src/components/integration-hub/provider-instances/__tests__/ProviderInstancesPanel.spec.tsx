/**
 * The provider-instances panel: one row per instance of every provider that holds records,
 * a fixed row (with its registry switch) for a provider that has none, and three different
 * answers for loading, failed and empty. Only the cap hooks and the tRPC client are stubbed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConfigUISchema } from '@camstack/types'
import { Mail } from 'lucide-react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface ProviderRow {
  addonId: string
  isActive: boolean
}

const h = vi.hoisted(() => ({
  fn: { data: [] as ProviderRow[] | undefined, error: null as Error | null },
  holders: {
    data: [] as ProviderRow[] | undefined,
    error: null as Error | null,
  },
  records: {} as Record<string, unknown[]>,
  describeFails: false,
  setEnabled: vi.fn(),
  create: vi.fn(async (_input: unknown) => ({ id: 'x' })),
  update: vi.fn(async (_input: unknown) => ({ ok: true as const })),
  remove: vi.fn(async (_input: unknown) => ({ ok: true as const })),
  targets: [] as { name: string; config: Record<string, unknown> }[],
}))

const FORM: ConfigUISchema = {
  sections: [
    {
      id: 'smtp',
      title: 'Relay',
      columns: 2,
      fields: [
        { type: 'text', key: 'host', label: 'Host', default: '' },
        { type: 'password', key: 'password', label: 'Password' },
      ],
    },
  ],
}

const PASSWORD_VIEW = { $secret: 'ref', v: 1, set: true }

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const query = (slot: { data: ProviderRow[] | undefined; error: Error | null }) => ({
    data: slot.data,
    error: slot.error,
    isPending: slot.data === undefined && slot.error === null,
    isError: slot.error !== null,
    refetch: vi.fn(),
  })
  return {
    ...actual,
    useAddonsListCapabilityProviders: (input: { capName: string }) =>
      query(input.capName === 'integration-instances' ? h.holders : h.fn),
    useAddonsList: () => ({
      data: [
        {
          manifest: {
            id: 'winston-logging',
            name: 'Winston',
            description: 'Rotated files',
          },
        },
        { manifest: { id: 'loki-logging', name: 'Loki' } },
        { manifest: { id: 'smtp-nodemailer', name: 'SMTP' } },
      ],
    }),
    useAddonsSetCapabilityProviderEnabled: () => ({
      mutate: h.setEnabled,
      isPending: false,
    }),
    useSystem: () => ({
      trpcClient: {
        integrationInstances: {
          describe: {
            query: async ({ addonId }: { addonId: string }) => {
              if (h.describeFails) throw new Error('describe failed')
              return {
                instanceMode: addonId === 'loki-logging' ? 'single' : 'multiple',
                kind: 'x',
                canTest: true,
              }
            },
          },
          listInstances: {
            query: async ({ addonId }: { addonId: string }) => h.records[addonId],
          },
          instanceFormSchema: { query: async () => FORM },
          createInstance: { mutate: h.create },
          updateInstance: { mutate: h.update },
          deleteInstance: { mutate: h.remove },
        },
        notificationOutput: { listTargets: { query: async () => h.targets } },
      },
    }),
  }
})

import { ConfirmDialogProvider } from '@camstack/ui-library'
import { ProviderInstancesPanel } from '../ProviderInstancesPanel'

function renderPanel(search = '') {
  // The open dialog lives in the real URL (`useUrlQueryParam` reads `window.location`).
  window.history.replaceState(null, '', `/${search}`)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConfirmDialogProvider>
          <ProviderInstancesPanel
            functionCap="log-destination"
            icon={Mail}
            title="Destinations"
            subtitle="Every destination."
            emptyTitle="Nothing configured"
            emptyDescription="Add one."
            addLabel="Add destination"
          />
        </ConfirmDialogProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  h.fn = { data: [], error: null }
  h.holders = { data: [], error: null }
  h.records = {}
  h.describeFails = false
  h.setEnabled.mockReset()
  h.create.mockClear()
  h.update.mockClear()
  h.remove.mockClear()
  h.targets = []
  window.history.replaceState(null, '', '/')
})

describe('ProviderInstancesPanel', () => {
  it('lists an instance row per record of two providers, and a fixed row with a switch', async () => {
    h.fn.data = [
      { addonId: 'winston-logging', isActive: true },
      { addonId: 'loki-logging', isActive: true },
      { addonId: 'smtp-nodemailer', isActive: true },
    ]
    h.holders.data = [
      { addonId: 'loki-logging', isActive: true },
      { addonId: 'smtp-nodemailer', isActive: true },
    ]
    h.records = {
      'loki-logging': [
        {
          id: 'loki-logging',
          name: 'Loki prod',
          configured: true,
          formValues: {},
        },
      ],
      'smtp-nodemailer': [
        {
          id: 'relay-default',
          name: 'Default relay',
          configured: true,
          formValues: {},
        },
        {
          id: 'inst-aaaaaaaa',
          name: 'Office relay',
          configured: false,
          formValues: {},
        },
      ],
    }
    renderPanel()
    expect(await screen.findByText('Loki prod')).toBeTruthy()
    expect(screen.getByText('Default relay')).toBeTruthy()
    expect(screen.getByText('Office relay')).toBeTruthy()
    expect(screen.getByText('Not configured')).toBeTruthy()
    expect(screen.getByText('Rotated files')).toBeTruthy()
    // Only the fixed row (Winston) carries the registry switch.
    expect(screen.getAllByRole('switch')).toHaveLength(1)
  })

  it('shows no empty text while a query is still unanswered', () => {
    h.fn.data = undefined
    renderPanel()
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('Nothing configured')).toBeNull()
  })

  it('shows the empty state only once every query answered with nothing', async () => {
    renderPanel()
    expect(await screen.findByText('Nothing configured')).toBeTruthy()
  })

  it('shows an error box, not the empty state, when a query failed', async () => {
    h.fn.data = [{ addonId: 'loki-logging', isActive: true }]
    h.holders.data = [{ addonId: 'loki-logging', isActive: true }]
    h.describeFails = true
    renderPanel()
    await waitFor(() => expect(screen.getByText('Could not load the list')).toBeTruthy())
    expect(screen.getByText('describe failed')).toBeTruthy()
    expect(screen.queryByText('Nothing configured')).toBeNull()
  })

  describe('with instances', () => {
    beforeEach(() => {
      h.fn.data = [
        { addonId: 'loki-logging', isActive: true },
        { addonId: 'smtp-nodemailer', isActive: true },
      ]
      h.holders.data = [
        { addonId: 'loki-logging', isActive: true },
        { addonId: 'smtp-nodemailer', isActive: true },
      ]
      h.records = {
        'loki-logging': [],
        'smtp-nodemailer': [
          {
            id: 'relay-default',
            name: 'Default relay',
            configured: true,
            formValues: { host: 'smtp.example.com', password: PASSWORD_VIEW },
          },
        ],
      }
    })

    it('add opens the picker, then the form, and creates then patches only the typed keys', async () => {
      renderPanel()
      fireEvent.click(await screen.findByRole('button', { name: /Add destination/ }))
      // Loki has no record yet and SMTP takes several: two providers, so a picker.
      fireEvent.click(await screen.findByRole('button', { name: /SMTP/ }))
      // The form's labels are not bound to their inputs: the empty text input is Host.
      await screen.findByDisplayValue('SMTP')
      const host = await waitFor(() => {
        const empty = screen
          .getAllByDisplayValue('')
          .find((el) => el.getAttribute('type') === 'text')
        if (empty === undefined) throw new Error('form not drawn yet')
        return empty
      })
      fireEvent.change(host, { target: { value: 'mail.example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
      await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1))
      expect(h.create.mock.calls[0]?.[0]).toMatchObject({
        addonId: 'smtp-nodemailer',
        id: expect.stringMatching(/^inst-[0-9a-f]{8}$/),
        name: 'SMTP',
      })
      await waitFor(() => expect(h.update).toHaveBeenCalledTimes(1))
      expect(h.update.mock.calls[0]?.[0]).toMatchObject({
        addonId: 'smtp-nodemailer',
        values: { host: 'mail.example.com' },
      })
      const patch = h.update.mock.calls[0]?.[0] as { values: object }
      expect(Object.keys(patch.values)).toEqual(['host'])
    })

    it('editing a record with a stored password sends no password', async () => {
      renderPanel('?instance=smtp-nodemailer:relay-default')
      const host = await screen.findByDisplayValue('smtp.example.com')
      fireEvent.change(host, { target: { value: 'mail2.example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
      await waitFor(() => expect(h.update).toHaveBeenCalledTimes(1))
      const sent = h.update.mock.calls[0]?.[0] as { id: string; values: Record<string, unknown> }
      expect(sent.id).toBe('relay-default')
      expect(sent.values).toEqual({ host: 'mail2.example.com' })
      expect('password' in sent.values).toBe(false)
    })

    it('delete asks first, and names the notification targets that pin the relay', async () => {
      h.targets = [{ name: 'Mail ops', config: { smtpInstanceId: 'relay-default' } }]
      renderPanel()
      fireEvent.click(await screen.findByRole('button', { name: 'Delete Default relay' }))
      expect(await screen.findByText(/Mail ops/)).toBeTruthy()
      expect(h.remove).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(h.remove).toHaveBeenCalledTimes(1))
      expect(h.remove.mock.calls[0]?.[0]).toEqual({
        addonId: 'smtp-nodemailer',
        id: 'relay-default',
      })
    })
  })
})
