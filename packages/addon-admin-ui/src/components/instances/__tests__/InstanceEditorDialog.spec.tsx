/**
 * The edit dialog shows the STORED value of every field, not the schema default: a select whose
 * stored option differs from its `default` must render the stored one, and a sign-in started
 * from an existing record must carry the record's effective values, not only the edited ones.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../../brokers/__tests__/setup'

const schemaQuery = vi.hoisted(() => vi.fn())

const FORM = {
  sections: [
    {
      id: 'account',
      title: 'Account',
      columns: 1,
      fields: [
        {
          type: 'select',
          key: 'amazonDomain',
          label: 'Amazon domain (region)',
          options: ['amazon.com', 'amazon.it', 'amazon.de'].map((value) => ({
            value,
            label: value,
          })),
          default: 'amazon.com',
          defaultByCountry: { IT: 'amazon.it' },
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
          instanceFormSchema: {
            query: async (input: unknown) => {
              schemaQuery(input)
              return FORM
            },
          },
          updateInstance: { mutate: async () => ({}) },
        },
      },
    }),
  }
})

import { InstanceEditorDialog } from '../InstanceEditorDialog'

const instance = {
  id: 'alexa_002',
  name: 'Alexa',
  kind: 'alexa',
  enabled: true,
  configured: true,
  status: { state: 'ok', label: 'Connected' },
  formValues: { amazonDomain: 'amazon.it' },
} as const

function renderDialog(formValues: Readonly<Record<string, unknown>> = instance.formValues) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <InstanceEditorDialog
        addonId="import-alexa"
        providerName="Alexa"
        description={{
          role: 'devices',
          instanceMode: 'multiple',
          kind: 'account',
          canTest: false,
          kinds: [
            {
              id: 'alexa',
              label: 'Alexa',
              functionCap: 'broker',
              signIn: { basePath: '/addon/import-alexa/login', methods: ['device-code'] },
            },
          ],
        }}
        instance={{ ...instance, formValues }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  schemaQuery.mockClear()
})

describe('InstanceEditorDialog — stored values', () => {
  it('a select shows its stored option, not the schema default', async () => {
    renderDialog()
    const select = (await screen.findByLabelText(/amazon domain/i)) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('amazon.it'))
  })

  it('a sign-in from an existing record sends the stored region, not only the edits', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }))
    vi.stubGlobal('fetch', fetchSpy)
    renderDialog()
    await screen.findByLabelText(/amazon domain/i)
    fireEvent.click(await screen.findByRole('button', { name: /get a code/i }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const calls = fetchSpy.mock.calls as unknown as Array<[string, { body: string }]>
    const start = calls.find(([url]) => String(url).includes('/code/start'))
    expect(start).toBeDefined()
    expect(JSON.parse(start?.[1].body ?? '{}')).toMatchObject({ amazonDomain: 'amazon.it' })
    vi.unstubAllGlobals()
  })

  it('the on/off switch stored beside the form values is not a form value', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }))
    vi.stubGlobal('fetch', fetchSpy)
    renderDialog({ amazonDomain: 'amazon.it', enabled: true })
    await screen.findByLabelText(/amazon domain/i)
    fireEvent.click(await screen.findByRole('button', { name: /get a code/i }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const calls = fetchSpy.mock.calls as unknown as Array<[string, { body: string }]>
    const start = calls.find(([url]) => String(url).includes('/code/start'))
    expect(JSON.parse(start?.[1].body ?? '{}')).not.toHaveProperty('enabled')
    vi.unstubAllGlobals()
  })
})

describe('InstanceEditorDialog — create a record of a provider with several kinds', () => {
  function renderCreate() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={client}>
        <InstanceEditorDialog
          addonId="storage-orchestrator"
          providerName="Storage Orchestrator"
          description={{
            role: 'services',
            instanceMode: 'multiple',
            kind: 'storage',
            canTest: false,
            kinds: [
              { id: 'recordings', label: 'Recordings', functionCap: 'storage' },
              { id: 'events', label: 'Event media', functionCap: 'storage' },
            ],
          }}
          instance={null}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    )
  }

  it('is titled and named after the kind, not the provider addon', async () => {
    renderCreate()
    expect(await screen.findByText('Add Recordings')).toBeTruthy()
    expect(screen.queryByText(/Add Storage Orchestrator/)).toBeNull()
    // The form builder's labels are not bound to their controls: step from the label to its input.
    const label = await screen.findByText(/^Name\b/)
    const input = label.parentElement?.querySelector('input')
    expect(input?.value).toBe('Recordings')
  })

  it('asks for the form of the chosen kind', async () => {
    renderCreate()
    await waitFor(() =>
      expect(schemaQuery).toHaveBeenCalledWith({
        addonId: 'storage-orchestrator',
        id: null,
        kind: 'recordings',
      }),
    )
  })
})
