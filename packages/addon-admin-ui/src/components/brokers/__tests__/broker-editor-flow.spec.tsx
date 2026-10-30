/**
 * The ONE broker create / edit / sign-in path: `BrokerEditorDialog`, and the
 * `BrokerPicker` that opens it stacked over the caller. Fakes stand in for the
 * `broker` cap hooks and for the addon's sign-in routes; the specs pin
 *   - every kind's create path through the same dialog (add routed to its owner),
 *   - the interactive sign-in as the default path for a kind that declares one,
 *     with its technical fields under Advanced and its region prefilled,
 *   - the stacked-modal return (new broker preselected, caller state kept, cancel).
 */
import { useState, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const h = vi.hoisted(() => ({
  add: vi.fn(),
  setSettings: vi.fn(),
  nextId: 'new_1',
  brokers: [] as Array<Record<string, unknown>>,
  providers: [] as Array<Record<string, unknown>>,
  schemas: {} as Record<string, unknown>,
}))

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
    useBrokerGetSettingsSchema: (input: { kind: string }) => ({
      data: h.schemas[input.kind],
      isLoading: false,
      isError: false,
    }),
    useBrokerGetSettings: () => ({
      data: { host: 'old.local' },
      isLoading: false,
      isError: false,
    }),
    useBrokerAdd: (opts?: { onSuccess?: (created: { id: string }) => void }) => ({
      mutate: (input: unknown) => {
        h.add(input)
        opts?.onSuccess?.({ id: h.nextId })
      },
      isPending: false,
      isError: false,
    }),
    useBrokerSetSettings: (opts?: { onSuccess?: () => void }) => ({
      mutate: (input: unknown) => {
        h.setSettings(input)
        opts?.onSuccess?.()
      },
      isPending: false,
      isError: false,
    }),
    useBrokerTestSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
  }
})

import { BrokerEditorDialog } from '../BrokerEditorDialog'
import { BrokerPicker } from '../BrokerPicker'

const HOST_SCHEMA = {
  sections: [
    {
      id: 'conn',
      title: 'Conn',
      columns: 1,
      fields: [
        {
          type: 'text',
          key: 'host',
          label: 'Host',
          placeholder: 'broker host',
        },
      ],
    },
  ],
}

const KINDS: ReadonlyArray<readonly [string, string, string]> = [
  ['home-assistant', 'provider-homeassistant', 'Home Assistant'],
  ['mqtt', 'mqtt-broker', 'MQTT'],
  ['homematic', 'provider-homematic', 'Homematic'],
  ['matter', 'addon-matter-broker', 'Matter'],
]

/** The JSON body a recorded `fetch(url, init)` call was sent with. */
function bodyOf(call: readonly unknown[] | undefined): unknown {
  const init = call?.[1]
  const body = init !== null && typeof init === 'object' && 'body' in init ? init.body : undefined
  return typeof body === 'string' ? JSON.parse(body) : undefined
}

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  h.add.mockReset()
  h.setSettings.mockReset()
  h.nextId = 'new_1'
  h.brokers = []
  h.providers = KINDS.map(([kind, addonId, label]) => ({
    addonId,
    kinds: [{ kind, label }],
  }))
  h.schemas = Object.fromEntries(KINDS.map(([kind]) => [kind, HOST_SCHEMA]))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('BrokerEditorDialog — create, every kind through the same dialog', () => {
  it.each(KINDS)('%s is added through its owning provider', async (kind, addonId, label) => {
    const onSaved = vi.fn()
    renderWithClient(<BrokerEditorDialog kind={kind} onClose={() => {}} onSaved={onSaved} />)

    fireEvent.change(await screen.findByPlaceholderText('broker host'), {
      target: { value: 'broker.local' },
    })
    // The name starts as the kind's label; no kind control for a single kind.
    expect((screen.getByPlaceholderText('My Home Assistant') as HTMLInputElement).value).toBe(label)
    expect(screen.queryByRole('combobox')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /create broker/i }))
    expect(h.add).toHaveBeenCalledWith({
      kind,
      name: label,
      settings: { host: 'broker.local' },
      addonId,
    })
    expect(onSaved).toHaveBeenCalledWith('new_1')
  })

  it('suggests the next free name when the kind already has a broker of that name', async () => {
    h.brokers = [
      {
        id: 'ha_1',
        addonId: 'provider-homeassistant',
        name: 'Home Assistant',
        kind: 'home-assistant',
        status: 'connected',
      },
    ]
    renderWithClient(
      <BrokerEditorDialog kind="home-assistant" onClose={() => {}} onSaved={() => {}} />,
    )
    await screen.findByPlaceholderText('broker host')
    expect((screen.getByPlaceholderText('My Home Assistant') as HTMLInputElement).value).toBe(
      'Home Assistant 2',
    )
  })
})

