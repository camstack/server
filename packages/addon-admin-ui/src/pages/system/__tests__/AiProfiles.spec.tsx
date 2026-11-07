/**
 * Component tests for the AI page.
 *
 * Pinned here: the DEFAULT-PROFILE surface (`llm.getDefaults` / `llm.setDefault`, the chain every
 * consumer falls back to), the page structure (tabs are URL state, presence is answered before
 * anything renders), and the Profiles section being the shared instances table over the `llm`
 * function cap with the model / vision / node columns read from each record's form values.
 */

import type { LlmDefault } from '@camstack/types'
import type { LinkableInstance } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstancesTableProps } from '../../../components/instances/InstancesTable'
import type { PanelRow } from '../../../components/instances/instances-model'

let mockProfiles: LinkableInstance[] = []
let mockDefaults: LlmDefault[] = []
let mockPresence: 'pending' | 'present' | 'absent' | 'unknown' = 'present'
const mockGetDefaults = vi.fn((): Promise<readonly LlmDefault[]> => Promise.resolve(mockDefaults))
const mockSetDefault = vi.fn(
  (_i: { selector: unknown; profileId: string | null }): Promise<void> => Promise.resolve(),
)
const mockTableProps = vi.fn((_p: Pick<InstancesTableProps, 'functionCap' | 'addLabel'>) => {})

interface ErrorBoxProps {
  readonly title?: string
  readonly message: ReactNode
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown, vars?: Record<string, unknown>) => {
      const template = typeof fallback === 'string' ? fallback : key
      if (vars === undefined) return template
      return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        name in vars ? String(vars[name]) : whole,
      )
    },
    i18n: { language: 'en' },
  }),
}))

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: {
        llm: {
          getDefaults: { query: mockGetDefaults },
          setDefault: { mutate: mockSetDefault },
          getUsage: { query: vi.fn(() => Promise.resolve([])) },
          listRuntimeNodes: { query: vi.fn(() => Promise.resolve([])) },
          listModelCatalog: { query: vi.fn(() => Promise.resolve([])) },
        },
        deviceManager: { listAll: { query: vi.fn(() => Promise.resolve([])) } },
        pipelineAnalytics: {
          listRecentTracks: {
            query: vi.fn(() => Promise.resolve({ tracks: [], nextCursor: null })),
          },
        },
        addons: { custom: { mutate: vi.fn() } },
      },
    }),
    ErrorBox: ({ message }: ErrorBoxProps) => <div>{message}</div>,
    useCapabilityPresence: () => mockPresence,
    useInstancesOfCap: () => ({
      data: mockProfiles,
      isLoading: false,
      isError: false,
      isSuccess: true,
      error: null,
    }),
  }
})

/** The table is its own spec; here it shows what the page hands it: the cap, the add label and the columns. */
vi.mock('../../../components/instances/InstancesTable', () => ({
  InstancesTable: (props: InstancesTableProps) => {
    mockTableProps(props)
    return (
      <div data-testid="instances-table">
        <button type="button">{props.addLabel}</button>
        {mockProfiles.map((p) => {
          const row: PanelRow = {
            kind: 'instance',
            key: p.id,
            addonId: 'ai',
            providerName: 'AI',
            id: p.id,
            name: p.name,
            configured: true,
            enabled: p.enabled,
            status: undefined,
            canTest: true,
          }
          return (
            <div key={p.id} data-testid={`row-${p.id}`}>
              <span>{p.name}</span>
              {(props.extraColumns ?? []).map((c) => (
                <span key={c.key} data-testid={`${p.id}-${c.key}`}>
                  {c.render(row, 0)}
                </span>
              ))}
            </div>
          )
        })}
      </div>
    )
  },
}))

const { AiProfilesPage } = await import('../AiProfiles')

function profile(over: Partial<LinkableInstance> & { formValues?: Record<string, unknown> } = {}) {
  const { formValues, ...rest } = over
  return {
    id: 'p-vision',
    name: 'Mac LM-Studio Qwen3-VL 8B',
    kind: 'openai-compatible',
    addonId: 'ai',
    state: 'ok',
    stateLabel: null,
    usable: true,
    enabled: true,
    formValues: { model: 'qwen/qwen3-vl-8b', supportsVision: true, ...formValues },
    ...rest,
  } satisfies LinkableInstance
}

