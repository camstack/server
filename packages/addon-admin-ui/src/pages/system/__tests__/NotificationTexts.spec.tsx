/**
 * Component tests for the Texts tab (i18n Phase 2).
 *
 * The state that matters most here is the DEGRADED one, and it is not an edge
 * case: the admin bundle and `addon-post-analysis` deploy separately, so a hub
 * whose addon half has not landed yet answers `has no custom action
 * 'nc.getTexts'` — verified against the live hub on 2026-08-13, which is
 * exactly the reply this suite fakes. The tab must SAY that, and never render
 * an empty table (which reads as "my customisations are gone") or crash.
 *
 * The other three pin the surface's promises: provenance is visible, the
 * shipped text is shown beside an override so a reset has something to go back
 * to, and Save sends a PATCH of what actually changed — nothing when nothing
 * did.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface CustomCall {
  readonly addonId: string
  readonly action: string
  readonly input: Record<string, unknown>
}

let mockCustomImpl: (call: CustomCall) => Promise<unknown> = () => Promise.resolve(null)
const calls: CustomCall[] = []
const mockCustom = vi.fn((call: CustomCall) => {
  calls.push(call)
  return mockCustomImpl(call)
})

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({ trpcClient: { addons: { custom: { mutate: mockCustom } } } }),
  }
})

import { NotificationTextsPage } from '../NotificationTexts'

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationTextsPage />
    </QueryClientProvider>,
  )
}

const CATALOG = {
  language: 'en',
  activeLanguage: 'en',
  languages: ['en', 'it'],
  entries: [
    {
      key: 'detection.body',
      shipped: '{{subject}} on {{camera}}',
      shippedLanguage: 'en',
      override: null,
      effective: '{{subject}} on {{camera}}',
      source: 'shipped',
      placeholders: ['subject', 'camera'],
      pluralCategories: [],
    },
    {
      key: 'class.person',
      shipped: 'people',
      shippedLanguage: 'en',
      override: 'humans',
      effective: 'humans',
      source: 'override',
      placeholders: [],
      pluralCategories: ['one', 'other'],
    },
  ],
}

describe('NotificationTexts page', () => {
  beforeEach(() => {
    calls.length = 0
    mockCustom.mockClear()
    mockCustomImpl = () => Promise.resolve(CATALOG)
  })

  it('says the catalog is UNAVAILABLE when the hub has no such action — it does not crash or blank', async () => {
    // The literal reply of a hub whose post-analysis addon predates Phase 2.
    mockCustomImpl = () =>
      Promise.reject(new Error("addon 'pipeline-analytics' has no custom action 'nc.getTexts'"))
    renderPage()
    await waitFor(() =>
      expect(screen.getByText(/text catalog is not available on this hub/i)).toBeTruthy(),
    )
    expect(screen.getByText(/has not been updated/i)).toBeTruthy()
    // NOT an empty table — that reads as data loss.
    expect(screen.queryByTestId('texts-rows')).toBeNull()
  })

  it('distinguishes an UNREADABLE reply from a missing one', async () => {
    mockCustomImpl = () => Promise.resolve({ nonsense: true })
    renderPage()
    await waitFor(() => expect(screen.getByText(/does not understand/i)).toBeTruthy())
  })

  it('renders one row per key, with the shipped text kept beside an override', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('text-row-detection.body')).toBeTruthy())
    const overridden = screen.getByTestId('text-row-class.person')
    expect(overridden.getAttribute('data-source')).toBe('override')
    // The box shows the override; the shipped wording is still on screen.
    expect(screen.getByTestId('text-input-class.person-input').getAttribute('value')).toBe('humans')
    expect(screen.getByText('people')).toBeTruthy()
    // …and the plural warning, before anyone flattens "person / people".
    expect(screen.getByText(/one, other/)).toBeTruthy()
  })

  it('saves a PATCH of what changed, and nothing when nothing did', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('texts-save')).toBeTruthy())
    const save = screen.getByTestId('texts-save')
    expect(save.hasAttribute('disabled')).toBe(true)

    fireEvent.change(screen.getByTestId('text-input-detection.body-input'), {
      target: { value: 'seen: {{subject}}' },
    })
    fireEvent.click(screen.getByTestId('texts-save'))

    await waitFor(() => expect(calls.some((c) => c.action === 'nc.setTextOverrides')).toBe(true))
    const write = calls.find((c) => c.action === 'nc.setTextOverrides')
    expect(write?.input).toEqual({
      language: 'en',
      overrides: { 'detection.body': 'seen: {{subject}}' },
    })
  })

  it('a per-key reset asks the server to drop the override', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('text-reset-class.person')).toBeTruthy())
    fireEvent.click(screen.getByTestId('text-reset-class.person'))
    fireEvent.click(screen.getByTestId('texts-save'))
    await waitFor(() => expect(calls.some((c) => c.action === 'nc.setTextOverrides')).toBe(true))
    expect(calls.find((c) => c.action === 'nc.setTextOverrides')?.input).toEqual({
      language: 'en',
      overrides: { 'class.person': null },
    })
  })

  it('the search box narrows the table', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('text-row-detection.body')).toBeTruthy())
    fireEvent.change(screen.getByTestId('texts-search'), { target: { value: 'person' } })
    await waitFor(() => expect(screen.queryByTestId('text-row-detection.body')).toBeNull())
    expect(screen.getByTestId('text-row-class.person')).toBeTruthy()
  })
})
