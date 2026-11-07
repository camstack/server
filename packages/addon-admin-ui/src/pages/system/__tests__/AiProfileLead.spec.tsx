/**
 * The top of an AI profile's dialog: provider widgets by generic id, or the model picker.
 * Every change is written through `integrationInstances.updateInstance`, and the changes one
 * widget makes together (config and model) travel as ONE patch.
 */
import type { IntegrationInstance, IntegrationInstanceDescription } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceRow } from '../../../components/instances/instances-model'
import type { ProviderWidgetProps } from '../ai-provider-widgets'

let kinds: NonNullable<IntegrationInstanceDescription['kinds']> = []
let formValues: Record<string, unknown> = {}
const mockUpdate = vi.fn((_i: unknown) => Promise.resolve({ ok: true as const }))
const mockListModels = vi.fn((_i: unknown) =>
  Promise.resolve({
    ok: true as const,
    models: [
      { id: 'm-text', label: 'Text model' },
      { id: 'm-vision', label: 'Vision model', features: { vision: true } },
    ],
  }),
)

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}))

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: {
        integrationInstances: {
          describe: {
            query: () => Promise.resolve({ instanceMode: 'multiple', kinds }),
          },
          getInstance: {
            query: () =>
              Promise.resolve({
                id: 'p1',
                name: 'P',
                configured: true,
                formValues,
              } satisfies Partial<IntegrationInstance>),
          },
          updateInstance: { mutate: mockUpdate },
        },
        llm: { listModels: { mutate: mockListModels } },
      },
    }),
  }
})

vi.mock('../ai-provider-widgets', () => ({
  providerWidget: (id: string) =>
    id === 'ai/managed-model'
      ? function Stub({
          onProviderConfigChange,
          onModelChange,
          providerConfig,
        }: ProviderWidgetProps) {
          return (
            <button
              type="button"
              data-testid="stub-widget"
              data-ref={JSON.stringify(providerConfig.model ?? null)}
              onClick={() => {
                onProviderConfigChange({
                  ...providerConfig,
                  model: { kind: 'catalog', catalogId: 'c1' },
                })
                onModelChange({ id: 'c1-file', supportsVision: true })
              }}
            >
              pick
            </button>
          )
        }
      : null,
}))

const { AiProfileLead } = await import('../AiProfileLead')

const ROW: InstanceRow = {
  kind: 'instance',
  key: 'ai/p1',
  addonId: 'ai',
  providerName: 'AI',
  id: 'p1',
  name: 'P',
  configured: true,
  enabled: true,
  status: undefined,
  canTest: true,
  kindId: 'managed-local',
}

function renderLead(row: InstanceRow = ROW): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AiProfileLead row={row} />
    </QueryClientProvider>,
  )
}

describe('AiProfileLead', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    formValues = { model: '', supportsVision: false }
  })

  it('renders the widget a kind names, and writes its config and model as ONE patch', async () => {
    kinds = [
      {
        id: 'managed-local',
        label: 'Managed',
        functionCap: 'llm',
        widgets: [{ id: 'ai/managed-model', placement: 'model' }],
      },
    ]
    renderLead()
    fireEvent.click(await screen.findByTestId('stub-widget'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate).toHaveBeenCalledWith({
      addonId: 'ai',
      id: 'p1',
      values: {
        modelRef: { kind: 'catalog', catalogId: 'c1' },
        model: 'c1-file',
        supportsVision: true,
      },
    })
    // A kind with a model widget has no second model control.
    expect(screen.queryByText('Load models')).toBeNull()
  })

  it('hands the widget the stored model reference', async () => {
    kinds = [
      {
        id: 'managed-local',
        label: 'Managed',
        functionCap: 'llm',
        widgets: [{ id: 'ai/managed-model', placement: 'model' }],
      },
    ]
    formValues = { model: 'f', modelRef: { kind: 'catalog', catalogId: 'stored' } }
    renderLead()
    const widget = await screen.findByTestId('stub-widget')
    expect(widget.getAttribute('data-ref')).toContain('stored')
  })

  it('names a widget this build does not know instead of guessing', async () => {
    kinds = [
      {
        id: 'managed-local',
        label: 'Managed',
        functionCap: 'llm',
        widgets: [{ id: 'x/unknown', placement: 'connection' }],
      },
    ]
    renderLead()
    expect(await screen.findByText(/needs an editor part this build does not have/)).toBeTruthy()
  })

  it('lists models for the stored record and writes the chosen one with its vision feature', async () => {
    kinds = [{ id: 'openai', label: 'OpenAI', functionCap: 'llm' }]
    renderLead({ ...ROW, kindId: 'openai' })
    fireEvent.click(await screen.findByText('Load models'))
    await waitFor(() =>
      expect(mockListModels).toHaveBeenCalledWith({
        addonId: 'ai',
        kind: 'openai',
        profileId: 'p1',
      }),
    )
    const select = await screen.findByLabelText('Model')
    await waitFor(() => expect(select.querySelector('option[value="m-vision"]')).not.toBeNull())
    fireEvent.change(select, { target: { value: 'm-vision' } })
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({
        addonId: 'ai',
        id: 'p1',
        values: { model: 'm-vision', supportsVision: true },
      }),
    )
  })
})