function renderPage(initialUrl = '/system/ai'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <QueryClientProvider client={client}>
        <AiProfilesPage />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('AiProfilesPage — default profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPresence = 'present'
    mockProfiles = [
      profile(),
      profile({
        id: 'p-text',
        name: 'Local Qwen 1.5B',
        formValues: { model: 'qwen-1.5b', supportsVision: false },
      }),
    ]
    mockDefaults = []
  })

  it('offers a vision default picker listing only vision-capable profiles', async () => {
    renderPage()
    const picker = await screen.findByLabelText('Default vision profile')
    await waitFor(() => expect(picker.querySelectorAll('option')).toHaveLength(2))
    const options = [...picker.querySelectorAll('option')].map((o) => o.getAttribute('value'))
    expect(options).toContain('p-vision')
    expect(options).not.toContain('p-text')
  })

  it('sets the vision default through llm.setDefault', async () => {
    renderPage()
    const picker = await screen.findByLabelText('Default vision profile')
    await waitFor(() => expect(picker.querySelector('option[value="p-vision"]')).not.toBeNull())
    fireEvent.change(picker, { target: { value: 'p-vision' } })
    await waitFor(() =>
      expect(mockSetDefault).toHaveBeenCalledWith({
        selector: { purpose: 'vision' },
        profileId: 'p-vision',
      }),
    )
  })

  it('clears a default by choosing none (profileId null, never the empty string)', async () => {
    mockDefaults = [{ selector: { purpose: 'text' }, profileId: 'p-text' }]
    renderPage()
    const picker = await screen.findByLabelText('Default text profile')
    await waitFor(() => expect(picker).toHaveValue('p-text'))
    fireEvent.change(picker, { target: { value: '' } })
    await waitFor(() =>
      expect(mockSetDefault).toHaveBeenCalledWith({
        selector: { purpose: 'text' },
        profileId: null,
      }),
    )
  })

  /** A default naming a DISABLED profile resolves to nothing at call time: say so where it is set. */
  it('warns when the chosen default profile is disabled', async () => {
    mockProfiles = [profile({ enabled: false })]
    mockDefaults = [{ selector: { purpose: 'vision' }, profileId: 'p-vision' }]
    renderPage()
    expect(await screen.findByText(/this default profile is disabled/i)).toBeTruthy()
  })
})

describe('AiProfilesPage — the profiles section', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPresence = 'present'
    mockProfiles = [profile()]
    mockDefaults = []
  })

  it('is the instances table over the llm function cap, with its own Add profile action', async () => {
    renderPage()
    expect(await screen.findByTestId('instances-table')).toBeTruthy()
    expect(mockTableProps).toHaveBeenCalledWith(
      expect.objectContaining({ functionCap: 'llm', addLabel: 'Add profile' }),
    )
  })

  it('draws model, vision and node from the record form values', async () => {
    mockProfiles = [
      profile({ formValues: { model: 'qwen/qwen3-vl-8b', supportsVision: true, nodeId: 'hub' } }),
    ]
    renderPage()
    expect(await screen.findByTestId('p-vision-model')).toHaveTextContent('qwen/qwen3-vl-8b')
    expect(screen.getByTestId('p-vision-vision')).toHaveTextContent('vision')
    expect(screen.getByTestId('p-vision-node')).toHaveTextContent('hub')
  })

  it('shows no vision badge for a text-only profile', async () => {
    mockProfiles = [profile({ formValues: { model: 'm', supportsVision: false } })]
    renderPage()
    expect((await screen.findByTestId('p-vision-vision')).textContent).toBe('')
  })
})

describe('AiProfilesPage — the common admin page structure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPresence = 'present'
    mockProfiles = [profile()]
    mockDefaults = []
  })

  it('opens the tab named in the URL, not always the first one', async () => {
    renderPage('/system/ai?tab=usage')
    expect(await screen.findByText('No AI calls in this window.')).toBeTruthy()
    expect(screen.queryByLabelText('Default vision profile')).toBeNull()
  })

  /** D315: an unanswered registry read must never read as "not installed". */
  it('renders a placeholder, not an absence, while the llm capability check is pending', async () => {
    mockPresence = 'pending'
    renderPage()
    expect(await screen.findByTestId('ai-presence-pending')).toBeTruthy()
    expect(screen.queryByText('AI is not installed')).toBeNull()
    expect(mockTableProps).not.toHaveBeenCalled()
  })

  it('says AI is not installed only when the registry answered with no provider', async () => {
    mockPresence = 'absent'
    renderPage()
    expect(await screen.findByText('AI is not installed')).toBeTruthy()
    expect(screen.queryByText('Add profile')).toBeNull()
  })

  it('renders the usage window picker even when the window has no calls', async () => {
    renderPage('/system/ai?tab=usage')
    expect(await screen.findByText('No AI calls in this window.')).toBeTruthy()
    expect(screen.getByLabelText('Window')).toBeTruthy()
  })
})
