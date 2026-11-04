/**
 * The provider-instances panel: one row per instance of every provider that holds records,
 * a fixed row (with its registry switch) for a provider that has none, and three different
 * answers for loading, failed and empty. Only the cap hooks and the tRPC client are stubbed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  descriptionExtra: {} as Record<string, Record<string, unknown>>,
  setEnabled: vi.fn(),
  setInstanceEnabled: vi.fn(),
  restart: vi.fn(async (_input: unknown) => ({ ok: true as const })),
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
    useAddonsRestartAddon: () => ({
      mutateAsync: h.restart,
      mutate: h.restart,
      isPending: false,
    }),
    LogStream: ({ addonId }: { addonId: string }) => <div data-testid="log-stream">{addonId}</div>,
    EventStream: ({ addonId }: { addonId: string }) => (
      <div data-testid="event-stream">{addonId}</div>
    ),
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
                ...h.descriptionExtra[addonId],
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

vi.mock('../use-set-instance-enabled', () => ({
  useSetInstanceEnabled: () => ({
    mutate: h.setInstanceEnabled,
    isPending: false,
  }),
}))

import { ConfirmDialogProvider } from '@camstack/ui-library'
import { InstancesTable } from '../InstancesTable'

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
          <InstancesTable
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
  h.descriptionExtra = {}
  h.setEnabled.mockReset()
  h.setInstanceEnabled.mockReset()
  h.restart.mockClear()
  h.create.mockClear()
  h.update.mockClear()
  h.remove.mockClear()
  h.targets = []
  window.history.replaceState(null, '', '/')
})

describe('InstancesTable', () => {
  describe('provider kinds, status label and restore id', () => {
    beforeEach(() => {
      h.fn.data = [{ addonId: 'smtp-nodemailer', isActive: true }]
      h.holders.data = [{ addonId: 'smtp-nodemailer', isActive: true }]
      h.records = {
        'smtp-nodemailer': [
          {
            id: 'a',
            name: 'Relay A',
            configured: true,
            enabled: true,
            formValues: {},
            kind: 'k2',
            status: { state: 'ok', label: 'Signed in' },
            lastCheckedAt: 1_700_000_000_000,
          },
        ],
      }
      h.descriptionExtra = {
        'smtp-nodemailer': {
          kinds: [
            { id: 'k1', label: 'Kind one' },
            { id: 'k2', label: 'Kind two', connectPath: '/addon/x/connect/{{brokerId}}' },
          ],
          allowRestoreId: true,
          mintsId: true,
        },
      }
    })

    it('shows the kind column, the status label instead of the state, and a connect action', async () => {
      renderPanel()
      expect(await screen.findByText('Relay A')).toBeTruthy()
      expect(screen.getByText('Kind two')).toBeTruthy()
      expect(screen.getByText('Signed in')).toBeTruthy()
      expect(screen.queryByText('ok')).toBeNull()
      expect(screen.getByRole('button', { name: 'Connect Relay A' })).toBeTruthy()
    })

    it('Add asks the kind and offers restore; the provider mints the id so none is sent', async () => {
      renderPanel('?instance=smtp-nodemailer:%2B')
      expect(await screen.findByText('Add SMTP')).toBeTruthy()
      expect(await screen.findByLabelText('Kind')).toBeTruthy()
      expect(screen.getByText('Restore under its old id')).toBeTruthy()
      fireEvent.click(await screen.findByRole('button', { name: 'Create' }))
      await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1))
      const sent = h.create.mock.calls[0]?.[0] as Record<string, unknown>
      expect(sent).toMatchObject({ addonId: 'smtp-nodemailer', kind: 'k1' })
      expect(sent).not.toHaveProperty('id')
    })

    it('without the new fields Add shows no kind picker and no restore, and still mints an id', async () => {
      h.descriptionExtra = {}
      renderPanel('?instance=smtp-nodemailer:%2B')
      expect(await screen.findByText('Add SMTP')).toBeTruthy()
      expect(screen.queryByLabelText('Kind')).toBeNull()
      expect(screen.queryByText('Restore under its old id')).toBeNull()
      fireEvent.click(await screen.findByRole('button', { name: 'Create' }))
      await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1))
      expect(h.create.mock.calls[0]?.[0]).toMatchObject({
        addonId: 'smtp-nodemailer',
        id: expect.stringMatching(/^inst-/),
      })
    })
  })

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
          enabled: true,
          formValues: {},
        },
      ],
      'smtp-nodemailer': [
        {
          id: 'relay-default',
          name: 'Default relay',
          configured: true,
          enabled: true,
          formValues: {},
        },
        {
          id: 'inst-aaaaaaaa',
          name: 'Office relay',
          configured: false,
          enabled: true,
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
    // The fixed row (Winston) carries the registry switch, each record its own.
    expect(screen.getAllByRole('switch')).toHaveLength(4)
  })

  describe('sub-header pills and Add', () => {
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
        'loki-logging': [
          {
            id: 'loki-logging',
            name: 'Loki prod',
            configured: true,
            enabled: true,
            formValues: {},
          },
        ],
        'smtp-nodemailer': [
          { id: 'a', name: 'Relay A', configured: true, enabled: true, formValues: {} },
          { id: 'b', name: 'Relay B', configured: true, enabled: true, formValues: {} },
        ],
      }
    })

    it('a pill filters the table and All restores it', async () => {
      renderPanel()
      expect(await screen.findByText('Loki prod')).toBeTruthy()
      fireEvent.click(screen.getByTestId('instance-pill-smtp-nodemailer'))
      expect(screen.queryByText('Loki prod')).toBeNull()
      expect(screen.getByText('Relay A')).toBeTruthy()
      fireEvent.click(screen.getByTestId('instance-pill-all'))
      expect(screen.getByText('Loki prod')).toBeTruthy()
    })

    it('Add is offered for a multiple provider that already holds two rows, and goes straight to its form', async () => {
      renderPanel()
      await screen.findByText('Relay A')
      fireEvent.click(screen.getByTestId('instance-pill-smtp-nodemailer'))
      fireEvent.click(screen.getByRole('button', { name: /Add destination/ }))
      expect(await screen.findByText('Add SMTP')).toBeTruthy()
    })

    it('Add stays visible but disabled, with the reason, when nothing is creatable', async () => {
      h.fn.data = [{ addonId: 'loki-logging', isActive: true }]
      h.holders.data = [{ addonId: 'loki-logging', isActive: true }]
      renderPanel()
      await screen.findByText('Loki prod')
      const add = screen.getByRole('button', { name: /Add destination/ }) as HTMLButtonElement
      expect(add.disabled).toBe(true)
      expect(screen.getByText(/only one instance is allowed/)).toBeTruthy()
      // A lone provider still has its pill.
      expect(screen.getByTestId('instance-pill-loki-logging')).toBeTruthy()
    })

    it('a single provider with a row is not offered: the only creatable one opens directly', async () => {
      renderPanel()
      await screen.findByText('Relay A')
      fireEvent.click(screen.getByRole('button', { name: /Add destination/ }))
      // Loki is `single` and holds one record, so SMTP is the only choice and opens its form.
      expect(await screen.findByText('Add SMTP')).toBeTruthy()
      expect(screen.queryByText('Add loki-logging')).toBeNull()
    })
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
            enabled: true,
            formValues: { host: 'smtp.example.com', password: PASSWORD_VIEW },
          },
        ],
      }
    })

    it('add opens the picker, then the form, and creates then patches only the typed keys', async () => {
      renderPanel()
      fireEvent.click(await screen.findByRole('button', { name: /Add destination/ }))
      // Loki has no record yet and SMTP takes several: two providers, so a picker.
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: /SMTP/ }),
      )
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
      const sent = h.update.mock.calls[0]?.[0] as {
        id: string
        values: Record<string, unknown>
      }
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
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(h.remove).toHaveBeenCalledTimes(1))
      expect(h.remove.mock.calls[0]?.[0]).toEqual({
        addonId: 'smtp-nodemailer',
        id: 'relay-default',
      })
    })
  })

  describe('per-instance switch, restart and activity', () => {
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
            formValues: {},
            status: { state: 'error', detail: 'refused' },
            enabled: false,
          },
          {
            id: 'inst-aaaaaaaa',
            name: 'Office relay',
            configured: true,
            enabled: true,
            formValues: {},
          },
        ],
      }
    })

    it('the switch of a record calls setInstanceEnabled with the addon, the id and the new value', async () => {
      renderPanel()
      fireEvent.click(await screen.findByRole('switch', { name: 'Enable Office relay' }))
      expect(h.setInstanceEnabled).toHaveBeenCalledWith({
        addonId: 'smtp-nodemailer',
        id: 'inst-aaaaaaaa',
        enabled: false,
      })
    })

    it('a row that is off shows one Off badge and no error or configured badge', async () => {
      renderPanel()
      await screen.findByText('Default relay')
      expect(screen.getAllByText('Off')).toHaveLength(1)
      expect(screen.queryByText('error')).toBeNull()
      // The other record is on and keeps its Configured badge.
      expect(screen.getAllByText('Configured')).toHaveLength(1)
      const toggle = screen.getByRole('switch', {
        name: 'Enable Default relay',
      })
      expect(toggle.getAttribute('aria-checked')).toBe('false')
    })

    it('restart confirms, names the runner group, then restarts the addon', async () => {
      renderPanel()
      fireEvent.click((await screen.findAllByRole('button', { name: 'Restart SMTP' }))[0]!)
      expect(await screen.findByText(/runner group/)).toBeTruthy()
      expect(h.restart).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
      await waitFor(() => expect(h.restart).toHaveBeenCalledWith({ addonId: 'smtp-nodemailer' }))
    })

    it('activity follows the first row provider and switches with the chips', async () => {
      renderPanel()
      await waitFor(() =>
        expect(screen.getByTestId('log-stream').textContent).toBe('smtp-nodemailer'),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Events' }))
      expect(screen.getByTestId('event-stream').textContent).toBe('smtp-nodemailer')
    })

    it('says how many targets pin a relay', async () => {
      h.targets = [{ name: 'Mail ops', config: { smtpInstanceId: 'inst-aaaaaaaa' } }]
      renderPanel()
      expect(await screen.findByText('1 target pins this relay')).toBeTruthy()
    })
  })
})
