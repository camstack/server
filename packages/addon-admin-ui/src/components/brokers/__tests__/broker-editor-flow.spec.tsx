/**
 * D950: ONE dialog creates or edits a broker for every caller. `BrokerEditorDialog` is a thin
 * wrapper over the instances editor, and `BrokerPicker` ("Create new…") and the wizard's broker
 * step open it stacked over their caller. Fakes stand in for the `broker` list hooks and the
 * `integration-instances` client; the specs pin
 *   - every kind's create path through the same dialog, routed to its owning provider,
 *   - `onSaved(id)` with the id the provider minted (and the stored id on edit),
 *   - the stacked-modal return (new broker preselected, caller state kept, cancel),
 *   - a kind that declares a sign-in offers it in the same dialog.
 */
import { useState, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './setup'

const h = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  nextId: 'new_1',
  brokers: [] as Array<Record<string, unknown>>,
  providers: [] as Array<Record<string, unknown>>,
  descriptions: {} as Record<string, Record<string, unknown>>,
  instances: {} as Record<string, Record<string, unknown>>,
}))

const FORM = {
  sections: [
    {
      id: 'conn',
      title: 'Conn',
      columns: 1,
      fields: [{ type: 'text', key: 'host', label: 'Host', placeholder: 'broker host' }],
    },
  ],
}

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useBrokerList: (input: { kind?: string }) => ({
      data: h.brokers.filter((b) => input.kind === undefined || b.kind === input.kind),
      isLoading: false,
      isError: false,
    }),
    useBrokerListProviders: () => ({ data: h.providers, isLoading: false }),
    useSystem: () => ({
      trpcClient: {
        integrationInstances: {
          describe: { query: async ({ addonId }: { addonId: string }) => h.descriptions[addonId] },
          getInstance: {
            query: async ({ id }: { id: string }) => h.instances[id] ?? null,
          },
          instanceFormSchema: { query: async () => FORM },
          createInstance: {
            mutate: async (input: unknown) => {
              h.create(input)
              return { id: h.nextId }
            },
          },
          updateInstance: {
            mutate: async (input: unknown) => {
              h.update(input)
              return { ok: true }
            },
          },
          testInstance: { mutate: async () => ({ success: true, status: 'validated' }) },
        },
      },
    }),
  }
})

import { BrokerEditorDialog } from '../BrokerEditorDialog'
import { BrokerPicker } from '../BrokerPicker'

const KINDS: ReadonlyArray<readonly [string, string, string]> = [
  ['home-assistant', 'provider-homeassistant', 'Home Assistant'],
  ['mqtt', 'mqtt-broker', 'MQTT'],
  ['alexa', 'import-alexa', 'Alexa'],
  ['matter', 'matter-broker', 'Matter'],
  ['google', 'google-services', 'Google'],
]

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  h.create.mockReset()
  h.update.mockReset()
  h.nextId = 'new_1'
  h.brokers = []
  h.instances = {}
  h.providers = KINDS.map(([kind, addonId, label]) => ({ addonId, kinds: [{ kind, label }] }))
  h.descriptions = Object.fromEntries(
    KINDS.map(([kind, addonId, label]) => [
      addonId,
      {
        instanceMode: 'multiple',
        kind: 'account',
        canTest: true,
        mintsId: true,
        kinds: [{ id: kind, label }],
      },
    ]),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BrokerEditorDialog — create, every kind through the same dialog', () => {
  it.each(KINDS)('%s is created through its owning provider', async (kind, addonId, label) => {
    const onSaved = vi.fn()
    renderWithClient(<BrokerEditorDialog kind={kind} onClose={() => {}} onSaved={onSaved} />)

    fireEvent.change(await screen.findByPlaceholderText('broker host'), {
      target: { value: 'broker.local' },
    })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('new_1'))
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ addonId, name: label, kind }))
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ addonId, id: 'new_1', values: { host: 'broker.local' } }),
    )
  })

  it('a provider scoped by addonId creates there even when the kind is not given', async () => {
    const onSaved = vi.fn()
    renderWithClient(
      <BrokerEditorDialog addonId="mqtt-broker" onClose={() => {}} onSaved={onSaved} />,
    )
    await screen.findByPlaceholderText('broker host')
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('new_1'))
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ addonId: 'mqtt-broker' }))
  })
})