describe('BrokerEditorDialog — edit', () => {
  it('saves the stored settings back through the owner', async () => {
    const onSaved = vi.fn()
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
    expect(host.value).toBe('old.local')
    fireEvent.change(host, { target: { value: 'new.local' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(h.setSettings).toHaveBeenCalledWith({
      id: 'mq_1',
      addonId: 'mqtt-broker',
      settings: { host: 'new.local' },
    })
    expect(onSaved).toHaveBeenCalledWith('mq_1')
  })
})

describe('BrokerEditorDialog — a kind that declares an interactive sign-in', () => {
  const SIGN_IN = '/addon/some-addon/login'

  beforeEach(() => {
    h.providers = [
      {
        addonId: 'some-addon',
        kinds: [
          {
            kind: 'account',
            label: 'Account Import',
            signIn: { basePath: SIGN_IN, methods: ['proxy'] },
          },
        ],
      },
    ]
    h.schemas = {
      account: {
        sections: [
          {
            id: 'acct',
            title: 'Account',
            columns: 1,
            fields: [
              {
                type: 'select',
                key: 'region',
                label: 'Region',
                options: [
                  { value: 'site.com', label: 'site.com' },
                  { value: 'site.it', label: 'site.it' },
                ],
                default: 'site.com',
                defaultByCountry: { IT: 'site.it' },
              },
              {
                type: 'password',
                key: 'cookie',
                label: 'Cookie',
                filledBySignIn: true,
              },
              { type: 'number', key: 'pollMs', label: 'Poll', default: 60000 },
            ],
          },
        ],
      },
    }
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('it-IT')
  })

  function stubSignInRoutes(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string) => {
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      if (url.endsWith('/start'))
        return json({
          sessionId: 's1',
          loginUrl: 'https://login.example.com/s1',
        })
      if (url.includes('/status')) {
        return json({
          sessionId: 's1',
          phase: 'captured',
          loginUrl: 'https://login.example.com/s1',
          error: null,
        })
      }
      if (url.endsWith('/commit')) return json({ brokerId: 'acct_1' })
      return json({ ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('offers the sign-in first, hides the technical fields under Advanced and prefills the region', async () => {
    renderWithClient(<BrokerEditorDialog kind="account" onClose={() => {}} onSaved={() => {}} />)
    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeTruthy()
    // Advanced holds region, cookie and poll; the manual Save is the secondary path.
    expect(screen.getByText('Advanced')).toBeTruthy()
    expect(screen.queryByText('Cookie')).toBeNull()
    expect(screen.queryByText('Poll')).toBeNull()
    // A sign-in mints the broker under a fresh id: no "restore under its original id".
    expect(screen.queryByText(/restore a broker/i)).toBeNull()
  })

  it('signs in, sends only the visible non-credential settings, and returns the broker without broker.add', async () => {
    const fetchMock = stubSignInRoutes()
    const onSaved = vi.fn()
    renderWithClient(<BrokerEditorDialog kind="account" onClose={() => {}} onSaved={onSaved} />)

    fireEvent.click(await screen.findByRole('button', { name: /^sign in$/i }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/start'))).toBe(true),
    )
    const start = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/start'))
    expect(bodyOf(start)).toEqual({
      region: 'site.it',
    })

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('acct_1'), {
      timeout: 5000,
    })
    const commit = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/commit'))
    expect(bodyOf(commit)).toEqual({
      sessionId: 's1',
      name: 'Account Import',
    })
    expect(h.add).not.toHaveBeenCalled()
  })

  it('re-links the existing broker when editing', async () => {
    const fetchMock = stubSignInRoutes()
    const onSaved = vi.fn()
    const broker = {
      id: 'acct_9',
      addonId: 'some-addon',
      name: 'Mine',
      kind: 'account',
      status: 'auth-failed',
      info: {},
      lastCheckedAt: null,
      error: null,
    } as const
    renderWithClient(<BrokerEditorDialog broker={broker} onClose={() => {}} onSaved={onSaved} />)
    fireEvent.click(await screen.findByRole('button', { name: /^sign in$/i }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('acct_1'), {
      timeout: 5000,
    })
    const commit = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/commit'))
    expect(bodyOf(commit)).toMatchObject({
      brokerId: 'acct_9',
    })
  })
})

function Host({ onChange }: { readonly onChange: (id: string | null) => void }): ReactElement {
  const [value, setValue] = useState<string | null>(null)
  const [note, setNote] = useState('')
  return (
    <div>
      <input aria-label="note" value={note} onChange={(e) => setNote(e.target.value)} />
      <BrokerPicker
        kind="mqtt"
        value={value}
        onChange={(id) => {
          setValue(id)
          onChange(id)
        }}
      />
      <output data-testid="picked">{value ?? 'none'}</output>
    </div>
  )
}

describe('BrokerPicker — Create new… stacks the broker dialog over the caller', () => {
  it('returns with the new broker selected and the caller state intact', async () => {
    const onChange = vi.fn()
    h.nextId = 'mq_new'
    renderWithClient(<Host onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('note'), {
      target: { value: 'draft in progress' },
    })

    fireEvent.click(screen.getByRole('button', { name: /create new/i }))
    fireEvent.change(await screen.findByPlaceholderText('broker host'), {
      target: { value: 'mqtt.local' },
    })
    fireEvent.click(screen.getByRole('button', { name: /create broker/i }))

    expect(h.add).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mqtt', addonId: 'mqtt-broker' }),
    )
    expect(screen.getByTestId('picked').textContent).toBe('mq_new')
    expect((screen.getByLabelText('note') as HTMLInputElement).value).toBe('draft in progress')
    // The dialog is gone.
    expect(screen.queryByPlaceholderText('broker host')).toBeNull()
  })

  it('cancel returns unchanged', async () => {
    const onChange = vi.fn()
    renderWithClient(<Host onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /create new/i }))
    await screen.findByPlaceholderText('broker host')
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onChange).not.toHaveBeenCalled()
    expect(h.add).not.toHaveBeenCalled()
    expect(screen.getByTestId('picked').textContent).toBe('none')
    expect(screen.queryByPlaceholderText('broker host')).toBeNull()
  })

  it('lists the brokers of the kind and selects one', () => {
    h.brokers = [
      {
        id: 'mq_1',
        addonId: 'mqtt-broker',
        name: 'Mosquitto',
        kind: 'mqtt',
        status: 'connected',
      },
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