describe('BrokerEditorDialog — edit', () => {
  it('saves the stored record back through its owner and reports its id', async () => {
    const onSaved = vi.fn()
    h.instances = {
      mq_1: {
        id: 'mq_1',
        name: 'Casa',
        kind: 'mqtt',
        enabled: true,
        configured: true,
        status: { state: 'ok', label: 'Connected' },
        formValues: { host: 'old.local' },
      },
    }
    const broker = {
      id: 'mq_1',
      addonId: 'mqtt-broker',
      name: 'Casa',
      kind: 'mqtt',
      status: 'connected',
      info: {},
      lastCheckedAt: null,
      error: null,
    } as const
    renderWithClient(<BrokerEditorDialog broker={broker} onClose={() => {}} onSaved={onSaved} />)
    const host = (await screen.findByPlaceholderText('broker host')) as HTMLInputElement
    await waitFor(() => expect(host.value).toBe('old.local'))
    fireEvent.change(host, { target: { value: 'new.local' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('mq_1'))
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        addonId: 'mqtt-broker',
        id: 'mq_1',
        values: { host: 'new.local' },
      }),
    )
  })
})

describe('BrokerEditorDialog — a kind that declares a sign-in', () => {
  it('offers it inside the same dialog', async () => {
    h.providers = [{ addonId: 'import-alexa', kinds: [{ kind: 'alexa', label: 'Alexa' }] }]
    h.descriptions = {
      'import-alexa': {
        instanceMode: 'multiple',
        kind: 'account',
        canTest: true,
        mintsId: true,
        kinds: [
          {
            id: 'alexa',
            label: 'Alexa',
            signIn: { basePath: '/addon/import-alexa/login', methods: ['device-code', 'proxy'] },
          },
        ],
      },
    }
    renderWithClient(<BrokerEditorDialog kind="alexa" onClose={() => {}} onSaved={() => {}} />)
    expect(await screen.findByRole('tab', { name: /device code/i })).toBeTruthy()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })
})

function Host({ onChange }: { readonly onChange: (id: string | null) => void }): ReactElement {
  const [value, setValue] = useState<string | null>(null)
  const [note, setNote] = useState('')
  return (
    <div>
      <input aria-label="note" value={note} onChange={(e) => setNote(e.target.value)} />
      <span data-testid="picked">{value ?? 'none'}</span>
      <BrokerPicker
        kind="mqtt"
        value={value}
        onChange={(id) => {
          setValue(id)
          onChange(id)
        }}
      />
    </div>
  )
}

describe('BrokerPicker — Create new… stacks the broker dialog over the caller', () => {
  it('returns with the new broker selected and the caller state intact', async () => {
    const onChange = vi.fn()
    h.nextId = 'mq_new'
    renderWithClient(<Host onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('note'), { target: { value: 'draft in progress' } })

    fireEvent.click(screen.getByRole('button', { name: /create new/i }))
    fireEvent.change(await screen.findByPlaceholderText('broker host'), {
      target: { value: 'mqtt.local' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(screen.getByTestId('picked').textContent).toBe('mq_new'))
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mqtt', addonId: 'mqtt-broker' }),
    )
    expect((screen.getByLabelText('note') as HTMLInputElement).value).toBe('draft in progress')
    expect(screen.queryByPlaceholderText('broker host')).toBeNull()
  })

  it('cancel returns unchanged', async () => {
    const onChange = vi.fn()
    renderWithClient(<Host onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /create new/i }))
    await screen.findByPlaceholderText('broker host')
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onChange).not.toHaveBeenCalled()
    expect(h.create).not.toHaveBeenCalled()
    expect(screen.getByTestId('picked').textContent).toBe('none')
    expect(screen.queryByPlaceholderText('broker host')).toBeNull()
  })

  it('lists the brokers of the kind and selects one', () => {
    h.brokers = [
      { id: 'mq_1', addonId: 'mqtt-broker', name: 'Mosquitto', kind: 'mqtt', status: 'connected' },
      {
        id: 'ha_1',
        addonId: 'provider-homeassistant',
        name: 'Home',
        kind: 'home-assistant',
        status: 'connected',
      },
    ]
    const onChange = vi.fn()
    renderWithClient(<Host onChange={onChange} />)
    expect(screen.queryByText('Home')).toBeNull()
    fireEvent.click(screen.getByText('Mosquitto'))
    expect(onChange).toHaveBeenCalledWith('mq_1')
  })
})
